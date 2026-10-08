import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import dns from 'node:dns';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server/app.js';
import { executeReplay, validateReplay } from '../src/server/replay.js';
import { EventStore } from '../src/server/store.js';
import { isReplay, type EventPage, type Header, type ReplayExecution, type ReplayPage, type ReplayRequest, type WebhookEvent } from '../src/shared/contracts.js';
import { capturedRequest, curlCommand, destination, editableText, queryPairs, replayHeaders, utf8Base64, withQuery } from '../src/shared/replay.js';
import { editorRequest, initialState, openReplayEditor } from '../src/web/replayEditor.js';

async function listen(server: Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function send(url: string, method = 'GET', body?: string | Buffer, headers: IncomingHttpHeaders = {}) {
  return new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const req = httpRequest(url, { method, headers: { ...headers, ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end(body);
  });
}

async function fixture(t: TestContext, responseLimit?: number) {
  const directory = await mkdtemp(join(tmpdir(), 'weebhooklab-replay-'));
  const path = join(directory, 'events.sqlite');
  const app = createApp({ databasePath: path, ...(responseLimit === undefined ? {} : { responseLimit }) });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address(); assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const received: { method: string; url: string; headers: Header[]; body: Buffer }[] = [];
  const target = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
    const headers: Header[] = []; for (let i = 0; i < req.rawHeaders.length; i += 2) headers.push([req.rawHeaders[i]!, req.rawHeaders[i + 1]!]);
    received.push({ method: req.method!, url: req.url!, headers, body: Buffer.concat(chunks) });
    if (req.url?.startsWith('/timeout-headers')) { res.writeHead(201); res.flushHeaders(); return; }
    if (req.url?.startsWith('/timeout')) return;
    if (req.url?.startsWith('/partial')) { res.writeHead(202); res.write('partial'); setImmediate(() => res.destroy()); return; }
    if (req.url?.startsWith('/large')) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(Buffer.alloc(4096, 97)); return; }
    if (req.url?.startsWith('/redirect')) { res.writeHead(302, { location: '/echo' }); res.end(); return; }
    const status = Number(req.url?.match(/^\/status\/(\d+)/)?.[1] ?? 200);
    res.writeHead(status, { 'content-type': 'application/json', 'x-response': ['one', 'two'], 'set-cookie': ['first=1', 'second=2'] });
    res.end(JSON.stringify({ success: status === 200, bytes: Buffer.concat(chunks).length }));
  });
  const targetUrl = await listen(target);
  t.after(async () => { target.closeAllConnections(); await new Promise<void>((resolve) => target.close(() => resolve())); await app.close(); await rm(directory, { recursive: true, force: true }); });
  const capture = async (body: string | Buffer = '{"plan":"basic"}', type = 'application/json', method = 'POST') => {
    assert.equal((await send(`${url}/hooks/payment?item=one&item=two&empty=&name=Jo%C3%A3o`, method, body, { 'content-type': type, 'x-repeat': ['one', 'two'], 'stripe-signature': 'test-signature' })).status, 200);
    const page = JSON.parse((await send(`${url}/api/events`)).body.toString()) as EventPage;
    return JSON.parse((await send(`${url}/api/events/${page.events[0]!.id}`)).body.toString()) as WebhookEvent;
  };
  const replay = async (event: WebhookEvent, overrides: Partial<ReplayRequest> = {}) => {
    const request = { ...capturedRequest(event), destinationUrl: `${targetUrl}/echo?item=one&item=two&empty=&name=Jo%C3%A3o`, ...overrides };
    const response = await send(`${url}/api/events/${event.id}/replays`, 'POST', JSON.stringify(request), { 'content-type': 'application/json' });
    assert.equal(response.status, 201, response.body.toString());
    const execution: unknown = JSON.parse(response.body.toString()); assert(isReplay(execution)); return execution;
  };
  return { directory, path, app, url, targetUrl, received, capture, replay };
}

