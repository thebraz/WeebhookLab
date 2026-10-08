import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { request, get, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server/app.js';
import { isEvent, isPage, isSummary, type EventPage, type EventSummary, type WebhookEvent } from '../src/shared/contracts.js';

async function fixture(t: TestContext, bodyLimit?: number) {
  const directory = await mkdtemp(join(tmpdir(), 'weebhooklab-test-'));
  const path = join(directory, 'events.sqlite');
  const app = createApp({ databasePath: path, ...(bodyLimit === undefined ? {} : { bodyLimit }) });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { app, url, path };
}

async function send(url: string, path: string, method = 'GET', body?: Buffer | string, headers: IncomingHttpHeaders = {}) {
  return await new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const bytes = body === undefined ? undefined : Buffer.from(body);
    const req = request(new URL(path, url), { method, headers: { ...headers, ...(bytes === undefined ? {} : { 'content-length': bytes.length }) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(bytes);
  });
}

async function page(url: string, query = ''): Promise<EventPage> {
  const response = await send(url, `/api/events${query}`);
  assert.equal(response.status, 200);
  const value: unknown = JSON.parse(response.body.toString());
  assert(isPage(value));
  return value;
}

async function detail(url: string, id: string): Promise<WebhookEvent> {
  const response = await send(url, `/api/events/${id}`);
  assert.equal(response.status, 200);
  const value: unknown = JSON.parse(response.body.toString());
  assert(isEvent(value));
  return value;
}

async function latest(url: string): Promise<WebhookEvent> { return detail(url, (await page(url)).events[0]!.id); }

for (const [name, contentType, body] of [
  ['JSON válido', 'application/json', ' { "event": "hello.world", "number": 1 }\n'],
  ['JSON inválido', 'application/json', '{bad json\n'],
  ['text', 'text/plain; charset=utf-8', 'Olá, webhook!\r\n<script>alert(1)</script>'],
  ['formulário', 'application/x-www-form-urlencoded', 'item=one&item=two&name=Jo%C3%A3o'],
  ['tipo desconhecido', 'application/x-custom', 'custom content'],
] as const) {
  test(`captura e preserva ${name}`, async (t) => {
    const { url } = await fixture(t);
    const response = await send(url, '/hooks/shop/order-created', 'POST', body, { 'content-type': contentType, 'user-agent': 'WeebhookLab integration test' });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body.toString()), { received: true });
    const event = await latest(url);
    assert.equal(Buffer.from(event.rawBody.data, 'base64').toString(), body);
    assert.equal(event.bodySize, Buffer.byteLength(body));
    assert.equal(event.contentType, contentType);
    assert.equal(event.path, '/hooks/shop/order-created');
    assert.equal(event.userAgent, 'WeebhookLab integration test');
    assert.equal(event.sourceIp, '127.0.0.1');
    assert.equal(event.responseStatus, response.status);
    assert.equal(event.response.body, response.body.toString());
    for (const [name, value] of event.response.headers) assert.equal(response.headers[name], value);
    assert(event.durationMs >= 0);
    assert.equal((await send(url, '/api/health')).status, 200);
  });
}

test('captura corpos vazios e todos os métodos exigidos', async (t) => {
  const { url } = await fixture(t);
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal((await send(url, '/hooks/empty', method)).status, 200);
    const event = await latest(url);
    assert.equal(event.method, method);
    assert.equal(event.bodySize, 0);
    assert.equal(event.rawBody.data, '');
  }
  assert.equal((await page(url)).events.length, 5);
});

test('preserva query repetida, nomes especiais e URL original', async (t) => {
  const { url } = await fixture(t);
  const target = '/hooks/encoded%2Fpath?debug=true&item=one&item=two&empty=&__proto__=safe&name=Jo%C3%A3o';
  assert.equal((await send(url, target)).status, 200);
  const event = await latest(url);
  assert.equal(event.requestTarget, target);
  assert.equal(event.path, '/hooks/encoded%2Fpath');
  assert.deepEqual(event.query, { debug: 'true', item: ['one', 'two'], empty: '', ['__proto__']: 'safe', name: 'João' });
  assert.equal(Object.getOwnPropertyDescriptor(event.query, '__proto__')?.value, 'safe');
});

