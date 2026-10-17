import { useMemo, useRef, useState } from 'react';
import type { Immutable } from '../../data/session-store';
import type { SessionRef } from '../../generated/core';
import type { Item, Session } from '../../generated/domain/models';
import type { NavigationStore } from '../../state/navigation/store';
import { briefLists } from '../../selectors/changes/topic';
import { changeLabel } from '../../selectors/changes/label';
import { awayGroups, type UnseenRow, unseenTopicRows } from '../../selectors/changes/unseen';
import { activeItems } from '../../selectors/removed';
import { waitingOnOwner } from '../../selectors/sessionClosed';
import { displayStatus } from '../../selectors/waiting/replied';
import { peekNames } from '../peek/names';
import { StatusBadge } from '../shared/StatusBadge';
import { statusKey } from '../shared/status';
import { shortLabel } from '../shared/short';
import { ChangeMarker } from './ChangeMarker';
import { Compare } from './Compare';
import { ItemName } from './ItemName';
import { clockTime, weekdayName } from './clock';

export type UnseenData = ReturnType<typeof unseenTopicRows>;

function briefKey(session: Immutable<Session>, topicId: string) { return `ariadne:brief:${session.project_id}:${session.id}:${topicId}`; }
/** The brief starts closed in the popover; an owner who opened it keeps it open. */
function readExpanded(key: string) { try { return localStorage.getItem(key) === 'expanded'; } catch { return false; } }

function Names({ items, session, route, onOpen }: { readonly items: readonly Immutable<Item>[]; readonly session: Immutable<Session>;
  readonly route: SessionRef; readonly onOpen: (id: string) => void }) {
  const labels = peekNames(session);
  const shown = items.slice(0, 3);
  return <>{shown.map(item => <ItemName key={item.id} item={item} route={route} label={labels.get(item.id)} onOpen={onOpen} />)}
    {items.length > shown.length && <span className="change-muted">and {items.length - shown.length} more</span>}</>;
}