for (const [name, method, body, type] of [
  ['GET', 'GET', '', 'text/plain'], ['POST JSON', 'POST', ' {"plan":"basic"}\r\n', 'application/json'],
  ['texto UTF-8', 'POST', 'Olá, webhook!\r\nline 2\n', 'text/plain; charset=utf-8'],
  ['GET com corpo', 'GET', 'get body', 'text/plain'],
  ['binário', 'POST', Buffer.from([0, 255, 128, 13, 10, 1]), 'application/octet-stream'],
  ['multipart', 'POST', '--x\r\nContent-Disposition: form-data; name="item"\r\n\r\none\r\n--x--\r\n', 'multipart/form-data; boundary=x'],
] as const) test(`replay real preserva ${name}`, async (t) => {
  const f = await fixture(t); const event = await f.capture(body, type, method); const execution = await f.replay(event);
  assert.equal(execution.result.status, 200); assert.equal(execution.result.error, undefined);
  assert.equal(execution.request.method, method); assert.deepEqual(f.received[0]!.body, Buffer.from(body));
  assert.equal(f.received[0]!.url, '/echo?item=one&item=two&empty=&name=Jo%C3%A3o');
  assert.deepEqual(f.received[0]!.headers.filter(([name]) => name.toLowerCase() === 'x-repeat'), [['x-repeat', 'one'], ['x-repeat', 'two']]);
  assert.equal(execution.result.contentType, 'application/json'); assert(execution.result.durationMs >= 0);
  assert.deepEqual(execution.result.headers.filter(([name]) => name.toLowerCase() === 'set-cookie'), [['set-cookie', 'first=1'], ['set-cookie', 'second=2']]);
  assert.equal(execution.result.bodySize, Buffer.from(execution.result.body.data, 'base64').length);
  const page = JSON.parse((await send(`${f.url}/api/events`)).body.toString()) as EventPage; assert.equal(page.events.length, 1);
});

for (const status of [200, 400, 500]) test(`HTTP ${status} é resposta e não erro de transporte`, async (t) => {
  const f = await fixture(t); const event = await f.capture(); const execution = await f.replay(event, { destinationUrl: `${f.targetUrl}/status/${status}` });
  assert.equal(execution.result.status, status); assert.equal(execution.result.error, undefined);
});

test('edição independente, histórico ordenado e pins sobrevivem ao reinício', async (t) => {
  const f = await fixture(t); const original = await f.capture(); const first = await f.replay(original);
  const modified = await f.replay(original, { method: 'PUT', body: { encoding: 'base64', data: utf8Base64('{"plan":"premium","active":true}') }, headers: [['Content-Type', 'application/json'], ['X-Edited', 'yes']] });
  assert.equal(f.received[1]!.method, 'PUT'); assert.equal(f.received[1]!.body.toString(), '{"plan":"premium","active":true}');
  assert.deepEqual(JSON.parse((await send(`${f.url}/api/events/${original.id}`)).body.toString()), original);
  assert.equal((await send(`${f.url}/api/events/${original.id}/pin`, 'PATCH', '{"pinned":true}')).status, 200);
  await f.app.close(); const restarted = createApp({ databasePath: f.path }); t.after(() => restarted.close());
  await restarted.listen({ host: '127.0.0.1', port: 0 }); const addr = restarted.server.address(); assert(addr && typeof addr !== 'string'); const url = `http://127.0.0.1:${addr.port}`;
  const history = JSON.parse((await send(`${url}/api/events/${original.id}/replays`)).body.toString()) as ReplayPage;
  assert.deepEqual(history.executions.map((attempt) => attempt.id), [modified.id, first.id]);
  const recovered = JSON.parse((await send(`${url}/api/replays/${modified.id}`)).body.toString()) as ReplayExecution;
  assert.deepEqual(recovered, modified);
  const pinned = JSON.parse((await send(`${url}/api/events?pinned=1`)).body.toString()) as EventPage; assert.equal(pinned.events[0]?.id, original.id);
  await restarted.close();
});

