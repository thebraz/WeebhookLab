import { useEffect, useMemo, useState } from 'react';
import type { WebhookEvent } from '../shared/contracts';
import { compareEvents } from '../shared/diff';
import { getEvent } from './api';
import DiffPanel from './DiffPanel';
export default function EventComparison({ ids, close }: { ids: string[]; close: () => void }) {
  const [events, setEvents] = useState<WebhookEvent[]>([]); const [error, setError] = useState(''); const key = ids.join(',');
  useEffect(() => { const controller = new AbortController(); setEvents([]); setError('');
    void Promise.all(key.split(',').map((id) => getEvent(id, controller.signal))).then((values) => { if (!controller.signal.aborted) setEvents(values); }).catch((e: unknown) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Comparison unavailable.'); });
    return () => controller.abort(); }, [key]);
  const diff = useMemo(() => events.length === 2 ? compareEvents(events[0]!, events[1]!) : null, [events]);
  return <div className="inspector-content"><button className="text-button" onClick={close}>Close comparison</button>{error && <p role="alert" className="notice warning">{error}</p>}{!diff && !error && <p role="status">Loading both events…</p>}{diff && <><p className="muted">A: {events[0]!.id}<br />B: {events[1]!.id}</p><DiffPanel result={diff} left={`Event #${events[0]!.sequence}`} right={`Event #${events[1]!.sequence}`} /></>}</div>;
}
