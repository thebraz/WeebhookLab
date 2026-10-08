import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArguments, dataDirectory } from '../src/server/cli.js';
import { createApp } from '../src/server/app.js';
import { EventStore } from '../src/server/store.js';
import { redactBody, MASK } from '../src/shared/redaction.js';
import { redactExport } from '../src/server/workspaces.js';
import { DEFAULT_WORKSPACE, type Workspace, type WorkspaceExport } from '../src/shared/workspaces.js';
import type { EventPage, WebhookEvent } from '../src/shared/contracts.js';
import { inspectPayload } from '../src/web/payload.js';
import { diffJson } from '../src/shared/diff.js';

test('CLI: opções essenciais, portas, hosts, nomes e localização independente do cwd', () => {
  assert.equal(parseArguments([]).host, '127.0.0.1');
  assert.deepEqual(parseArguments(['--port', '8080', '--host', '0.0.0.0', '--no-open', '--workspace', 'projeto']),
    { port: 8080, host: '0.0.0.0', open: false, workspace: 'projeto', help: false, version: false });
  assert(parseArguments(['--help']).help); assert(parseArguments(['--version']).version);
  for (const value of ['0', '65536', '-1', '1.5', 'abc', '8080x']) assert.throws(() => parseArguments(['--port', value]));
  for (const args of [['--port'], ['--host', 'https://example.test'], ['--workspace', ' '], ['--unknown']]) assert.throws(() => parseArguments(args));
  assert.equal(dataDirectory('win32', { LOCALAPPDATA: 'local' }, 'home'), join('local', 'WeebhookLab'));
  assert.equal(dataDirectory('linux', { XDG_DATA_HOME: 'local' }, 'home'), join('local', 'weebhooklab'));
  assert.equal(dataDirectory('darwin', {}, 'home'), join('home', 'Library', 'Application Support', 'WeebhookLab'));
});

test('exportação mascara formulários codificados e valores abaixo de caminhos sensíveis', () => {
  const form = { encoding: 'base64' as const, data: Buffer.from('%74oken=release-canary&token=second-canary&plan=basic&plan=premium').toString('base64') };
  const original = form.data;
  const clean = Buffer.from(redactBody(form, [['Content-Type', 'application/x-www-form-urlencoded']]).data, 'base64').toString();
  assert(!clean.includes('canary')); assert.deepEqual(new URLSearchParams(clean).getAll('plan'), ['basic', 'premium']); assert.equal(form.data, original);
  const file: WorkspaceExport = { format: 'weebhooklab-workspace', version: 1, redacted: false, exportedAt: new Date().toISOString(),
    workspace: { id: DEFAULT_WORKSPACE, name: 'local', createdAt: new Date().toISOString() }, requests: [], mocks: [], bindings: [], events: [], replays: [],
    transformations: [{ id: randomUUID(), name: 'teste', operations: [{ id: '1', enabled: true, type: 'set', path: '$.signing_secret.value', value: 'release-canary' }] }] };
  assert.equal(redactExport(file).transformations[0]!.operations[0]!.value, MASK);
  assert.equal(file.transformations[0]!.operations[0]!.value, 'release-canary');
});

test('JSON de replay inválido não expõe o conteúdo recebido na mensagem de erro', async (t) => {
  const app = createApp({ databasePath: ':memory:' }); t.after(() => app.close());
  await app.inject({ method: 'POST', url: '/hooks/test', payload: '{}' });
  const event = (await app.inject('/api/events')).json<EventPage>().events[0]!;
  const response = await app.inject({ method: 'POST', url: `/api/events/${event.id}/replays`, payload: 'secret-release-canary-invalid-json' });
  assert.equal(response.statusCode, 400); assert(!response.body.includes('canary')); assert.equal(response.json<{ error: { message: string } }>().error.message, 'Invalid JSON.');
});

