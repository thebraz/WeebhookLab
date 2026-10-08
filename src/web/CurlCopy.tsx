import { useState } from 'react';
import type { ReplayRequest } from '../shared/contracts';
import { curlCommand, queryPairs, sensitiveHeader, type CurlShell } from '../shared/replay';
import { copyText } from './api';
import { redactRequest, sensitiveField } from '../shared/redaction';

export default function CurlCopy({ request, close }: { request: ReplayRequest; close: () => void }) {
  const [shell, setShell] = useState<CurlShell>('powershell');
  const [include, setInclude] = useState(false);
  const [status, setStatus] = useState('');
  const hasSensitive = request.headers.some(([name]) => sensitiveHeader(name)) || queryPairs(request.destinationUrl).some(([name]) => sensitiveField(name)) || request.body.data !== redactRequest(request).body.data;
  let command = '';
  let error = '';
  try { command = curlCommand(include ? request : redactRequest(request), shell, include); } catch (failure) { error = failure instanceof Error ? failure.message : 'Invalid request.'; }
  return <section className="curl-copy" aria-label="Copy as cURL">
    <div className="section-heading"><h3>cURL · {shell === 'powershell' ? 'PowerShell / curl.exe' : 'POSIX · Bash / sh'}</h3><button className="text-button" onClick={close}>Close</button></div>
    <label>Shell <select aria-label="cURL shell" value={shell} onChange={(event) => setShell(event.target.value as CurlShell)}><option value="powershell">PowerShell (curl.exe)</option><option value="posix">POSIX (base64 --decode)</option></select></label>
    {hasSensitive && <label className="check-label"><input type="checkbox" checked={include} onChange={(event) => { setInclude(event.target.checked); setStatus(''); }} />Include original sensitive data in the command and clipboard</label>}
    {hasSensitive && <p className="notice">{include ? 'This command contains sensitive data.' : 'Secrets are hidden; opaque bodies are omitted. Reveal originals for an exact command.'}</p>}
    {error ? <p role="alert" className="notice warning">{error}</p> : <pre className="code-block wrap">{command}</pre>}
    <button className="text-button" disabled={!!error} onClick={() => { void copyText(command).then(() => setStatus('Copied')).catch(() => setStatus('Unable to copy')); }}>Copy command</button>
    {status && <span className="copy-status" role="status">{status}</span>}
  </section>;
}
