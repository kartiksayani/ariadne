import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Immutable } from '../../data/session-store';
import type { SessionRef } from '../../generated/core';
import type { Item, Session } from '../../generated/domain/models';
import type { NavigationStore } from '../../state/navigation/store';
import type { ChangeRow } from '../../selectors/changes/card';
import { briefLists } from '../../selectors/changes/topic';
import { changeLabel } from '../../selectors/changes/label';
import { type AwayGroup, awayGroups, type UnseenRow, unseenTopicRows } from '../../selectors/changes/unseen';
import { activeItems } from '../../selectors/removed';
import { waitingOnOwner } from '../../selectors/sessionClosed';
import { displayStatus } from '../../selectors/waiting/replied';
import { peekNames } from '../peek/names';
import { StatusBadge } from '../shared/StatusBadge';
import { STATUS, statusColor, statusKey } from '../shared/status';
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
  return <>{shown.map((item, index) => <Fragment key={item.id}>{index > 0 && ', '}<ItemName item={item} route={route} label={labels.get(item.id)} onOpen={onOpen} /></Fragment>)}
    {items.length > shown.length && <span className="change-muted"> and {items.length - shown.length} more</span>}</>;
}

const COUNT_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
/** Small counts read as words in a sentence ("Two things need you"), larger ones as digits. */
const countWord = (count: number) => COUNT_WORDS[count] ?? String(count);

/** SPEC 5.5: each counted line of the away summary leads with its status icon; findings to ack use the plain check. */
const AWAY_ICON: Readonly<Record<AwayGroup['key'], { readonly icon: string; readonly color: string }>> = {
  waiting: { icon: STATUS.waiting.icon, color: statusColor('waiting') },
  decided: { icon: STATUS.decided.icon, color: statusColor('decided') },
  ack: { icon: 'ph ph-check', color: 'var(--color-text)' },
  replaced: { icon: STATUS.replaced.icon, color: statusColor('replaced') },
  progress: { icon: STATUS.progress.icon, color: statusColor('progress') },
};

/** The agent's own paragraph, folded to three lines; "Show more" appears only when the text is cut. */
function BriefLead({ text }: { readonly text: string }) {
  const box = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => { if (!open) setCut(element.scrollHeight > element.clientHeight + 1); };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [text, open]);
  return <div className="brief-lead">
    <p ref={box} className="brief-text" data-open={open || undefined}>{text}</p>
    {cut && <button type="button" className="brief-more" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'Show less' : 'Show more'}</button>}
  </div>;
}

/** The away summary as it reads when the rows are taken: its counts and names stay while the popover is open. */
function awaySnapshot(session: Immutable<Session>, data: UnseenData) {
  const long = data.summary.longAbsence && data.list.length > 0;
  return { long, summary: data.summary, groups: long ? awayGroups(session, data.summary) : [] };
}

