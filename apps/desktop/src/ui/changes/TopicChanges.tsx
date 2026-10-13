import { useEffect, useMemo, useRef, useState } from 'react';
import type { Immutable } from '../../data/session-store';
import type { Session } from '../../generated/domain/models';
import { useNavigation, type NavigationStore } from '../../state/navigation/store';
import { useReadingSeen } from '../../state/preferences/reading';
import { briefLists, sinceYouWereHere } from '../../selectors/changes/topic';
import { changeRow, type ChangeRow } from '../../selectors/changes/card';
import type { SeenState } from '../../selectors/changes/seen';
import { Compare } from './Compare';
import { ChangeName } from './AnswerChanges';
import { shortLabel } from '../shared/short';

export function unseenTopicRows(session: Immutable<Session>, topicId: string, seen: SeenState, now = Date.now()) {
  const summary = sinceYouWereHere(session, topicId, seen, now);
  const reads = new Map(seen?.items.map(item => [item.item_id, item.revision]));
  const rows = [...summary.groups.updated, ...summary.groups.replaced, ...summary.groups.new].flatMap(row => {
    const records = row.records.filter(record => record.revision > (reads.get(row.item.id) ?? 0));
    const fresh = Date.parse(row.item.created_at) > Date.parse(summary.baseline ?? '') && !reads.has(row.item.id);
    return fresh || records.length ? [changeRow(session, row.item, records)] : [];
  }).sort((left, right) => newest(right) - newest(left));
  const count = rows.reduce((sum, row) => sum + row.records.length + Number(!reads.has(row.item.id) && Date.parse(row.item.created_at) > Date.parse(summary.baseline ?? '')), 0);
  return { summary, rows, count };
}
function newest(row: ChangeRow) { return Math.max(Date.parse(row.item.created_at), ...row.records.map(record => Date.parse(record.at))); }
function briefKey(session: Immutable<Session>, topicId: string) { return `ariadne:brief:${session.project_id}:${session.id}:${topicId}`; }
function readCollapsed(key: string) { try { return localStorage.getItem(key) === 'collapsed'; } catch { return false; } }
function time(at: string) { return new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }

