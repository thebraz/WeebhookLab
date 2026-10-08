import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import { isEvent, isReplay, uuidPattern, type Header } from '../shared/contracts.js';
import { checkJson, validateOperations } from '../shared/json.js';
import { editableText } from '../shared/replay.js';
import { MASK, redactBody, redactHeaders, redactJson, redactRequest, redactText, redactUrl, sensitivePath } from '../shared/redaction.js';
import { detectProvider } from '../shared/providers.js';
import type { DocumentKind, MockBinding, MockResponse, WorkspaceDocument, WorkspaceExport } from '../shared/workspaces.js';
import { EventStore } from './store.js';
import { validateReplay } from './replay.js';

const id = (value: unknown): value is string => typeof value === 'string' && new RegExp(uuidPattern).test(value);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid configuration.');
  return value as Record<string, unknown>;
};
const name = (value: unknown): string => { if (typeof value !== 'string' || !value.trim() || value.length > 100) throw new Error('Name is required, up to 100 characters.'); return value.trim(); };
export const endpointPath = (value: unknown): string => {
  if (typeof value !== 'string' || !value.startsWith('/hooks/') || value.length > 1024 || /[\s?#]/.test(value) || Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new Error('Use an exact /hooks/… endpoint without query parameters or fragments.');
  return value;
};
function headers(value: unknown): Header[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Use up to 100 headers.');
  let bytes = 0;
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some((v) => typeof v !== 'string')) throw new Error('Invalid header.');
    try { validateHeaderName(pair[0] as string); validateHeaderValue(pair[0] as string, pair[1]); } catch { throw new Error('Invalid header.'); }
    bytes += Buffer.byteLength(pair[0] as string) + Buffer.byteLength(pair[1] as string);
  }
  if (bytes > 32768) throw new Error('Headers exceed 32 KB.');
  return value as Header[];
}
export function validateMock(value: unknown): MockResponse {
  const input = object(value);
  if (!Number.isInteger(input.status) || Number(input.status) < 200 || Number(input.status) > 599) throw new Error('Response status must be between 200 and 599.');
  const pairs = headers(input.headers);
  const contentTypes = pairs.filter(([key]) => key.toLowerCase() === 'content-type');
  if (contentTypes.length > 1) throw new Error('Use only one Content-Type header.');
  const charset = contentTypes[0]?.[1].match(/charset\s*=\s*"?([^;"\s]+)/i)?.[1]?.toLowerCase();
  if (charset && !['utf-8', 'utf8'].includes(charset)) throw new Error('Mock response body is UTF-8 text; use a compatible charset.');
  if (pairs.some(([key]) => /^(content-length|transfer-encoding|connection|keep-alive|trailer|upgrade|content-encoding)$/i.test(key))) throw new Error('Transport and compression headers are managed by the server.');
  if (typeof input.body !== 'string' || Buffer.byteLength(input.body) > 65536) throw new Error('Response body is limited to 64 KB.');
  if ([204, 205, 304].includes(Number(input.status)) && input.body) throw new Error('This status does not allow a response body.');
  if (![input.delayMs, input.maxDelayMs].every((v) => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 10_000)
    || Number(input.maxDelayMs) < Number(input.delayMs)) throw new Error('Delay must be between 0 and 10,000 ms; maximum must be at least the minimum.');
  return { status: Number(input.status), headers: pairs, body: input.body, delayMs: Number(input.delayMs), maxDelayMs: Number(input.maxDelayMs) };
}

export function validateDocument(kind: DocumentKind, value: unknown, bodyLimit: number): WorkspaceDocument {
  const input = object(value);
  if (!id(input.id)) throw new Error('Invalid ID.');
  if (kind === 'bindings') { if (!id(input.profileId)) throw new Error('Invalid profile.'); return { id: input.id, path: endpointPath(input.path), profileId: input.profileId }; }
  const label = name(input.name);
  if (kind === 'requests') return { id: input.id, name: label, request: validateReplay(input.request, bodyLimit) };
  if (kind === 'mocks') return { id: input.id, name: label, response: validateMock(input.response) };
  validateOperations(input.operations); return { id: input.id, name: label, operations: input.operations };
}

