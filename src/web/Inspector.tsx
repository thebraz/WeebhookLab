import { useEffect, useRef, useState } from 'react';
import type { Header, Values, WebhookEvent } from '../shared/contracts';
import { copyText, formatBytes, getEvent, pinEvent } from './api';
import { inspectPayload, sensitiveHeader, type PayloadView } from './payload';
import { capturedRequest } from '../shared/replay';
import ReplayPanel, { type EditorState } from './ReplayPanel';
import CurlCopy from './CurlCopy';
import { typingTarget } from './shortcuts';
import { MASK, redactHeaders, redactText, redactUrl, sensitiveField } from '../shared/redaction';
import JsonPaths from './JsonPaths';
import { providerEvidenceText } from '../shared/providers';

const tabs = ['Overview', 'Payload', 'Headers', 'Query', 'Raw', 'Response', 'Replays'] as const;
type Tab = typeof tabs[number];

function Pairs({ values }: { values: Values }) {
  const entries = Object.entries(values).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((item): Header => [name, item]));
  return <DataTable entries={entries} empty="No parameters received." />;
}

export function DataTable({ entries, empty = 'No headers received.' }: { entries: Header[]; empty?: string }) {
  if (!entries.length) return <p className="muted">{empty}</p>;
  return <table className="data-table"><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody>
    {entries.map(([name, value], index) => <tr key={index}><th scope="row">{name}</th><td>{value}</td></tr>)}
  </tbody></table>;
}

export function Payload({ view, reveal = false }: { view: PayloadView | null; reveal?: boolean }) {
  if (!view) return <p className="muted">Preparing preview…</p>;
  if (view.kind === 'empty') return <div className="section-empty"><span className="empty-symbol">∅</span><h3>Empty body</h3><p>This request did not send a body.</p></div>;
  if (view.kind === 'form') return <Pairs values={Object.fromEntries(Object.entries(view.values).map(([key, value]) => [key, !reveal && sensitiveField(key) ? MASK : value]))} />;
  if (view.kind === 'multipart') return <><p className="notice">Multipart parts. Files remain in the original body; no files are saved separately.</p><table className="data-table"><thead><tr><th>Field</th><th>Content / file</th><th>Type · size</th></tr></thead><tbody>{view.parts.map((part, index) => <tr key={index}><th scope="row">{part.name}</th><td>{!reveal && sensitiveField(part.name) ? MASK : reveal ? part.value : redactText(part.value)}</td><td>{part.contentType ?? 'text'} · {formatBytes(part.size)}</td></tr>)}</tbody></table></>;
  return <>{view.kind === 'invalid-json' && <p className="notice warning">Invalid JSON. The received content is preserved below.</p>}
    {view.kind === 'limited-json' && <p className="notice warning">JSON preview limited to protect browser resources.</p>}
    {view.kind === 'binary' && <p className="notice">{view.reason}</p>}
    <pre className={`code-block ${view.kind === 'json' ? 'json' : ''}`}>{view.kind === 'binary' ? reveal ? view.hex : 'Bytes hidden. Reveal values to inspect opaque content.' : reveal ? view.text : redactText(view.text)}</pre>{view.kind === 'json' && <JsonPaths text={view.original} />}</>;
}

