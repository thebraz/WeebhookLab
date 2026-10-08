import type { FastifyReply } from 'fastify';
import type { Header } from '../shared/contracts.js';
import type { MockResponse } from '../shared/workspaces.js';

export function webhookResponse(reply: FastifyReply, config?: MockResponse): { headers: Header[]; body: string } {
  const body = config?.body ?? JSON.stringify({ received: true });
  const headers: Header[] = config ? config.headers.map(([name, value]) => [name.toLowerCase(), value]) : [['content-type', 'application/json; charset=utf-8']];
  const noBody = [204, 304].includes(config?.status ?? 200);
  if (noBody) { for (let i = headers.length - 1; i >= 0; i--) if (headers[i]![0] === 'content-type') headers.splice(i, 1); }
  else {
    if (!headers.some(([name]) => name === 'content-type')) headers.push(['content-type', 'text/plain; charset=utf-8']);
    headers.push(['content-length', String(Buffer.byteLength(body))]);
  }
  for (let i = headers.length - 1; i >= 0; i--) if (headers[i]![0] === 'x-content-type-options') headers.splice(i, 1);
  headers.push(['x-content-type-options', 'nosniff']);
  reply.code(config?.status ?? 200);
  for (const name of new Set(headers.map(([name]) => name))) {
    const values = headers.filter(([key]) => key === name).map(([, value]) => value);
    reply.header(name, values.length === 1 ? values[0]! : values);
  }
  return { headers, body };
}
