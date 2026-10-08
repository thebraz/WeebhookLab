import { useMemo, useState } from 'react';
import { checkJson, formatPath, type Json, type JsonPath } from '../shared/json';
import { copyText } from './api';
export default function JsonPaths({ text }: { text: string }) {
  const [limit, setLimit] = useState(100); const [status, setStatus] = useState('');
  const data = useMemo(() => {
    try {
      const value: unknown = JSON.parse(text); checkJson(value); const paths: string[] = [];
      const walk = (item: Json, path: JsonPath) => { if (paths.length >= 1000) return; if (path.length) paths.push(formatPath(path));
        if (Array.isArray(item)) item.forEach((child, i) => walk(child, [...path, i]));
        else if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) walk(child, [...path, key]); };
      walk(value, []); return { paths, error: '' };
    } catch (error) { return { paths: [], error: error instanceof Error ? error.message : 'Invalid JSON.' }; }
  }, [text]);
  return <details className="json-paths"><summary>JSON paths · copy property</summary>{data.error && <p className="notice warning">{data.error}</p>}
    {data.paths.slice(0, limit).map((path) => <div className="path-row" key={path}><code>{path}</code><button className="text-button" type="button" aria-label={`Copy path ${path}`} onClick={() => { void copyText(path).then(() => setStatus(`Copied: ${path}`)).catch(() => setStatus('Unable to copy.')); }}>Copy path</button></div>)}
    {limit < data.paths.length && <button className="text-button" type="button" onClick={() => setLimit(limit + 100)}>More paths (up to 1,000)</button>}{status && <p role="status">{status}</p>}
  </details>;
}