test('preserva headers repetidos e sensíveis sem normalizar seus valores', async (t) => {
  const { url } = await fixture(t);
  const response = await send(url, '/hooks/headers', 'POST', 'hello', { 'X-Repeat': ['one', 'two'], Authorization: 'Bearer test-canary', Cookie: 'session=test-canary' });
  assert.equal(response.status, 200);
  const event = await latest(url);
  assert.deepEqual(event.headers.filter(([name]) => name.toLowerCase() === 'x-repeat'), [['X-Repeat', 'one'], ['X-Repeat', 'two']]);
  assert(event.headers.some(([name, value]) => name === 'Authorization' && value === 'Bearer test-canary'));
  const list = await send(url, '/api/events');
  assert(!list.body.toString().includes('test-canary'));
  assert(!list.body.toString().includes('rawBody'));
});

test('preserva bytes binários, encoding, multipart e GET com corpo', async (t) => {
  const { url } = await fixture(t);
  const bytes = Buffer.from([0, 255, 128, 10, 13, 1]);
  for (const method of ['POST', 'GET']) {
    assert.equal((await send(url, '/hooks/binary', method, bytes, { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip' })).status, 200);
    const event = await latest(url);
    assert.deepEqual(Buffer.from(event.rawBody.data, 'base64'), bytes);
    assert.equal(event.contentEncoding, 'gzip');
  }
  const multipart = Buffer.concat([Buffer.from('--test-boundary\r\nContent-Disposition: form-data; name="file"; filename="sample.bin"\r\nContent-Type: application/octet-stream\r\n\r\n'), bytes, Buffer.from('\r\n--test-boundary--\r\n')]);
  assert.equal((await send(url, '/hooks/multipart', 'POST', multipart, { 'content-type': 'multipart/form-data; boundary=test-boundary' })).status, 200);
  assert.deepEqual(Buffer.from((await latest(url)).rawBody.data, 'base64'), multipart);
});

test('aplica limite em bytes, rejeita 413 sem salvar e permanece operacional', async (t) => {
  const { url } = await fixture(t, 64);
  assert.equal((await send(url, '/hooks/limit', 'POST', Buffer.alloc(64))).status, 200);
  for (const method of ['POST', 'GET']) {
    const response = await send(url, '/hooks/limit', method, Buffer.alloc(65));
    assert.equal(response.status, 413);
    assert.equal((JSON.parse(response.body.toString()) as { error: { code: string } }).error.code, 'PAYLOAD_TOO_LARGE');
  }
  assert.equal((await page(url)).events.length, 1);
  assert.equal((await send(url, '/api/health')).status, 200);
});

test('valida parâmetros, bloqueia acesso de outra origem e mantém erros consistentes', async (t) => {
  const { url } = await fixture(t);
  for (const query of ['?limit=0', '?limit=101', '?cursor=-1', '?cursor=9007199254740993', '?extra=value']) assert.equal((await send(url, `/api/events${query}`)).status, 400);
  assert.equal((await send(url, '/api/events/not-an-id')).status, 400);
  assert.equal((await send(url, '/api/events/00000000-0000-4000-8000-000000000000')).status, 404);
  assert.equal((await send(url, '/api/events', 'GET', undefined, { origin: 'https://example.com' })).status, 403);
  assert.equal((await send(url, '/api/health', 'GET', undefined, { host: 'example.com' })).status, 403);
  assert.equal((await send(url, '/api/health', 'GET', undefined, { origin: url })).status, 200);
});

test('persiste IDs e bytes após reiniciar a aplicação', async (t) => {
  const { app, url, path } = await fixture(t);
  await send(url, '/hooks/restart', 'POST', 'persisted bytes');
  const original = await latest(url);
  await app.close();
  const restarted = createApp({ databasePath: path });
  t.after(() => restarted.close());
  await restarted.listen({ host: '127.0.0.1', port: 0 });
  const address = restarted.server.address();
  assert(address && typeof address !== 'string');
  const recovered = await detail(`http://127.0.0.1:${address.port}`, original.id);
  assert.deepEqual(recovered, original);
  await restarted.close();
});

test('muitos eventos simultâneos têm IDs únicos e paginação determinística', async (t) => {
  const { url } = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 75 }, (_, index) => send(url, `/hooks/rapid/${index}`, 'POST', String(index))));
  assert(responses.every((response) => response.status === 200));
  let cursor: number | null = null;
  const events: EventSummary[] = [];
  do {
    const result = await page(url, `?limit=17${cursor === null ? '' : `&cursor=${cursor}`}`);
    events.push(...result.events); cursor = result.nextCursor;
  } while (cursor !== null);
  assert.equal(events.length, 75);
  assert.equal(new Set(events.map((event) => event.id)).size, 75);
  assert.equal(new Set(events.map((event) => event.path)).size, 75);
  assert.deepEqual(events.map((event) => event.sequence), Array.from({ length: 75 }, (_, index) => 75 - index));
});

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('Tempo limite aguardando evento SSE.');
}