export function validateImport(value: unknown, bodyLimit: number): WorkspaceExport {
  const input = object(value);
  if (input.format !== 'weebhooklab-workspace' || input.version !== 1) throw new Error('Unsupported workspace format or version.');
  const workspace = object(input.workspace);
  if (!id(workspace.id) || typeof workspace.createdAt !== 'string' || !Number.isFinite(Date.parse(workspace.createdAt))) throw new Error('Invalid workspace.');
  name(workspace.name);
  if (typeof input.redacted !== 'boolean' || typeof input.exportedAt !== 'string' || !Number.isFinite(Date.parse(input.exportedAt))) throw new Error('Invalid export metadata.');
  const seen = new Set<string>();
  const add = (itemId: string) => { if (seen.has(itemId)) throw new Error('Duplicate IDs in the file.'); seen.add(itemId); };
  let configCount = 0;
  for (const kind of ['requests', 'mocks', 'bindings', 'transformations'] as const) {
    if (!Array.isArray(input[kind]) || (configCount += input[kind].length) > 500) throw new Error('Missing configuration or limit of 500 exceeded.');
    input[kind] = input[kind].map((v: unknown) => validateDocument(kind, v, bodyLimit));
    for (const item of input[kind] as WorkspaceDocument[]) add(item.id);
  }
  const config = input as unknown as WorkspaceExport;
  const mocks = new Set(config.mocks.map((m) => m.id)); const paths = new Set<string>();
  for (const binding of config.bindings) {
    if (!mocks.has(binding.profileId) || paths.has(binding.path)) throw new Error('Invalid profile reference or duplicate endpoint.'); paths.add(binding.path);
  }
  if (!Array.isArray(input.events) || input.events.length > 1000 || !Array.isArray(input.replays) || input.replays.length > 1000) throw new Error('Use up to 1,000 events and 1,000 executions.');
  const events = new Set<string>(); const requests = new Set(config.requests.map((r) => r.id));
  for (const event of input.events) {
    if (!isEvent(event) || event.bodySize !== Buffer.byteLength(event.rawBody.data, 'base64') || event.bodySize > bodyLimit
      || (event.workspaceId !== undefined && event.workspaceId !== workspace.id) || typeof event.httpVersion !== 'string'
      || event.requestTarget.length > 8192 || event.response.body.length > 65536) throw new Error('Invalid event or event belongs to another workspace.');
    headers(event.headers); headers(event.response.headers); endpointPath(event.path);
    if (event.requestTarget.split('?')[0] !== event.path || !/^[A-Z-]{1,32}$/.test(event.method)) throw new Error('Inconsistent event metadata.');
    checkJson(event.query);
    let payload: unknown;
    try { const text = editableText(event.rawBody, event.headers); payload = text === null ? undefined : JSON.parse(text); } catch { /* Payload can be opaque. */ }
    event.provider = detectProvider({ headers: event.headers, payload });
    add(event.id); events.add(event.id);
  }
  for (const execution of input.replays) {
    if (!isReplay(execution) || (execution.workspaceId !== undefined && execution.workspaceId !== workspace.id)
      || (execution.sourceEventId && !events.has(execution.sourceEventId)) || (execution.savedRequestId && !requests.has(execution.savedRequestId))
      || execution.request.bodySize !== Buffer.byteLength(execution.request.body.data, 'base64')
      || execution.result.bodySize !== Buffer.byteLength(execution.result.body.data, 'base64') || execution.result.bodySize > bodyLimit) throw new Error('Invalid execution or reference.');
    validateReplay(execution.request, bodyLimit); headers(execution.result.headers); add(execution.id);
  }
  return config;
}

export function redactExport(input: WorkspaceExport): WorkspaceExport {
  const result = structuredClone(input); result.redacted = true;
  result.requests = result.requests.map((r) => ({ ...r, request: redactRequest(r.request) }));
  result.mocks = result.mocks.map((m) => ({ ...m, response: { ...m.response, headers: redactHeaders(m.response.headers), body: redactText(m.response.body) } }));
  result.transformations = result.transformations.map((p) => ({ ...p, operations: p.operations.map((op) => ({ ...op,
    ...(op.value === undefined ? {} : { value: sensitivePath(op.path) ? MASK : redactJson(op.value) }) })) }));
  result.events = result.events.map((e) => {
    const body = redactBody(e.rawBody, e.headers);
    const requestTarget = redactUrl(e.requestTarget);
    return { ...e, requestTarget, query: redactJson(e.query) as typeof e.query, headers: redactHeaders(e.headers), rawBody: body,
      bodySize: Buffer.byteLength(body.data, 'base64'), response: { headers: redactHeaders(e.response.headers), body: redactText(e.response.body) } };
  });
  result.replays = result.replays.map((r) => {
    const request = redactRequest(r.request); const body = redactBody(r.result.body, r.result.headers);
    return { ...r, request: { ...request, bodySize: Buffer.byteLength(request.body.data, 'base64') }, result: { ...r.result, body,
      bodySize: Buffer.byteLength(body.data, 'base64'), receivedSize: Math.max(r.result.receivedSize, Buffer.byteLength(body.data, 'base64')), headers: redactHeaders(r.result.headers) } };
  });
  return result;
}