/** What changed in one topic (SPEC 5.5, D18): the brief, then what moved since the owner was last here. */
export function ChangesPopover({ session, topicId, route, navigation, data, undoToken, onOpenItem }: {
  readonly session: Immutable<Session>; readonly topicId: string; readonly route: SessionRef; readonly navigation: NavigationStore;
  readonly data: UnseenData; readonly undoToken: string | null; readonly onOpenItem: (id: string) => void;
}) {
  const storageKey = briefKey(session, topicId);
  const [briefOpen, setBriefOpen] = useState(() => readExpanded(storageKey));
  const briefButton = useRef<HTMLButtonElement>(null);
  const topic = session.topics[topicId];
  const labels = peekNames(session);
  const { summary, list } = data;
  const lists = useMemo(() => briefLists(session, topicId), [session, topicId]);
  const waiting = useMemo(() => activeItems(session).filter(item => item.topic_id === topicId && waitingOnOwner(session, item))
    .sort((left, right) => (left.waiting_since ?? left.created_at).localeCompare(right.waiting_since ?? right.created_at)), [session, topicId]);
  // Every row shown since the popover opened is held, so a row the owner reads elsewhere (the dwell on Details, the dock) stays,
  // dimmed, instead of vanishing under the pointer. A held row leaves only when its item is removed, archived or moved to another
  // topic, or on Mark all caught up. An entry in `list` always wins over its held copy: a newer unseen revision shows as live.
  const live = useMemo(() => new Set(activeItems(session).filter(item => item.topic_id === topicId).map(item => item.id)), [session, topicId]);
  const [held, setHeld] = useState<ReadonlyMap<string, UnseenRow>>(() => new Map(list.map(entry => [entry.row.item.id, entry])));
  // The "While you were away" section reads from the summary as it was when the rows were taken, so it never collapses under the owner.
  const [away, setAway] = useState(() => awaySnapshot(session, data));
  let current = held;
  const edit = () => { if (current === held) current = new Map(held); return current as Map<string, UnseenRow>; };
  for (const id of held.keys()) if (!live.has(id)) edit().delete(id);
  for (const entry of list) if (current.get(entry.row.item.id) !== entry) edit().set(entry.row.item.id, entry);
  if (current !== held) setHeld(current);
  if (held.size === 0 && list.length > 0) setAway(awaySnapshot(session, data));
  const listed = new Set(list.map(entry => entry.row.item.id));
  const silent = useRef(new Set<string>());
  const previous = useRef(listed);
  const [announcement, setAnnouncement] = useState({ sequence: 0, text: '' });
  useEffect(() => {
    const gone = [...previous.current].filter(id => !listed.has(id) && !silent.current.has(id) && held.has(id));
    listed.forEach(id => silent.current.delete(id));
    previous.current = listed;
    if (gone.length === 0) return;
    const names = gone.map(id => labels.get(id) ?? shortLabel(held.get(id)!.row.item));
    setAnnouncement(value => ({ sequence: value.sequence + 1, text: names.map(name => `${name} seen`).join('. ') }));
  }, [list, held]);   // It runs when the list or the held set changes; the rest is read fresh.
  if (!topic) return null;
  const longAway = away.long && current.size > 0;
  const canUndo = !!undoToken && navigation.reading.canUndo(undoToken);
  const rows = [...current.values()].sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
  const toggleBrief = (next: boolean) => {
    setBriefOpen(next);
    try { localStorage.setItem(storageKey, next ? 'expanded' : 'collapsed'); } catch { /* The brief still opens for this view. */ }
  };
  const markSeen = (row: UnseenRow) => {
    if (!navigation.markItemSeen(route, row.row.item.id, row.row.item.revision)) return;
    silent.current.add(row.row.item.id);   // The owner's own click is not announced.
  };
  const catchUp = () => {
    list.forEach(entry => silent.current.add(entry.row.item.id));
    setHeld(new Map());
    const at = new Date().toISOString();
    const opened = navigation.opened.get(route)?.getSnapshot();
    const coversCurrent = opened?.status === 'ready' && opened.snapshot?.freshness === 'fresh' && opened.snapshot.session.revision === session.revision;
    navigation.reading.catchUp({ kind: 'mark_seen', session: route, at,
      items: data.rows.map(row => ({ item_id: row.item.id, revision: row.item.revision })), topics: coversCurrent ? [{ topic_id: topicId, at: session.updated_at }] : [] }, topicId);
  };
  const lastReworded = summary.groups.reworded.flatMap(row => row.records.map(record => ({ row, at: record.at }))).sort((left, right) => Date.parse(right.at) - Date.parse(left.at))[0];
  const since = summary.baseline ? clockTime(summary.baseline) : null;
  // A row seen elsewhere stays, dimmed, until the popover closes; "All caught up" shows when nothing is left to show.
  const caughtUp = rows.length === 0;
  const quiet = away.groups.find(group => group.key === 'progress');
  const needs = away.groups.find(group => group.key === 'waiting');

  const undoButton = <button type="button" className="btn btn-ghost changes-undo-button" onClick={() => navigation.reading.undo(undoToken!)}>↺ Undo</button>;
  // SPEC 5.2: each group lists its names with a one-line text: the outcome of a decided or replaced item, the question that waits on the owner.
  const oneLine = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();
  const briefGroups = [
    { label: 'Decided', status: 'decided' as const, rows: lists.decided, line: (row: ChangeRow) => oneLine(row.item.outcome || row.item.why) },
    { label: 'Your turn', status: 'waiting' as const, rows: lists.yourTurn, line: (row: ChangeRow) => oneLine(row.item.ask || row.item.question) },
    { label: 'Replaced', status: 'replaced' as const, rows: lists.replaced, line: (row: ChangeRow) => oneLine(row.item.outcome || row.item.why) },
  ];
  const brief = <section className="changes-section" aria-label="Topic brief">
    <button ref={briefButton} type="button" className="changes-brief-head" aria-expanded={briefOpen} onClick={() => toggleBrief(!briefOpen)}>
      <i className={briefOpen ? 'ph ph-caret-down' : 'ph ph-caret-right'} aria-hidden="true" />
      <span className="changes-label-caps">Brief</span>
      {topic.brief && <>{' '}<span className="change-muted">by the agent · updated <time dateTime={topic.brief_updated_at ?? topic.created_at}>{clockTime(topic.brief_updated_at ?? topic.created_at)}</time></span></>}
    </button>
    {!briefOpen && <p className="change-muted changes-brief-counts">{lists.decided.length} decided · {lists.yourTurn.length} your turn · {lists.replaced.length} replaced</p>}
    {briefOpen && <div className="changes-brief-body">
      {topic.brief && <BriefLead text={topic.brief} />}
      {briefGroups.map(group => <div className="brief-group" key={group.label}>
        <h3 className="brief-group-label"><i className={STATUS[group.status].icon} style={{ color: statusColor(group.status) }} aria-hidden="true" />{group.label}</h3>
        <ul>{group.rows.length ? group.rows.map(row => <li key={row.item.id}>
          <span className="brief-names">
            <ItemName item={row.item} route={route} label={labels.get(row.item.id)} onOpen={onOpenItem} />
            {group.label === 'Replaced' && <>{' '}<span role="img" aria-label="replaced by">→</span>{' '}
              {row.replacement ? <ItemName item={row.replacement} route={route} label={labels.get(row.replacement.id)} onOpen={onOpenItem} /> : <span className="change-muted">an unavailable item</span>}</>}
          </span>
          {group.line(row) && <span className="brief-line">{group.line(row)}</span>}
        </li>) : <li className="change-muted">{group.label === 'Your turn' ? 'No questions waiting on you' : 'None yet'}</li>}</ul>
      </div>)}
    </div>}
  </section>;

  return <div className="changes-body" data-testid="changes-body">
    <div className="accessibility-announcement" role="status" aria-live="polite" aria-atomic="true" aria-label="Seen elsewhere"><span key={announcement.sequence}>{announcement.text}</span></div>
    {longAway && <section className="changes-section changes-away" aria-label="While you were away">
      <p className="changes-away-lead">You were away since {weekdayName(away.summary.baseline!)} {clockTime(away.summary.baseline!)}. A lot moved in this topic{quiet && quiet.count * 2 >= away.summary.changeCount ? ', most of it progress notes' : ''}.
        {needs ? ` ${needs.count === 1 ? 'One thing needs' : `${countWord(needs.count)} things need`} you.` : ''}</p>
      <ul className="changes-away-list">{away.groups.map(group => <li key={group.key}>
        <i className={`${AWAY_ICON[group.key].icon} changes-away-icon`} style={{ color: AWAY_ICON[group.key].color }} aria-hidden="true" />
        <span className="changes-away-count">{group.count}</span><span className="changes-away-label">{group.label}</span>
        {group.key !== 'progress' && <span className="changes-away-names"><Names items={group.items} session={session} route={route} onOpen={onOpenItem} /></span>}</li>)}</ul>
      <div className="changes-away-actions">
        {waiting[0] && <button type="button" className="changes-action" data-kind="primary" onClick={() => onOpenItem(waiting[0]!.id)}><i className="ph-fill ph-question" aria-hidden="true" />Start with what’s waiting</button>}
        <button type="button" className="changes-action" data-kind="outline" onClick={() => { toggleBrief(true); briefButton.current?.focus(); }}>Read the brief</button>
        {canUndo ? undoButton : <button type="button" className="changes-action" data-kind="ghost" title="Clears every marker. Nothing is acked or changed." onClick={catchUp}>Mark all caught up</button>}
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
        {!longAway && (canUndo ? undoButton : <button type="button" className="changes-catch-up" title="Clears every marker. Nothing is acked or changed." aria-label="Mark all caught up" onClick={catchUp}><i className="ph ph-check" aria-hidden="true" />
          <span className="changes-catch-up-verb" aria-hidden="true">Mark </span><span className="changes-catch-up-rest" aria-hidden="true">all caught up</span></button>)}
      </div>
      <ul className="changes-rows">{rows.map(entry => {
        const { row, kind } = entry, item = row.item, marked = !listed.has(item.id);
        const name = labels.get(item.id) ?? shortLabel(item);
        const label = row.replacement && item.status === 'replaced' ? `Replaced by “${labels.get(row.replacement.id) ?? shortLabel(row.replacement)}”` : changeLabel(item, entry.record, entry.later);
        return <li className="changes-row" data-testid="changes-row" key={item.id} data-item-id={item.id} data-kind={kind} data-seen={marked || undefined}>
          <StatusBadge status={statusKey[displayStatus(session, item)]} variant="icon" size={14} />
          <span className="changes-line">
            {!marked && <ChangeMarker kind={kind} />}
            <ItemName item={item} route={route} label={name} onOpen={onOpenItem} />
            <span className="changes-what" data-tone={waitingOnOwner(session, item) ? 'ask' : undefined}>{label}</span>
          </span>
          <Compare row={row} session={session} why={item.why} variant="link" />
          <time className="changes-time" dateTime={entry.at}>{clockTime(entry.at)}</time>
          <button type="button" className="changes-seen" aria-disabled={marked || undefined} title="Mark seen" aria-label={marked ? `${name} is seen` : `Mark ${name} seen`}
            onClick={() => { if (!marked) markSeen(entry); }}><i className="ph ph-check" aria-hidden="true" /></button>
        </li>;
      })}</ul>
    </section>}
    {lastReworded && <p className="change-muted changes-footnote">Rewordings aren’t counted: “{labels.get(lastReworded.row.item.id) ?? shortLabel(lastReworded.row.item)}” was reworded at {clockTime(lastReworded.at)}.</p>}
  </div>;
}