test('valida URL, método, headers, Base64, limite e timeout sem executar', async (t) => {
  const f = await fixture(t); const event = await f.capture(); const original = capturedRequest(event);
  for (const change of [
    ...['file:///test', 'ftp://localhost/test', '/relative', 'http://user:pass@localhost', 'http://localhost/#secret', 'http://local host'].map((destinationUrl) => ({ destinationUrl })),
    { method: 'CONNECT' }, { method: 'POST\r\nInjected' }, { headers: [['X-Bad', 'bad\r\nInjected: true']] }, { body: { encoding: 'base64', data: '!' } },
    { body: { encoding: 'base64', data: Buffer.alloc(1024 * 1024 + 1).toString('base64') } }, { timeoutMs: 0 }, { timeoutMs: 120001 },
  ]) assert.equal((await send(`${f.url}/api/events/${event.id}/replays`, 'POST', JSON.stringify({ ...original, ...change }))).status, 400);
  assert.equal(f.received.length, 0);
  assert.equal((JSON.parse((await send(`${f.url}/api/events/${event.id}/replays`)).body.toString()) as ReplayPage).executions.length, 0);
});

test('recalcula headers de transporte e remove tokens Connection', async (t) => {
  const f = await fixture(t); const event = await f.capture('body', 'text/plain');
  const execution = await f.replay(event, { headers: [['Host', 'wrong.invalid'], ['Content-Length', '100000'], ['Connection', 'X-Hop'], ['X-Hop', 'remove'], ['Transfer-Encoding', 'chunked'], ['Content-Type', 'text/plain']] });
  assert.deepEqual(execution.request.headers, [['Content-Type', 'text/plain']]);
  assert(f.received[0]!.headers.some(([name, value]) => name.toLowerCase() === 'host' && value === new URL(f.targetUrl).host));
  assert(f.received[0]!.headers.some(([name, value]) => name.toLowerCase() === 'content-length' && value === '4'));
  assert(!f.received[0]!.headers.some(([name]) => name.toLowerCase() === 'x-hop'));
});

test('conexão recusada, timeout e desconexão parcial mantêm a aplicação disponível', async (t) => {
  const f = await fixture(t); const event = await f.capture();
  const closed = createServer(); const closedUrl = await listen(closed); await new Promise<void>((resolve) => closed.close(() => resolve()));
  const refused = await f.replay(event, { destinationUrl: closedUrl }); assert.equal(refused.result.error?.code, 'CONNECTION_REFUSED'); assert.equal(refused.result.status, undefined);
  const timeout = await f.replay(event, { destinationUrl: `${f.targetUrl}/timeout`, timeoutMs: 100 }); assert.equal(timeout.result.error?.code, 'TIMEOUT');
  const headersTimeout = await f.replay(event, { destinationUrl: `${f.targetUrl}/timeout-headers`, timeoutMs: 100 }); assert.equal(headersTimeout.result.status, 201); assert.equal(headersTimeout.result.error?.code, 'TIMEOUT');
  const partial = await f.replay(event, { destinationUrl: `${f.targetUrl}/partial` }); assert.equal(partial.result.status, 202); assert.equal(partial.result.error?.code, 'CONNECTION_TERMINATED');
  assert.equal((await send(`${f.url}/api/health`)).status, 200);
});

test('limita resposta sem perder status e não segue redirects', async (t) => {
  const f = await fixture(t, 64); const event = await f.capture();
  const large = await f.replay(event, { destinationUrl: `${f.targetUrl}/large` }); assert.equal(large.result.status, 200); assert(large.result.truncated); assert.equal(large.result.bodySize, 64); assert.equal(Buffer.from(large.result.body.data, 'base64').length, 64);
  const redirect = await f.replay(event, { destinationUrl: `${f.targetUrl}/redirect` }); assert.equal(redirect.result.status, 302); assert.equal(f.received.length, 2);
});

