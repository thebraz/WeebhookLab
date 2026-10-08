import { request as httpRequest, validateHeaderName, validateHeaderValue } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { base64Pattern, type ReplayExecution, type ReplayRequest } from '../shared/contracts.js';
import { destination, replayHeaders } from '../shared/replay.js';

export function validateReplay(value: unknown, bodyLimit: number): ReplayRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid replay configuration.');
  const input = value as ReplayRequest;
  const url = destination(typeof input.destinationUrl === 'string' ? input.destinationUrl : '');
  if (typeof input.method !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Z-]{1,32}$/.test(input.method) || input.method === 'CONNECT') throw new Error('Invalid or unsupported HTTP method.');
  if (!Array.isArray(input.headers) || input.headers.length > 100) throw new Error('Use up to 100 headers.');
  let headerSize = 0;
  for (const pair of input.headers) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some((part) => typeof part !== 'string')) throw new Error('Invalid header.');
    try { validateHeaderName(pair[0]); validateHeaderValue(pair[0], pair[1]); } catch { throw new Error('Invalid header name or value.'); }
    headerSize += Buffer.byteLength(pair[0]) + Buffer.byteLength(pair[1]);
  }
  if (headerSize > 32_768) throw new Error('Headers exceed 32 KB.');
  if (!input.body || input.body.encoding !== 'base64' || typeof input.body.data !== 'string' || !base64Pattern.test(input.body.data)) throw new Error('Invalid Base64 body.');
  if (Buffer.byteLength(input.body.data, 'base64') > bodyLimit) throw new Error(`Body exceeds ${bodyLimit} bytes.`);
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 120_000) throw new Error('Timeout must be between 100 and 120,000 ms.');
  return { destinationUrl: url.href, method: input.method, headers: replayHeaders(input.headers), body: { ...input.body }, timeoutMs: input.timeoutMs };
}

const failures: Record<string, string> = {
  CONNECTION_REFUSED: 'Connection refused by the destination.', DNS_FAILURE: 'Unable to resolve the destination hostname.',
  TIMEOUT: 'Request timed out.', CANCELLED: 'Execution cancelled by the user.',
  CONNECTION_TERMINATED: 'The destination closed the connection before completing the response.',
  TLS_ERROR: 'TLS connection failed. Check the destination certificate.', INTERNAL_ERROR: 'Internal error while executing the request.',
};

export async function executeReplay(request: ReplayRequest, signal: AbortSignal, responseLimit: number): Promise<ReplayExecution['result']> {
  const startedAt = performance.now();
  return new Promise((resolve) => {
    const result: ReplayExecution['result'] = { durationMs: 0, headers: [], contentType: null, body: { encoding: 'base64', data: '' }, bodySize: 0, receivedSize: 0, truncated: false };
    const chunks: Buffer[] = [];
    let finished = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; finish('TIMEOUT'); outgoing.destroy(); }, request.timeoutMs);
    const finish = (code?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      result.body.data = Buffer.concat(chunks, result.bodySize).toString('base64');
      result.durationMs = Number((performance.now() - startedAt).toFixed(3));
      if (code) result.error = { code, message: failures[code] ?? failures.INTERNAL_ERROR! };
      resolve(result);
    };
    const cancel = () => { finish('CANCELLED'); outgoing.destroy(); };
    const url = new URL(request.destinationUrl);
    const bytes = Buffer.from(request.body.data, 'base64');
    let outgoing: ReturnType<typeof httpRequest>;
    try {
      const headers = request.headers.flatMap(([name, value]) => [name, value]);
      headers.push('Host', url.host, 'Content-Length', String(bytes.length), 'Connection', 'close');
      outgoing = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: request.method, headers, agent: false }, (response) => {
        result.status = response.statusCode!;
        result.statusText = response.statusMessage ?? '';
        for (let i = 0; i < response.rawHeaders.length; i += 2) result.headers.push([response.rawHeaders[i]!, response.rawHeaders[i + 1]!]);
        result.contentType = response.headers['content-type'] ?? null;
        response.on('data', (chunk: Buffer) => {
          if (finished) return;
          result.receivedSize += chunk.length;
          const retained = chunk.subarray(0, Math.max(0, responseLimit - result.bodySize));
          if (retained.length) chunks.push(retained);
          result.bodySize += retained.length;
          if (result.receivedSize > responseLimit) {
            result.truncated = true;
            finish();
            response.destroy(); outgoing.destroy();
          }
        });
        response.on('end', () => finish());
        response.on('error', () => finish(timedOut ? 'TIMEOUT' : signal.aborted ? 'CANCELLED' : 'CONNECTION_TERMINATED'));
        response.on('aborted', () => finish(timedOut ? 'TIMEOUT' : signal.aborted ? 'CANCELLED' : 'CONNECTION_TERMINATED'));
      });
    } catch { finish('INTERNAL_ERROR'); return; }
    outgoing.on('error', (error: NodeJS.ErrnoException) => {
      const code = timedOut ? 'TIMEOUT' : signal.aborted ? 'CANCELLED' : error.code === 'ECONNREFUSED' ? 'CONNECTION_REFUSED'
        : ['ENOTFOUND', 'EAI_AGAIN'].includes(error.code ?? '') ? 'DNS_FAILURE'
        : ['ECONNRESET', 'EPIPE', 'HPE_INVALID_CONSTANT'].includes(error.code ?? '') ? 'CONNECTION_TERMINATED'
        : /CERT|SSL|TLS/.test(error.code ?? '') ? 'TLS_ERROR' : 'INTERNAL_ERROR';
      finish(code);
    });
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    outgoing.end(bytes);
  });
}
