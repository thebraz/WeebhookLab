import { useMemo, useState } from 'react';
import type { DiffResult } from '../shared/diff';
import { MASK, redactText, sensitivePath } from '../shared/redaction';
const labels = { added: 'added', removed: 'removed', modified: 'modified', 'type-changed': 'type changed' };
export default function DiffPanel({ result, left, right }: { result: DiffResult; left: string; right: string }) {
  const [mode, setMode] = useState('unified'); const [limit, setLimit] = useState(50); const [reveal, setReveal] = useState(false); const [index, setIndex] = useState(0);
  const counts = useMemo(() => result.changes.reduce((acc, change) => ({ ...acc, [change.type]: acc[change.type] + 1 }), { added: 0, removed: 0, modified: 0, 'type-changed': 0 }), [result]);
  const value = (item: unknown, path: string) => { if (item === undefined) return '∅ missing'; if (!reveal && sensitivePath(path)) return MASK;
    const text = JSON.stringify(item, null, 2); const display = reveal ? text : redactText(text); return display.length > 8192 ? display.slice(0, 8192) + '\n… value shortened' : display; };
  const navigate = (direction: number) => { const next = Math.max(0, Math.min(result.changes.length - 1, index + direction)); setIndex(next); setLimit((old) => Math.max(old, next + 1)); requestAnimationFrame(() => document.getElementById(`diff-change-${next}`)?.focus()); };
  return <section className="diff-panel" aria-label="Structural comparison"><div className="section-heading"><h3>{left} → {right}</h3><select aria-label="Comparison mode" value={mode} onChange={(e) => setMode(e.target.value)}><option value="unified">Unified</option><option value="side">Side by side</option></select><button className="text-button" type="button" aria-pressed={reveal} onClick={() => setReveal(!reveal)}>{reveal ? 'Hide sensitive values' : 'Reveal sensitive values'}</button></div>
    <p className="muted">{Object.entries(counts).map(([type, count]) => `${count} ${labels[type as keyof typeof labels]}`).join(' · ')}. Arrays are compared by index; object key order is ignored.</p>
    {result.notices.map((notice, i) => <p className="notice warning" key={i}>{notice}</p>)}{result.truncated && <p className="notice warning">Result limited to 1,000 changes.</p>}
    {!result.changes.length && !result.notices.length && <p className="notice">No changes.</p>}
    {!!result.changes.length && <div className="action-bar"><button className="text-button" type="button" disabled={index === 0} onClick={() => navigate(-1)}>Previous</button><span>{index + 1} / {result.changes.length}</span><button className="text-button" type="button" disabled={index === result.changes.length - 1} onClick={() => navigate(1)}>Next change</button></div>}
    {result.changes.slice(0, limit).map((change, i) => <article className="diff-change" id={`diff-change-${i}`} key={`${change.path}-${i}`} tabIndex={-1}><h4><code>{change.path}</code> · {labels[change.type]}</h4><div className={mode === 'side' ? 'diff-columns' : ''}><pre className="diff-removed">− {value(change.previous, change.path)}</pre><pre className="diff-added">+ {value(change.current, change.path)}</pre></div></article>)}
    {limit < result.changes.length && <button className="text-button" type="button" onClick={() => setLimit(limit + 50)}>50 more changes</button>}
  </section>;
}