test('cancelamento deliberado e ID duplicado não provocam reenvios', async (t) => {
  const f = await fixture(t); const event = await f.capture(); const id = randomUUID();
  const payload = JSON.stringify({ ...capturedRequest(event), id, destinationUrl: `${f.targetUrl}/timeout` });
  const pending = send(`${f.url}/api/events/${event.id}/replays`, 'POST', payload);
  for (let i = 0; i < 100 && !f.received.length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.received.length, 1);
  assert.equal((await send(`${f.url}/api/replays/${id}`, 'DELETE')).status, 200);
  const execution = JSON.parse((await pending).body.toString()) as ReplayExecution; assert.equal(execution.result.error?.code, 'CANCELLED');
  assert.equal((await send(`${f.url}/api/events/${event.id}/replays`, 'POST', payload)).status, 409); assert.equal(f.received.length, 1);
});

test('replay direcionado a /hooks é uma captura distinta', async (t) => {
  const f = await fixture(t); const event = await f.capture(); await f.replay(event, { destinationUrl: `${f.url}/hooks/replayed` });
  const page = JSON.parse((await send(`${f.url}/api/events`)).body.toString()) as EventPage;
  assert.equal(page.events.length, 2); assert.notEqual(page.events[0]!.id, event.id); assert.equal(page.events[0]!.path, '/hooks/replayed');
});

test('busca persistida, paginação e filtros combinados retornam apenas resumos', async (t) => {
  const f = await fixture(t); await f.capture('{"customerId":"premium"}'); const target = await f.capture('{"customerId":"premium"}');
  await f.capture('other', 'text/plain', 'PUT');
  for (const text of ['payment', 'customerId', 'premium', 'x-repeat', 'João', 'empty=', 'pr', '"premium"']) {
    const page = JSON.parse((await send(`${f.url}/api/events?search=${encodeURIComponent(text)}`)).body.toString()) as EventPage; assert(page.events.length > 0, text); assert(!JSON.stringify(page).includes('rawBody'));
  }
  const first = JSON.parse((await send(`${f.url}/api/events?search=premium&method=POST&status=200&path=payment&contentType=json&limit=1`)).body.toString()) as EventPage;
  assert.equal(first.events[0]!.id, target.id); assert(first.nextCursor);
  const second = JSON.parse((await send(`${f.url}/api/events?search=premium&method=POST&limit=1&cursor=${first.nextCursor}`)).body.toString()) as EventPage;
  assert.equal(second.events.length, 1); assert.notEqual(second.events[0]!.id, target.id);
  assert.equal((await send(`${f.url}/api/events?from=bad`)).status, 400);
  assert.equal((JSON.parse((await send(`${f.url}/api/events?from=2099-01-01T00:00:00Z`)).body.toString()) as EventPage).events.length, 0);
});

test('migração indexa eventos da Etapa 1 e marca tentativas interrompidas', async (t) => {
  const f = await fixture(t); const event = await f.capture('{"legacy":"find-me"}'); await f.app.close();
  const db = new DatabaseSync(f.path); db.exec('DROP TABLE event_index; DROP TABLE events_search;');
  const execution = { id: randomUUID(), sequence: 1, sourceEventId: event.id, executedAt: new Date().toISOString(), state: 'running', request: { ...capturedRequest(event), bodySize: event.bodySize }, result: { durationMs: 0, headers: [], contentType: null, body: { encoding: 'base64', data: '' }, bodySize: 0, receivedSize: 0, truncated: false } };
  db.prepare('INSERT INTO replays(id, source_event_id, execution) VALUES (?, ?, ?)').run(execution.id, event.id, JSON.stringify(execution)); db.close();
  const store = new EventStore(f.path);
  try {
    assert.equal(store.list(50, undefined, { search: 'find-me' }).events[0]?.id, event.id);
    assert.equal(store.getReplay(execution.id)?.result.error?.code, 'INTERRUPTED');
    assert.deepEqual(store.get(event.id)?.rawBody, event.rawBody);
  } finally { store.close(); }
});