export function registerWorkspaceRoutes(app: FastifyInstance, store: EventStore, scope: (request: FastifyRequest) => string, bodyLimit: number,
  replay: (request: FastifyRequest, reply: FastifyReply, sourceId: string | null, savedId?: string) => Promise<unknown>) {
  const schema = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: uuidPattern } } };
  const parse = (request: FastifyRequest) => JSON.parse((request.body as Buffer).toString()) as unknown;
  const bad = (reply: FastifyReply, error: unknown) => reply.code(400).send({ error: { code: 'INVALID_CONFIGURATION', message: error instanceof SyntaxError ? 'Invalid JSON.' : error instanceof Error ? error.message : 'Invalid configuration.' } });
  app.get('/api/workspaces', () => ({ workspaces: store.workspaces(), activeId: store.activeWorkspace() }));
  app.post('/api/workspaces', (request, reply) => { try { return reply.code(201).send(store.createWorkspace(name(object(parse(request)).name))); } catch (error) { return bad(reply, error); } });
  app.put<{ Params: { id: string } }>('/api/workspaces/:id/active', { schema: { params: schema } }, (request, reply) => {
    try { store.activate(request.params.id); return { activeId: request.params.id }; } catch (error) { return bad(reply, error); }
  });
  app.get('/api/configuration', (request) => store.configuration(scope(request)));
  app.get('/api/endpoints', (request) => ({ endpoints: store.endpoints(scope(request)) }));
  for (const kind of ['requests', 'mocks', 'bindings', 'transformations'] as const) {
    app.put<{ Params: { id: string } }>(`/api/${kind}/:id`, { bodyLimit: Math.ceil(bodyLimit * 4 / 3) + 65536, schema: { params: schema } }, (request, reply) => {
      try {
        const workspaceId = scope(request); const value = validateDocument(kind, { ...object(parse(request)), id: request.params.id }, bodyLimit);
        if (kind === 'bindings') {
          const binding = value as MockBinding;
          if (!store.document('mocks', binding.profileId, workspaceId)) throw new Error('Profile not found in this workspace.');
          if (store.configuration(workspaceId).bindings.some((b) => b.path === binding.path && b.id !== binding.id)) throw new Error('This endpoint already has a profile; edit the existing binding.');
        }
        store.putDocument(kind, value, workspaceId); return value;
      } catch (error) { return bad(reply, error); }
    });
    app.delete<{ Params: { id: string } }>(`/api/${kind}/:id`, { schema: { params: schema } }, (request, reply) => store.deleteDocument(kind, request.params.id, scope(request)) ? { deleted: true } : reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Configuration not found.' } }));
  }
  app.post<{ Params: { id: string } }>('/api/requests/:id/replays', { bodyLimit: Math.ceil(bodyLimit * 4 / 3) + 65536, schema: { params: schema } }, (request, reply) => {
    if (!store.document('requests', request.params.id, scope(request))) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Request not found.' } });
    return replay(request, reply, null, request.params.id);
  });
  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>('/api/requests/:id/replays', { schema: { params: schema } }, (request, reply) => {
    const cursor = request.query.cursor === undefined ? undefined : Number(request.query.cursor);
    if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 1)) return bad(reply, new Error('Invalid cursor.'));
    if (!store.document('requests', request.params.id, scope(request))) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Request not found.' } });
    return store.listReplays(request.params.id, 25, cursor, scope(request), true);
  });
  app.get<{ Querystring: { secrets?: string } }>('/api/workspaces/export', { schema: { querystring: { type: 'object', additionalProperties: false, properties: { secrets: { type: 'string', enum: ['include'] } } } } }, (request, reply) => {
    try {
      const file = store.exportWorkspace(scope(request)); const output = request.query.secrets === 'include' ? file : redactExport(file);
      const serialized = JSON.stringify(output, null, 2); if (Buffer.byteLength(serialized) > 10_485_760) throw new Error('Export exceeds 10 MB.');
      return reply.header('content-disposition', 'attachment; filename="weebhooklab-workspace.json"').type('application/json').send(serialized);
    } catch (error) { return bad(reply, error); }
  });
  app.post('/api/workspaces/import', { bodyLimit: 10_485_760 }, (request, reply) => {
    try { return reply.code(201).send(store.importWorkspace(validateImport(parse(request), bodyLimit))); } catch (error) { return bad(reply, error); }
  });
}
