import { useEffect, useMemo, useRef, useState } from 'react';
import type { Header, ReplayExecution, ReplayRequest, ReplaySummary, WebhookEvent } from '../shared/contracts';
import { capturedRequest, destination, editableText, localDestination, queryPairs, replayErrorText, sensitiveHeader, withQuery } from '../shared/replay';
import { cancelReplay, formatBytes, getReplay, listReplays, putDocument, runReplay } from './api';
import { inspectPayload, type PayloadView } from './payload';
import { DataTable, Payload } from './Inspector';
import BodyEditor from './BodyEditor';
import CurlCopy from './CurlCopy';
import { typingTarget } from './shortcuts';
import { editorRequest, initialState, requestState, openReplayEditor, type EditorState } from './replayEditor';
import type { SavedRequest } from '../shared/workspaces';
import { compareRequests, compareResponses, type DiffResult } from '../shared/diff';
import { MASK, redactText, redactUrl, sensitiveField } from '../shared/redaction';
import DiffPanel from './DiffPanel';
import TransformPanel from './TransformPanel';
export type { EditorState } from './replayEditor';

export default function ReplayPanel({ event, cache, openEditor, saved, onSaved }: { event: WebhookEvent; cache: Map<string, EditorState>; openEditor: { count: number; edit: boolean }; saved?: SavedRequest; onSaved?: () => void }) {
  const [editor, setEditor] = useState<EditorState>(() => cache.get(event.id) ?? (saved ? { ...requestState(saved.request), edit: true } : initialState(event)));
  const [showEditor, setShowEditor] = useState(openEditor.count > 0);
  const [confirmed, setConfirmed] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [history, setHistory] = useState<ReplaySummary[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [result, setResult] = useState<ReplayExecution | null>(null);
  const [view, setView] = useState<PayloadView | null>(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [curl, setCurl] = useState<ReplayRequest | null>(null);
  const [saveName, setSaveName] = useState(saved?.name ?? '');
  const [saveStatus, setSaveStatus] = useState('');
  const [compareConfig, setCompareConfig] = useState(false);
  const [otherAttempt, setOtherAttempt] = useState<ReplayExecution | null>(null);
  const [comparisonMode, setComparisonMode] = useState('requests');
  const comparisonSelection = useRef<AbortController | null>(null);
  const selection = useRef<AbortController | null>(null);
  const original = useMemo(() => saved?.request ?? capturedRequest(event), [event, saved]);
  const originalText = useMemo(() => editableText(original.body, original.headers), [original]);
  const change = (next: EditorState) => { cache.set(event.id, next); setEditor(next); };
  const enabledHeaders: Header[] = editor.headers.filter((row) => row.enabled).map((row) => [row.name, row.value]);
  const contentType = enabledHeaders.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '';
  const isJson = /^(application\/json|[^;]+\+json)(;|$)/i.test(contentType);
  const modifiedBody = editor.text !== null && editor.text !== originalText;
  const signatureWarning = modifiedBody && enabledHeaders.some(([name]) => /signature/i.test(name));
  const rows = queryPairs(editor.request.destinationUrl);
  let url: URL | null = null;
  try { url = destination(editor.request.destinationUrl); } catch { /* Validation feedback appears on execution. */ }

  const refresh = async (before?: number) => {
    setLoading(true);
    try {
      const page = await listReplays(event.id, new AbortController().signal, before, !!saved);
      setHistory((current) => before === undefined ? page.executions : [...current, ...page.executions]);
      setCursor(page.nextCursor);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to load replay history.'); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    const controller = new AbortController();
    void listReplays(event.id, controller.signal, undefined, !!saved).then((page) => { setHistory(page.executions); setCursor(page.nextCursor); }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Replay history unavailable.');
    });
    return () => { controller.abort(); selection.current?.abort(); comparisonSelection.current?.abort(); };
  }, [event.id, saved]);
  useEffect(() => {
    if (!openEditor.count) return;
    setShowEditor(true); setConfirmed(false); setError('');
    setEditor((current) => { const next = openReplayEditor(current, openEditor.edit); cache.set(event.id, next); return next; });
  }, [openEditor.count, openEditor.edit, event.id, cache]);
  useEffect(() => {
    const close = (key: KeyboardEvent) => {
      if (!document.querySelector('dialog[open]') && key.key === 'Escape' && !key.ctrlKey && !key.altKey && !key.metaKey && !typingTarget(key.target)) { setCurl(null); setShowEditor(false); }
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, []);
  useEffect(() => {
    if (!result) { setView(null); return; }
    let active = true;
    setView(null);
    void inspectPayload({ ...event, contentType: result.result.contentType, contentEncoding: result.result.headers.find(([name]) => name.toLowerCase() === 'content-encoding')?.[1] ?? null,
      rawBody: result.result.body, bodySize: result.result.bodySize,
    }).then((payload) => { if (active) setView(payload); });
    return () => { active = false; };
  }, [result, event]);

  const selectedRequest = (): ReplayRequest => editorRequest(editor, original);
  const execute = async () => {
    setError('');
    try {
      const request = selectedRequest();
      if (!confirmed) throw new Error('Confirm the destination before running.');
      const id = crypto.randomUUID();
      setRunning(id);
      const execution = await runReplay(event.id, id, request, !!saved);
      setResult(execution);
      await refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to execute. Check replay history before retrying.'); }
    finally { setRunning(null); }
  };
  const updateQuery = (entries: Header[]) => {
    try { change({ ...editor, request: { ...editor.request, destinationUrl: withQuery(editor.request.destinationUrl, entries) } }); setConfirmed(false); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Invalid URL.'); }
  };
  const updateHeader = (index: number, patch: Partial<EditorState['headers'][number]>) => change({ ...editor, headers: editor.headers.map((row, i) => i === index ? { ...row, ...patch } : row) });
  const cancel = async (id: string) => {
    try { await cancelReplay(id); await refresh(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to cancel.'); }
  };
  const selectAttempt = (id: string) => {
    selection.current?.abort();
    const controller = new AbortController(); selection.current = controller;
    setError('');
    void getReplay(id, controller.signal).then((execution) => { if (!controller.signal.aborted) setResult(execution); }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Execution unavailable.');
    });
  };
  const configurationDiff = useMemo<DiffResult | null>(() => {
    if (!compareConfig) return null;
    try { return compareRequests(original, editorRequest(editor, original)); } catch { return { changes: [], notices: ['Fix the configuration to compare.'], truncated: false }; }
  }, [compareConfig, original, editor]);
  const executionDiff = useMemo(() => !result || !otherAttempt ? null : comparisonMode === 'requests' ? compareRequests(otherAttempt.request, result.request) : compareResponses(otherAttempt.result, result.result), [result, otherAttempt, comparisonMode]);
  const originalReplayDiff = useMemo(() => result ? compareRequests(original, result.request) : null, [result, original]);
  const saveRequest = async (duplicate: boolean) => {
    try { const request = selectedRequest(); await putDocument('requests', { id: saved && !duplicate ? saved.id : crypto.randomUUID(), name: saveName, request }); setSaveStatus('Request saved; no request was sent.'); onSaved?.(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to save.'); }
  };
  return <div className="replay-panel">
    <div className="action-bar"><button className="text-button" onClick={() => { setShowEditor(!showEditor); }}> {showEditor ? 'Close editor' : 'Open editor'}</button><button className="text-button" onClick={() => { change({ ...requestState(structuredClone(original)), edit: true }); setShowEditor(true); setConfirmed(false); }}>Duplicate as draft</button><button className="text-button" disabled={loading} onClick={() => { void refresh(); }}>Refresh history</button></div>
    {error && <p className="notice warning" role="alert">{error}</p>}
    {showEditor && <form className="replay-editor" onSubmit={(e) => { e.preventDefault(); void execute(); }}>
      <div className="section-heading"><h3>{editor.edit ? 'Edit & Replay' : 'Replay original event'}</h3><button type="button" className="text-button" disabled={!!running} onClick={() => change({ ...editor, edit: !editor.edit })}>{editor.edit ? 'Use original' : 'Enable editing'}</button></div>
      <div className="request-line"><label>Method<input aria-label="Replay method" value={editor.edit ? editor.request.method : original.method} disabled={!editor.edit || !!running} onChange={(e) => change({ ...editor, request: { ...editor.request, method: e.target.value.toUpperCase() } })} /></label><label>Destination URL<input aria-label="Destination URL" type="text" value={!reveal && rows.some(([key]) => sensitiveField(key)) ? redactUrl(editor.request.destinationUrl) : editor.request.destinationUrl} disabled={!!running || (!reveal && rows.some(([key]) => sensitiveField(key)))} onChange={(e) => { change({ ...editor, request: { ...editor.request, destinationUrl: e.target.value } }); setConfirmed(false); }} /></label><label>Timeout (ms)<input aria-label="Timeout in ms" type="number" min={100} max={120000} value={Number.isNaN(editor.request.timeoutMs) ? '' : editor.request.timeoutMs} disabled={!!running} onChange={(e) => change({ ...editor, request: { ...editor.request, timeoutMs: e.target.valueAsNumber } })} /></label></div>
      {editor.edit && <>
        <div className="section-heading"><h3>Query · synchronized with the URL</h3><button type="button" className="text-button" disabled={!url || !!running} onClick={() => updateQuery([...rows, ['', '']])}>Add parameter</button></div>
        {rows.map(([name, value], index) => <div className="pair-editor query-row" key={index}><input aria-label={`Parameter ${index + 1}`} value={name} disabled={!!running} onChange={(e) => updateQuery(rows.map((row, i) => i === index ? [e.target.value, value] : row))} /><input aria-label={`Parameter value ${index + 1}`} type={!reveal && sensitiveField(name) ? 'password' : 'text'} value={value} disabled={!!running} onChange={(e) => updateQuery(rows.map((row, i) => i === index ? [name, e.target.value] : row))} /><button type="button" className="text-button" disabled={!!running} aria-label={`Remove parameter ${index + 1}`} onClick={() => updateQuery(rows.filter((_, i) => i !== index))}>×</button></div>)}
        <div className="section-heading"><h3>Headers</h3><button type="button" className="text-button" onClick={() => setReveal(!reveal)}>{reveal ? 'Hide sensitive values' : 'Reveal sensitive values'}</button><button type="button" className="text-button" disabled={!!running} onClick={() => change({ ...editor, headers: [...editor.headers, { name: '', value: '', enabled: true }] })}>Add header</button></div>
        {editor.headers.map((row, index) => <div className="pair-editor header-row" key={index}><input type="checkbox" aria-label={`Enable header ${index + 1}`} checked={row.enabled} disabled={!!running} onChange={(e) => updateHeader(index, { enabled: e.target.checked })} /><input aria-label={`Header ${index + 1}`} value={row.name} disabled={!!running} onChange={(e) => updateHeader(index, { name: e.target.value })} /><input aria-label={`Header value ${index + 1}`} type={!reveal && sensitiveHeader(row.name) ? 'password' : 'text'} autoComplete="off" value={row.value} disabled={!!running} onChange={(e) => updateHeader(index, { value: e.target.value })} /><button type="button" className="text-button" disabled={row.original === undefined || !!running} aria-label={`Restore header ${index + 1}`} onClick={() => { const pair = original.headers[row.original!]; if (pair) updateHeader(index, { name: pair[0], value: pair[1], enabled: true }); }}>↺</button><button type="button" className="text-button" disabled={!!running} aria-label={`Remove header ${index + 1}`} onClick={() => change({ ...editor, headers: editor.headers.filter((_, i) => i !== index) })}>×</button></div>)}
        <p className="muted">Host, Connection, Content-Length, and transport headers are managed by the HTTP client.</p>
        <label className="content-type">Content-Type<input aria-label="Replay Content-Type" value={contentType} disabled={!!running} onChange={(e) => {
          const index = editor.headers.findIndex((row) => row.name.toLowerCase() === 'content-type');
          if (index < 0) change({ ...editor, headers: [...editor.headers, { name: 'Content-Type', value: e.target.value, enabled: true }] });
          else updateHeader(index, { value: e.target.value, enabled: true });
        }} /></label>
        <div className="section-heading"><h3>Body · {editor.text === null ? 'original bytes' : 'UTF-8'}</h3>{isJson && editor.text !== null && <button type="button" className="text-button" disabled={!!running} onClick={() => {
          try { change({ ...editor, text: JSON.stringify(JSON.parse(editor.text!) as unknown, null, 2) }); setError(''); }
          catch { setError('Invalid JSON: check the syntax.'); }
        }}>Format JSON</button>}</div>
        {editor.text === null ? <p className="notice">Binary, multipart, compressed content, or a non-UTF-8 charset: body editing unavailable. Replay preserves the exact original bytes.</p> : <><BodyEditor value={editor.text} json={isJson} disabled={!!running} onChange={(text) => change({ ...editor, text })} /><p className="muted">Original bytes and line endings are preserved until the text is changed. Edited text uses UTF-8.</p></>}
        {signatureWarning && <p className="notice warning">Body changed: webhook signatures may become invalid. Signature headers will not be recalculated.</p>}
        {isJson && editor.text !== null && <TransformPanel text={editor.text} apply={(text) => { change({ ...editor, text, edit: true }); setConfirmed(false); }} />}
      </>}
      <div className="action-bar"><input aria-label="Saved request name" placeholder="Saved request name" value={saveName} onChange={(e) => setSaveName(e.target.value)} /><button className="text-button" type="button" disabled={!saveName.trim() || !!running} onClick={() => { void saveRequest(false); }}>{saved ? 'Save changes' : 'Save as request'}</button>{saved && <button className="text-button" type="button" onClick={() => { void saveRequest(true); }}>Save independent copy</button>}<button className="text-button" type="button" onClick={() => setCompareConfig(!compareConfig)}>Compare original and edited configuration</button></div>{saveStatus && <p role="status">{saveStatus}</p>}{configurationDiff && <DiffPanel result={configurationDiff} left="Original configuration" right="Editor" />}
      <p className={`notice ${url && !localDestination(url) ? 'warning' : ''}`}>{url && !localDestination(url) ? 'Non-local destination. Sending may have real effects and share data and credentials.' : 'Replay sends a real request to the destination. Requests are never retried automatically.'}<br /><strong>{(reveal ? editor.request.destinationUrl : redactUrl(editor.request.destinationUrl)) || 'Enter the destination.'}</strong></p>
      <label className="check-label"><input type="checkbox" checked={confirmed} disabled={!!running} onChange={(e) => setConfirmed(e.target.checked)} />I confirm the destination and sending this request</label>
      <div className="action-bar"><button className="text-button" type="submit" disabled={!confirmed || !!running}>{running ? 'Running…' : 'Run replay'}</button>{running && <button type="button" className="text-button" onClick={() => { void cancel(running); }}>Cancel execution</button>}<button type="button" className="text-button" onClick={() => { try { setCurl(selectedRequest()); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Invalid request.'); } }}>Edited request as cURL</button></div>
    </form>}
    {curl && <CurlCopy request={curl} close={() => setCurl(null)} />}
    <h3 className="raw-heading">Replay history</h3>
    {!history.length && <p className="muted">No replays have been run for this event.</p>}
    <div className="replay-history">{history.map((attempt) => <div className="history-row" key={attempt.id}><button className={`event-row ${result?.id === attempt.id ? 'selected' : ''}`} onClick={() => selectAttempt(attempt.id)}><span>#{attempt.sequence} · {attempt.method} {reveal ? attempt.destinationUrl : redactUrl(attempt.destinationUrl)}</span><span>{attempt.state === 'running' ? 'Running' : (attempt.error ? replayErrorText(attempt.error.message) : undefined) ?? `HTTP ${attempt.status ?? '—'}`} · {attempt.durationMs.toFixed(2)} ms</span><time>{new Date(attempt.executedAt).toLocaleString('en-US')}</time></button>{attempt.state === 'running' && <button className="text-button" onClick={() => { void cancel(attempt.id); }}>Cancel</button>}</div>)}</div>
    {cursor !== null && <button className="text-button" disabled={loading} onClick={() => { void refresh(cursor); }}>Older executions</button>}
    {result && <section className="replay-result" aria-label="Replay result"><div className="section-heading"><h3>Result · {result.state === 'running' ? 'running' : 'completed'}</h3><button className="text-button" onClick={() => setCurl(result.request)}>This execution as cURL</button></div><dl className="overview">{[
      ['Destination', reveal ? result.request.destinationUrl : redactUrl(result.request.destinationUrl)], ['Method', result.request.method], ['Executed at', new Date(result.executedAt).toLocaleString('en-US')], ['ID', result.id],
      ['HTTP status', result.result.status === undefined ? 'No HTTP response' : `${result.result.status} ${result.result.statusText ?? ''}`], ['Duration', `${result.result.durationMs.toFixed(2)} ms`], ['Content-Type', result.result.contentType ?? 'Not provided'],
      ['Retained response', formatBytes(result.result.bodySize)], ['Received bytes', `${formatBytes(result.result.receivedSize)}${result.result.truncated ? ' (partial)' : ''}`], ['Configured timeout', `${result.request.timeoutMs} ms`],
    ].map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
      {result.result.error && <p className="notice warning" role="alert">{result.result.error.code}: {replayErrorText(result.result.error.message)}</p>}
      {result.result.truncated && <p className="notice warning">Response limit reached. Only the first {result.result.bodySize}  bytes were retained; the connection was closed.</p>}
      <div className="section-heading raw-heading"><h3>Response headers</h3><button className="text-button" onClick={() => setReveal(!reveal)}>{reveal ? 'Hide sensitive values' : 'Reveal sensitive values'}</button></div><DataTable entries={result.result.headers.map(([name, value]) => [name, !reveal && sensitiveHeader(name) ? '•••••••• [hidden]' : value])} />
      <h3 className="raw-heading">Response body</h3><Payload view={view} reveal={reveal} />
      <details><summary>Exact request used · {formatBytes(result.request.bodySize)}</summary><DataTable entries={result.request.headers.map(([name, value]) => [name, !reveal && sensitiveHeader(name) ? '•••••••• [hidden]' : value])} /><pre className="code-block wrap">{reveal ? editableText(result.request.body, result.request.headers) ?? `Base64: ${result.request.body.data}` : redactText(editableText(result.request.body, result.request.headers) ?? MASK)}</pre></details>
      {originalReplayDiff && <details><summary>Original → replay #{result.sequence}</summary><DiffPanel result={originalReplayDiff} left="Original" right={`Replay #${result.sequence}`} /></details>}
      <div className="action-bar"><label>Compare execution<select aria-label="Compare execution" value={otherAttempt?.id ?? ''} onChange={(e) => {
        comparisonSelection.current?.abort(); setOtherAttempt(null); if (!e.target.value) return; const controller = new AbortController(); comparisonSelection.current = controller;
        void getReplay(e.target.value, controller.signal).then((value) => { if (!controller.signal.aborted) setOtherAttempt(value); }).catch((error: unknown) => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Comparison unavailable.'); });
      }}><option value="">Select another attempt</option>{history.filter((h) => h.id !== result.id).map((h) => <option value={h.id} key={h.id}>Replay #{h.sequence} · {h.status ?? h.error?.code ?? h.state}</option>)}</select></label><select aria-label="Compare requests or responses" value={comparisonMode} onChange={(e) => setComparisonMode(e.target.value)}><option value="requests">Requests</option><option value="responses">Responses</option></select></div>
      {executionDiff && otherAttempt && <DiffPanel result={executionDiff} left={`Replay #${otherAttempt.sequence}`} right={`Replay #${result.sequence}`} />}
    </section>}
  </div>;
}