test('query repetida, valores vazios, encoding e corpo opaco não são corrompidos', () => {
  const entries: Header[] = [['item', 'a&b'], ['item', "' $()`"], ['', ''], ['name', 'João']];
  assert.deepEqual(queryPairs(withQuery('http://localhost:3000/path?old=1', entries)), entries);
  assert.throws(() => destination('javascript:alert(1)')); assert.throws(() => destination('http://user:pass@localhost'));
  assert.equal(editableText({ encoding: 'base64', data: utf8Base64('Olá\r\n') }, [['Content-Type', 'text/plain']]), 'Olá\r\n');
  for (const type of ['multipart/form-data; boundary=x', 'application/octet-stream', 'text/plain; charset=iso-8859-1']) assert.equal(editableText({ encoding: 'base64', data: 'YQ==' }, [['Content-Type', type]]), null);
  assert.deepEqual(replayHeaders([['Connection', 'X-Hop'], ['X-Hop', 'no'], ['X-Repeat', 'a'], ['X-Repeat', 'b']]), [['X-Repeat', 'a'], ['X-Repeat', 'b']]);
  assert.throws(() => validateReplay({}, 100));
});

async function child(executable: string, args: string[]) {
  const proc = spawn(executable, args, { windowsHide: true });
  let stderr = ''; proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  proc.stdout.resume();
  const [code] = await once(proc, 'close'); assert.equal(code, 0, stderr);
}

for (const shell of ['powershell', 'posix'] as const) test(`cURL ${shell}: comando executado preserva bytes e escaping sem executar conteúdo`, async (t) => {
  const executable = shell === 'powershell' ? (process.platform === 'win32' ? 'powershell.exe' : 'pwsh') : (process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash');
  if (process.platform !== 'win32' && shell === 'powershell') { t.skip('Integração PowerShell validada no Windows.'); return; }
  if (process.platform === 'win32' && shell === 'posix') {
    try { await access(executable); } catch { t.skip('Git Bash não está instalado.'); return; }
  }
  const f = await fixture(t); const event = await f.capture();
  const marker = join(f.directory, 'must-not-exist');
  const body = Buffer.concat([Buffer.from(`Olá\r\n' " $() \x60 & ; $(touch '${marker}')\n`), Buffer.from([0, 255, 128])]);
  const request: ReplayRequest = { ...capturedRequest(event), destinationUrl: withQuery(`${f.targetUrl}/echo`, [['item', "'\"$()`&"], ['item', ''], ['name', 'João']]), headers: [['Content-Type', 'application/octet-stream'], ['X-Special', "'\"$()`&\\"], ['Authorization', 'Bearer test-canary'], ['X-Latin', 'João'], ['X-Empty', ''], ['X-Repeat', 'one'], ['X-Repeat', 'two']], body: { encoding: 'base64', data: body.toString('base64') } };
  const excluded = curlCommand(request, shell); assert(!excluded.includes('test-canary'));
  const command = curlCommand(request, shell, true); assert(command.includes('test-canary'));
  if (shell === 'powershell') {
    const file = join(f.directory, 'curl.ps1'); await writeFile(file, '\ufeff' + command);
    await child(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file]);
  } else await child(executable, ['-c', command]);
  assert.deepEqual(f.received[0]!.body, body);
  assert.deepEqual(queryPairs(`http://localhost${f.received[0]!.url}`), queryPairs(request.destinationUrl));
  assert(f.received[0]!.headers.some(([name, value]) => name.toLowerCase() === 'x-special' && value === "'\"$()`&\\"));
  assert(f.received[0]!.headers.some(([name, value]) => name.toLowerCase() === 'authorization' && value === 'Bearer test-canary'));
  assert(f.received[0]!.headers.some(([name, value]) => name.toLowerCase() === 'x-latin' && value === 'João'));
  assert(f.received[0]!.headers.some(([name, value]) => name.toLowerCase() === 'x-empty' && value === ''));
  assert.deepEqual(f.received[0]!.headers.filter(([name]) => name.toLowerCase() === 'x-repeat'), [['X-Repeat', 'one'], ['X-Repeat', 'two']]);
  await assert.rejects(access(marker));
  const emptyCommand = curlCommand({ ...request, method: 'GET', headers: [], body: { encoding: 'base64', data: '' } }, shell);
  if (shell === 'powershell') {
    const file = join(f.directory, 'empty.ps1'); await writeFile(file, '\ufeff' + emptyCommand);
    await child(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file]);
  } else await child(executable, ['-c', emptyCommand]);
  assert.equal(f.received[1]!.method, 'GET'); assert.equal(f.received[1]!.body.length, 0);
});