export function TopicChanges({ session, topicId, navigation, onOpenItem }: {
  readonly session: Immutable<Session>; readonly topicId: string; readonly navigation: NavigationStore; readonly onOpenItem: (id: string) => void;
}) {
  const nav = useNavigation(navigation), route = useMemo(() => ({ project_id: session.project_id, session_id: session.id }), [session.project_id, session.id]);
  const seen = useReadingSeen(navigation.reading, nav.preferences, route);
  const topic = session.topics[topicId];
  const storageKey = briefKey(session, topicId);
  const [collapsed, setCollapsed] = useState(() => readCollapsed(storageKey));
  const [sinceOpen, setSinceOpen] = useState(false);
  const undoToken = navigation.reading.undoToken(route, topicId);
  const [leaving, setLeaving] = useState<readonly ChangeRow[]>([]);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const lists = useMemo(() => briefLists(session, topicId), [session, topicId]);
  const { summary, rows, count } = useMemo(() => unseenTopicRows(session, topicId, seen), [session, topicId, seen]);
  const canUndo = !!undoToken && navigation.reading.canUndo(undoToken);
  // A caught-up mark is an observation, never an owner-blocking mutation. Pending Undo already covers the topic.
  useEffect(() => {
    if (seen && summary.changeCount > 0 && !rows.length && !canUndo) navigation.markTopicCaughtUp(route, topicId, session.revision);
  }, [navigation, route, topicId, seen, summary.changeCount, rows.length, canUndo, session.revision]);
  useEffect(() => { setCollapsed(readCollapsed(storageKey)); }, [storageKey]);
  useEffect(() => () => { timers.current.forEach(timer => clearTimeout(timer)); }, []);
  if (!topic) return null;
  const toggleBrief = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem(storageKey, next ? 'collapsed' : 'expanded'); } catch { /* Collapse still works for this view. */ }
  };
  const mark = (row: ChangeRow) => {
    if (!navigation.markItemSeen(route, row.item.id, row.item.revision)) return;
    setLeaving(previous => [...previous.filter(value => value.item.id !== row.item.id), row]);
    const timer = setTimeout(() => { timers.current.delete(timer); setLeaving(previous => previous.filter(value => value !== row)); }, 3000);
    timers.current.add(timer);
  };
  const catchUp = () => {
    const at = new Date().toISOString();
    const current = navigation.opened.get(route)?.getSnapshot();
    const coversCurrent = current?.status === 'ready' && current.snapshot?.freshness === 'fresh' && current.snapshot.session.revision === session.revision;
    navigation.reading.catchUp({ kind: 'mark_seen', session: route, at,
      items: rows.map(row => ({ item_id: row.item.id, revision: row.item.revision })), topics: coversCurrent ? [{ topic_id: topicId, at: session.updated_at }] : [] }, topicId);
  };
  const displayRows = [...rows, ...leaving.filter(row => !rows.some(value => value.item.id === row.item.id))].sort((left, right) => newest(right) - newest(left));
  return <div className="topic-changes">
    <section className="topic-brief change-surface" aria-label="Topic brief">
      <button type="button" className="change-link" aria-expanded={!collapsed} onClick={toggleBrief}>Topic brief <i className={collapsed ? 'ph ph-caret-right' : 'ph ph-caret-down'} aria-hidden="true" /></button>
      {topic.brief && <span className="change-muted brief-attribution">By the agent · as of <time dateTime={topic.brief_updated_at ?? topic.created_at}>{time(topic.brief_updated_at ?? topic.created_at)}</time></span>}
      {!collapsed && <>
        {topic.brief && <p className="brief-text">{topic.brief}</p>}
        {[{ label: 'Decided', rows: lists.decided }, { label: 'Your turn', rows: lists.yourTurn }, { label: 'Replaced', rows: lists.replaced }].map(group => <div className="brief-list" key={group.label}>
          <strong>{group.label}</strong><ul>{group.rows.length ? group.rows.map(row => <li key={row.item.id}>
            {group.label === 'Replaced' ? <><del><ChangeName row={row} onOpenItem={onOpenItem} /></del><span className="change-muted"> replaced by </span>
              {row.replacement ? <button type="button" className="change-name" onClick={() => onOpenItem(row.replacement!.id)}>{shortLabel(row.replacement)}</button> : <span className="change-muted">an unavailable item</span>}</>
              : <ChangeName row={row} onOpenItem={onOpenItem} />}
          </li>) : <li className="change-muted">{group.label === 'Your turn' ? 'No questions waiting on you' : 'None yet'}</li>}</ul>
        </div>)}
      </>}
    </section>
    <section className="topic-since change-surface" aria-label="Since you were here">
      {canUndo && <button type="button" className="change-link" onClick={() => { navigation.reading.undo(undoToken!); }}>Undo</button>}
      {summary.longAbsence && rows.length > 0 ? <div className="since-away"><span>{count} {count === 1 ? 'change' : 'changes'} while you were away</span><span aria-hidden="true"> · </span><button type="button" className="change-link" onClick={catchUp}>Mark all seen</button></div>
        : displayRows.length ? <>
          <button type="button" className="change-link" aria-expanded={sinceOpen} onClick={() => setSinceOpen(value => !value)}>{rows.length ? `Since you were here · ${count} ${count === 1 ? 'change' : 'changes'}` : 'All caught up'}</button>
          {sinceOpen && <><ul className="since-cards">{displayRows.map(row => {
            const marked = leaving.some(value => value.item.id === row.item.id && value.item.revision >= row.item.revision);
            return <li className="since-card" key={row.item.id}>
              <ChangeName row={row} onOpenItem={onOpenItem} /><Compare row={row} session={session} />
              <button type="button" className="btn btn-secondary since-seen" disabled={marked} onClick={() => mark(row)}>{marked ? '✓ Seen' : 'Seen'}</button>
              {row.replacement && <p className="change-muted">Replaced by <button type="button" className="change-name" onClick={() => onOpenItem(row.replacement!.id)}>{shortLabel(row.replacement)}</button>{row.why ? ` · ${row.why}` : ''}</p>}
              {row.reasons.map(reason => <p key={reason}>{reason}</p>)}
              {!row.records.length && <p className="change-muted">New</p>}
            </li>;
          })}</ul>{rows.length > 0 && <button type="button" className="change-link" onClick={catchUp}>Mark all caught up</button>}</>}
        </> : <span className="change-muted">All caught up</span>}
    </section>
  </div>;
}
