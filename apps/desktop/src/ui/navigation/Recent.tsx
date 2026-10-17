import { useEffect, useMemo, useRef } from 'react';
import type { RecentAction, RecentItem } from '../../generated/core';
import type { Session } from '../../generated/domain/models';
import type { Immutable } from '../../data/session-store';
import { changeLabel } from '../../selectors/changes/label';
import { changedLately } from '../../selectors/changes/lately';
import { itemRemoved } from '../../selectors/removed';
import { clockTime } from '../changes/clock';
import { peekNames } from '../peek/names';
import { usePeek } from '../peek/context';
import { usePopover, useRestoreFocus } from '../parts/parts';
import './recent.css';

export const RECENT_LIMIT = 15;
/** Visits form a distinct-item recency list, independently of back/forward. */
export function recordRecent(entries: readonly Immutable<RecentItem>[] | undefined, itemId: string,
  action: RecentAction, now: string = new Date().toISOString()): RecentItem[] {
  const ids = new Set([itemId]);
  return [{ item_id: itemId, action, visited_at: now }, ...(entries ?? []).filter(entry => {
    if (ids.has(entry.item_id)) return false;
    ids.add(entry.item_id); return true;
  }).map(entry => ({ ...entry }))].slice(0, RECENT_LIMIT);
}
export function recentEntries(session: Immutable<Session>, entries: readonly Immutable<RecentItem>[] | undefined) {
  return (entries ?? []).slice(0, RECENT_LIMIT).flatMap(entry => {
    const item = session.items[entry.item_id];
    return item && !itemRemoved(session, item.id) ? [{ entry, item }] : [];
  });
}

/**
 * The top-bar Recent popover (SPEC 6.11, D19). "Changed lately": the six items whose latest real change is newest, each with
 * what changed. "Viewed": the items the owner visited, newest first, with the time. A click selects the item and closes it.
 * Hovering a name peeks it; neither opening nor peeking changes what the owner has seen.
 */
export function RecentPopover({ session, entries, onReveal, onClose }: {
  readonly session: Immutable<Session>;
  readonly entries: readonly Immutable<RecentItem>[] | undefined;
  readonly onReveal: (id: string) => void;
  readonly onClose: (restoreFocus: boolean) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  usePopover(true, onClose, panel, '[data-popover-trigger="recent"]');
  useRestoreFocus(panel);
  useEffect(() => { panel.current?.focus(); }, []);
  const peek = usePeek();
  const labels = peekNames(session);
  const lately = useMemo(() => changedLately(session), [session]);
  const visits = useMemo(() => recentEntries(session, entries), [session, entries]);
  const route = { project_id: session.project_id, session_id: session.id };
  const open = (id: string) => { onClose(false); onReveal(id); };
  const hover = (id: string) => peek ? peek.hoverProps({ ...route, item_id: id }) : {};
  return <div ref={panel} className="recent-popover" role="dialog" aria-label="Recent items" tabIndex={-1}
    onKeyDown={event => { if (!event.metaKey && !event.ctrlKey && event.key !== 'Escape' && event.key !== 'F6') event.stopPropagation(); }}>
    <div className="recent-head">
      <i className="ph ph-clock-counter-clockwise" aria-hidden="true" />
      <h2>Recent</h2>
      <button type="button" className="btn btn-ghost recent-close" aria-label="Close recent" title="Close ( esc )" onClick={() => onClose(true)}>×</button>
    </div>
    <section className="recent-section" aria-label="Changed lately">
      <h3 className="p-label">Changed lately</h3>
      {lately.length ? <ul className="recent-list">{lately.map(({ item, record, later, at }) => <li key={item.id}>
        <button type="button" className="recent-item" title={item.question} {...hover(item.id)} onClick={() => open(item.id)}>
          <span className="recent-name">{labels.get(item.id)}</span>
          <small>· {changeLabel(item, record, later)}</small>
          <time dateTime={at}>{clockTime(at)}</time>
        </button></li>)}</ul> : <p className="recent-empty">Nothing has changed yet.</p>}
    </section>
    <section className="recent-section" aria-label="Viewed">
      <h3 className="p-label">Viewed</h3>
      {visits.length ? <ul className="recent-list">{visits.map(({ entry, item }) => <li key={item.id}>
        <button type="button" className="recent-item" title={item.question} {...hover(item.id)} onClick={() => open(item.id)}>
          <span className="recent-name">{labels.get(item.id)}</span>
          <small>· {entry.action}</small>
          <time dateTime={entry.visited_at}>{clockTime(entry.visited_at)}</time>
        </button></li>)}</ul> : <p className="recent-empty">Open or peek at an item to start your recent trail.</p>}
    </section>
  </div>;
}