test('cURL vazio mantém método e evita adicionar corpo artificial', () => {
  const request: ReplayRequest = { destinationUrl: 'http://localhost/test', method: 'GET', headers: [], body: { encoding: 'base64', data: '' }, timeoutMs: 1000 };
  assert(!curlCommand(request, 'posix').includes('--data'));
  assert(!curlCommand(request, 'powershell').includes('data-binary ='));
});

test('AbortSignal já cancelado não envia uma requisição', async () => {
  const result = await executeReplay({ destinationUrl: 'http://127.0.0.1:1', method: 'GET', headers: [], body: { encoding: 'base64', data: '' }, timeoutMs: 1000 }, AbortSignal.abort(), 64);
  assert.equal(result.error?.code, 'CANCELLED');
});

test('falha DNS é distinguida sem usar serviços externos', async (t) => {
  const f = await fixture(t); const event = await f.capture();
  t.mock.method(dns, 'lookup', (_name: string, _options: unknown, callback: (error: Error) => void) => {
    callback(Object.assign(new Error('test DNS failure'), { code: 'ENOTFOUND' }));
  });
  const execution = await f.replay(event, { destinationUrl: 'http://unresolvable.invalid/test' });
  assert.equal(execution.result.error?.code, 'DNS_FAILURE'); assert.equal(execution.result.status, undefined);
  assert(!JSON.stringify(execution.result).includes('test DNS failure'));
});

test('busca em milhares de eventos continua limitada e não retorna corpos', async (t) => {
  const f = await fixture(t); const original = await f.capture(); await f.app.close();
  const store = new EventStore(f.path);
  try {
    const body = Buffer.from('{"customerId":"needle-premium"}');
    const { sequence: _sequence, rawBody: _rawBody, ...metadata } = original;
    void _sequence; void _rawBody;
    for (let index = 0; index < 2500; index++) store.create({ ...metadata, id: randomUUID(), bodySize: body.length }, body, performance.now());
    const start = performance.now();
    const page = store.list(50, undefined, { search: 'needle-premium', method: 'POST', status: '200' });
    assert.equal(page.events.length, 50); assert(page.nextCursor); assert(performance.now() - start < 2000);
    assert(!JSON.stringify(page).includes('rawBody')); assert(!JSON.stringify(page).includes('needle-premium'));
  } finally { store.close(); }
});

test('histórico paginado mantém ordem, resumos leves e associação com o original', async (t) => {
  const f = await fixture(t); const event = await f.capture();
  const ids: string[] = [];
  for (let attempt = 0; attempt < 27; attempt++) ids.unshift((await f.replay(event)).id);
  const first = JSON.parse((await send(`${f.url}/api/events/${event.id}/replays`)).body.toString()) as ReplayPage;
  assert.equal(first.executions.length, 25); assert(first.nextCursor); assert(!JSON.stringify(first).includes('base64'));
  const second = JSON.parse((await send(`${f.url}/api/events/${event.id}/replays?cursor=${first.nextCursor}`)).body.toString()) as ReplayPage;
  assert.deepEqual([...first.executions, ...second.executions].map((item) => item.id), ids); assert.equal(second.nextCursor, null);
  assert(first.executions.every((item) => item.sourceEventId === event.id));
});

