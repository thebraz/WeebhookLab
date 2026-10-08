import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const validation = join(root, '.release-validation');
await mkdir(validation, { recursive: true });
assert(process.env.npm_execpath, 'Execute com npm run test:package.');
const npm = (args, cwd = root) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
  cwd, encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, npm_config_cache: join(validation, 'npm-cache') },
});
npm(['run', 'build']);
const [archive] = JSON.parse(npm(['pack', '--ignore-scripts', '--json']));
const paths = archive.files.map((file) => file.path);
assert(paths.includes('dist/server/cli.js') && paths.includes('dist/web/index.html') && paths.includes('dist/shared/contracts.js'));
assert(paths.every((path) => /^(dist\/(server|shared|web)\/|docs\/images\/[\w-]+\.jpg$|package\.json$|README\.md$|CHANGELOG\.md$|CONTRIBUTING\.md$|LICENSE$)/.test(path)), 'O pacote contém arquivos fora da distribuição.');
const readme = await readFile(join(root, 'README.md'), 'utf8');
for (const [, path] of readme.matchAll(/\]\((docs\/images\/[^)]+)\)/g)) assert(paths.includes(path), `Imagem ausente do pacote: ${path}`);
assert(paths.every((path) => !/\.(sqlite|db|map)(?:-|$)/i.test(path)));
const directory = await mkdtemp(join(tmpdir(), 'weebhooklab-install-'));
npm(['init', '-y'], directory);
npm(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', join(root, archive.filename)], directory);
const cli = join(directory, 'node_modules', 'weebhooklab', 'dist', 'server', 'cli.js');
const manifest = JSON.parse(await readFile(join(directory, 'node_modules', 'weebhooklab', 'package.json'), 'utf8'));
assert.equal(manifest.bin.weebhooklab, 'dist/server/cli.js');
await access(join(directory, 'node_modules', '.bin', process.platform === 'win32' ? 'weebhooklab.cmd' : 'weebhooklab'));
assert.equal(npm(['exec', '--offline', '--', 'weebhooklab', '--version'], directory).trim(), manifest.version);
assert.match(npm(['exec', '--offline', '--', 'weebhooklab', '--help'], directory), /--no-open/);
assert.throws(() => execFileSync(process.execPath, [cli, '--port', '0'], { cwd: directory, stdio: 'pipe' }),
  (error) => error.status === 1 && !String(error.stdout).includes('started') && !String(error.stderr).includes(' at '));

const receiver = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  response.writeHead(500, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ received: JSON.parse(Buffer.concat(chunks).toString()), method: request.method }));
});
receiver.listen(0, '127.0.0.1'); await once(receiver, 'listening');
const receiverUrl = `http://127.0.0.1:${receiver.address().port}`;
const portProbe = createServer(); portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening');
const port = portProbe.address().port; await new Promise((resolve) => portProbe.close(resolve));
const url = `http://127.0.0.1:${port}`;
const env = { ...process.env, WEEBHOOKLAB_DATA_DIR: join(directory, 'storage') };
let child;
let output = '';
let errors = '';
const start = async () => {
  output = ''; errors = '';
  // Windows cannot deliver POSIX signals to child processes; IPC triggers the same handler.
  const preload = 'data:text/javascript,process.on("message",signal=>{process.disconnect();process.emit(signal)})';
  child = spawn(process.execPath, ['--import', preload, cli, '--port', String(port), '--host', '127.0.0.1', '--no-open', '--workspace', 'release-test'],
    { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { errors += chunk; });
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null) throw new Error(`CLI encerrou antes de iniciar: ${errors}`);
    try { if ((await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) })).ok && output.includes('Inspector ready')) return; } catch { /* Wait for the actual listener. */ }
    await delay(100);
  }
  throw new Error('Timeout ao iniciar CLI instalado.');
};
const stop = async (signal) => {
  const exit = once(child, 'exit'); child.send(signal);
  const timeout = setTimeout(() => child.kill(), 10_000);
  try { const [code, killed] = await exit; assert.equal(killed, null); assert.equal(code, 0, errors); }
  finally { clearTimeout(timeout); }
};
const api = async (path, method = 'GET', body) => {
  const response = await fetch(`${url}${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  assert(response.ok, `${method} ${path}: ${response.status}`); return response.json();
};
try {
  await start();
  const htmlResponse = await fetch(url); const html = await htmlResponse.text(); assert(htmlResponse.ok && html.includes('id="root"'));
  assert(htmlResponse.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  for (const asset of [...html.matchAll(/(?:src|href)="(\/assets\/[^"\s]+)"/g)].map((match) => match[1])) { const response = await fetch(`${url}${asset}`); assert(response.ok); assert((await response.arrayBuffer()).byteLength > 0); }
  assert.equal((await fetch(`${url}/package.json`)).status, 404);
  assert.equal((await fetch(`${url}/../server/cli.js`)).status, 404);
  const conflict = spawn(process.execPath, [cli, '--port', String(port), '--no-open'], { cwd: directory, env: { ...env, WEEBHOOKLAB_DATA_DIR: join(directory, 'conflict') }, windowsHide: true });
  let conflictOutput = ''; conflict.stdout.on('data', (chunk) => { conflictOutput += chunk; }); conflict.stderr.on('data', (chunk) => { conflictOutput += chunk; });
  assert.equal((await once(conflict, 'exit'))[0], 1); assert(conflictOutput.includes('is already in use')); assert(!conflictOutput.includes('Inspector ready'));
  await api('/hooks/release', 'POST', { plan: 'basic', token: 'package-secret-canary' });
  const event = (await api('/api/events')).events[0]; const original = await api(`/api/events/${event.id}`);
  assert.equal(Buffer.from(original.rawBody.data, 'base64').toString(), '{"plan":"basic","token":"package-secret-canary"}');
  const request = { method: 'PUT', destinationUrl: `${receiverUrl}/receiver?debug=true`, headers: [['Content-Type', 'application/json']], body: { encoding: 'base64', data: Buffer.from('{"plan":"premium"}').toString('base64') }, timeoutMs: 1000 };
  const replay = await api(`/api/events/${event.id}/replays`, 'POST', request);
  assert.equal(replay.result.status, 500); assert.equal(replay.result.error, undefined);
  assert.deepEqual(JSON.parse(Buffer.from(replay.result.body.data, 'base64').toString()), { received: { plan: 'premium' }, method: 'PUT' });
  const savedId = randomUUID(); await api(`/api/requests/${savedId}`, 'PUT', { name: 'Reusable request', request });
  const profileId = randomUUID(); await api(`/api/mocks/${profileId}`, 'PUT', { name: 'HTTP failure', response: { status: 500, headers: [['Content-Type', 'application/json']], body: '{"mock":true}', delayMs: 0, maxDelayMs: 0 } });
  await api(`/api/bindings/${randomUUID()}`, 'PUT', { path: '/hooks/mock', profileId });
  const mocked = await fetch(`${url}/hooks/mock`, { method: 'POST', body: '{}' }); assert.equal(mocked.status, 500); assert.deepEqual(await mocked.json(), { mock: true });
  const workspaceState = await api('/api/workspaces'); const workspaceId = workspaceState.activeId;
  const exported = await api('/api/workspaces/export');
  assert(exported.redacted); assert(!exported.events.some((item) => Buffer.from(item.rawBody.data, 'base64').toString().includes('package-secret-canary')));
  const imported = await api('/api/workspaces/import', 'POST', exported); assert.notEqual(imported.id, workspaceId); assert.equal((await api('/api/workspaces')).activeId, workspaceId);
  const streamAbort = new AbortController(); const stream = await fetch(`${url}/api/events/stream?workspace=${workspaceId}`, { signal: streamAbort.signal }); const reader = stream.body.getReader(); await reader.read();
  const slowClient = httpRequest(`${url}/hooks/partial`, { method: 'POST', headers: { 'content-length': '1024' } }); slowClient.on('error', () => {}); slowClient.write('x');
  await stop('SIGINT'); assert((await reader.read()).done); streamAbort.abort();
  slowClient.destroy();
  await start();
  assert.equal((await api('/api/workspaces')).activeId, workspaceId);
  assert.equal((await api(`/api/events/${event.id}`)).rawBody.data, original.rawBody.data);
  assert.equal((await api(`/api/events/${event.id}/replays`)).executions[0].id, replay.id);
  assert.equal((await api('/api/configuration')).requests[0].id, savedId);
  assert.equal((await api('/api/events?exactPath=%2Fhooks%2Fpartial')).events.length, 0);
  assert.equal((await fetch(`${url}/hooks/mock`, { method: 'POST', body: '{}' })).status, 500);
  const demo = spawn(process.execPath, [join(root, 'examples', 'demo.mjs'), `${url}/hooks/demo`], { cwd: directory, stdio: 'pipe', windowsHide: true });
  demo.stdout.resume(); demo.stderr.resume(); assert.equal((await once(demo, 'exit'))[0], 0);
  await stop('SIGTERM');
  const released = createServer(); released.listen(port, '127.0.0.1'); await once(released, 'listening'); await new Promise((resolve) => released.close(resolve));
  console.log(`Pacote verificado: ${archive.filename} (${archive.files.length} arquivos, ${archive.size} bytes).`);
  console.log('Instalação limpa, CLI, assets, captura, edição/replay HTTP 500, histórico, mock, exportação/importação, demo e reinício: OK.');
  console.log(`Encerramento SIGINT/SIGTERM${process.platform === 'win32' ? ' via IPC no Windows' : ''}, SSE e liberação da porta: OK.`);
  console.log(`Instalação isolada: ${directory}`);
} finally {
  if (child && child.exitCode === null) child.kill();
  await new Promise((resolve) => receiver.close(resolve));
}
