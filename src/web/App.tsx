import { useCallback, useEffect, useRef, useState } from 'react';
import { isSummary, type EventFilters, type EventSummary } from '../shared/contracts';
import { activateWorkspace, copyText, getWorkspaces, listEvents, setApiWorkspace } from './api';
import EventList from './EventList';
import Inspector from './Inspector';
import { typingTarget } from './shortcuts';
import type { Workspace } from '../shared/workspaces';
import LibraryPanel from './LibraryPanel';
import EventComparison from './EventComparison';
import CommandPalette from './CommandPalette';
import type { EditorState } from './replayEditor';

function localTime(time: string): string {
  const date = new Date(time);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function mergeEvents(first: EventSummary[], second: EventSummary[]): EventSummary[] {
  const merged = new Map(second.map((event) => [event.id, event]));
  for (const event of first) {
    const previous = merged.get(event.id);
    merged.set(event.id, previous && JSON.stringify(previous) === JSON.stringify(event) ? previous : event);
  }
  return Array.from(merged.values()).sort((a, b) => b.sequence - a.sequence);
}

export default function App() {
  const captureUrl = new URL(window.location.origin);
  if (import.meta.env.DEV) captureUrl.port = '5050';
  const endpoint = `${captureUrl.origin}/hooks/test`;
  const command = `Invoke-WebRequest -Method Post -Uri '${endpoint}' -ContentType 'application/json' -Body '{"event":"hello.world"}'`;
  const editorCache = useRef(new Map<string, EditorState>());
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [inspectorCommand, setInspectorCommand] = useState<string | null>(null);
  const [section, setSection] = useState<'events' | 'requests' | 'endpoints' | 'workspaces'>('events');
  const [compared, setCompared] = useState<string[]>([]); const [comparing, setComparing] = useState(false);
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'reconnecting' | 'disconnected'>('connecting');
  const [initialization, setInitialization] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [skipped, setSkipped] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [copied, setCopied] = useState('');
  const refreshRef = useRef<(preservePages?: boolean) => void>(() => {});
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const libraryDirty = useRef(false);
  const setLibraryDirty = useCallback((dirty: boolean) => { libraryDirty.current = dirty; }, []);
  const canLeaveLibrary = () => !libraryDirty.current || window.confirm('Discard unsaved endpoint configuration changes?');
  const navigateSection = (next: typeof section) => { if (next === section || canLeaveLibrary()) { setSection(next); return true; } return false; };
  const selectEvent = useCallback((id: string) => { setSelectedId(id); setComparing(false); }, []);
  const compareEvent = useCallback((id: string) => setCompared((old) => old.includes(id) ? old.filter((value) => value !== id) : old.length < 2 ? [...old, id] : old), []);
  const pinChanged = (id: string, pinned: boolean) => {
    setEvents((current) => current.flatMap((event) => event.id === id ? filters.pinned === '1' && !pinned ? [] : [{ ...event, pinned }] : [event]));
    refreshRef.current(true);
  };
  const pagingGeneration = useRef(0);
  const [filters, setFilters] = useState<EventFilters>({});
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const filterKey = JSON.stringify(filters);
  const refreshWorkspaces = async () => { const state = await getWorkspaces(); setWorkspaces(state.workspaces); return state; };
  useEffect(() => { let active = true; void getWorkspaces().then((state) => { if (active) { setWorkspaces(state.workspaces); setApiWorkspace(state.activeId); setWorkspaceId(state.activeId); } }).catch((e: unknown) => { if (active) { setError(e instanceof Error ? e.message : 'Workspaces unavailable.'); setLoading(false); setConnection('disconnected'); } }); return () => { active = false; }; }, [initialization]);
  const switchWorkspace = async (id: string) => { if (!canLeaveLibrary()) return; await activateWorkspace(id); setApiWorkspace(id); pagingGeneration.current++; setEvents([]); setSelectedId(null); setCompared([]); setComparing(false); setSearch(''); setFilters({}); setInspectorCommand(null); setWorkspaceId(id); };
  useEffect(() => {
    const timer = setTimeout(() => setFilters((current) => ({ ...current, search })), 250);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (!workspaceId) return;
    const controller = new AbortController();
    const activeFilters = JSON.parse(filterKey) as EventFilters;
    setLoading(true);
    let refreshing = false;
    let pendingRefresh = false;
    let pendingPreserve = true;
    const refresh = async (preservePages = false) => {
      if (refreshing) { pendingRefresh = true; pendingPreserve = pendingPreserve && preservePages; return; }
      refreshing = true;
      pagingGeneration.current++;
      try {
        const page = await listEvents(controller.signal, undefined, activeFilters);
        if (controller.signal.aborted) return;
        const keepOlderPages = preservePages && eventsRef.current.some((event) => event.sequence < (page.events.at(-1)?.sequence ?? Infinity));
        setEvents((current) => preservePages ? mergeEvents(page.events, current) : page.events);
        if (!keepOlderPages) setCursor(page.nextCursor);
        setSkipped(page.skippedRecords); setError('');
        setSelectedId((current) => current ?? page.events[0]?.id ?? null);
      } catch (failure: unknown) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Server unavailable.');
      } finally {
        refreshing = false;
        if (!controller.signal.aborted) {
          setLoading(false);
          if (pendingRefresh) { const preserve = pendingPreserve; pendingRefresh = false; pendingPreserve = true; void refresh(preserve); }
        }
      }
    };
    refreshRef.current = (preservePages) => { void refresh(preservePages); };
    void refresh();
    return () => controller.abort();
  }, [filterKey, workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const connect = () => {
      clearTimeout(retry);
      source?.close();
      if (!navigator.onLine) { setConnection('disconnected'); return; }
      setConnection(attempts ? 'reconnecting' : 'connecting');
      source = new EventSource(`/api/events/stream?workspace=${encodeURIComponent(workspaceId)}`);
      source.addEventListener('ready', () => { attempts = 0; setConnection('connected'); refreshRef.current(true); });
      source.addEventListener('webhook', (message: MessageEvent<string>) => {
        try {
          const event: unknown = JSON.parse(message.data);
          if (!isSummary(event)) throw new Error();
          if (event.workspaceId === workspaceId) refreshRef.current(true);
        } catch { setError('Invalid notification. Refresh the list to recover events.'); }
      });
      source.onerror = () => {
        source?.close();
        setConnection(navigator.onLine ? 'reconnecting' : 'disconnected');
        retry = setTimeout(connect, Math.min(30_000, 1500 * 2 ** Math.min(attempts++, 5)));
      };
    };
    const offline = () => { clearTimeout(retry); source?.close(); setConnection('disconnected'); };
    connect();
    window.addEventListener('online', connect);
    window.addEventListener('offline', offline);
    return () => { clearTimeout(retry); source?.close(); window.removeEventListener('online', connect); window.removeEventListener('offline', offline); };
  }, [workspaceId]);

  useEffect(() => {
    const handle = (key: KeyboardEvent) => {
      if (section !== 'events' || document.querySelector('dialog[open]') || key.ctrlKey || key.metaKey || key.altKey || key.shiftKey || typingTarget(key.target)) return;
      if (key.key === '/') { key.preventDefault(); searchRef.current?.focus(); return; }
      if (key.key === 'ArrowUp' || key.key === 'ArrowDown') {
        key.preventDefault();
        const index = events.findIndex((event) => event.id === selectedId);
        const next = Math.max(0, Math.min(events.length - 1, index + (key.key === 'ArrowDown' ? 1 : -1)));
        if (events[next]) setSelectedId(events[next].id);
      } else if (key.key === 'Enter' && selectedId && !(key.target instanceof Element && key.target.closest('button, a, summary'))) {
        key.preventDefault(); document.getElementById('inspector-panel')?.focus();
      }
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [events, selectedId, section]);

  const loadMore = async () => {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    const generation = pagingGeneration.current;
    try {
      const page = await listEvents(new AbortController().signal, cursor, filters);
      if (generation !== pagingGeneration.current) return;
      setEvents((current) => mergeEvents(page.events, current));
      setCursor(page.nextCursor); setSkipped((current) => current + page.skippedRecords); setError('');
    } catch (failure: unknown) { setError(failure instanceof Error ? failure.message : 'Unable to load more events.'); }
    finally { setLoadingMore(false); }
  };
  const copy = async (value: string) => {
    try { await copyText(value); setCopied('Copied to clipboard'); }
    catch { setCopied('Unable to copy. Select and copy the text.'); }
  };
  const dispatchCommand = (action: string) => { if (!navigateSection('events')) return; setComparing(false); setInspectorCommand(action); };
  return <div className="app-shell">
    <header className="app-header"><div className="brand"><span className="brand-mark" aria-hidden="true">↳</span><h1>Weebhook<span>Lab</span></h1><span className="local-label">LOCAL</span></div>
      <div className="header-right"><CommandPalette commands={[
        { label: 'Search events', run: () => { if (navigateSection('events')) requestAnimationFrame(() => searchRef.current?.focus()); } },
        { label: 'Replay selected event', disabled: !selectedId, run: () => dispatchCommand('replay') }, { label: 'Edit & Replay', disabled: !selectedId, run: () => dispatchCommand('edit') },
        { label: 'Compare events', run: () => { if (!navigateSection('events')) return; if (compared.length === 2) setComparing(true); else setCopied('Select two events using the checkboxes to compare.'); } },
        { label: 'Copy as cURL', disabled: !selectedId, run: () => dispatchCommand('curl') }, { label: 'Create saved request', run: () => navigateSection('requests') },
        { label: 'Switch workspace', run: () => navigateSection('workspaces') }, { label: 'Configure endpoint', run: () => navigateSection('endpoints') },
      ]} /><code>{captureUrl.host}</code><span className={`connection ${connection}`} role="status"><span className="connection-dot" />{{ connected: 'Listening', connecting: 'Connecting', reconnecting: 'Reconnecting', disconnected: 'Disconnected' }[connection]}</span></div></header>
    <div className="workspace-bar"><div><label>Workspace <select aria-label="Active workspace" value={workspaceId} onChange={(e) => { void switchWorkspace(e.target.value).catch((error: unknown) => setError(error instanceof Error ? error.message : 'Unable to switch workspace.')); }}>{workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label></div><div><code>{captureUrl.origin}/hooks/*</code><button className="text-button" onClick={() => { void copy(endpoint); }}>Copy endpoint</button></div></div>
    <nav className="section-nav" aria-label="Main navigation">{(['events', 'requests', 'endpoints', 'workspaces'] as const).map((s) => <button className="text-button" aria-current={section === s ? 'page' : undefined} key={s} onClick={() => navigateSection(s)}>{{ events: 'Events', requests: 'Requests', endpoints: 'Endpoints', workspaces: 'Workspaces' }[s]}</button>)}</nav>
    {copied && <div className="global-notice" role="status">{copied}</div>}
    {error && <div className="global-notice warning" role="alert">{error} <button className="text-button" onClick={() => workspaceId ? refreshRef.current() : setInitialization((current) => current + 1)}>Try again</button></div>}
    {skipped > 0 && <div className="global-notice warning" role="status">{skipped}  invalid record(s) could not be displayed.</div>}
    {section !== 'events' && workspaceId ? <LibraryPanel key={`${workspaceId}-${section}`} captureEndpoint={endpoint} section={section} workspaces={workspaces} activeId={workspaceId} onDirtyChange={setLibraryDirty} onWorkspaceChange={switchWorkspace} onWorkspaceList={async () => { await refreshWorkspaces(); }} openEndpoint={(path, id) => { if (!navigateSection('events')) return; setSearch(''); setFilters({ path, exactPath: path }); setSelectedId(id); setComparing(false); }} /> : <main className="workspace">
      <aside className="events-panel"><div className="panel-heading"><h2>Events <span>{events.length}</span></h2><span className="muted">Newest first</span></div>
        <div className="event-filters"><input ref={searchRef} aria-label="Search events" type="search" placeholder="Search payload, headers, query… (/)" value={search} onChange={(e) => setSearch(e.target.value)} /><details className="advanced-filters"><summary>Filters{Object.entries(filters).filter(([key, value]) => !['search', 'pinned', 'exactPath'].includes(key) && value).length ? ' · active' : ''}</summary><div className="filter-grid">
          <label>Method<select aria-label="Filter by method" value={filters.method ?? ''} onChange={(e) => setFilters({ ...filters, method: e.target.value })}><option value="">All</option>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map((method) => <option key={method}>{method}</option>)}</select></label>
          <label>Status<input aria-label="Filter by status" type="number" min={100} max={599} placeholder="All" value={filters.status ?? ''} onChange={(e) => setFilters({ ...filters, status: e.target.value })} /></label>
          <label>Endpoint<input aria-label="Filter by endpoint" placeholder="/hooks/payment" value={filters.path ?? ''} onChange={(e) => setFilters({ ...filters, path: e.target.value, exactPath: '' })} /></label>
          <label>Content-Type<input aria-label="Filter by content type" placeholder="application/json" value={filters.contentType ?? ''} onChange={(e) => setFilters({ ...filters, contentType: e.target.value })} /></label>
        </div><div className="filter-grid"><label>From<input aria-label="Start date" type="datetime-local" onChange={(e) => setFilters({ ...filters, from: e.target.value ? new Date(e.target.value).toISOString() : '' })} value={filters.from ? localTime(filters.from) : ''} /></label><label>To<input aria-label="End date" type="datetime-local" onChange={(e) => setFilters({ ...filters, to: e.target.value ? new Date(e.target.value).toISOString() : '' })} value={filters.to ? localTime(filters.to) : ''} /></label></div></details><div className="filter-actions"><label className="check-label"><input type="checkbox" checked={filters.pinned === '1'} onChange={(e) => setFilters({ ...filters, pinned: e.target.checked ? '1' : '' })} />Pinned only</label><button className="text-button" onClick={() => { setSearch(''); setFilters({}); }}>Clear filters</button></div></div>
        {!!compared.length && <div className="action-bar comparison-actions"><span>{compared.length} / 2 events</span><button className="text-button" disabled={compared.length !== 2} onClick={() => setComparing(true)}>Compare events</button><button className="text-button" onClick={() => { setCompared([]); setComparing(false); }}>Clear</button></div>}
        <div className="events-scroll">{events.length ? <EventList events={events} selectedId={selectedId} onSelect={selectEvent} compared={compared} onCompare={compareEvent} /> : <div className="list-empty"><span className="list-empty-icon" aria-hidden="true">≡</span><p>{loading ? 'Loading events…' : Object.values(filters).some(Boolean) ? 'No results for these filters' : 'No events captured'}</p><span>Requests will appear here.</span></div>}
          {cursor !== null && <button className="load-more" onClick={() => { void loadMore(); }} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load older events'}</button>}</div>
        <div className="panel-footer"><span className="connection-dot" />  Real-time updates</div>
      </aside>
      <section className="inspector-panel" aria-label="Event inspector">{comparing && compared.length === 2 ? <EventComparison ids={compared} close={() => setComparing(false)} /> : selectedId ? <Inspector key={workspaceId} cache={editorCache.current} id={selectedId} onPin={pinChanged} command={inspectorCommand} onCommandHandled={() => setInspectorCommand(null)} /> : <div className="welcome"><div className="welcome-glyph" aria-hidden="true">{`{ }`}</div><span className="eyebrow">YOUR ENDPOINT IS READY</span><h2>Waiting for webhooks</h2><p>Send a request to start inspecting.<br />Headers, payload, and response in one place.</p><div className="command-card"><div><span>FIRST REQUEST · POWERSHELL</span><button className="text-button" onClick={() => { void copy(command); }}>Copy command</button></div><pre>{command}</pre></div><div className="welcome-notes"><span>● Local data</span><span>● Original body preserved</span><span>● No external setup</span></div></div>}</section>
    </main>}
    <footer className="app-footer"><span>WeebhookLab <span className="muted">/ v0.1.0</span></span><span>Local capture · SQLite · SSE</span><span>Request limit: 1 MB</span></footer>
  </div>;
}
