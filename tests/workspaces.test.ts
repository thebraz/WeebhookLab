import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server/app.js';
import { EventStore } from '../src/server/store.js';
import { compareEvents, compareRequests, compareResponses } from '../src/shared/diff.js';
import { formatPath, transform, type TransformOperation } from '../src/shared/json.js';
import { capturedRequest, utf8Base64 } from '../src/shared/replay.js';
import { DEFAULT_WORKSPACE, type MockProfile, type SavedRequest, type Workspace, type WorkspaceConfiguration, type WorkspaceExport } from '../src/shared/workspaces.js';
import type { EventPage, ReplayExecution, ReplayPage, WebhookEvent } from '../src/shared/contracts.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'weebhooklab-stage3-')); const path = join(directory, 'events.sqlite');
  const app = createApp({ databasePath: path }); await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address(); assert(address && typeof address !== 'string'); const url = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); assert.equal(dirname(directory), tmpdir()); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const api = (route: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' = 'GET', value?: unknown, workspaceId = DEFAULT_WORKSPACE) => app.inject({ url: route, method, headers: { 'x-workspace-id': workspaceId, ...(value === undefined ? {} : { 'content-type': 'application/json' }) }, ...(value === undefined ? {} : { payload: JSON.stringify(value) }) });
  const capture = async (body: string, endpoint = '/hooks/payment') => { const response = await app.inject({ url: endpoint, method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 'secret-signature-canary', authorization: 'Bearer secret-auth-canary' }, payload: body });
    assert(response.statusCode >= 200); return response; };
  const latest = async (workspaceId = DEFAULT_WORKSPACE) => { const page = (await api('/api/events', 'GET', undefined, workspaceId)).json<EventPage>(); return (await api(`/api/events/${page.events[0]!.id}`, 'GET', undefined, workspaceId)).json<WebhookEvent>(); };
  const mock = async (status = 500, delayMs = 0, endpoint = '/hooks/payment') => {
    const profile: MockProfile = { id: randomUUID(), name: 'Test response', response: { status, headers: [['Content-Type', 'application/json'], ['X-Mock', 'yes'], ['Set-Cookie', 'secret-cookie-canary']], body: '{"token":"secret-body-canary","received":false}', delayMs, maxDelayMs: delayMs } };
    assert.equal((await api(`/api/mocks/${profile.id}`, 'PUT', profile)).statusCode, 200);
    const bindingId = randomUUID(); assert.equal((await api(`/api/bindings/${bindingId}`, 'PUT', { path: endpoint, profileId: profile.id })).statusCode, 200);
    return { profile, bindingId };
  };
  return { app, path, url, api, capture, latest, mock };
}

