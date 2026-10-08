import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { setTimeout as delay } from 'node:timers/promises';
import { EventStore, InvalidRecordError } from './store.js';
import { EventStream } from './stream.js';
import { normalize } from './normalize.js';
import { webhookResponse } from './response.js';
import { executeReplay, validateReplay } from './replay.js';
import { uuidPattern, type EventFilters } from '../shared/contracts.js';
import { registerWorkspaceRoutes } from './workspaces.js';
import type { SavedRequest } from '../shared/workspaces.js';

export const DEFAULT_DATABASE = fileURLToPath(new URL('../../data/events.sqlite', import.meta.url));
export const DEFAULT_BODY_LIMIT = 1024 * 1024;

export interface AppOptions { databasePath?: string; bodyLimit?: number; responseLimit?: number; serveWeb?: boolean; development?: boolean; allowedHost?: string }

export function createApp(options: AppOptions = {}) {
  const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
  const responseLimit = options.responseLimit ?? 1024 * 1024;
  if (!Number.isSafeInteger(bodyLimit) || bodyLimit < 1) throw new Error('Invalid request body limit.');
  if (!Number.isSafeInteger(responseLimit) || responseLimit < 1) throw new Error('Invalid response limit.');
  const store = new EventStore(options.databasePath ?? DEFAULT_DATABASE, bodyLimit);
  const stream = new EventStream();
  const app = Fastify({ logger: false, bodyLimit, requestTimeout: 30_000, connectionTimeout: 30_000, exposeHeadRoutes: false, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  const timings = new WeakMap<FastifyRequest, number>();
  const workspaces = new WeakMap<FastifyRequest, string>();
  const scope = (request: FastifyRequest) => workspaces.get(request)!;
  const closing = new AbortController();
  let delayedRequests = 0;
  const activeReplays = new Map<string, AbortController>();
  const idSchema = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: uuidPattern } } };
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

  app.addHook('onRequest', async (request, reply) => {
    timings.set(request, performance.now());
    const workspaceId = request.url.startsWith('/api/') ? request.headers['x-workspace-id'] ?? store.activeWorkspace() : store.activeWorkspace();
    if (typeof workspaceId !== 'string' || !store.hasWorkspace(workspaceId)) return reply.code(404).send({ error: { code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found.' } });
    workspaces.set(request, workspaceId);
    let host: URL;
    try { host = new URL(`http://${request.headers.host ?? ''}`); }
    catch { return reply.code(403).send({ error: { code: 'LOCAL_ONLY', message: 'Local access required.' } }); }
    const selectedHost = options.allowedHost;
    const hostname = host.hostname.replace(/^\[|\]$/g, '');
    const localAddress = request.raw.socket.localAddress?.replace(/^::ffff:/, '');
    const allowed = ['localhost', '127.0.0.1', '::1'].includes(hostname) || (selectedHost &&
      (hostname === selectedHost || (['0.0.0.0', '::'].includes(selectedHost) && isIP(hostname) && hostname === localAddress)));
    if (!allowed || host.username || host.password) {
      return reply.code(403).send({ error: { code: 'LOCAL_ONLY', message: 'Local access required.' } });
    }
    if (request.url.startsWith('/api/') && request.headers.origin) {
      try {
        const origin = new URL(request.headers.origin);
        const validPort = origin.port === host.port || (options.development && origin.port === '5173');
        if (origin.protocol !== 'http:' || origin.username || origin.password ||
          !(['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) || origin.hostname === host.hostname) || !validPort) throw new Error();
      } catch { return reply.code(403).send({ error: { code: 'ORIGIN_DENIED', message: 'Origin not allowed.' } }); }
    }
  });
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    if (request.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    return payload;
  });
  app.addHook('preClose', async () => { closing.abort(); stream.close(); for (const controller of activeReplays.values()) controller.abort(); });
  app.addHook('onClose', async () => { store.close(); });
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
    const status = typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500 ? statusCode : 503;
    const code = error instanceof InvalidRecordError ? 'INVALID_RECORD' : status === 413 ? 'PAYLOAD_TOO_LARGE' : status === 503 ? 'STORAGE_UNAVAILABLE' : 'INVALID_REQUEST';
    const message = error instanceof InvalidRecordError ? 'Invalid local record or configuration. Original data has been preserved.' : status === 413 ? `Body exceeds the limit of ${bodyLimit} bytes.` : status === 503 ? 'Unable to access or save the event.' : 'Invalid request.';
    reply.code(status).send({ error: { code, message } });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Resource not found.' } }));

  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], url: '/hooks/*',
    handler: async (request, reply) => {
      let body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      // Fastify does not parse GET bodies; preserve them under the same size limit.
      if (request.method === 'GET') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request.raw.iterator({ destroyOnReturn: false })) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          size += bytes.length;
          if (size > bodyLimit) {
            request.raw.resume();
            return reply.code(413).send({ error: { code: 'PAYLOAD_TOO_LARGE', message: `Body exceeds the limit of ${bodyLimit} bytes.` } });
          }
          chunks.push(bytes);
        }
        body = Buffer.concat(chunks);
      }
      const timing = timings.get(request)!;
      const workspaceId = scope(request);
      const mock = store.mockForPath(request.url.split('?')[0]!, workspaceId)?.response;
      if (mock && mock.maxDelayMs > 0) {
        if (delayedRequests >= 20) return reply.code(429).send({ error: { code: 'MOCK_BUSY', message: 'Limit of 20 concurrent delayed responses reached; request not captured.' } });
        delayedRequests++;
        try { await delay(mock.delayMs + Math.floor(Math.random() * (mock.maxDelayMs - mock.delayMs + 1)), undefined, { signal: closing.signal }); }
        catch { return reply.code(503).send({ error: { code: 'CLOSING', message: 'Server shutting down.' } }); }
        finally { delayedRequests--; }
      }
      const response = webhookResponse(reply, mock);
      const event = { ...normalize(request, body, new Date().toISOString()), responseStatus: reply.statusCode, response };
      const saved = store.create(event, body, timing, workspaceId);
      stream.publish(saved);
      return reply.send([204, 304].includes(reply.statusCode) ? undefined : Buffer.from(response.body, 'utf8'));
    },
  });

  app.get('/api/health', () => { store.ping(); return { status: 'ok', bodyLimit }; });
  app.get<{ Querystring: EventFilters & { limit?: string; cursor?: string } }>('/api/events', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      limit: { type: 'string', pattern: '^[1-9][0-9]{0,2}$' }, cursor: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' },
      search: { type: 'string', maxLength: 256 }, method: { type: 'string', pattern: '^[A-Z-]{1,32}$' },
      status: { type: 'string', pattern: '^[1-5][0-9]{2}$' }, path: { type: 'string', maxLength: 1024 }, exactPath: { type: 'string', maxLength: 1024 },
      contentType: { type: 'string', maxLength: 256 }, from: { type: 'string', maxLength: 40 }, to: { type: 'string', maxLength: 40 },
      pinned: { type: 'string', enum: ['0', '1'] },
    } } },
  }, (request, reply) => {
    const limit = Number(request.query.limit ?? 50);
    const cursor = request.query.cursor === undefined ? undefined : Number(request.query.cursor);
    if (limit > 100 || (cursor !== undefined && !Number.isSafeInteger(cursor))) {
      return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'Invalid pagination.' } });
    }
    const filters = { ...request.query };
    for (const key of ['from', 'to'] as const) {
      if (filters[key] !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}T/.test(filters[key]) || !Number.isFinite(Date.parse(filters[key]))) return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'Invalid date.' } });
        filters[key] = new Date(filters[key]).toISOString();
      }
    }
    if (filters.from && filters.to && filters.from > filters.to) return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'Start date must precede end date.' } });
    return store.list(limit, cursor, filters, scope(request));
  });
  app.get<{ Querystring: { workspace?: string } }>('/api/events/stream', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { workspace: { type: 'string', pattern: uuidPattern } } } },
  }, (request, reply) => {
    const workspaceId = request.query.workspace ?? scope(request);
    if (!store.hasWorkspace(workspaceId)) return reply.code(404).send({ error: { code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found.' } });
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store',
      connection: 'keep-alive', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff',
    });
    request.raw.socket.setTimeout(0);
    stream.connect(reply.raw, workspaceId);
  });
  app.get<{ Params: { id: string } }>('/api/events/:id', {
    schema: { params: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' },
    } } },
  }, (request, reply) => {
    const event = store.get(request.params.id.toLowerCase(), scope(request));
    return event ?? reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Event not found.' } });
  });

  app.patch<{ Params: { id: string } }>('/api/events/:id/pin', { schema: { params: idSchema } }, (request, reply) => {
    let input: { pinned?: unknown };
    try { input = JSON.parse((request.body as Buffer).toString()) as { pinned?: unknown }; } catch { return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'Invalid pin state.' } }); }
    if (!input || typeof input.pinned !== 'boolean') return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'Invalid pin state.' } });
    if (!store.pin(request.params.id.toLowerCase(), input.pinned, scope(request))) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Event not found.' } });
    return { pinned: input.pinned };
  });

  const launchReplay = async (request: FastifyRequest, reply: FastifyReply, sourceEventId: string | null, savedRequestId?: string) => {
    const workspaceId = scope(request);
    let outgoing: ReturnType<typeof validateReplay>;
    let id: string;
    try {
      const input = JSON.parse((request.body as Buffer).toString()) as Record<string, unknown>;
      const saved = savedRequestId ? store.document('requests', savedRequestId, workspaceId) as SavedRequest : null;
      outgoing = validateReplay(saved && input.destinationUrl === undefined ? saved.request : input, bodyLimit);
      if (input.id !== undefined && (typeof input.id !== 'string' || !new RegExp(uuidPattern).test(input.id))) throw new Error('Invalid execution ID.');
      id = typeof input.id === 'string' ? input.id.toLowerCase() : randomUUID();
    } catch (error) { return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: error instanceof SyntaxError ? 'Invalid JSON.' : error instanceof Error ? error.message : 'Invalid replay.' } }); }
    if (store.hasReplayId(id)) return reply.code(409).send({ error: { code: 'DUPLICATE_EXECUTION', message: 'This execution already exists; no new request was sent.' } });
    if (activeReplays.size >= 10) return reply.code(429).send({ error: { code: 'REPLAY_BUSY', message: 'Wait for a running execution to finish.' } });
    const execution = store.createReplay({ id, sourceEventId, ...(savedRequestId ? { savedRequestId } : {}), executedAt: new Date().toISOString(), state: 'running',
      request: { ...outgoing, bodySize: Buffer.byteLength(outgoing.body.data, 'base64') },
      result: { durationMs: 0, headers: [], contentType: null, body: { encoding: 'base64', data: '' }, bodySize: 0, receivedSize: 0, truncated: false },
    }, workspaceId);
    const controller = new AbortController();
    activeReplays.set(id, controller);
    try {
      execution.result = await executeReplay(outgoing, controller.signal, responseLimit);
      execution.state = 'completed';
      try { store.saveReplay(execution); }
      catch { return reply.code(503).send({ error: { code: 'EXECUTION_NOT_SAVED', message: 'The request was sent, but its result could not be saved. Check the destination before retrying.' } }); }
      return reply.code(201).send(execution);
    } finally { activeReplays.delete(id); }
  };
  app.post<{ Params: { id: string } }>('/api/events/:id/replays', {
    bodyLimit: Math.ceil(bodyLimit * 4 / 3) + 65_536, schema: { params: idSchema },
  }, async (request, reply) => {
    const event = store.get(request.params.id.toLowerCase(), scope(request));
    if (!event) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Event not found.' } });
    return launchReplay(request, reply, event.id);
  });
  registerWorkspaceRoutes(app, store, scope, bodyLimit, launchReplay);

  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>('/api/events/:id/replays', {
    schema: { params: idSchema, querystring: { type: 'object', additionalProperties: false, properties: { cursor: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' } } } },
  }, (request, reply) => {
    const id = request.params.id.toLowerCase();
    if (!store.get(id, scope(request))) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Event not found.' } });
    const cursor = request.query.cursor === undefined ? undefined : Number(request.query.cursor);
    if (cursor !== undefined && !Number.isSafeInteger(cursor)) return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'Invalid pagination.' } });
    return store.listReplays(id, 25, cursor, scope(request));
  });
  app.get<{ Params: { id: string } }>('/api/replays/:id', { schema: { params: idSchema } }, (request, reply) =>
    store.getReplay(request.params.id.toLowerCase(), scope(request)) ?? reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Execution not found.' } }));
  app.delete<{ Params: { id: string } }>('/api/replays/:id', { schema: { params: idSchema } }, (request, reply) => {
    const id = request.params.id.toLowerCase();
    if (!store.getReplay(id, scope(request))) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Execution not found.' } });
    const controller = activeReplays.get(id);
    if (!controller) return reply.code(409).send({ error: { code: 'NOT_RUNNING', message: 'The execution has finished or is not running.' } });
    controller.abort();
    return { cancelled: true };
  });

  if (options.serveWeb) {
    app.register(fastifyStatic, {
      root: fileURLToPath(new URL('../web', import.meta.url)),
      setHeaders(response) {
        response.header('content-security-policy', "default-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
        response.header('referrer-policy', 'no-referrer');
      },
    });
  }
  return app;
}
