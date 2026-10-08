import type { Header, ReplayExecution, ReplayRequest, WebhookEvent } from './contracts.js';
import { editableText, queryPairs } from './replay.js';
import { checkJson, formatPath, type Json, type JsonPath } from './json.js';

export type DiffChangeType = 'added' | 'removed' | 'modified' | 'type-changed';
export interface DiffChange { path: string; type: DiffChangeType; previous?: Json; current?: Json }
export interface DiffResult { changes: DiffChange[]; notices: string[]; truncated: boolean }
const kind = (value: Json) => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

export function diffJson(previous: unknown, current: unknown, root: JsonPath = []): DiffResult {
  const result: DiffResult = { changes: [], notices: [], truncated: false };
  try { checkJson(previous); checkJson(current); }
  catch (error) { result.notices.push(error instanceof Error ? error.message : 'Invalid JSON.'); return result; }
  const emit = (path: JsonPath, type: DiffChangeType, a?: Json, b?: Json) => {
    if (result.changes.length >= 1000) { result.truncated = true; return; }
    result.changes.push({ path: formatPath(path), type, ...(a === undefined ? {} : { previous: a }), ...(b === undefined ? {} : { current: b }) });
  };
  const visit = (a: Json, b: Json, path: JsonPath): void => {
    if (result.truncated || Object.is(a, b)) return;
    if (kind(a) !== kind(b)) { emit(path, 'type-changed', a, b); return; }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      const keys = Array.isArray(a) && Array.isArray(b) ? Array.from({ length: Math.max(a.length, b.length) }, (_, i) => i)
        : [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
      for (const key of keys) {
        const left = (a as Record<string | number, Json>)[key]; const right = (b as Record<string | number, Json>)[key];
        if (!Object.hasOwn(a, key)) emit([...path, key], 'added', undefined, right);
        else if (!Object.hasOwn(b, key)) emit([...path, key], 'removed', left);
        else visit(left!, right!, [...path, key]);
        if (result.truncated) break;
      }
    } else emit(path, 'modified', a, b);
  };
  visit(previous, current, root);
  return result;
}

function headerMap(headers: Header[]): { [key: string]: Json } {
  const result: { [key: string]: Json } = Object.create(null) as { [key: string]: Json };
  for (const [name, value] of headers) {
    const key = name.toLowerCase(); const old = result[key];
    result[key] = old === undefined ? [value] : [...old as Json[], value];
  }
  return result;
}

function bodyDiff(a: ReplayRequest['body'], ah: Header[], b: ReplayRequest['body'], bh: Header[]): DiffResult {
  const result: DiffResult = { changes: [], notices: [], truncated: false };
  if (a.data.length > 1_398_104 || b.data.length > 1_398_104) { result.notices.push('Body exceeds the 1 MB comparison limit.'); return result; }
  const left = editableText(a, ah); const right = editableText(b, bh);
  if (left === null || right === null) { result.notices.push(`Binary or compressed body, or unsupported charset: ${a.data === b.data ? 'identical bytes' : 'different bytes'}; no text diff.`); return result; }
  const json = (headers: Header[]) => /^(application\/json|[^;]+\+json)(;|$)/i.test(headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '');
  if (json(ah) && json(bh)) {
    try { return diffJson(JSON.parse(left), JSON.parse(right), ['body']); }
    catch { result.notices.push('Invalid JSON: comparing the body as text.'); }
  }
  const text = diffJson(left.split('\n'), right.split('\n'), ['body', 'lines']);
  return { ...text, notices: [...result.notices, ...text.notices] };
}

function merge(a: DiffResult, b: DiffResult): DiffResult {
  return { changes: [...a.changes, ...b.changes].slice(0, 1000), notices: [...a.notices, ...b.notices], truncated: a.truncated || b.truncated || a.changes.length + b.changes.length > 1000 };
}

export function compareRequests(a: ReplayRequest, b: ReplayRequest): DiffResult {
  const normalize = (r: ReplayRequest) => { const url = new URL(r.destinationUrl); return { method: r.method, origin: url.origin, path: url.pathname,
    query: headerMap(queryPairs(r.destinationUrl)), headers: headerMap(r.headers), contentType: r.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? null, timeoutMs: r.timeoutMs }; };
  return merge(diffJson(normalize(a), normalize(b)), bodyDiff(a.body, a.headers, b.body, b.headers));
}

export function compareEvents(a: WebhookEvent, b: WebhookEvent): DiffResult {
  const normalize = (e: WebhookEvent) => ({ method: e.method, path: e.path, query: e.query, headers: headerMap(e.headers), contentType: e.contentType });
  return merge(diffJson(normalize(a), normalize(b)), bodyDiff(a.rawBody, a.headers, b.rawBody, b.headers));
}

export function compareResponses(a: ReplayExecution['result'], b: ReplayExecution['result']): DiffResult {
  const normalize = (r: ReplayExecution['result']) => ({ status: r.status ?? null, durationMs: r.durationMs, headers: headerMap(r.headers),
    error: r.error ? { code: r.error.code, message: r.error.message } : null, truncated: r.truncated });
  const result = merge(diffJson(normalize(a), normalize(b)), bodyDiff(a.body, a.headers, b.body, b.headers));
  if (a.error || b.error) result.notices.push('Execution errors are separate from HTTP status; bodies may be partial.');
  if (a.truncated || b.truncated) result.notices.push('Comparison is limited to retained response bytes.');
  return result;
}