test('configuração persistida inválida é recusada sem executar, apagar ou expor o registro', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'weebhooklab-invalid-record-')); const path = join(directory, 'events.sqlite');
  const app = createApp({ databasePath: path }); const db = new DatabaseSync(path);
  t.after(async () => { db.close(); await app.close(); assert.equal(dirname(directory), tmpdir()); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const id = randomUUID();
  await app.inject({ method: 'PUT', url: `/api/mocks/${id}`, payload: { name: 'teste', response: { status: 500, headers: [], body: '', delayMs: 0, maxDelayMs: 0 } } });
  await app.inject({ method: 'PUT', url: `/api/bindings/${randomUUID()}`, payload: { path: '/hooks/corrupt', profileId: id } });
  db.prepare('UPDATE workspace_documents SET data = ? WHERE id = ?').run('secret-corruption-canary', id);
  for (const url of ['/api/configuration', '/hooks/corrupt']) {
    const response = await app.inject(url); assert.equal(response.statusCode, 503); assert(!response.body.includes('canary')); assert(response.body.includes('preserved'));
  }
  assert.equal(db.prepare('SELECT data FROM workspace_documents WHERE id = ?').get(id)?.data, 'secret-corruption-canary');
  assert.equal((await app.inject('/api/events')).json<EventPage>().events.length, 0);
  assert.equal((await app.inject('/api/health')).statusCode, 200);
});

test('SSE isola workspaces e encerra conexões durante shutdown', async (t) => {
  const app = createApp({ databasePath: ':memory:' }); await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address(); assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const other = (await app.inject({ method: 'POST', url: '/api/workspaces', payload: { name: 'outro' } })).json<Workspace>();
  const abort = new AbortController(); t.after(async () => { abort.abort(); await app.close(); });
  const subscribe = async (workspace: string) => {
    const response = await fetch(`${url}/api/events/stream?workspace=${workspace}`, { signal: abort.signal }); assert.equal(response.status, 200);
    const reader = response.body!.getReader(); assert(Buffer.from((await reader.read()).value!).toString().includes('ready')); return reader;
  };
  const local = await subscribe(DEFAULT_WORKSPACE); const remote = await subscribe(other.id);
  await app.inject({ method: 'POST', url: '/hooks/local', payload: '{}' });
  assert(Buffer.from((await local.read()).value!).toString().includes('/hooks/local'));
  await app.inject({ method: 'PUT', url: `/api/workspaces/${other.id}/active` });
  await app.inject({ method: 'POST', url: '/hooks/other', payload: '{}' });
  const message = Buffer.from((await remote.read()).value!).toString(); assert(message.includes('/hooks/other')); assert(!message.includes('/hooks/local'));
  await app.close(); assert((await local.read()).done); assert((await remote.read()).done);
});

test('Host selecionado é explícito e origens externas ou credenciais em Host são recusadas', async (t) => {
  const local = createApp({ databasePath: ':memory:' }); const selected = createApp({ databasePath: ':memory:', allowedHost: '192.0.2.1' });
  t.after(async () => { await local.close(); await selected.close(); });
  assert.equal((await local.inject({ url: '/api/health', headers: { host: '192.0.2.1:5050' } })).statusCode, 403);
  assert.equal((await selected.inject({ url: '/api/health', headers: { host: '192.0.2.1:5050', origin: 'http://192.0.2.1:5050' } })).statusCode, 200);
  assert.equal((await selected.inject({ url: '/api/health', headers: { host: '192.0.2.1:5050', origin: 'http://evil.test:5050' } })).statusCode, 403);
  assert.equal((await local.inject({ url: '/api/health', headers: { host: 'secret@127.0.0.1:5050' } })).statusCode, 403);
});

test('shutdown cancela mocks e dez replays, preserva resultados e limita concorrência', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'weebhooklab-shutdown-')); const path = join(directory, 'events.sqlite');
  const app = createApp({ databasePath: path }); let delayed = 0;
  app.addHook('preHandler', async (request) => { if (request.url === '/hooks/delay') delayed++; });
  await app.listen({ host: '127.0.0.1', port: 0 }); const address = app.server.address(); assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); assert.equal(dirname(directory), tmpdir()); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await app.inject({ method: 'POST', url: '/hooks/source', payload: '{}' }); const source = (await app.inject('/api/events')).json<EventPage>().events[0]!;
  const id = randomUUID(); await app.inject({ method: 'PUT', url: `/api/mocks/${id}`, payload: { name: 'slow', response: { status: 500, body: '', headers: [], delayMs: 10000, maxDelayMs: 10000 } } });
  await app.inject({ method: 'PUT', url: `/api/bindings/${randomUUID()}`, payload: { path: '/hooks/delay', profileId: id } });
  const request = { method: 'POST', destinationUrl: `${url}/hooks/delay`, body: { encoding: 'base64', data: '' }, headers: [], timeoutMs: 12000 };
  const executions = Array.from({ length: 10 }, () => app.inject({ method: 'POST', url: `/api/events/${source.id}/replays`, payload: request }));
  const pendingMock = fetch(`${url}/hooks/delay`, { method: 'POST' });
  for (let attempt = 0; delayed < 11 && attempt < 100; attempt++) await delay(20);
  assert.equal(delayed, 11);
  assert.equal((await app.inject({ method: 'POST', url: `/api/events/${source.id}/replays`, payload: request })).statusCode, 429);
  const started = performance.now(); await app.close(); assert(performance.now() - started < 5000);
  assert.equal((await pendingMock).status, 503);
  for (const execution of await Promise.all(executions)) { assert.equal(execution.statusCode, 201); assert.equal(execution.json<{ result: { error: { code: string } } }>().result.error.code, 'CANCELLED'); }
  const reopened = new EventStore(path);
  try { assert.equal(reopened.list(50).events.length, 1); assert.equal(reopened.listReplays(source.id, 25).executions.length, 10); assert(reopened.listReplays(source.id, 25).executions.every((r) => r.state === 'completed' && r.error?.code === 'CANCELLED')); }
  finally { reopened.close(); }
});

