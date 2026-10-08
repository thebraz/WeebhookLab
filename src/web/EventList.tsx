import { memo, useEffect, useLayoutEffect, useRef } from 'react';
import type { EventSummary } from '../shared/contracts';
import { formatBytes, formatTime } from './api';

interface Props { events: EventSummary[]; selectedId: string | null; onSelect: (id: string) => void; compared?: string[]; onCompare?: (id: string) => void }

const EventRow = memo(function EventRow({ event, selected, focusable, compared, comparisonDisabled, onSelect, onCompare }: {
  event: EventSummary; selected: boolean; focusable: boolean; compared: boolean; comparisonDisabled: boolean;
  onSelect: Props['onSelect']; onCompare: Props['onCompare'];
}) {
  return <div className="comparable-event" data-event-id={event.id}>{onCompare && <input type="checkbox" tabIndex={focusable ? 0 : -1} aria-label={`Compare event ${event.sequence}`} checked={compared} disabled={comparisonDisabled} onChange={() => onCompare(event.id)} />}<button type="button" tabIndex={focusable ? 0 : -1} className={`event-row ${selected ? 'selected' : ''}`}
    aria-pressed={selected} onClick={() => onSelect(event.id)} onKeyDown={(key) => { if (key.key === 'Enter') { key.preventDefault(); document.getElementById('inspector-panel')?.focus(); } }}>
    <div className="event-main">{event.pinned && <span className="pin-indicator" title="Pinned event" aria-label="Pinned event">◆</span>}<span className={`method method-${event.method.toLowerCase()}`}>{event.method}</span><span className="event-path" title={event.path}>{event.path}</span><span className={`status-code status-${Math.floor(event.responseStatus / 100)}`}>{event.responseStatus}</span></div>
    <div className="event-meta"><span>{event.provider && event.provider.provider !== 'unknown' ? `${event.provider.provider}${event.provider.eventType ? ` · ${event.provider.eventType}` : ''}` : event.contentType?.split(';')[0] || 'no content type'} · {formatBytes(event.bodySize)}</span><time dateTime={event.receivedAt} title={new Date(event.receivedAt).toLocaleString('en-US')}>{formatTime(event.receivedAt)}</time></div>
  </button></div>;
});

export default memo(function EventList({ events, selectedId, onSelect, compared = [], onCompare }: Props) {
  const list = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ id: string; top: number } | null>(null);
  useEffect(() => {
    const scroll = list.current?.parentElement;
    if (!scroll) return;
    const remember = () => {
      if (!list.current || scroll.scrollTop === 0) { anchor.current = null; return; }
      const rows = list.current.children;
      const top = scroll.getBoundingClientRect().top + (rows[0]?.getBoundingClientRect().height ?? 0);
      let low = 1; let high = rows.length - 1;
      while (low < high) { const middle = (low + high) >> 1; if (rows[middle]!.getBoundingClientRect().bottom <= top) low = middle + 1; else high = middle; }
      const row = rows[low] as HTMLElement | undefined;
      anchor.current = row?.dataset.eventId ? { id: row.dataset.eventId, top: row.getBoundingClientRect().top - scroll.getBoundingClientRect().top } : null;
    };
    scroll.addEventListener('scroll', remember, { passive: true });
    return () => scroll.removeEventListener('scroll', remember);
  }, []);
  useLayoutEffect(() => {
    const scroll = list.current?.parentElement;
    const row = anchor.current && list.current?.querySelector<HTMLElement>(`[data-event-id="${anchor.current.id}"]`);
    if (scroll && row && anchor.current) scroll.scrollTop += row.getBoundingClientRect().top - scroll.getBoundingClientRect().top - anchor.current.top;
    else anchor.current = null;
  }, [events]);
  useLayoutEffect(() => {
    const scroll = list.current?.parentElement;
    const row = list.current?.querySelector<HTMLElement>(`[data-event-id="${selectedId}"]`);
    if (!scroll || !row) return;
    const viewport = scroll.getBoundingClientRect();
    const bounds = row.getBoundingClientRect();
    const top = viewport.top + (list.current?.firstElementChild?.getBoundingClientRect().height ?? 0);
    if (bounds.top < top) scroll.scrollTop -= top - bounds.top;
    else if (bounds.bottom > viewport.bottom) scroll.scrollTop += bounds.bottom - viewport.bottom;
    if (list.current?.contains(document.activeElement) && document.activeElement instanceof HTMLButtonElement) row.querySelector<HTMLButtonElement>('.event-row')?.focus({ preventScroll: true });
  }, [selectedId]);
  const hasSelection = events.some((event) => event.id === selectedId);
  return <div ref={list} className="event-list" aria-label="Captured events">
    <div className="list-columns" aria-hidden="true"><span>REQUEST</span><span>STATUS / TIME</span></div>
    {events.map((event, index) => <EventRow key={event.id} event={event} selected={selectedId === event.id} focusable={selectedId === event.id || (!hasSelection && index === 0)} compared={compared.includes(event.id)} comparisonDisabled={compared.length >= 2 && !compared.includes(event.id)} onSelect={onSelect} onCompare={onCompare} />)}
  </div>;
});
