import type { Values, WebhookEvent } from '../shared/contracts';
import { checkJson } from '../shared/json';
export { sensitiveHeader } from '../shared/replay';

export type PayloadView =
  | { kind: 'empty' }
  | { kind: 'json' | 'text' | 'invalid-json' | 'limited-json'; text: string; original: string }
  | { kind: 'form'; values: Values; original: string }
  | { kind: 'multipart'; parts: { name: string; value: string; size: number; contentType: string | null }[] }
  | { kind: 'binary'; hex: string; reason: string };

export function bodyBytes(event: WebhookEvent): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(event.rawBody.data), (character) => character.charCodeAt(0));
}

export function hexPreview(bytes: Uint8Array): string {
  return Array.from({ length: Math.ceil(Math.min(bytes.length, 256) / 16) }, (_, line) => {
    const offset = line * 16;
    const chunk = bytes.slice(offset, offset + 16);
    const hex = Array.from(chunk, (byte) => byte.toString(16).padStart(2, '0')).join(' ').padEnd(47);
    const text = Array.from(chunk, (byte) => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.').join('');
    return `${offset.toString(16).padStart(8, '0')}  ${hex}  ${text}`;
  }).join('\n');
}

export async function inspectPayload(event: WebhookEvent): Promise<PayloadView> {
  const bytes = bodyBytes(event);
  if (!bytes.length) return { kind: 'empty' };
  const type = event.contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  const binary = (reason: string): PayloadView => ({ kind: 'binary', hex: hexPreview(bytes), reason });
  if (event.contentEncoding && event.contentEncoding.toLowerCase() !== 'identity') return binary(`Body with Content-Encoding: ${event.contentEncoding}. Original bytes have been preserved.`);
  if (type === 'multipart/form-data') {
    try {
      const form = await new Response(new Blob([bytes]), { headers: { 'content-type': event.contentType! } }).formData();
      const parts = Array.from(form, ([name, value]) => typeof value === 'string'
        ? { name, value, size: new TextEncoder().encode(value).length, contentType: null }
        : { name, value: value.name, size: value.size, contentType: value.type || 'application/octet-stream' });
      return { kind: 'multipart', parts };
    } catch { return binary('Invalid or incomplete multipart data. See the preserved bytes in Raw.'); }
  }
  if (type === 'application/octet-stream' || /^(image|audio|video|font)\//.test(type)) return binary('Binary content. Preview of the first 256 bytes.');
  const charset = event.contentType?.match(/charset\s*=\s*"?([^;"\s]+)/i)?.[1] ?? 'utf-8';
  let text: string;
  try { text = new TextDecoder(charset, { fatal: true }).decode(bytes); }
  catch { return binary(`Unable to display the body as text (${charset}).`); }
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return binary('The body contains control bytes. Preview of the first 256 bytes.');
  }
  if (type === 'application/json' || type.endsWith('+json')) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return { kind: 'invalid-json', text, original: text }; }
    try { checkJson(parsed); } catch { return { kind: 'limited-json', text: 'JSON exceeds 64 levels, 20,000 values, or 1 MB. Original bytes remain available in Raw.', original: text }; }
    return { kind: 'json', text: JSON.stringify(parsed, null, 2), original: text };
  }
  if (type === 'application/x-www-form-urlencoded') {
    const values: Values = Object.create(null) as Values;
    for (const [name, value] of new URLSearchParams(text)) {
      const previous = values[name];
      values[name] = previous === undefined ? value : [...(Array.isArray(previous) ? previous : [previous]), value];
    }
    return { kind: 'form', values, original: text };
  }
  return { kind: 'text', text, original: text };
}