test('etapa 3: fluxo completo HTTP, diff, transformação, mocks, salvo, isolamento e reinício', async (t) => {
  const f = await fixture(t);
  const originalText = JSON.stringify({ id: 'evt_1', object: 'event', type: 'invoice.paid', data: { object: { customer: { plan: 'basic' } } }, metadata: { debug: true }, user_id: 42, token: 'secret-json-canary' });
  assert.equal((await f.capture(originalText)).statusCode, 200); const a = await f.latest();
  await f.capture(originalText.replace('basic', 'premium')); const b = await f.latest();
  assert(compareEvents(a, b).changes.some((c) => c.path === '$.body.data.object.customer.plan'));
  assert.equal(a.provider?.provider, 'stripe'); assert.equal(a.provider?.eventType, 'invoice.paid'); assert.equal(a.provider?.signatureVerified, false);
  assert.equal(formatPath(['data', 'object', 'customer', 'plan']), '$.data.object.customer.plan');
  const operations: TransformOperation[] = [
    { id: 'set-plan', enabled: true, type: 'set', path: '$.data.object.customer.plan', value: 'enterprise' },
    { id: 'remove-debug', enabled: true, type: 'delete', path: 'metadata.debug' },
    { id: 'rename-user', enabled: true, type: 'rename', path: 'user_id', name: 'userId' },
  ];
  const transformed = transform(JSON.parse(originalText), operations); assert.equal(transformed.error, undefined);
  const profileId = randomUUID(); assert.equal((await f.api(`/api/transformations/${profileId}`, 'PUT', { name: 'Upgrade', operations })).statusCode, 200);
  const request = { ...capturedRequest(a), destinationUrl: `${f.url}/hooks/replayed?item=one&item=two` };
  const first = (await f.api(`/api/events/${a.id}/replays`, 'POST', { ...request, id: randomUUID() })).json<ReplayExecution>(); assert.equal(first.result.status, 200);
  const edited = { ...request, body: { encoding: 'base64' as const, data: utf8Base64(JSON.stringify(transformed.value)) } };
  const secondResponse = await f.api(`/api/events/${a.id}/replays`, 'POST', { ...edited, id: randomUUID() }); assert.equal(secondResponse.statusCode, 201);
  const second = secondResponse.json<ReplayExecution>(); assert.equal(second.sourceEventId, a.id);
  assert(compareRequests(first.request, second.request).changes.some((c) => c.path === '$.body.data.object.customer.plan'));
  assert.equal(Buffer.from((await f.latest()).rawBody.data, 'base64').toString(), JSON.stringify(transformed.value));
  assert.equal(Buffer.from((await f.api(`/api/events/${a.id}`)).json<WebhookEvent>().rawBody.data, 'base64').toString(), originalText);
  const { profile } = await f.mock(500, 0); const failed = await fetch(`${f.url}/hooks/payment?source=test`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  assert.equal(failed.status, 500); assert.equal(failed.headers.get('x-mock'), 'yes'); assert.equal(await failed.text(), profile.response.body);
  const mocked = await f.latest(); assert.equal(mocked.responseStatus, 500); assert.equal(mocked.response.body, profile.response.body);
  const third = (await f.api(`/api/events/${a.id}/replays`, 'POST', { ...edited, destinationUrl: `${f.url}/hooks/payment`, id: randomUUID() })).json<ReplayExecution>();
  assert.equal(third.result.status, 500); assert.equal(compareResponses(first.result, third.result).changes.find((c) => c.path === '$.status')?.current, 500);
  const delayed = { ...profile, response: { ...profile.response, status: 200, delayMs: 70, maxDelayMs: 70 } };
  assert.equal((await f.api(`/api/mocks/${profile.id}`, 'PUT', delayed)).statusCode, 200);
  const start = performance.now(); const slow = await fetch(`${f.url}/hooks/payment`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }); await slow.text();
  assert.equal(slow.status, 200); assert(performance.now() - start >= 60); assert((await f.latest()).durationMs >= 60);
  const saved: SavedRequest = { id: randomUUID(), name: 'Reusable Payment', request: edited };
  assert.equal((await f.api(`/api/requests/${saved.id}`, 'PUT', saved)).statusCode, 200);
  const savedExecutionResponse = await f.api(`/api/requests/${saved.id}/replays`, 'POST', { id: randomUUID() }); assert.equal(savedExecutionResponse.statusCode, 201);
  const savedExecution = savedExecutionResponse.json<ReplayExecution>(); assert.equal(savedExecution.sourceEventId, null); assert.equal(savedExecution.savedRequestId, saved.id); assert.equal(savedExecution.result.status, 200);
  assert.equal((await f.api(`/api/requests/${saved.id}/replays`)).json<ReplayPage>().executions[0]?.id, savedExecution.id);
  const workspaceResponse = await f.api('/api/workspaces', 'POST', { name: 'Another project' }); assert.equal(workspaceResponse.statusCode, 201); const other = workspaceResponse.json<Workspace>();
  assert.equal((await f.api(`/api/workspaces/${other.id}/active`, 'PUT')).statusCode, 200);
  assert.equal((await f.api('/api/events', 'GET', undefined, other.id)).json<EventPage>().events.length, 0);
  assert.equal((await f.api(`/api/events/${a.id}`, 'GET', undefined, other.id)).statusCode, 404);
  assert.equal((await f.api(`/api/replays/${first.id}`, 'GET', undefined, other.id)).statusCode, 404);
  assert.equal((await f.api(`/api/requests/${saved.id}/replays`, 'POST', {}, other.id)).statusCode, 404);
  assert.equal((await f.api('/api/configuration', 'GET', undefined, other.id)).json<WorkspaceConfiguration>().requests.length, 0);
  await f.capture('{}'); const otherEvent = await f.latest(other.id); assert.equal(otherEvent.workspaceId, other.id); assert.equal(otherEvent.responseStatus, 200);
  const raw = (await f.api('/api/workspaces/export?secrets=include')).json<WorkspaceExport>(); assert.equal(raw.redacted, false);
  const clean = (await f.api('/api/workspaces/export')).json<WorkspaceExport>(); assert.equal(clean.redacted, true);
  const decoded = JSON.stringify(clean) + clean.events.map((e) => Buffer.from(e.rawBody.data, 'base64').toString()).join('') + clean.requests.map((r) => Buffer.from(r.request.body.data, 'base64').toString()).join('');
  for (const secret of ['secret-json-canary', 'secret-signature-canary', 'secret-auth-canary', 'secret-cookie-canary', 'secret-body-canary']) assert(!decoded.includes(secret));
  const importResponse = await f.api('/api/workspaces/import', 'POST', raw); assert.equal(importResponse.statusCode, 201, importResponse.body); const imported = importResponse.json<Workspace>();
  const recovered = (await f.api('/api/workspaces/export?secrets=include', 'GET', undefined, imported.id)).json<WorkspaceExport>();
  assert.equal(recovered.events.length, raw.events.length); assert.equal(recovered.replays.length, raw.replays.length); assert.equal(recovered.requests.length, 1);
  assert.notEqual(recovered.events[0]?.id, raw.events[0]?.id); assert.equal(recovered.events[0]?.rawBody.data, raw.events[0]?.rawBody.data);
  assert(recovered.replays.every((r) => r.workspaceId === imported.id)); assert(recovered.replays.filter((r) => r.sourceEventId).every((r) => recovered.events.some((e) => e.id === r.sourceEventId)));
  assert.equal(recovered.bindings[0]?.profileId, recovered.mocks[0]?.id);
  assert.equal((await f.api('/api/workspaces/import', 'POST', clean)).statusCode, 201);
  await f.app.close(); const restarted = createApp({ databasePath: f.path }); t.after(() => restarted.close());
  const state = (await restarted.inject('/api/workspaces')).json<{ activeId: string }>(); assert.equal(state.activeId, other.id);
  const config = (await restarted.inject({ url: '/api/configuration', headers: { 'x-workspace-id': DEFAULT_WORKSPACE } })).json<WorkspaceConfiguration>();
  assert.equal(config.requests[0]?.id, saved.id); assert.equal(config.mocks[0]?.response.delayMs, 70); assert.deepEqual(config.transformations[0]?.operations, operations);
  assert.equal((await restarted.inject({ url: `/api/events/${a.id}`, headers: { 'x-workspace-id': DEFAULT_WORKSPACE } })).json<WebhookEvent>().rawBody.data, a.rawBody.data);
  assert.equal((await restarted.inject({ url: `/api/replays/${second.id}`, headers: { 'x-workspace-id': DEFAULT_WORKSPACE } })).json<ReplayExecution>().result.status, 200);
  await restarted.close();
});

