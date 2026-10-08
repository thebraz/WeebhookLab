import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { diffJson, compareRequests, compareResponses } from '../src/shared/diff.js';
import { checkJson, formatPath, parsePath, transform, type TransformOperation } from '../src/shared/json.js';
import { detectProvider, providerEvidenceText } from '../src/shared/providers.js';
import { redactBody, redactHeaders, redactJson, redactRequest, redactText, redactUrl } from '../src/shared/redaction.js';
import { replayErrorText, utf8Base64 } from '../src/shared/replay.js';
import type { ReplayExecution, ReplayRequest } from '../src/shared/contracts.js';
import { Payload } from '../src/web/Inspector.js';
import DiffPanel from '../src/web/DiffPanel.js';
import BodyEditor from '../src/web/BodyEditor.js';

test('historical interface metadata is displayed in English without rewriting custom content', () => {
  const original = { evidence: 'Cliente HTTP genérico', message: 'Tempo limite da requisição excedido.' };
  assert.equal(providerEvidenceText(original.evidence), 'Generic HTTP client');
  assert.equal(replayErrorText(original.message), 'Request timed out.');
  assert.equal(original.evidence, 'Cliente HTTP genérico');
  assert.equal(original.message, 'Tempo limite da requisição excedido.');
  assert.equal(replayErrorText('My custom error'), 'My custom error');
  assert.equal(providerEvidenceText('My custom evidence'), 'My custom evidence');
  assert.equal(replayErrorText('__proto__'), '__proto__');
  assert.equal(providerEvidenceText('constructor'), 'constructor');
});

test('diff semântico: propriedades, tipos, null, arrays, objetos vazios e ordenação', () => {
  const a = { removed: 1, changed: false, type: 1, customer: { plan: 'basic' }, array: ['one', { x: 1 }], nil: null, empty: {} };
  const b = { added: null, changed: true, type: '1', customer: { plan: 'premium' }, array: ['two', { x: 1 }, []], nil: null, empty: {} };
  const result = diffJson(a, b);
  assert.deepEqual(result.changes.map((c) => [c.path, c.type]), [
    ['$.added', 'added'], ['$.array[0]', 'modified'], ['$.array[2]', 'added'], ['$.changed', 'modified'], ['$.customer.plan', 'modified'], ['$.removed', 'removed'], ['$.type', 'type-changed'],
  ]);
  assert.equal(result.changes[0]!.previous, undefined); assert.equal(result.changes[0]!.current, null);
  assert.equal(diffJson({ a: 1, b: { x: 1, y: 2 } }, { b: { y: 2, x: 1 }, a: 1 }).changes.length, 0);
  assert.equal(diffJson(null, {}).changes[0]?.type, 'type-changed');
  assert.deepEqual(diffJson([null, 1], [null]).changes.map((c) => [c.path, c.type]), [['$[1]', 'removed']]);
  assert.equal(diffJson({}, { blank: {} }).changes[0]?.type, 'added');
  assert.equal(diffJson([], []).changes.length, 0);
  assert.deepEqual(a.customer, { plan: 'basic' });
});

test('diff e inspeção limitam profundidade, quantidade e saída', () => {
  let deep: unknown = null; for (let i = 0; i < 66; i++) deep = { child: deep };
  assert(diffJson(deep, {}).notices.length); assert.throws(() => checkJson(Array(20001).fill(1)));
  assert.throws(() => checkJson('x'.repeat(1_048_577))); assert.throws(() => checkJson({ value: Infinity }));
  const cycle: { self?: unknown } = {}; cycle.self = cycle; assert.throws(() => checkJson(cycle));
  const a = Object.fromEntries(Array.from({ length: 1100 }, (_, i) => [`field${i}`, 0]));
  const b = Object.fromEntries(Array.from({ length: 1100 }, (_, i) => [`field${i}`, 1]));
  assert.equal(diffJson(a, b).changes.length, 1000); assert.equal(diffJson(a, b).truncated, true);
});

