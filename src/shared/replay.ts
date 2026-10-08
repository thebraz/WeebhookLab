import { base64Pattern, type Header, type ReplayRequest, type WebhookEvent } from './contracts.js';

export const sensitiveHeader = (name: string): boolean => /authorization|cookie|token|api[-_]?key|secret|signature|credential/i.test(name);
const transportHeaders = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade', 'expect']);

export function replayErrorText(message: string): string {
  const historical: Record<string, string> = {
    'Conexão recusada pelo destino.': 'Connection refused by the destination.',
    'Não foi possível resolver o nome do destino.': 'Unable to resolve the destination hostname.',
    'Tempo limite da requisição excedido.': 'Request timed out.',
    'Execução cancelada pelo usuário.': 'Execution cancelled by the user.',
    'O destino encerrou a conexão antes de concluir a resposta.': 'The destination closed the connection before completing the response.',
    'Falha na conexão TLS. Verifique o certificado do destino.': 'TLS connection failed. Check the destination certificate.',
    'Falha interna ao executar a requisição.': 'Internal error while executing the request.',
    'Execução interrompida; o destino pode ter recebido o pedido.': 'Execution interrupted; the destination may have received the request.',
    'Execução importada sem resultado final; nenhum envio foi feito.': 'Execution imported without a final result; no request was sent.',
  };
  return Object.hasOwn(historical, message) ? historical[message]! : message;
}

export function replayHeaders(headers: Header[]): Header[] {
  const blocked = new Set(transportHeaders);
  for (const [name, value] of headers) if (name.toLowerCase() === 'connection') {
    for (const token of value.split(',')) blocked.add(token.trim().toLowerCase());
  }
  return headers.filter(([name]) => !blocked.has(name.toLowerCase())).map(([name, value]) => [name, value]);
}

export function destination(value: string): URL {
  if (!value || value.length > 8192 || /\s/.test(value) || Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new Error('Provide a valid HTTP or HTTPS URL with special characters encoded.');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Provide an absolute URL, including http:// or https://.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
    throw new Error('Use HTTP or HTTPS without credentials in the URL or fragments.');
  }
  return url;
}

export function localDestination(url: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
}

export function capturedRequest(event: WebhookEvent): ReplayRequest {
  return { destinationUrl: new URL(event.requestTarget, 'http://localhost:3000').href, method: event.method,
    headers: replayHeaders(event.headers), body: { ...event.rawBody }, timeoutMs: 10_000 };
}

export function queryPairs(url: string): Header[] {
  try { return Array.from(new URL(url).searchParams); } catch { return []; }
}

export function withQuery(url: string, entries: Header[]): string {
  const parsed = destination(url);
  const search = new URLSearchParams();
  for (const [name, value] of entries) search.append(name, value);
  parsed.search = search.toString();
  return parsed.href;
}

export function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

export function editableText(body: ReplayRequest['body'], headers: Header[]): string | null {
  const type = headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '';
  const encoding = headers.find(([name]) => name.toLowerCase() === 'content-encoding')?.[1];
  const charset = type.match(/charset\s*=\s*"?([^;"\s]+)/i)?.[1]?.toLowerCase() ?? 'utf-8';
  if ((encoding && encoding.toLowerCase() !== 'identity') || !['utf-8', 'utf8'].includes(charset)
    || /^(multipart\/|application\/octet-stream|image\/|audio\/|video\/|font\/)/i.test(type)) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(atob(body.data), (c) => c.charCodeAt(0)));
    for (const c of text) if (c.charCodeAt(0) < 32 && !['\t', '\r', '\n'].includes(c)) return null;
    return text;
  } catch { return null; }
}

export type CurlShell = 'posix' | 'powershell';
const posixQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const psQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const configQuote = (value: string): string => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\r', '\\r').replaceAll('\n', '\\n')}"`;

export function curlCommand(request: ReplayRequest, shell: CurlShell, includeSensitive = false): string {
  const url = destination(request.destinationUrl).href;
  if (!/^[!#$%&'*+.^_`|~0-9A-Z-]{1,32}$/.test(request.method) || request.method === 'CONNECT') throw new Error('Invalid HTTP method.');
  const headers = replayHeaders(request.headers).filter(([name]) => includeSensitive || !sensitiveHeader(name));
  if (!base64Pattern.test(request.body.data) || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 100 || request.timeoutMs > 120_000) throw new Error('Invalid body or timeout.');
  for (const [name, value] of headers) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || Array.from(value).some((c) => (c.charCodeAt(0) < 32 && c !== '\t') || c.charCodeAt(0) === 127 || c.charCodeAt(0) > 255)) throw new Error('Invalid header name or value.');
  }
  if (request.method === 'HEAD' && request.body.data) throw new Error('cURL does not support HEAD with a body in this format. Use replay in the application.');
  const headerArgument = (name: string, value: string) => value === '' ? `${name};` : `${name}: ${value}`;
  if (shell === 'posix') {
    const args = ['curl', '--globoff', '--max-time', String(request.timeoutMs / 1000), '--request', posixQuote(request.method), '--url', posixQuote(url)];
    if (request.method === 'HEAD') args.push('--head');
    for (const [name, value] of headers) {
      const header = headerArgument(name, value);
      args.push('--header', Array.from(header).some((c) => c.charCodeAt(0) > 127)
        ? `"$(printf '%s' ${posixQuote(btoa(header))} | base64 --decode)"` : posixQuote(header));
    }
    if (request.body.data) args.push('--data-binary', '@-');
    // printf receives only Base64; payload bytes never become shell source.
    return (request.body.data ? `printf '%s' ${posixQuote(request.body.data)} | base64 --decode | ` : '') + args.join(' ');
  }
  const config = [`request = ${configQuote(request.method)}`, `url = ${configQuote(url)}`, 'globoff', `max-time = ${request.timeoutMs / 1000}`,
    ...(request.method === 'HEAD' ? ['head'] : [])];
  const headerLines = headers.map(([name, value]) => psQuote(headerArgument(name, value)));
  return `$configFile = [IO.Path]::GetTempFileName()\n$bodyFile = [IO.Path]::GetTempFileName()\n$headerFile = [IO.Path]::GetTempFileName()\ntry {\n  [IO.File]::WriteAllBytes($bodyFile, [Convert]::FromBase64String(${psQuote(request.body.data)}))\n  $headers = @(\n    ${headerLines.join('\n    ')}\n  )\n  [IO.File]::WriteAllLines($headerFile, [string[]]$headers, [Text.Encoding]::GetEncoding(28591))\n  $config = @(\n    ${config.map(psQuote).join('\n    ')}\n  )\n  $config += 'header = "@' + $headerFile.Replace('\\', '\\\\').Replace('"', '\\"') + '"'\n${request.body.data ? `  $config += 'data-binary = "@' + $bodyFile.Replace('\\', '\\\\').Replace('"', '\\"') + '"'\n` : ''}  [IO.File]::WriteAllLines($configFile, $config, [Text.UTF8Encoding]::new($false))\n  curl.exe --config $configFile\n} finally {\n  Remove-Item -LiteralPath $configFile, $bodyFile, $headerFile -Force\n}`;
}