/** What changed in one topic (SPEC 5.5, D18): the brief, then what moved since the owner was last here. */
export function ChangesPopover({ session, topicId, route, navigation, data, undoToken, onOpenItem }: {
  readonly session: Immutable<Session>; readonly topicId: string; readonly route: SessionRef; readonly navigation: NavigationStore;
  readonly data: UnseenData; readonly undoToken: string | null; readonly onOpenItem: (id: string) => void;
}) {
  const storageKey = briefKey(session, topicId);
  const [briefOpen, setBriefOpen] = useState(() => readExpanded(storageKey));
  const [seenHere, setSeenHere] = useState<ReadonlyMap<string, UnseenRow>>(new Map());
  const briefButton = useRef<HTMLButtonElement>(null);
  const topic = session.topics[topicId];
  const labels = peekNames(session);
  const { summary, list } = data;
  const lists = useMemo(() => briefLists(session, topicId), [session, topicId]);
  const longAway = summary.longAbsence && list.length > 0;
  const away = useMemo(() => longAway ? awayGroups(session, summary) : [], [session, summary, longAway]);
  const waiting = useMemo(() => activeItems(session).filter(item => item.topic_id === topicId && waitingOnOwner(session, item))
    .sort((left, right) => (left.waiting_since ?? left.created_at).localeCompare(right.waiting_since ?? right.created_at)), [session, topicId]);
  if (!topic) return null;
  const canUndo = !!undoToken && navigation.reading.canUndo(undoToken);
  const rows = [...list, ...[...seenHere.values()].filter(row => !list.some(value => value.row.item.id === row.row.item.id))]
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
  const toggleBrief = (next: boolean) => {
    setBriefOpen(next);
    try { localStorage.setItem(storageKey, next ? 'expanded' : 'collapsed'); } catch { /* The brief still opens for this view. */ }
  };
  const markSeen = (row: UnseenRow) => {
    if (!navigation.markItemSeen(route, row.row.item.id, row.row.item.revision)) return;
    setSeenHere(previous => new Map(previous).set(row.row.item.id, row));
  };
  const catchUp = () => {
    const at = new Date().toISOString();
    const current = navigation.opened.get(route)?.getSnapshot();
    const coversCurrent = current?.status === 'ready' && current.snapshot?.freshness === 'fresh' && current.snapshot.session.revision === session.revision;
    navigation.reading.catchUp({ kind: 'mark_seen', session: route, at,
      items: data.rows.map(row => ({ item_id: row.item.id, revision: row.item.revision })), topics: coversCurrent ? [{ topic_id: topicId, at: session.updated_at }] : [] }, topicId);
  };
  const lastReworded = summary.groups.reworded.flatMap(row => row.records.map(record => ({ row, at: record.at }))).sort((left, right) => Date.parse(right.at) - Date.parse(left.at))[0];
  const since = summary.baseline ? clockTime(summary.baseline) : null;
  // A row the owner just marked seen stays, dimmed, until the popover closes; "All caught up" shows when nothing is left to show.
  const caughtUp = rows.length === 0;
  const quiet = away.find(group => group.key === 'progress');
  const needs = away.find(group => group.key === 'waiting');

  const undoButton = <button type="button" className="btn btn-ghost changes-undo-button" onClick={() => navigation.reading.undo(undoToken!)}>↺ Undo</button>;
  const brief = <section className="changes-section" aria-label="Topic brief">
    <button ref={briefButton} type="button" className="changes-brief-head" aria-expanded={briefOpen} onClick={() => toggleBrief(!briefOpen)}>
      <i className={briefOpen ? 'ph ph-caret-down' : 'ph ph-caret-right'} aria-hidden="true" />
      <span className="changes-label-caps">Brief</span>
      {topic.brief && <>{' '}<span className="change-muted">by the agent · updated <time dateTime={topic.brief_updated_at ?? topic.created_at}>{clockTime(topic.brief_updated_at ?? topic.created_at)}</time></span></>}
      {!briefOpen && <>{' '}<span className="change-muted changes-brief-counts">{lists.decided.length} decided · {lists.yourTurn.length} your turn · {lists.replaced.length} replaced</span></>}
    </button>
    {briefOpen && <div className="changes-brief-body">
      {topic.brief && <p className="brief-text">{topic.brief}</p>}
      {[{ label: 'Decided', rows: lists.decided }, { label: 'Your turn', rows: lists.yourTurn }, { label: 'Replaced', rows: lists.replaced }].map(group => <div className="brief-list" key={group.label}>
        <strong>{group.label}</strong><ul>{group.rows.length ? group.rows.map(row => <li key={row.item.id} data-pair={group.label === 'Replaced' || undefined}>
          {group.label === 'Replaced'
            ? <><del><ItemName item={row.item} route={route} label={labels.get(row.item.id)} onOpen={onOpenItem} /></del>{' '}<span className="brief-replacement"><span className="change-muted">replaced by </span>
              {row.replacement ? <ItemName item={row.replacement} route={route} label={labels.get(row.replacement.id)} onOpen={onOpenItem} /> : <span className="change-muted">an unavailable item</span>}</span></>
            : <ItemName item={row.item} route={route} label={labels.get(row.item.id)} onOpen={onOpenItem} />}
        </li>) : <li className="change-muted">{group.label === 'Your turn' ? 'No questions waiting on you' : 'None yet'}</li>}</ul>
      </div>)}
    </div>}
  </section>;

  return <div className="changes-body" data-testid="changes-body">
    {longAway && <section className="changes-section changes-away" aria-label="While you were away">
      <p>You were away since {weekdayName(summary.baseline!)} {clockTime(summary.baseline!)}. A lot moved in this topic{quiet && quiet.count * 2 >= summary.changeCount ? ', most of it progress notes' : ''}.
        {needs ? ` ${needs.count === 1 ? 'One thing needs' : `${needs.count} things need`} you.` : ''}</p>
      <ul className="changes-away-list">{away.map(group => <li key={group.key}><strong>{group.count}</strong> {group.label}
        {group.key !== 'progress' && <span className="changes-away-names"><Names items={group.items} session={session} route={route} onOpen={onOpenItem} /></span>}</li>)}</ul>
      <div className="changes-away-actions">
        {waiting[0] && <button type="button" className="btn btn-primary" onClick={() => onOpenItem(waiting[0]!.id)}><i className="ph-fill ph-question" aria-hidden="true" /> Start with what’s waiting</button>}
        <button type="button" className="btn btn-secondary" onClick={() => { toggleBrief(true); briefButton.current?.focus(); }}>Read the brief</button>
        {canUndo ? undoButton : <button type="button" className="btn btn-ghost" title="Clears every marker. Nothing is acked or changed." onClick={catchUp}>Mark all caught up</button>}
      </div>
    </section>}
    {caughtUp && <p className="changes-caught-up" role="status"><i className="ph ph-check-circle" aria-hidden="true" />
      {canUndo ? <>All caught up. The markers are cleared; nothing was acked or changed. {undoButton}</>
        : <>All caught up. Nothing new{since ? ` since ${since}` : ''}.</>}</p>}
    {brief}
    {!caughtUp && <section className="changes-section" aria-label="Since you were here">
      <div className="changes-since-head">
        <span className="changes-label-caps">Since you were here</span>
        <span className="change-muted">{data.list.length} unseen{since ? ` · since ${since}` : ''}</span>
        {!longAway && (canUndo ? undoButton : <button type="button" className="btn btn-ghost changes-catch-up" title="Clears every marker. Nothing is acked or changed." onClick={catchUp}>✓ Mark all caught up</button>)}
      </div>
      <ul className="changes-rows">{rows.map(entry => {
        const { row, kind } = entry, item = row.item, marked = seenHere.has(item.id);
        const name = labels.get(item.id) ?? shortLabel(item);
        const label = row.replacement && item.status === 'replaced' ? `Replaced by “${labels.get(row.replacement.id) ?? shortLabel(row.replacement)}”` : changeLabel(item, entry.record, entry.later);
        return <li className="changes-row" data-testid="changes-row" key={item.id} data-item-id={item.id} data-kind={kind} data-seen={marked || undefined}>
          <StatusBadge status={statusKey[displayStatus(session, item)]} variant="icon" size={15} />
          {!marked && <ChangeMarker kind={kind} />}
          <ItemName item={item} route={route} label={name} onOpen={onOpenItem} />
          <span className="changes-what" data-tone={kind === 'new' ? 'new' : undefined}>{label}</span>
          <time className="changes-time" dateTime={entry.at}>{clockTime(entry.at)}</time>
          <button type="button" className="btn btn-ghost changes-seen" disabled={marked} title="Mark seen" aria-label={marked ? `${name} is seen` : `Mark ${name} seen`}
            onClick={() => markSeen(entry)}>{marked ? '✓ Seen' : '✓'}</button>
          <Compare row={row} session={session} why={item.why} />
        </li>;
      })}</ul>
    </section>}
    {lastReworded && <p className="change-muted changes-footnote">Rewordings aren’t counted: “{labels.get(lastReworded.row.item.id) ?? shortLabel(lastReworded.row.item)}” was reworded at {clockTime(lastReworded.at)}.</p>}
  </div>;
}