test('erro de armazenamento após envio informa resultado incerto e não reenvia', async (t) => {
  const f = await fixture(t); const event = await f.capture();
  const db = new DatabaseSync(f.path);
  db.exec("CREATE TRIGGER fail_replay_save BEFORE UPDATE ON replays WHEN json_extract(NEW.execution, '$.state') = 'completed' BEGIN SELECT RAISE(ABORT, 'private-storage-error'); END;");
  try {
    const response = await send(`${f.url}/api/events/${event.id}/replays`, 'POST', JSON.stringify({ ...capturedRequest(event), destinationUrl: `${f.targetUrl}/echo` }));
    assert.equal(response.status, 503); assert.equal(f.received.length, 1);
    assert.equal((JSON.parse(response.body.toString()) as { error: { code: string } }).error.code, 'EXECUTION_NOT_SAVED');
    assert(!response.body.toString().includes('private-storage-error'));
    const history = JSON.parse((await send(`${f.url}/api/events/${event.id}/replays`)).body.toString()) as ReplayPage;
    assert.equal(history.executions.length, 1); assert.equal((await send(`${f.url}/api/health`)).status, 200);
  } finally { db.close(); }
});

for (const [name, initial, edited, type] of [
  ['JSON editado ao reabrir Replay', '{"userId":123,"plan":"basic"}', '{"userId":123,"plan":"premium","active":true}', 'application/json'],
  ['corpo explicitamente vazio', '{"plan":"basic"}', '', 'application/json'],
  ['texto editado', 'original text\r\n', 'Olá, texto editado!\r\nlinha 2\n', 'text/plain; charset=utf-8'],
] as const) test(`rascunho do editor envia ${name} e persiste os bytes reais`, async (t) => {
  const f = await fixture(t); const event = await f.capture(initial, type);
  const original = capturedRequest(event);
  let editor = openReplayEditor(initialState(event), true);
  editor = { ...editor, text: edited, request: { ...editor.request, destinationUrl: `${f.targetUrl}/echo` } };
  editor = openReplayEditor(editor, false);
  const request = editorRequest(editor, original);
  const execution = await f.replay(event, request);
  assert.deepEqual(f.received[0]!.body, Buffer.from(edited));
  assert.equal(execution.request.body.data, Buffer.from(edited).toString('base64'));
  assert.equal(execution.request.bodySize, Buffer.byteLength(edited));
  assert.deepEqual(JSON.parse((await send(`${f.url}/api/events/${event.id}`)).body.toString()), event);
  await f.app.close();
  const restarted = createApp({ databasePath: f.path });
  try {
    await restarted.ready();
    const recovered = await restarted.inject(`/api/replays/${execution.id}`);
    assert.equal(recovered.statusCode, 200);
    assert.deepEqual((JSON.parse(recovered.body) as ReplayExecution).request, execution.request);
  } finally { await restarted.close(); }
});

