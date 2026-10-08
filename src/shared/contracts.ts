export type Values = Record<string, string | string[]>;
export type Header = [name: string, value: string];

export interface EventSummary {
  workspaceId?: string;
  provider?: import('./providers.js').Detection;
  id: string;
  sequence: number;
  method: string;
  path: string;
  receivedAt: string;
  contentType: string | null;
  bodySize: number;
  responseStatus: number;
  durationMs: number;
  pinned?: boolean;
}

export interface WebhookEvent extends EventSummary {
  requestTarget: string;
  httpVersion: string;
  headers: Header[];
  query: Values;
  userAgent: string | null;
  sourceIp: string | null;
  contentEncoding: string | null;
  rawBody: { encoding: 'base64'; data: string };
  response: { headers: Header[]; body: string };
}

export interface EventPage {
  events: EventSummary[];
  nextCursor: number | null;
  skippedRecords: number;
}

export interface ApiError { error: { code: string; message: string } }

export interface EventFilters {
  search?: string;
  method?: string;
  status?: string;
  path?: string;
  exactPath?: string;
  contentType?: string;
  from?: string;
  to?: string;
  pinned?: string;
}

export interface ReplayRequest {
  destinationUrl: string;
  method: string;
  headers: Header[];
  body: { encoding: 'base64'; data: string };
  timeoutMs: number;
}

export interface ReplayExecution {
  id: string;
  sequence: number;
  sourceEventId: string | null;
  savedRequestId?: string | null;
  workspaceId?: string;
  executedAt: string;
  state: 'running' | 'completed';
  request: ReplayRequest & { bodySize: number };
  result: {
    status?: number;
    statusText?: string;
    durationMs: number;
    headers: Header[];
    contentType: string | null;
    body: { encoding: 'base64'; data: string };
    bodySize: number;
    receivedSize: number;
    truncated: boolean;
    error?: { code: string; message: string };
  };
}

export type ReplaySummary = Pick<ReplayExecution, 'id' | 'sequence' | 'sourceEventId' | 'executedAt' | 'state'> & {
  method: string; destinationUrl: string; status?: number; durationMs: number; error?: { code: string; message: string };
};
export interface ReplayPage { executions: ReplaySummary[]; nextCursor: number | null }

export const uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
export const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function isReplay(value: unknown): value is ReplayExecution {
  if (!value || typeof value !== 'object') return false;
  const item = value as ReplayExecution;
  return typeof item.id === 'string' && new RegExp(uuidPattern).test(item.id)
    && (item.sourceEventId === null || (typeof item.sourceEventId === 'string' && new RegExp(uuidPattern).test(item.sourceEventId)))
    && (item.savedRequestId === undefined || item.savedRequestId === null || (typeof item.savedRequestId === 'string' && new RegExp(uuidPattern).test(item.savedRequestId)))
    && Number.isSafeInteger(item.sequence) && item.sequence > 0
    && typeof item.executedAt === 'string' && Number.isFinite(Date.parse(item.executedAt))
    && (item.state === 'running' || item.state === 'completed')
    && !!item.request && typeof item.request.destinationUrl === 'string' && typeof item.request.method === 'string'
    && isHeaders(item.request.headers) && item.request.body?.encoding === 'base64'
    && typeof item.request.body.data === 'string' && base64Pattern.test(item.request.body.data)
    && Number.isSafeInteger(item.request.bodySize) && item.request.bodySize >= 0
    && Number.isSafeInteger(item.request.timeoutMs) && item.request.timeoutMs > 0
    && !!item.result && isHeaders(item.result.headers) && item.result.body?.encoding === 'base64'
    && typeof item.result.body.data === 'string' && base64Pattern.test(item.result.body.data)
    && Number.isFinite(item.result.durationMs) && item.result.durationMs >= 0
    && Number.isSafeInteger(item.result.bodySize) && item.result.bodySize >= 0
    && Number.isSafeInteger(item.result.receivedSize) && item.result.receivedSize >= item.result.bodySize
    && typeof item.result.truncated === 'boolean'
    && (item.result.contentType === null || typeof item.result.contentType === 'string')
    && (item.result.status === undefined || (Number.isInteger(item.result.status) && item.result.status >= 100 && item.result.status <= 599))
    && (item.result.error === undefined || (typeof item.result.error.code === 'string' && typeof item.result.error.message === 'string'));
}

export function isReplayPage(value: unknown): value is ReplayPage {
  if (!value || typeof value !== 'object') return false;
  const page = value as ReplayPage;
  return Array.isArray(page.executions) && page.executions.every((item) => typeof item.id === 'string'
    && Number.isSafeInteger(item.sequence) && typeof item.method === 'string' && typeof item.destinationUrl === 'string'
    && (item.sourceEventId === null || typeof item.sourceEventId === 'string') && typeof item.executedAt === 'string' && Number.isFinite(item.durationMs))
    && (page.nextCursor === null || (Number.isSafeInteger(page.nextCursor) && page.nextCursor > 0));
}

export function isSummary(value: unknown): value is EventSummary {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  return typeof event.id === 'string' && /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(event.id)
    && typeof event.sequence === 'number' && Number.isSafeInteger(event.sequence) && event.sequence > 0
    && typeof event.method === 'string' && typeof event.path === 'string'
    && typeof event.receivedAt === 'string' && Number.isFinite(Date.parse(event.receivedAt))
    && (event.contentType === null || typeof event.contentType === 'string')
    && typeof event.bodySize === 'number' && Number.isSafeInteger(event.bodySize) && event.bodySize >= 0
    && typeof event.responseStatus === 'number' && Number.isInteger(event.responseStatus) && event.responseStatus >= 100 && event.responseStatus <= 599
    && typeof event.durationMs === 'number' && Number.isFinite(event.durationMs) && event.durationMs >= 0;
}

function isHeaders(value: unknown): value is Header[] {
  return Array.isArray(value) && value.every((item: unknown) => Array.isArray(item) && item.length === 2 && item.every((part: unknown) => typeof part === 'string'));
}

export function isEvent(value: unknown): value is WebhookEvent {
  if (!isSummary(value)) return false;
  const event = value as unknown as Record<string, unknown>;
  const raw = event.rawBody as Record<string, unknown> | undefined;
  const response = event.response as Record<string, unknown> | undefined;
  return typeof event.requestTarget === 'string' && typeof event.httpVersion === 'string'
    && isHeaders(event.headers) && typeof event.query === 'object' && event.query !== null
    && !Array.isArray(event.query) && Object.values(event.query).every((part: unknown) => typeof part === 'string' || (Array.isArray(part) && part.every((item: unknown) => typeof item === 'string')))
    && [event.userAgent, event.sourceIp, event.contentEncoding].every((part) => part === null || typeof part === 'string')
    && raw?.encoding === 'base64' && typeof raw.data === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw.data)
    && response !== null && response !== undefined && isHeaders(response.headers) && typeof response.body === 'string';
}

export function isPage(value: unknown): value is EventPage {
  if (typeof value !== 'object' || value === null) return false;
  const page = value as Record<string, unknown>;
  return Array.isArray(page.events) && page.events.every(isSummary)
    && (page.nextCursor === null || (typeof page.nextCursor === 'number' && Number.isSafeInteger(page.nextCursor) && page.nextCursor > 0))
    && typeof page.skippedRecords === 'number' && Number.isSafeInteger(page.skippedRecords) && page.skippedRecords >= 0;
}