test('mock via HTTP real: GET/POST, headers, delay de 3000 ms, reinício e histórico preservado', async (t) => {
  let app: ReturnType<typeof createApp> | undefined;
  t.after(() => app?.close());
  const f = await fixture(t); app = f.app; let url = f.url;
  const api = async (path: string, method = 'GET', value?: unknown, workspaceId = DEFAULT_WORKSPACE) => {
    const response = await fetch(`${url}${path}`, { method, headers: { 'x-workspace-id': workspaceId, ...(value === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    assert(response.ok, await response.clone().text()); return response.json();
  };
  const capture = async (path: string, method = 'GET') => {
    const response = await fetch(`${url}${path}`, { method });
    return { status: response.status, headers: response.headers, body: await response.text() };
  };
  assert.equal((await capture('/hooks/stage3-mock')).status, 200);
  const original = await f.latest();
  const execution = await api(`/api/events/${original.id}/replays`, 'POST', { ...capturedRequest(original), destinationUrl: `${url}/hooks/history` }) as ReplayExecution;
  assert.equal(execution.result.status, 200);
  const before = new DatabaseSync(f.path, { readOnly: true });
  const historicalEvents = before.prepare('SELECT * FROM events ORDER BY sequence').all();
  const historicalReplays = before.prepare('SELECT * FROM replays ORDER BY sequence').all(); before.close();
  const profile: MockProfile = { id: randomUUID(), name: 'Stage 3 failure', response: { status: 500, headers: [['Content-Type', 'application/json'], ['X-Mock', 'stage3']],
    body: '{"error":"simulated_failure"}', delayMs: 0, maxDelayMs: 0 } };
  await api(`/api/mocks/${profile.id}`, 'PUT', profile);
  assert.equal((await capture('/hooks/stage3-mock')).status, 200); // Saving a reusable profile alone does not activate it.
  const bindingId = randomUUID();
  await api(`/api/bindings/${bindingId}`, 'PUT', { path: '/hooks/stage3-mock', profileId: profile.id });
  for (const method of ['GET', 'POST']) {
    const response = await capture('/hooks/stage3-mock?source=test', method);
    assert.equal(response.status, 500); assert.equal(response.body, profile.response.body);
    assert.equal(response.headers.get('content-type'), 'application/json'); assert.equal(response.headers.get('x-mock'), 'stage3');
    const event = await f.latest(); assert.equal(event.responseStatus, response.status); assert.equal(event.response.body, response.body);
    assert(event.response.headers.some(([key, value]) => key === 'x-mock' && value === 'stage3'));
  }
  for (const path of ['/hooks/unconfigured', '/hooks/stage3-mock/child', '/hooks/stage3-mock/']) {
    const response = await capture(path); assert.equal(response.status, 200); assert.equal(response.body, '{"received":true}');
  }
  const other = await api('/api/workspaces', 'POST', { name: 'Other mocks' }) as Workspace;
  await api(`/api/workspaces/${other.id}/active`, 'PUT');
  assert.equal((await capture('/hooks/stage3-mock')).status, 200);
  assert.equal((await api('/api/configuration', 'GET', undefined, other.id) as WorkspaceConfiguration).mocks.length, 0);
  assert.equal((await fetch(`${url}/api/replays/${execution.id}`, { headers: { 'x-workspace-id': other.id } })).status, 404);
  await api(`/api/workspaces/${DEFAULT_WORKSPACE}/active`, 'PUT');
  await api(`/api/mocks/${profile.id}`, 'PUT', { ...profile, response: { ...profile.response, delayMs: 3000, maxDelayMs: 3000 } });
  let started = performance.now(); const delayed = await capture('/hooks/stage3-mock');
  assert.equal(delayed.status, 500); assert(performance.now() - started >= 2900); assert((await f.latest()).durationMs >= 2900);
  await app.close(); app = createApp({ databasePath: f.path });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address(); assert(address && typeof address !== 'string'); url = `http://127.0.0.1:${address.port}`;
  started = performance.now(); const restarted = await capture('/hooks/stage3-mock', 'POST');
  assert.equal(restarted.status, 500); assert.equal(restarted.body, profile.response.body); assert.equal(restarted.headers.get('x-mock'), 'stage3');
  assert(performance.now() - started >= 2900);
  const config = await api('/api/configuration') as WorkspaceConfiguration;
  assert.equal(config.mocks[0]?.response.delayMs, 3000); assert.equal(config.bindings[0]?.path, '/hooks/stage3-mock');
  const after = new DatabaseSync(f.path, { readOnly: true });
  try {
    for (const row of historicalEvents) assert.deepEqual(after.prepare('SELECT * FROM events WHERE id = ?').get(row.id!), row);
    for (const row of historicalReplays) assert.deepEqual(after.prepare('SELECT * FROM replays WHERE id = ?').get(row.id!), row);
    assert.deepEqual(after.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { after.close(); }
  await api(`/api/bindings/${bindingId}`, 'DELETE');
  assert.equal((await capture('/hooks/stage3-mock')).status, 200);
});

test('mock exato, duplicação, exclusão, validação e respostas sem corpo', async (t) => {
  const f = await fixture(t); const { profile, bindingId } = await f.mock(500);
  assert.equal((await f.capture('{}', '/hooks/payment/child')).statusCode, 200);
  assert.equal((await f.capture('{}', '/hooks/payment?x=1')).statusCode, 500);
  assert.equal((await f.api('/api/events?exactPath=%2Fhooks%2Fpayment')).json<EventPage>().events.length, 1);
  assert.equal((await f.api(`/api/bindings/${randomUUID()}`, 'PUT', { path: '/hooks/payment', profileId: profile.id })).statusCode, 400);
  for (const response of [{ ...profile.response, status: 199 }, { ...profile.response, status: 600 }, { ...profile.response, delayMs: 10001, maxDelayMs: 10001 }, { ...profile.response, maxDelayMs: -1 }, { ...profile.response, headers: [['Content-Length', '1']] }, { ...profile.response, headers: [['X-Test', 'bad\r\nInjected']] }, { ...profile.response, status: 204 }]) assert.equal((await f.api(`/api/mocks/${profile.id}`, 'PUT', { ...profile, response })).statusCode, 400);
  for (const status of [204, 205, 304]) {
    assert.equal((await f.api(`/api/mocks/${profile.id}`, 'PUT', { ...profile, response: { ...profile.response, status, body: '' } })).statusCode, 200);
    const actual = await fetch(`${f.url}/hooks/payment`, { method: 'POST', body: '{}' }); assert.equal(actual.status, status); assert.equal(await actual.text(), '');
    const event = await f.latest(); assert.equal(event.response.body, ''); assert.equal(event.responseStatus, status);
    for (const [name, value] of event.response.headers) assert.equal(actual.headers.get(name), value);
  }
  assert.equal((await f.api(`/api/mocks/${randomUUID()}`, 'PUT', { ...profile, id: randomUUID(), name: 'Copy' })).statusCode, 200);
  assert.equal((await f.api(`/api/mocks/${profile.id}`, 'DELETE')).statusCode, 200);
  assert.equal((await f.api('/api/configuration')).json<WorkspaceConfiguration>().bindings.length, 0);
  assert.equal((await f.api(`/api/bindings/${bindingId}`, 'DELETE')).statusCode, 404);
  assert.equal((await f.capture('{}')).statusCode, 200);
});

test('captura atrasada mantém o workspace de chegada e limita atrasos concorrentes', async (t) => {
  const f = await fixture(t); await f.mock(500, 120);
  const pending = f.capture('{}'); await new Promise<void>((resolve) => setTimeout(resolve, 20));
  const other = (await f.api('/api/workspaces', 'POST', { name: 'Other' })).json<Workspace>(); await f.api(`/api/workspaces/${other.id}/active`, 'PUT');
  assert.equal((await pending).statusCode, 500); assert.equal((await f.latest()).workspaceId, DEFAULT_WORKSPACE);
  assert.equal((await f.api('/api/events', 'GET', undefined, other.id)).json<EventPage>().events.length, 0);
  await f.api(`/api/workspaces/${DEFAULT_WORKSPACE}/active`, 'PUT');
  const responses = await Promise.all(Array.from({ length: 25 }, () => f.app.inject({ url: '/hooks/payment', method: 'POST', payload: '{}' })));
  assert.equal(responses.filter((r) => r.statusCode === 429).length, 5); assert.equal(responses.filter((r) => r.statusCode === 500).length, 20);
});

test('importação rejeita conteúdo malformado, versões, colisões e referências sem sobrescrever', async (t) => {
  const f = await fixture(t); await f.capture('{"hello":"world"}'); const input = (await f.api('/api/workspaces/export?secrets=include')).json<WorkspaceExport>();
  const invalid: unknown[] = [null, {}, { ...input, version: 2 }, { ...input, events: [...input.events, input.events[0]] }, { ...input, events: [{ ...input.events[0], workspaceId: randomUUID() }] }, { ...input, events: [{ ...input.events[0], bodySize: 999 }] }, { ...input, events: [{ ...input.events[0], path: '/outside' }] }, { ...input, bindings: [{ id: randomUUID(), path: '/hooks/payment', profileId: randomUUID() }] }, { ...input, transformations: [{ id: randomUUID(), name: 'Unsafe', operations: [{ id: 'one', enabled: true, type: 'script', path: '$.x', value: 'process.exit()' }] }] }];
  for (const value of invalid) assert.equal((await f.api('/api/workspaces/import', 'POST', value)).statusCode, 400);
  assert.equal((await f.app.inject({ url: '/api/workspaces/import', method: 'POST', payload: '{invalid' })).statusCode, 400);
  assert.equal((await f.api('/api/workspaces')).json<{ workspaces: Workspace[] }>().workspaces.length, 1);
  assert.equal((await f.api('/api/events')).json<EventPage>().events[0]?.id, input.events[0]?.id);
  const unsafeHtml = { ...input, requests: [{ id: randomUUID(), name: '<script>alert(1)</script>', request: { ...capturedRequest(input.events[0]!), destinationUrl: 'javascript:alert(1)' } }] };
  assert.equal((await f.api('/api/workspaces/import', 'POST', unsafeHtml)).statusCode, 400);
});

test('salvos têm identidades independentes; exportação opaca e endpoint overview usam dados persistidos', async (t) => {
  const f = await fixture(t); await f.capture('{}'); await f.capture('{}');
  const event = await f.latest(); const one: SavedRequest = { id: randomUUID(), name: 'Original', request: capturedRequest(event) };
  const two: SavedRequest = { ...structuredClone(one), id: randomUUID(), name: 'Copy' };
  assert.equal((await f.api(`/api/requests/${one.id}`, 'PUT', one)).statusCode, 200); assert.equal((await f.api(`/api/requests/${two.id}`, 'PUT', two)).statusCode, 200);
  two.request.method = 'PUT'; await f.api(`/api/requests/${two.id}`, 'PUT', two);
  assert.equal((await f.api('/api/configuration')).json<WorkspaceConfiguration>().requests.find((r) => r.id === one.id)?.request.method, 'POST');
  assert.equal((await f.api(`/api/mocks/${one.id}`, 'PUT', { name: 'Collision', response: { status: 200, headers: [], body: '', delayMs: 0, maxDelayMs: 0 } })).statusCode, 400);
  const overview = (await f.api('/api/endpoints')).json<{ endpoints: { count: number; method: string }[] }>(); assert.equal(overview.endpoints[0]?.count, 2); assert.equal(overview.endpoints[0]?.method, 'POST');
  const opaque = await f.app.inject({ url: '/hooks/binary', method: 'POST', headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('opaque-secret-canary') }); assert.equal(opaque.statusCode, 200);
  const clean = (await f.api('/api/workspaces/export')).json<WorkspaceExport>(); assert.equal(clean.events.find((e) => e.path === '/hooks/binary')?.rawBody.data, '');
  assert.equal((await f.api(`/api/requests/${one.id}`, 'DELETE')).statusCode, 200); assert.equal((await f.api('/api/configuration')).json<WorkspaceConfiguration>().requests.length, 1);
});

test('associação de execução recusa referências entre workspaces no armazenamento', () => {
  const store = new EventStore(':memory:');
  try {
    const other = store.createWorkspace('Other'); const id = randomUUID();
    assert.throws(() => store.createReplay({ id, sourceEventId: randomUUID(), workspaceId: other.id, executedAt: new Date().toISOString(), state: 'running', request: { method: 'POST', destinationUrl: 'http://localhost', timeoutMs: 1000, headers: [], body: { encoding: 'base64', data: '' }, bodySize: 0 }, result: { durationMs: 0, headers: [], contentType: null, body: { encoding: 'base64', data: '' }, bodySize: 0, receivedSize: 0, truncated: false } }, other.id));
    assert.equal(store.getReplay(id, other.id), null);
  } finally { store.close(); }
});

test('excluir definição durante replay preserva execução e exportação sem referência quebrada', async (t) => {
  const f = await fixture(t); await f.mock(500, 150);
  const saved: SavedRequest = { id: randomUUID(), name: 'Delayed', request: { destinationUrl: `${f.url}/hooks/payment`, method: 'POST', headers: [], body: { encoding: 'base64', data: '' }, timeoutMs: 1000 } };
  await f.api(`/api/requests/${saved.id}`, 'PUT', saved);
  const pending = f.api(`/api/requests/${saved.id}/replays`, 'POST', {});
  for (let tries = 0; tries < 20; tries++) {
    if ((await f.api(`/api/requests/${saved.id}/replays`)).json<ReplayPage>().executions.length) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.equal((await f.api(`/api/requests/${saved.id}/replays`)).json<ReplayPage>().executions.length, 1);
  await f.api(`/api/requests/${saved.id}`, 'DELETE');
  const execution = (await pending).json<ReplayExecution>(); assert.equal(execution.savedRequestId, null); assert.equal(execution.result.status, 500);
  const archive = (await f.api('/api/workspaces/export?secrets=include')).json<WorkspaceExport>(); assert.equal(archive.requests.length, 0); assert.equal(archive.replays[0]?.savedRequestId, null);
  assert.equal((await f.api('/api/workspaces/import', 'POST', archive)).statusCode, 201);
});