test('comparação de requests cobre método, destino, path, query repetida, headers e JSON', () => {
  const a: ReplayRequest = { destinationUrl: 'http://localhost/hooks/a?item=one&item=two', method: 'POST', timeoutMs: 1000, headers: [['Content-Type', 'application/json'], ['X-Test', 'one']], body: { encoding: 'base64', data: utf8Base64('{"b":2,"a":1}') } };
  const b = { ...a, destinationUrl: 'http://localhost/hooks/b?item=one&item=three', method: 'PUT', timeoutMs: 2000, headers: [['content-type', 'application/json'], ['x-test', 'two']] as ReplayRequest['headers'], body: { encoding: 'base64' as const, data: utf8Base64('{"a":1,"b":3}') } };
  const paths = compareRequests(a, b).changes.map((c) => c.path);
  for (const expected of ['$.method', '$.path', '$.query.item[1]', '$.headers["x-test"][0]', '$.body.b', '$.timeoutMs']) assert(paths.includes(expected));
  const binary = { ...a, headers: [['Content-Type', 'application/octet-stream']] as ReplayRequest['headers'] };
  assert(compareRequests(binary, b).notices[0]?.includes('Binary'));
  assert.equal(compareRequests({ ...a, headers: [['content-type', 'text/plain']], body: { encoding: 'base64', data: utf8Base64('line1\nline2') } }, { ...b, headers: [['content-type', 'text/plain']], body: { encoding: 'base64', data: utf8Base64('line1\nline3') } }).changes.at(-1)?.path, '$.body.lines[1]');
});

test('resposta HTTP e erro de execução permanecem distintos na comparação', () => {
  const a: ReplayExecution['result'] = { status: 200, durationMs: 31, headers: [], contentType: null, body: { encoding: 'base64', data: '' }, bodySize: 0, receivedSize: 0, truncated: false };
  const timeout: ReplayExecution['result'] = { ...a, durationMs: 94, error: { code: 'TIMEOUT', message: 'Tempo excedido' } }; delete timeout.status;
  const result = compareResponses(a, timeout);
  assert.equal(result.changes.find((c) => c.path === '$.status')?.current, null);
  assert(result.changes.some((c) => c.path === '$.error')); assert(result.changes.some((c) => c.path === '$.durationMs'));
  assert(result.notices.some((n) => n.includes('separate')));
});

test('provedores: indicadores, tipos, conflitos, Discord confiável e unknown', () => {
  const github = detectProvider({ headers: [['X-GitHub-Event', 'push'], ['User-Agent', 'GitHub-Hookshot/1']] });
  assert.equal(github.provider, 'github'); assert.equal(github.confidence, 'high'); assert.equal(github.eventType, 'push'); assert.equal(github.signatureVerified, false);
  const stripe = detectProvider({ headers: [['Stripe-Signature', 'fake']], payload: { object: 'event', id: 'evt_1', type: 'invoice.paid', data: { object: {} } } });
  assert.equal(stripe.provider, 'stripe'); assert.equal(stripe.confidence, 'high'); assert.equal(stripe.eventType, 'invoice.paid');
  assert.equal(detectProvider({ headers: [['Stripe-Signature', 'fake']] }).confidence, 'medium');
  const shopify = detectProvider({ headers: [['X-Shopify-Topic', 'orders/create'], ['X-Shopify-Hmac-Sha256', 'fake']] });
  assert.equal(shopify.provider, 'shopify'); assert.equal(shopify.eventType, 'orders/create');
  assert.equal(detectProvider({ headers: [['X-GitHub-Event', 'push'], ['Stripe-Signature', 'fake']] }).provider, 'unknown');
  assert.equal(detectProvider({ headers: [] }).provider, 'unknown');
  assert.equal(detectProvider({ headers: [['User-Agent', 'curl/8']] }).provider, 'generic');
  assert.equal(detectProvider({ headers: [['X-Signature-Ed25519', 'fake']] }).provider, 'unknown');
  assert.equal(detectProvider({ headers: [['X-Signature-Ed25519', 'fake'], ['X-Signature-Timestamp', '123']], payload: { type: 2, application_id: '123' } }).provider, 'discord');
  assert.equal(detectProvider({ headers: [] }, [() => ({ provider: 'generic', confidence: 'low', evidence: ['custom'], signatureVerified: false })]).provider, 'generic');
});

test('caminhos sem ambiguidade: pontos, aspas, unicode, índices e nomes numéricos', () => {
  const parts = ['customer', 'a.b', 'quote"value', 'a\\b', 'Olá!', '0', 'items', 2];
  assert.deepEqual(parsePath(formatPath(parts)), parts);
  assert.equal(formatPath(['customer', 'subscription', 'plan']), '$.customer.subscription.plan');
  assert.deepEqual(parsePath('customer.plan'), ['customer', 'plan']);
  for (const path of ['', '$', '$.x[-1]', '$.x[01]', '$.x..y', '$.__proto__.x', '$.constructor.x', '$.x[1e3]', '$["bad]']) assert.throws(() => parsePath(path));
});

