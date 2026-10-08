import { useEffect, useMemo, useRef, useState } from 'react';
import type { Header, WebhookEvent } from '../shared/contracts';
import type { EndpointOverview, MockProfile, SavedRequest, Workspace, WorkspaceConfiguration } from '../shared/workspaces';
import { MASK, sensitiveField } from '../shared/redaction';
import { sensitiveHeader } from '../shared/replay';
import { createWorkspace, deleteDocument, exportWorkspace, getConfiguration, getEndpoints, importWorkspace, putDocument } from './api';
import ReplayPanel from './ReplayPanel';
import type { EditorState } from './replayEditor';
import BodyEditor from './BodyEditor';

const empty: WorkspaceConfiguration = { requests: [], mocks: [], bindings: [], transformations: [] };
const newMock = (): MockProfile => ({ id: crypto.randomUUID(), name: '', response: { status: 200, headers: [['Content-Type', 'application/json']], body: '{"received":true}', delayMs: 0, maxDelayMs: 0 } });
function requestEvent(saved: SavedRequest): WebhookEvent {
  const url = new URL(saved.request.destinationUrl); const query = Object.fromEntries(url.searchParams);
  return { id: saved.id, sequence: 1, receivedAt: new Date().toISOString(), method: saved.request.method, path: url.pathname, requestTarget: url.pathname + url.search,
    contentType: saved.request.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? null, headers: saved.request.headers, httpVersion: '1.1', query,
    userAgent: null, sourceIp: null, contentEncoding: null, rawBody: saved.request.body, bodySize: atob(saved.request.body.data).length, responseStatus: 200, durationMs: 0, response: { headers: [], body: '' } };
}
export default function LibraryPanel({ section, workspaces, activeId, onWorkspaceChange, onWorkspaceList, openEndpoint, captureEndpoint, onDirtyChange }: {
  section: 'requests' | 'endpoints' | 'workspaces'; workspaces: Workspace[]; activeId: string; onWorkspaceChange: (id: string) => Promise<void>; onWorkspaceList: () => Promise<void>; openEndpoint: (path: string, id: string) => void;
  captureEndpoint: string;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [config, setConfig] = useState(empty); const [endpoints, setEndpoints] = useState<EndpointOverview[]>([]); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [selected, setSelected] = useState(''); const [name, setName] = useState(''); const [newUrl, setNewUrl] = useState(captureEndpoint);
  const [mock, setMock] = useState(newMock); const [mockPath, setMockPath] = useState('/hooks/test'); const [appliedProfile, setAppliedProfile] = useState('');
  const [includeSecrets, setIncludeSecrets] = useState(false); const [reveal, setReveal] = useState(false); const [busy, setBusy] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [editorSession, setEditorSession] = useState(0);
  const [mockBaseline, setMockBaseline] = useState(() => JSON.stringify(mock));
  const [bindingBaseline, setBindingBaseline] = useState(() => JSON.stringify({ path: mockPath, profileId: appliedProfile }));
  const panel = useRef<HTMLElement>(null); const heading = useRef<HTMLHeadingElement>(null); const mockForm = useRef<HTMLFormElement>(null); const bindingForm = useRef<HTMLFormElement>(null); const errorNotice = useRef<HTMLParagraphElement>(null);
  const returnPath = useRef('');
  const dirty = configuring && (JSON.stringify(mock) !== mockBaseline || JSON.stringify({ path: mockPath, profileId: appliedProfile }) !== bindingBaseline);
  const canDiscard = () => !dirty || window.confirm('Discard unsaved endpoint configuration changes?');
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => { if (editorSession) { if (panel.current) panel.current.scrollTop = 0; heading.current?.focus({ preventScroll: true }); } }, [editorSession]);
  useEffect(() => { if (!configuring && editorSession) panel.current?.querySelector<HTMLButtonElement>(returnPath.current ? `[data-configure-path="${CSS.escape(returnPath.current)}"]` : '.manage-profiles')?.focus(); }, [configuring, editorSession]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => { if (error) errorNotice.current?.scrollIntoView({ block: 'nearest' }); }, [error]);
  const cache = useRef(new Map<string, EditorState>()); const generation = useRef(0);
  const refresh = async () => { const token = ++generation.current; const [configuration, overview] = await Promise.all([getConfiguration(), getEndpoints()]); if (token !== generation.current) return; setConfig(configuration); setEndpoints(overview.endpoints); };
  useEffect(() => { void refresh().catch((e: unknown) => setError(e instanceof Error ? e.message : 'Data unavailable.')); return () => { generation.current++; }; }, []);
  const perform = async (action: () => Promise<unknown>) => { setError(''); setMessage(''); setBusy(true); try { await action(); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Operation unavailable.'); } finally { setBusy(false); } };
  const saved = config.requests.find((r) => r.id === selected);
  const event = useMemo(() => saved ? requestEvent(saved) : null, [saved]);
  const changeHeader = (index: number, pair: Header) => setMock({ ...mock, response: { ...mock.response, headers: mock.response.headers.map((r, i) => i === index ? pair : r) } });
  const editMock = (profile?: MockProfile, path = mockPath) => {
    if (!canDiscard()) return;
    if (!configuring) returnPath.current = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.configurePath ?? '' : '';
    const value = structuredClone(profile ?? newMock());
    const profileId = profile?.id ?? '';
    setMock(value); setMockPath(path); setAppliedProfile(profileId); setReveal(false);
    setMockBaseline(JSON.stringify(value)); setBindingBaseline(JSON.stringify({ path, profileId }));
    setError(''); setMessage(''); setConfiguring(true); setEditorSession((current) => current + 1);
  };
  const saveMock = async () => {
    const profile = await putDocument('mocks', mock);
    setMock(profile); setMockBaseline(JSON.stringify(profile)); setAppliedProfile(profile.id);
    setMessage('Profile saved. Use Apply to endpoint to bind it to this path.');
  };
  const applyMock = async () => {
    const existing = config.bindings.find((binding) => binding.path === mockPath);
    if (appliedProfile === 'default') {
      if (existing) await deleteDocument('bindings', existing.id);
      setBindingBaseline(JSON.stringify({ path: mockPath, profileId: 'default' }));
      setMessage(`Default response applied to ${mockPath}.`);
      return;
    }
    let profileId = appliedProfile;
    if (!profileId || profileId === mock.id) {
      const profile = await putDocument('mocks', mock);
      setMock(profile); setMockBaseline(JSON.stringify(profile)); profileId = profile.id;
    }
    await putDocument('bindings', { id: existing?.id ?? crypto.randomUUID(), path: mockPath, profileId });
    setAppliedProfile(profileId);
    setBindingBaseline(JSON.stringify({ path: mockPath, profileId }));
    setMessage(`Mock active on ${mockPath}.`);
  };
  const validApplication = () => bindingForm.current?.reportValidity() && (appliedProfile === 'default' || mockForm.current?.reportValidity());
  return <section ref={panel} className="library-panel"><div className="section-heading"><h2>{section === 'requests' ? 'Saved requests' : section === 'endpoints' ? 'Endpoints and responses' : 'Local workspaces'}</h2><button className="text-button" disabled={busy} onClick={() => { void perform(async () => {}); }}>Refresh</button></div>
    {error && !configuring && <p ref={errorNotice} className="notice warning" role="alert">{error}</p>}{message && <p className="notice" role="status">{message}</p>}
    {section === 'requests' && <><form className="action-bar" onSubmit={(e) => { e.preventDefault(); void perform(async () => { const value = await putDocument('requests', { id: crypto.randomUUID(), name, request: { method: 'POST', destinationUrl: newUrl, headers: [['Content-Type', 'application/json']], body: { encoding: 'base64', data: 'e30=' }, timeoutMs: 10000 } }); setSelected(value.id); setName(''); }); }}><input aria-label="New request name" placeholder="Request name" value={name} onChange={(e) => setName(e.target.value)} required /><input aria-label="New request destination" value={newUrl} onChange={(e) => setNewUrl(e.target.value)} required /><button className="text-button" disabled={busy}>Create request</button></form>
      <div className="saved-requests">{config.requests.map((r) => <div className="action-bar" key={r.id}><button className="text-button" aria-pressed={selected === r.id} onClick={() => setSelected(r.id)}>{r.name} · {r.request.method}</button><button className="text-button" disabled={busy} onClick={() => { void perform(async () => { const copy = await putDocument('requests', { ...r, id: crypto.randomUUID(), name: `${r.name} (copy)`.slice(0, 100) }); setSelected(copy.id); }); }}>Duplicate</button><button className="text-button" disabled={busy} onClick={() => { void perform(async () => { await deleteDocument('requests', r.id); cache.current.delete(r.id); if (selected === r.id) setSelected(''); }); }}>Delete</button></div>)}</div>
      {!config.requests.length && <p className="muted">Create a request definition or save a draft in the replay editor.</p>}{saved && event && <ReplayPanel key={saved.id} event={event} saved={saved} cache={cache.current} openEditor={{ count: 1, edit: true }} onSaved={() => { void perform(async () => {}); }} />}</>}
    {section === 'endpoints' && <>{!configuring && <><div className="action-bar"><button className="text-button manage-profiles" onClick={() => editMock()}>Manage response profiles</button></div><p className="muted">Exact path matching, excluding query parameters. Without a binding: HTTP 200 and {`{"received":true}`}. Configuration is recorded at capture time.</p>
      <table className="data-table endpoint-table"><thead><tr><th>Endpoint</th><th>Events · method</th><th>Latest event · provider</th><th>Active mock</th><th>Actions</th></tr></thead><tbody>{endpoints.map((endpoint) => <tr key={endpoint.path}><th scope="row"><code>{endpoint.path}</code></th><td>{endpoint.count} · {endpoint.method}</td><td>#{endpoint.recent.sequence} · {new Date(endpoint.recent.receivedAt).toLocaleString('en-US')}<br />{endpoint.recent.provider?.confidence === 'high' ? endpoint.recent.provider.provider : 'no reliable detection'}</td><td>{endpoint.profile ? `${endpoint.profile.name} · HTTP ${endpoint.profile.response.status}` : 'Default · HTTP 200'}</td><td><button className="text-button" onClick={() => openEndpoint(endpoint.path, endpoint.recent.id)}>Recent requests</button><button className="text-button" data-configure-path={endpoint.path} onClick={() => editMock(endpoint.profile ?? undefined, endpoint.path)}>Configure</button></td></tr>)}</tbody></table></>}
      {configuring && <><div className="section-heading endpoint-config-heading"><h3 ref={heading} tabIndex={-1}>Configure <code>{mockPath}</code></h3><div className="action-bar"><button className="text-button" disabled={busy} onClick={() => { if (mockForm.current?.reportValidity()) void perform(saveMock); }}>Save profile</button><button className="text-button" disabled={busy} onClick={() => { if (validApplication()) void perform(applyMock); }}>Apply to endpoint</button><button className="text-button" disabled={busy} onClick={() => { if (canDiscard()) { setConfiguring(false); setError(''); setMessage(''); if (panel.current) panel.current.scrollTop = 0; } }}>Back to endpoints</button></div></div>
      <h3 className="raw-heading">Response profiles</h3><div className="action-bar"><select aria-label="Select response profile" value={config.mocks.some((m) => m.id === mock.id) ? mock.id : ''} onChange={(e) => { editMock(config.mocks.find((m) => m.id === e.target.value)); }}><option value="">New profile</option>{config.mocks.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select><button className="text-button" onClick={() => editMock()}>New profile</button><button className="text-button" onClick={() => { setMock({ ...structuredClone(mock), id: crypto.randomUUID(), name: `${mock.name} (copy)`.slice(0, 100) }); setAppliedProfile(''); setReveal(false); }}>Duplicate profile</button>{config.mocks.some((m) => m.id === mock.id) && <button className="text-button" disabled={busy} onClick={() => { void perform(async () => { await deleteDocument('mocks', mock.id); editMock(); setMessage('Profile deleted; bound endpoints use the default response.'); }); }}>Delete profile</button>}</div>
      <form ref={mockForm} className="mock-editor" onSubmit={(e) => { e.preventDefault(); void perform(saveMock); }}>{error && <p ref={errorNotice} className="notice warning" role="alert">{error}</p>}<fieldset disabled={busy}><div className="filter-grid"><label>Name<input aria-label="Profile name" required maxLength={100} value={mock.name} onChange={(e) => setMock({ ...mock, name: e.target.value })} /></label><label>HTTP status<input aria-label="Mock response status" required type="number" min={200} max={599} value={Number.isNaN(mock.response.status) ? '' : mock.response.status} onChange={(e) => setMock({ ...mock, response: { ...mock.response, status: e.target.valueAsNumber } })} /></label><label>Minimum delay (ms)<input aria-label="Minimum delay" required type="number" min={0} max={10000} value={Number.isNaN(mock.response.delayMs) ? '' : mock.response.delayMs} onChange={(e) => setMock({ ...mock, response: { ...mock.response, delayMs: e.target.valueAsNumber, maxDelayMs: Math.max(mock.response.maxDelayMs, e.target.valueAsNumber) } })} /></label><label>Maximum delay (ms)<input aria-label="Maximum delay" required type="number" min={Number.isFinite(mock.response.delayMs) ? mock.response.delayMs : 0} max={10000} value={Number.isNaN(mock.response.maxDelayMs) ? '' : mock.response.maxDelayMs} onChange={(e) => setMock({ ...mock, response: { ...mock.response, maxDelayMs: e.target.valueAsNumber } })} /></label></div>
        <p className="muted">Equal minimum and maximum: fixed delay. Otherwise: bounded random delay. Up to 20 concurrent delays; maximum 10 seconds.</p><div className="section-heading raw-heading"><h3>Response headers</h3><button className="text-button" type="button" onClick={() => setReveal(!reveal)}>{reveal ? 'Hide sensitive values' : 'Reveal sensitive values'}</button><button className="text-button" type="button" onClick={() => setMock({ ...mock, response: { ...mock.response, headers: [...mock.response.headers, ['', '']] } })}>Add header</button></div>
        {mock.response.headers.map(([key, value], i) => <div className="pair-editor query-row" key={i}><input aria-label={`Mock header ${i + 1}`} value={key} onChange={(e) => changeHeader(i, [e.target.value, value])} /><input aria-label={`Mock header value ${i + 1}`} type={!reveal && (sensitiveHeader(key) || sensitiveField(key)) ? 'password' : 'text'} value={value} onChange={(e) => changeHeader(i, [key, e.target.value])} /><button className="text-button" type="button" aria-label={`Delete mock header ${i + 1}`} onClick={() => setMock({ ...mock, response: { ...mock.response, headers: mock.response.headers.filter((_, n) => n !== i) } })}>×</button></div>)}
        <h3 className="raw-heading">Response body · up to 64 KB</h3><BodyEditor label="Response body" value={mock.response.body} onChange={(body) => setMock({ ...mock, response: { ...mock.response, body } })} json={true} disabled={busy} /><button className="text-button" disabled={busy}>Save profile</button></fieldset></form>
      <h3 className="raw-heading">Apply profile to endpoint</h3><form ref={bindingForm} className="action-bar" onSubmit={(e) => { e.preventDefault(); if (validApplication()) void perform(applyMock); }}><input aria-label="Mock endpoint" required pattern="/hooks/.*" disabled={busy} value={mockPath} onChange={(e) => setMockPath(e.target.value)} /><select aria-label="Applied profile" disabled={busy} value={appliedProfile} onChange={(e) => { const profile = config.mocks.find((m) => m.id === e.target.value); if (profile) editMock(profile); else setAppliedProfile(e.target.value); }}><option value="">Current profile</option><option value="default">Default response</option>{config.mocks.map((m) => <option key={m.id} value={m.id}>{m.name} · HTTP {m.response.status}</option>)}</select><button className="text-button" disabled={busy}>Apply to endpoint</button></form>
      {config.bindings.map((binding) => <div className="action-bar" key={binding.id}><code>{binding.path} → {config.mocks.find((m) => m.id === binding.profileId)?.name ?? MASK}</code><button className="text-button" disabled={busy} onClick={() => editMock(config.mocks.find((m) => m.id === binding.profileId), binding.path)}>Edit binding</button></div>)}</>}</>}
    {section === 'workspaces' && <><p className="notice">Requests to /hooks/* belong to the workspace active when the request starts. Switching workspaces does not move events or running executions.</p><form className="action-bar" onSubmit={(e) => { e.preventDefault(); void perform(async () => { const workspace = await createWorkspace(name); await onWorkspaceList(); await onWorkspaceChange(workspace.id); }); }}><input aria-label="Workspace name" placeholder="New workspace name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /><button className="text-button" disabled={busy}>Create workspace</button></form>
      {workspaces.map((workspace) => <div className="action-bar" key={workspace.id}><strong>{workspace.name}</strong><code>{workspace.id}</code><button className="text-button" disabled={busy || workspace.id === activeId} onClick={() => { void perform(() => onWorkspaceChange(workspace.id)); }}>{workspace.id === activeId ? 'Active' : 'Activate'}</button></div>)}
      <h3 className="raw-heading">Export / import</h3><label className="check-label"><input type="checkbox" checked={includeSecrets} onChange={(e) => setIncludeSecrets(e.target.checked)} />Include original secrets in export</label>{includeSecrets && <p className="notice warning" role="alert">The file will include credentials and original payloads. Protect it before sharing.</p>}<p className="muted">Export v1: up to 10 MB, 1,000 events, and 1,000 executions. Secrets are redacted by default; binary/compressed bodies are omitted. Import creates a copy with new IDs and never executes requests.</p><button className="text-button" disabled={busy} onClick={() => { void perform(() => exportWorkspace(includeSecrets)); }}>Export workspace</button>
      <label className="import-label">Import JSON file<input aria-label="Import workspace" type="file" accept="application/json,.json" disabled={busy} onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; void perform(async () => { if (file.size > 10_485_760) throw new Error('File exceeds 10 MB.'); const workspace = await importWorkspace(await file.text()); await onWorkspaceList(); setMessage(`Imported: ${workspace.name}. Select it to open.`); }); }} /></label></>}
  </section>;
}
