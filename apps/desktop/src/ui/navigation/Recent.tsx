import { useState } from 'react';
import type { RecentAction, RecentItem, SessionSeen } from '../../generated/core';
import type { Item, Session } from '../../generated/domain/models';
import type { Immutable } from '../../data/session-store';
import { isChangedSinceRead, isNewToOwner, type SeenState } from '../../selectors/changes/seen';
import { activeItems, itemRemoved } from '../../selectors/removed';
import { itemLabels } from '../shared/short';
import { Dialog } from '../dialogs/Dialog';
import './navigation.css';

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
export function recentEntries(session: Immutable<Session>, entries: readonly Immutable<RecentItem>[] | undefined,
  changedOnly = false, seen: SeenState = null) {
  return (entries ?? []).slice(0, RECENT_LIMIT).flatMap(entry => {
    const item = session.items[entry.item_id];
    return item && !itemRemoved(session, item.id) && (!changedOnly || isNewToOwner(item, seen) || isChangedSinceRead(item, seen))
      ? [{ entry, item }] : [];
  });
}
interface RecentProps {
  readonly session: Immutable<Session>;
  readonly entries: readonly Immutable<RecentItem>[] | undefined;
  readonly onReveal: (id: string) => void;
}
export function RecentTrail({ session, entries, nextWaiting, onReveal }: RecentProps & { readonly nextWaiting: Immutable<Item> | null }) {
  const labels = itemLabels(activeItems(session), session.topics);
  return <nav className="recent-trail" aria-label="Your recent trail">
    <div className="recent-trail-items">{recentEntries(session, entries).slice(0, 3).map(({ entry, item }, index) =>
      <span key={item.id}>{index > 0 && <span className="recent-trail-separator" aria-hidden="true">›</span>}
        <button type="button" title={item.question} onClick={() => onReveal(item.id)}>{labels.get(item.id)} <small>· {entry.action}</small></button></span>)}</div>
    {nextWaiting && <button type="button" className="recent-next" onClick={() => onReveal(nextWaiting.id)} title={nextWaiting.question}>
      Next: {labels.get(nextWaiting.id)} <span aria-hidden="true">→</span></button>}
  </nav>;
}
export function RecentDialog({ session, entries, seen, onReveal, onClose }: RecentProps & {
  readonly seen: Immutable<SessionSeen> | null | undefined;
  readonly onClose: () => void;
}) {
  const [changedOnly, setChangedOnly] = useState(false);
  const visits = recentEntries(session, entries, changedOnly, seen);
  const labels = itemLabels(activeItems(session), session.topics);
  return <Dialog label="Recent items" width={560} onCancel={onClose}>
    <div className="recent-header"><h2>Recent</h2><button type="button" className="btn btn-ghost" aria-pressed={changedOnly}
      onClick={() => setChangedOnly(value => !value)}>Changed only</button>
      <button type="button" className="btn btn-ghost" aria-label="Close recent" onClick={onClose}>×</button></div>
    <p className="recent-caption">Up to 15 different items · newest first</p>
    <div className="recent-list">{visits.map(({ entry, item }) => <button type="button" className="recent-item" key={item.id}
      onClick={() => { onReveal(item.id); onClose(); }}><span>{labels.get(item.id)} <small>· {entry.action}</small></span></button>)}</div>
    {!visits.length && <p className="recent-empty">{changedOnly ? 'No changed items in your recent visits.' : 'Open or peek at an item to start your recent trail.'}</p>}
  </Dialog>;
}
