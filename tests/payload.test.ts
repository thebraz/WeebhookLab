import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectPayload, sensitiveHeader } from '../src/web/payload.js';
import type { WebhookEvent } from '../src/shared/contracts.js';

function event(body: Buffer | string, contentType: string | null): WebhookEvent {
  const bytes = Buffer.from(body);
  return { id: '00000000-0000-4000-8000-000000000000', sequence: 1, method: 'POST', path: '/hooks/test', requestTarget: '/hooks/test', httpVersion: '1.1', receivedAt: new Date().toISOString(), contentType, bodySize: bytes.length, responseStatus: 200, durationMs: 1, headers: [], query: {}, userAgent: null, sourceIp: null, contentEncoding: null, rawBody: { encoding: 'base64', data: bytes.toString('base64') }, response: { headers: [], body: '{"received":true}' } };
}

test('prévia diferencia corpo vazio, JSON inválido, texto e bytes', async () => {
  assert.deepEqual(await inspectPayload(event('', 'application/json')), { kind: 'empty' });
  const json = await inspectPayload(event('{"a":1}', 'application/json'));
  assert(json.kind === 'json'); assert.equal(json.text, '{\n  "a": 1\n}'); assert.equal(json.original, '{"a":1}');
  const invalid = await inspectPayload(event('{broken', 'application/json'));
  assert(invalid.kind === 'invalid-json'); assert.equal(invalid.text, '{broken');
  const text = await inspectPayload(event('<script>literal</script>', 'text/plain'));
  assert(text.kind === 'text'); assert.equal(text.text, '<script>literal</script>');
  assert.equal((await inspectPayload(event(Buffer.from([0, 255]), 'application/octet-stream'))).kind, 'binary');
  assert.equal((await inspectPayload(event(Buffer.from([255]), null))).kind, 'binary');
});

test('prévia de formulários preserva repetições e mostra multipart sem salvar arquivos', async () => {
  const form = await inspectPayload(event('item=one&item=two', 'application/x-www-form-urlencoded'));
  assert(form.kind === 'form'); assert.deepEqual(form.values.item, ['one', 'two']);
  const body = '--x\r\nContent-Disposition: form-data; name="field"\r\n\r\nhello\r\n--x\r\nContent-Disposition: form-data; name="file"; filename="file.bin"\r\nContent-Type: application/octet-stream\r\n\r\nabc\r\n--x--\r\n';
  const multipart = await inspectPayload(event(body, 'multipart/form-data; boundary=x'));
  assert(multipart.kind === 'multipart');
  assert.deepEqual(multipart.parts, [{ name: 'field', value: 'hello', size: 5, contentType: null }, { name: 'file', value: 'file.bin', size: 3, contentType: 'application/octet-stream' }]);
});

test('headers sensíveis são reconhecidos e conteúdo codificado fica opaco', async () => {
  for (const name of ['Authorization', 'Cookie', 'X-API-Key', 'X-Auth-Token', 'Stripe-Signature']) assert(sensitiveHeader(name));
  assert(!sensitiveHeader('Content-Type'));
  const compressed = event('opaque', 'application/json'); compressed.contentEncoding = 'gzip';
  assert.equal((await inspectPayload(compressed)).kind, 'binary');
});
