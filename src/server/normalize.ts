import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Header, Values, WebhookEvent } from '../shared/contracts.js';
import { detectProvider } from '../shared/providers.js';

export type EventMetadata = Omit<WebhookEvent, 'rawBody' | 'sequence'>;

export function normalize(request: FastifyRequest, body: Buffer, receivedAt: string): Omit<EventMetadata, 'response'> {
  const requestTarget = request.raw.url ?? request.url;
  const separator = requestTarget.indexOf('?');
  const query: Values = Object.create(null) as Values;
  for (const [name, value] of new URLSearchParams(separator < 0 ? '' : requestTarget.slice(separator + 1))) {
    const existing = query[name];
    query[name] = existing === undefined ? value : [...(Array.isArray(existing) ? existing : [existing]), value];
  }
  const headers: Header[] = [];
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    headers.push([request.raw.rawHeaders[index]!, request.raw.rawHeaders[index + 1]!]);
  }
  let payload: unknown;
  if (body.length <= 1_048_576 && (!request.headers['content-encoding'] || request.headers['content-encoding'] === 'identity')) {
    try { payload = JSON.parse(body.toString('utf8')); } catch { /* Provider detection does not require valid JSON. */ }
  }
  return {
    id: randomUUID(), method: request.method, provider: detectProvider({ headers, payload }),
    path: separator < 0 ? requestTarget : requestTarget.slice(0, separator),
    requestTarget, httpVersion: request.raw.httpVersion, receivedAt,
    headers, query, contentType: request.headers['content-type'] ?? null,
    contentEncoding: request.headers['content-encoding'] ?? null,
    userAgent: request.headers['user-agent'] ?? null,
    sourceIp: request.raw.socket.remoteAddress ?? null,
    bodySize: body.length, responseStatus: 200, durationMs: 0,
  };
}