test('limite: inspeciona 1 KB, 100 KB e 1 MB; rejeita 5 MB sem persistir', async (t) => {
  const app = createApp({ databasePath: ':memory:' }); t.after(() => app.close());
  for (const size of [1024, 100 * 1024, 1024 * 1024]) {
    const body = JSON.stringify({ data: 'x'.repeat(size - 11) }); assert.equal(Buffer.byteLength(body), size);
    assert.equal((await app.inject({ method: 'POST', url: '/hooks/size', headers: { 'content-type': 'application/json' }, payload: body })).statusCode, 200);
    const summary = (await app.inject('/api/events')).json<EventPage>().events[0]!;
    const event = (await app.inject(`/api/events/${summary.id}`)).json<WebhookEvent>();
    const started = performance.now(); const view = await inspectPayload(event); assert.equal(view.kind, 'json');
    t.diagnostic(`Inspector ${size} bytes: ${(performance.now() - started).toFixed(1)} ms`);
    assert.equal(Buffer.from(event.rawBody.data, 'base64').toString(), body);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/hooks/size', payload: 'x'.repeat(5 * 1024 * 1024) })).statusCode, 413);
  assert.equal((await app.inject('/api/events')).json<EventPage>().events.length, 3);
  const nested = '['.repeat(1000) + '1' + ']'.repeat(1000);
  await app.inject({ method: 'POST', url: '/hooks/deep', headers: { 'content-type': 'application/json' }, payload: nested });
  const last = (await app.inject('/api/events')).json<EventPage>().events[0]!;
  assert.equal((await inspectPayload((await app.inject(`/api/events/${last.id}`)).json<WebhookEvent>())).kind, 'limited-json');
  assert(diffJson({ values: Array(20_001).fill(1) }, {}).notices.length);
});

test('100, 1000 e 10000 eventos: páginas e pesquisa limitadas, seleção sem carregar todos os corpos', (t) => {
  const store = new EventStore(':memory:'); t.after(() => store.close());
  const body = Buffer.from(JSON.stringify({ data: 'x'.repeat(990), marker: 'profile-marker' }));
  for (let i = 1; i <= 10_000; i++) {
    store.create({ id: randomUUID(), method: 'POST', path: '/hooks/profile', requestTarget: '/hooks/profile', httpVersion: '1.1', headers: [['Content-Type', 'application/json']], query: {},
      contentType: 'application/json', contentEncoding: null, userAgent: null, sourceIp: null, receivedAt: new Date().toISOString(), bodySize: body.length, responseStatus: 200, durationMs: 0,
      response: { headers: [], body: '{}' } }, body, performance.now());
    if ([100, 1000, 10_000].includes(i)) {
      const started = performance.now(); const page = store.list(50); assert.equal(page.events.length, 50); assert(page.nextCursor); assert(JSON.stringify(page).length < 40_000);
      assert(store.get(page.events[0]!.id)); assert.equal(store.list(50, undefined, { search: 'profile-marker', method: 'POST' }).events.length, 50);
      assert.equal(store.list(50, undefined, { search: 'missing-marker' }).events.length, 0);
      t.diagnostic(`${i} eventos / página + detalhe + busca + filtro: ${(performance.now() - started).toFixed(1)} ms`);
    }
  }
});