test('rascunho preserva headers editados, desativados e repetidos ao reabrir Replay', async (t) => {
  const f = await fixture(t); const event = await f.capture();
  let editor = openReplayEditor(initialState(event), true);
  editor = { ...editor, headers: [
    { name: 'Content-Type', value: 'text/plain; charset=utf-8', enabled: true },
    { name: 'x-TEST', value: 'WeebhookLab', enabled: true },
    { name: 'X-Disabled', value: 'do-not-send', enabled: false },
    { name: 'X-Repeat', value: 'edited-one', enabled: true },
    { name: 'x-repeat', value: 'edited-two', enabled: true },
    { name: 'Host', value: 'wrong.invalid', enabled: true },
    { name: 'Content-Length', value: '100000', enabled: true },
  ], text: 'edited text', request: { ...editor.request, destinationUrl: `${f.targetUrl}/echo` } };
  const request = editorRequest(openReplayEditor(editor, false), capturedRequest(event));
  const execution = await f.replay(event, request);
  const headers = f.received[0]!.headers;
  assert(headers.some(([name, value]) => name.toLowerCase() === 'x-test' && value === 'WeebhookLab'));
  assert(!headers.some(([name]) => name.toLowerCase() === 'x-disabled'));
  assert(headers.some(([name, value]) => name.toLowerCase() === 'content-type' && value === 'text/plain; charset=utf-8'));
  assert(headers.some(([name, value]) => name.toLowerCase() === 'content-length' && value === String(Buffer.byteLength('edited text'))));
  assert.deepEqual(headers.filter(([name]) => name.toLowerCase() === 'x-repeat'), [['X-Repeat', 'edited-one'], ['x-repeat', 'edited-two']]);
  assert(!execution.request.headers.some(([name]) => ['host', 'content-length'].includes(name.toLowerCase())));
});

test('rascunho sincroniza URL e query incluindo remoção, duplicatas e caracteres especiais', async (t) => {
  const f = await fixture(t); const event = await f.capture();
  let editor = openReplayEditor(initialState(event), true);
  const added: Header[] = [['mode', 'debug'], ['version', '1'], ['remove', 'yes'], ['empty', ''], ['tag', 'one'], ['tag', 'João & premium']];
  let url = withQuery(`${f.targetUrl}/echo?old=discard`, added);
  url = withQuery(url, queryPairs(url).filter(([name]) => name !== 'remove').map(([name, value]) => [name, name === 'version' ? '2' : value]));
  editor = { ...editor, request: { ...editor.request, destinationUrl: url } };
  const execution = await f.replay(event, editorRequest(openReplayEditor(editor, false), capturedRequest(event)));
  assert.equal(f.received[0]!.url, '/echo?mode=debug&version=2&empty=&tag=one&tag=Jo%C3%A3o+%26+premium');
  assert.equal(execution.request.destinationUrl, url);
});

test('rascunho editado com HTTP 500 mantém resposta, corpo enviado e histórico', async (t) => {
  const f = await fixture(t); const event = await f.capture();
  let editor = openReplayEditor(initialState(event), true);
  editor = { ...editor, text: '{"plan":"premium"}', request: { ...editor.request, destinationUrl: `${f.targetUrl}/status/500` } };
  const execution = await f.replay(event, editorRequest(openReplayEditor(editor, false), capturedRequest(event)));
  assert.equal(execution.result.status, 500); assert.equal(execution.result.error, undefined);
  assert.equal(f.received[0]!.body.toString(), '{"plan":"premium"}');
  assert(execution.result.durationMs >= 0); assert(execution.result.bodySize > 0);
  const history = JSON.parse((await send(`${f.url}/api/events/${event.id}/replays`)).body.toString()) as ReplayPage;
  assert.equal(history.executions[0]!.status, 500); assert.equal(history.executions[0]!.error, undefined);
  assert.equal((await send(`${f.url}/api/health`)).status, 200);
});

test('Replay sem edição e Usar original explícito preservam a requisição original', async (t) => {
  const f = await fixture(t); const event = await f.capture(' {"plan":"basic"}\r\n');
  const original = capturedRequest(event);
  let editor = openReplayEditor(initialState(event), false);
  editor = { ...editor, request: { ...editor.request, destinationUrl: `${f.targetUrl}/echo` } };
  await f.replay(event, editorRequest(editor, original));
  editor = { ...openReplayEditor(editor, true), text: '{"plan":"premium"}' };
  editor = { ...editor, edit: false };
  await f.replay(event, editorRequest(openReplayEditor(editor, false), original));
  assert(f.received.every((attempt) => attempt.body.equals(Buffer.from(original.body.data, 'base64'))));
  assert.deepEqual(JSON.parse((await send(`${f.url}/api/events/${event.id}`)).body.toString()), event);
});
