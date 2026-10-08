import { isEvent, isPage, isReplay, isReplayPage, type EventFilters, type EventPage, type ReplayExecution, type ReplayPage, type ReplayRequest, type WebhookEvent } from '../shared/contracts';
import type { DocumentKind, EndpointOverview, Workspace, WorkspaceConfiguration, WorkspaceDocument } from '../shared/workspaces';
let activeWorkspaceId = '';
export const setApiWorkspace = (id: string) => { activeWorkspaceId = id; };

async function request<T>(path: string, validate: (value: unknown) => value is T, signal: AbortSignal, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, headers: { ...init.headers, ...(activeWorkspaceId ? { 'x-workspace-id': activeWorkspaceId } : {}) }, signal, cache: 'no-store' });
  if (!response.ok) {
    const problem = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    if (typeof problem?.error?.message === 'string') throw new Error(problem.error.message);
    if (response.status === 404) throw new Error('Event not found.');
    if (response.status === 503) throw new Error('The local database is unavailable or the record is invalid.');
    throw new Error('Unable to load events.');
  }
  const value: unknown = await response.json();
  if (!validate(value)) throw new Error('The server returned invalid data.');
  return value;
}

export const listEvents = (signal: AbortSignal, cursor?: number, filters: EventFilters = {}): Promise<EventPage> => {
  const params = new URLSearchParams({ limit: '50', ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)) });
  if (cursor !== undefined) params.set('cursor', String(cursor));
  return request(`/api/events?${params}`, isPage, signal);
};
export const getEvent = (id: string, signal: AbortSignal): Promise<WebhookEvent> => request(`/api/events/${encodeURIComponent(id)}`, isEvent, signal);
export const listReplays = (id: string, signal: AbortSignal, cursor?: number, saved = false): Promise<ReplayPage> => request(`/api/${saved ? 'requests' : 'events'}/${id}/replays${cursor === undefined ? '' : `?cursor=${cursor}`}`, isReplayPage, signal);
export const getReplay = (id: string, signal: AbortSignal): Promise<ReplayExecution> => request(`/api/replays/${id}`, isReplay, signal);
export const runReplay = (sourceId: string, id: string, value: ReplayRequest, saved = false): Promise<ReplayExecution> => request(`/api/${saved ? 'requests' : 'events'}/${sourceId}/replays`, isReplay, new AbortController().signal, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...value, id }),
});
export const cancelReplay = (id: string): Promise<{ cancelled: boolean }> => request(`/api/replays/${id}`, (value): value is { cancelled: boolean } => !!value && typeof value === 'object' && 'cancelled' in value, new AbortController().signal, { method: 'DELETE' });
export const pinEvent = (id: string, pinned: boolean): Promise<{ pinned: boolean }> => request(`/api/events/${id}/pin`, (value): value is { pinned: boolean } => !!value && typeof value === 'object' && 'pinned' in value && typeof value.pinned === 'boolean', new AbortController().signal, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pinned }) });

export const formatTime = (time: string): string => new Date(time).toLocaleTimeString('en-US', { hour12: false });
export const formatBytes = (bytes: number): string => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;

export async function copyText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
}

const signal = () => new AbortController().signal;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
export const getWorkspaces = () => request('/api/workspaces', (v): v is { workspaces: Workspace[]; activeId: string } => record(v) && Array.isArray(v.workspaces) && typeof v.activeId === 'string', signal());
export const createWorkspace = (name: string) => request('/api/workspaces', (v): v is Workspace => record(v) && typeof v.id === 'string' && typeof v.name === 'string', signal(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
export const activateWorkspace = (id: string) => request(`/api/workspaces/${id}/active`, (v): v is { activeId: string } => record(v) && typeof v.activeId === 'string', signal(), { method: 'PUT' });
export const getConfiguration = () => request('/api/configuration', (v): v is WorkspaceConfiguration => record(v) && ['requests', 'mocks', 'bindings', 'transformations'].every((key) => Array.isArray(v[key])), signal());
export const putDocument = <T extends WorkspaceDocument>(kind: DocumentKind, value: T): Promise<T> => request(`/api/${kind}/${value.id}`, (v): v is T => record(v) && v.id === value.id, signal(), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
export const deleteDocument = (kind: DocumentKind, id: string) => request(`/api/${kind}/${id}`, (v): v is { deleted: boolean } => record(v) && v.deleted === true, signal(), { method: 'DELETE' });
export const getEndpoints = () => request('/api/endpoints', (v): v is { endpoints: EndpointOverview[] } => record(v) && Array.isArray(v.endpoints), signal());
export const importWorkspace = (text: string) => request('/api/workspaces/import', (v): v is Workspace => record(v) && typeof v.id === 'string' && typeof v.name === 'string', signal(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: text });
export async function exportWorkspace(secrets: boolean): Promise<void> {
  const response = await fetch(`/api/workspaces/export${secrets ? '?secrets=include' : ''}`, { headers: { 'x-workspace-id': activeWorkspaceId }, cache: 'no-store' });
  if (!response.ok) { const error = await response.json() as { error: { message: string } }; throw new Error(error.error.message); }
  const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = url; link.download = 'weebhooklab-workspace.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
