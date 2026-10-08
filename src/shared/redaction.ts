import type { Header, ReplayRequest } from './contracts.js';
import { editableText, sensitiveHeader, utf8Base64 } from './replay.js';
import { checkJson, parsePath, type Json } from './json.js';
export const MASK = '******** [hidden]';
export const sensitiveField = (name: string): boolean => sensitiveHeader(name) || /^(password|passwd|pwd|sessionid|privatekey)$/i.test(name.replace(/[-_]/g, ''));
export function sensitivePath(path: string): boolean {
  try { return parsePath(path).some((part) => typeof part === 'string' && (sensitiveField(part) || sensitiveHeader(part))); }
  catch { return true; }
}
export const redactHeaders = (headers: Header[]): Header[] => headers.map(([name, value]) => [name, sensitiveHeader(name) ? MASK : value]);
export function redactJson(value: unknown): Json {
  checkJson(value);
  const visit = (item: Json): Json => {
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, sensitiveField(key) ? MASK : visit(child)]));
  };
  return visit(value);
}
export function redactText(text: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { return text.replace(/((?:"(?:password|token|secret|api[_-]?key|access_token|refresh_token)"|(?:password|token|secret|api[_-]?key|access_token|refresh_token))\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"?|[^\s&;,]+)/gi, `$1${JSON.stringify(MASK)}`); }
  try { return JSON.stringify(redactJson(parsed), null, 2); } catch { return `${MASK} · JSON exceeds inspection limits.`; }
}
export function redactUrl(value: string): string {
  try { const url = new URL(value, 'http://local'); for (const key of [...url.searchParams.keys()]) if (sensitiveField(key)) url.searchParams.set(key, MASK);
    return value.startsWith('/') ? url.pathname + url.search : url.href;
  } catch { return MASK; }
}
export function redactBody(body: ReplayRequest['body'], headers: Header[]): ReplayRequest['body'] {
  const text = editableText(body, headers);
  if (text === null) return { encoding: 'base64', data: '' };
  if (headers.some(([name, value]) => name.toLowerCase() === 'content-type' && /^application\/x-www-form-urlencoded(?:;|$)/i.test(value))) {
    const fields = new URLSearchParams(text);
    if ([...fields.keys()].some(sensitiveField)) return { encoding: 'base64', data: utf8Base64(new URLSearchParams([...fields].map(([key, value]) => [key, sensitiveField(key) ? MASK : value])).toString()) };
    return { ...body };
  }
  const redacted = redactText(text);
  return redacted.includes(MASK) ? { encoding: 'base64', data: utf8Base64(redacted) } : { ...body };
}
export function redactRequest(request: ReplayRequest): ReplayRequest {
  return { ...request, destinationUrl: redactUrl(request.destinationUrl), headers: redactHeaders(request.headers), body: redactBody(request.body, request.headers) };
}