const op = (type: TransformOperation['type'], path: string, extra: Partial<TransformOperation> = {}): TransformOperation => ({ id: `${type}-${path}`, enabled: true, type, path, ...extra });
test('transformações ordenadas, independentes, arrays e propriedades especiais', () => {
  const original = { customer: { plan: 'basic' }, metadata: { debug: true }, user_id: 1, items: ['a', 'b'], 'a.b': { 'q"x': null } };
  const copy = structuredClone(original);
  const operations = [op('set', 'customer.plan', { value: 'premium' }), op('delete', 'metadata.debug'), op('rename', 'user_id', { name: 'userId' }), op('set', 'items[2]', { value: 'c' }), op('delete', 'items[0]'), op('set', '$["a.b"]["q\\"x"]', { value: false })];
  const result = transform(original, operations); assert.equal(result.error, undefined);
  assert.deepEqual(result.value, { customer: { plan: 'premium' }, metadata: {}, userId: 1, items: ['b', 'c'], 'a.b': { 'q"x': false } });
  assert.deepEqual(original, copy);
  assert.deepEqual(transform({ value: 1 }, [op('set', 'value', { value: 2 }), op('set', 'value', { id: 'disabled', enabled: false, value: 3 })]).value, { value: 2 });
});

test('pipeline inválido identifica etapa e não produz resultado parcial', () => {
  const original = { x: 1, list: [1], nested: {} };
  for (const invalid of [op('delete', 'missing'), op('set', 'missing.child', { value: 2 }), op('set', 'list[2]', { value: 2 }), op('rename', 'list[0]', { name: 'x' }), op('rename', 'x', { name: 'nested' }), op('set', '__proto__.polluted', { value: true }), op('set', 'list.name', { value: 1 })]) {
    const result = transform(original, [op('set', 'x', { value: 2 }), invalid]);
    assert.equal(result.error?.step, 2); assert.equal(result.value, undefined); assert.equal(original.x, 1);
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('redaction preserva dados originais e cobre headers, JSON, URL, texto e opacos', () => {
  const original = { password: 'canary', nested: [{ token: 'canary', plan: 'premium' }], apiKey: 'canary', access_token: 'canary', refresh_token: 'canary', secret: 'canary' };
  assert(!JSON.stringify(redactJson(original)).includes('canary')); assert.equal(original.password, 'canary');
  assert(!JSON.stringify(redactHeaders([['Authorization', 'canary'], ['Cookie', 'canary'], ['Set-Cookie', 'canary'], ['X-API-Key', 'canary']])).includes('canary'));
  assert.equal(redactHeaders([['Content-Type', 'application/json']])[0]?.[1], 'application/json');
  assert(!redactUrl('http://localhost/hooks/a?token=canary&name=public').includes('canary')); assert(redactUrl('/hooks/a?token=canary').startsWith('/hooks/a'));
  assert(!redactText('{"token":"canary",broken').includes('canary')); assert(!redactText('token=canary&plan=basic').includes('canary'));
  let deep: unknown = { token: 'canary' }; for (let i = 0; i < 70; i++) deep = { x: deep }; assert(!redactText(JSON.stringify(deep)).includes('canary'));
  assert.equal(redactBody({ encoding: 'base64', data: 'AP8=' }, [['content-type', 'application/octet-stream']]).data, '');
  const r: ReplayRequest = { method: 'POST', destinationUrl: 'http://localhost/hooks/a?apiKey=canary', timeoutMs: 1000, headers: [['Content-Type', 'application/json'], ['Authorization', 'canary']], body: { encoding: 'base64', data: utf8Base64(JSON.stringify(original)) } };
  const clean = redactRequest(r); assert(!JSON.stringify(clean).includes('canary')); assert(!atob(clean.body.data).includes('canary')); assert.equal(r.headers[1]?.[1], 'canary');
  const normal = { ...r, body: { encoding: 'base64' as const, data: utf8Base64(' { "plan": "basic" }\r\n') } };
  assert.equal(redactRequest(normal).body.data, normal.body.data);
});

test('exibições ordinárias não expõem segredos; reveal é explícito', () => {
  const text = '{"token":"canary-ui-secret","plan":"basic"}';
  const view = { kind: 'json' as const, text, original: text };
  const markup = renderToStaticMarkup(createElement(Payload, { view })); assert(!markup.includes('canary-ui-secret')); assert(markup.includes('basic'));
  assert(renderToStaticMarkup(createElement(Payload, { view, reveal: true })).includes('canary-ui-secret'));
  assert(!renderToStaticMarkup(createElement(BodyEditor, { value: text, json: true, disabled: false, onChange: () => {} })).includes('canary-ui-secret'));
  const diff = diffJson({ token: 'canary-ui-secret' }, { token: 'second-secret' });
  assert(!renderToStaticMarkup(createElement(DiffPanel, { result: diff, left: 'A', right: 'B' })).includes('canary-ui-secret'));
});