export default function Inspector({ id, onPin, command, onCommandHandled, cache }: { id: string; onPin: (id: string, pinned: boolean) => void; command?: string | null; onCommandHandled?: () => void; cache?: Map<string, EditorState> }) {
  const [event, setEvent] = useState<WebhookEvent | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('Overview');
  const [view, setView] = useState<PayloadView | null>(null);
  const [reveal, setReveal] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const [showCurl, setShowCurl] = useState(false);
  const [openEditor, setOpenEditor] = useState({ count: 0, edit: false });
  const [pinning, setPinning] = useState(false);
  const editors = useRef(cache ?? new Map<string, EditorState>());
  useEffect(() => {
    const controller = new AbortController();
    setEvent(null); setError(''); setView(null); setReveal(false); setCopyStatus(''); setShowCurl(false); setOpenEditor({ count: 0, edit: false });
    void getEvent(id, controller.signal).then(async (received) => {
      if (controller.signal.aborted) return;
      setEvent(received);
      const payload = await inspectPayload(received);
      if (!controller.signal.aborted) setView(payload);
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Unable to open the event.');
    });
    return () => controller.abort();
  }, [id]);
  useEffect(() => {
    if (!event || event.id !== id || !command) return;
    if (command === 'curl') setShowCurl(true); else { setTab('Replays'); setOpenEditor((old) => ({ count: old.count + 1, edit: command === 'edit' })); }
    onCommandHandled?.();
  }, [event, id, command, onCommandHandled]);
  useEffect(() => {
    const handle = (key: KeyboardEvent) => {
      if (document.querySelector('dialog[open]') || key.ctrlKey || key.metaKey || key.altKey || key.shiftKey || typingTarget(key.target)) return;
      if (!event) return;
      if (key.key.toLowerCase() === 'r' || key.key.toLowerCase() === 'e') {
        key.preventDefault(); setTab('Replays'); setOpenEditor((current) => ({ count: current.count + 1, edit: key.key.toLowerCase() === 'e' }));
      } else if (key.key.toLowerCase() === 'c') { key.preventDefault(); setShowCurl(true); }
      else if (key.key === 'Escape') { setShowCurl(false); setTab('Overview'); }
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [event]);

  if (error) return <div className="inspector-state" role="alert"><h2>Event unavailable</h2><p>{error}</p></div>;
  if (!event) return <div className="inspector-state" role="status">Loading event…</div>;
  const visibleHeaders: Header[] = event.headers.map(([name, value]) => [name, !reveal && sensitiveHeader(name) ? '•••••••• [hidden]' : value]);
  const textBody = view && 'original' in view ? reveal ? view.original : redactText(view.original) : event.bodySize === 0 ? '' : '[binary / multipart body: see the original Base64 below]';
  const reconstructed = `${event.method} ${reveal ? event.requestTarget : redactUrl(event.requestTarget)} HTTP/${event.httpVersion}\n${visibleHeaders.map(([name, value]) => `${name}: ${value}`).join('\n')}\n\n${textBody}`;
  const copy = async (value: string) => {
    try { await copyText(value); setCopyStatus('Copied'); }
    catch { setCopyStatus('Unable to copy'); }
  };
  const capturedHost = event.headers.find(([name]) => name.toLowerCase() === 'host')?.[1] ?? window.location.host;
  const sourceRequest = { ...capturedRequest(event), destinationUrl: new URL(event.requestTarget, `http://${capturedHost}`).href };
  return <>
    <div className="inspector-title"><div><span className={`method method-${event.method.toLowerCase()}`}>{event.method}</span><h2>{reveal ? event.requestTarget : redactUrl(event.requestTarget)}</h2></div><span className="response-badge">HTTP {event.responseStatus}</span></div>
    <div className="inspector-subtitle"><span>{new Date(event.receivedAt).toLocaleString('en-US')}</span><span>{event.durationMs.toFixed(2)} ms</span><span>{formatBytes(event.bodySize)}</span></div>
    <div className="action-bar inspector-actions"><button className="text-button" onClick={() => { setTab('Replays'); setOpenEditor((current) => ({ count: current.count + 1, edit: false })); }}>Replay (R)</button><button className="text-button" onClick={() => { setTab('Replays'); setOpenEditor((current) => ({ count: current.count + 1, edit: true })); }}>Edit & Replay (E)</button><button className="text-button" onClick={() => setShowCurl(!showCurl)}>Copy as cURL (C)</button><button className="text-button" aria-pressed={!!event.pinned} disabled={pinning} onClick={() => {
      setPinning(true); void pinEvent(event.id, !event.pinned).then((value) => { setEvent((current) => current?.id === event.id ? { ...current, pinned: value.pinned } : current); onPin(event.id, value.pinned); }).catch((failure: unknown) => setCopyStatus(failure instanceof Error ? failure.message : 'Unable to pin the event.')).finally(() => setPinning(false));
    }}>{event.pinned ? 'Unpin event' : 'Pin event'}</button></div>
    <div className="tabs" role="tablist" aria-label="Inspector sections">{tabs.map((name) => <button key={name} id={`tab-${name}`} role="tab" aria-selected={tab === name} aria-controls="inspector-panel" tabIndex={tab === name ? 0 : -1} onClick={() => { setTab(name); setCopyStatus(''); }} onKeyDown={(key) => {
      if (key.key === 'ArrowRight' || key.key === 'ArrowLeft' || key.key === 'Home' || key.key === 'End') {
        key.preventDefault();
        const next = key.key === 'Home' ? 0 : key.key === 'End' ? tabs.length - 1 : (tabs.indexOf(name) + (key.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        setTab(tabs[next]!);
        document.getElementById(`tab-${tabs[next]!}`)?.focus();
      }
    }}>{name}{name === 'Headers' && <span>{event.headers.length}</span>}{name === 'Query' && <span>{Object.keys(event.query).length}</span>}</button>)}</div>
    <div className="inspector-content" id="inspector-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} tabIndex={0}>
      <div className="action-bar quick-copy"><button className="text-button" disabled={!(view && 'original' in view) && !reveal} onClick={() => { void copy(view && 'original' in view ? reveal ? view.original : redactText(view.original) : event.rawBody.data); }}>{view && 'original' in view ? 'Copy payload' : 'Copy payload (Base64)'}</button><button className="text-button" onClick={() => { void copy(visibleHeaders.map(([name, value]) => `${name}: ${value}`).join('\n')); }}>{reveal ? 'Copy headers (including sensitive values)' : 'Copy headers (redacted)'}</button><button className="text-button" onClick={() => { void copy(reveal ? sourceRequest.destinationUrl : redactUrl(sourceRequest.destinationUrl)); }}>Copy URL</button><button className="text-button" onClick={() => { void copy(event.id); }}>Copy ID</button></div>
      {showCurl && <CurlCopy request={sourceRequest} close={() => setShowCurl(false)} />}
      <div className="section-heading"><h3>{tab === 'Raw' ? 'Original data' : tab}</h3>
        <button className="text-button" aria-pressed={reveal} onClick={() => setReveal(!reveal)}>{reveal ? 'Hide sensitive values' : 'Reveal sensitive values'}</button>
      </div>
      {copyStatus && <p className="copy-status" role="status">{copyStatus}</p>}
      {tab === 'Overview' && <><dl className="overview">{[
        ['Method', event.method], ['Endpoint', event.path], ['Received at', new Date(event.receivedAt).toLocaleString('en-US')],
        ['Response status', String(event.responseStatus)], ['Processing time', `${event.durationMs.toFixed(3)} ms`],
        ['Body size', `${event.bodySize} bytes`], ['Content-Type', event.contentType ?? 'Not provided'],
        ['Content-Encoding', event.contentEncoding ?? 'Not provided'], ['User-Agent', event.userAgent ?? 'Not provided'],
        ['Source IP', event.sourceIp ?? 'Unavailable'], ['Event ID', event.id],
      ].map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl><div className="provider-details"><h3>Likely provider: {event.provider?.provider ?? 'unknown'}</h3><p>Confidence: {event.provider?.confidence === 'high' ? 'high' : event.provider?.confidence === 'medium' ? 'medium' : 'low'}{event.provider?.eventType ? ` · ${event.provider.eventType}` : ''}</p><ul>{event.provider?.evidence.map((item) => <li key={item}>{providerEvidenceText(item)}</li>)}</ul><p className="notice">Detected from indicators. Signatures have not been verified.</p></div></>}
      {tab === 'Payload' && <Payload view={view} reveal={reveal} />}
      {tab === 'Headers' && <DataTable entries={visibleHeaders} />}
      {tab === 'Query' && <Pairs values={Object.fromEntries(Object.entries(event.query).map(([key, value]) => [key, !reveal && sensitiveField(key) ? MASK : value]))} />}
      {tab === 'Raw' && <><p className="notice">HTTP representation reconstructed from metadata. Spacing, transport framing, and headers below are not a raw copy of the connection.</p><pre className="code-block">{reconstructed}</pre><div className="section-heading raw-heading"><h3>Original body · Base64 · {event.bodySize} bytes</h3><button className="text-button" disabled={!reveal} onClick={() => { void copy(event.rawBody.data); }}>Copy Base64</button></div><p className="muted">Reveal values to access the exact received bytes.</p><pre className="code-block wrap">{reveal ? event.rawBody.data || '(0 bytes)' : MASK}</pre></>}
      {tab === 'Response' && <><div className="response-line"><span className="status-code">{event.responseStatus}</span><span>Response configured at capture time</span></div><DataTable entries={reveal ? event.response.headers : redactHeaders(event.response.headers)} /><h3 className="raw-heading">Response body</h3><pre className="code-block json">{reveal ? event.response.body : redactText(event.response.body)}</pre><p className="muted">Response metadata produced by the application. Excludes headers added by the transport.</p></>}
      <div hidden={tab !== 'Replays'}><ReplayPanel key={event.id} event={event} cache={editors.current} openEditor={openEditor} /></div>
    </div>
  </>;
}