async function subscribe(t: TestContext, url: string) {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = get(`${url}/api/events/stream`, resolve);
    req.on('error', reject);
    t.after(() => req.destroy());
  });
  const messages: { type: string; data: unknown }[] = [];
  let buffered = '';
  response.on('data', (chunk: Buffer) => {
    buffered += chunk.toString();
    let separator: number;
    while ((separator = buffered.indexOf('\n\n')) !== -1) {
      const frame = buffered.slice(0, separator); buffered = buffered.slice(separator + 2);
      const type = frame.match(/^event: (.*)$/m)?.[1];
      const data = frame.match(/^data: (.*)$/m)?.[1];
      if (type && data) messages.push({ type, data: JSON.parse(data) as unknown });
    }
  });
  t.after(() => response.destroy());
  await until(() => messages.some((message) => message.type === 'ready'));
  return { response, messages };
}

test('SSE entrega resumos para múltiplos clientes e tolera desconexões', async (t) => {
  const { url } = await fixture(t);
  const first = await subscribe(t, url);
  const second = await subscribe(t, url);
  await send(url, '/hooks/stream', 'POST', 'private payload');
  await until(() => first.messages.length === 2 && second.messages.length === 2);
  const message = first.messages[1]!;
  assert.equal(message.type, 'webhook');
  assert(isSummary(message.data));
  assert(!JSON.stringify(message.data).includes('private payload'));
  assert.deepEqual(message.data, second.messages[1]!.data);
  first.response.destroy();
  await Promise.all(Array.from({ length: 25 }, (_, index) => send(url, `/hooks/stream/${index}`, 'POST', String(index))));
  await until(() => second.messages.length === 27);
  const ids = second.messages.filter((item) => isSummary(item.data)).map((item) => (item.data as EventSummary).id);
  assert.equal(new Set(ids).size, 26);
  assert.equal((await page(url)).events.length, 26);
});

test('registro corrompido é isolado e falha de gravação não confirma captura', async (t) => {
  const { url, path } = await fixture(t);
  await send(url, '/hooks/good', 'POST', 'one');
  await send(url, '/hooks/bad', 'POST', 'two');
  const bad = await latest(url);
  const db = new DatabaseSync(path);
  db.prepare('UPDATE events SET summary = ? WHERE id = ?').run('invalid json', bad.id);
  const result = await page(url);
  assert.equal(result.events.length, 1); assert.equal(result.skippedRecords, 1);
  assert.equal((await send(url, `/api/events/${bad.id}`)).status, 503);
  db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'test database failure'); END;");
  const failed = await send(url, '/hooks/storage-failure', 'POST', 'not saved');
  assert.equal(failed.status, 503);
  assert(!failed.body.toString().includes('test database failure'));
  assert.equal((await page(url)).events.length, 1);
  db.close();
});
