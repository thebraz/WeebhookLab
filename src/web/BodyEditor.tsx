import { useMemo, useRef, useState } from 'react';
import { MASK, redactText } from '../shared/redaction';

export default function BodyEditor({ value, onChange, json, disabled, label = 'Request body' }: { value: string; onChange: (value: string) => void; json: boolean; disabled: boolean; label?: string }) {
  const preview = useRef<HTMLPreElement>(null);
  const [reveal, setReveal] = useState(false);
  const redacted = useMemo(() => redactText(value), [value]);
  const sensitive = redacted.includes(MASK);
  const display = sensitive && !reveal ? redacted : value;
  const tokens = json && display.length <= 65_536 ? display.split(/("(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g) : [display];
  return <>{sensitive && <button className="text-button" type="button" aria-pressed={reveal} onClick={() => setReveal(!reveal)}>{reveal ? 'Hide sensitive body' : 'Reveal to edit sensitive body'}</button>}<div className="body-editor">
    <pre ref={preview} aria-hidden="true">{tokens.map((token, index) => <span key={index} className={json ? /^".*:\s*$/.test(token) ? 'json-key' : token.startsWith('"') ? 'json-string' : /^(true|false|null|-?\d)/.test(token) ? 'json-literal' : '' : ''}>{token}</span>)}{'\n'}</pre>
    <textarea aria-label={label} value={display} disabled={disabled || (sensitive && !reveal)} spellCheck={false} wrap="off" onChange={(event) => onChange(event.target.value)} onScroll={(event) => {
      if (preview.current) { preview.current.scrollTop = event.currentTarget.scrollTop; preview.current.scrollLeft = event.currentTarget.scrollLeft; }
    }} onKeyDown={(event) => {
      if (event.key !== 'Tab' || event.shiftKey) return;
      event.preventDefault();
      const input = event.currentTarget;
      const start = input.selectionStart;
      const next = value.slice(0, start) + '  ' + value.slice(input.selectionEnd);
      onChange(next);
      requestAnimationFrame(() => { input.selectionStart = input.selectionEnd = start + 2; });
    }} />
  </div></>;
}
