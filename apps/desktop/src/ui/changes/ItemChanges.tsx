import { useMemo, useState } from 'react';
import type { Immutable, SessionStore } from '../../data/session-store';
import type { Item, ItemChangeRecord, ItemChangesProjection, Page, QueryCursor, Session } from '../../generated/domain/models';
import type { SessionRef } from '../../generated/core';
import { ServiceFailure, type RendererService } from '../../data/service';
import { useHistory } from '../../components/history/useHistory';
import { changeRow, type ChangedField } from '../../selectors/changes/card';
import { isChangedSinceRead, type SeenState } from '../../selectors/changes/seen';
import { ChangeValue, Compare, fieldNames, isBlockValue } from './Compare';
import { Markdown } from '../shared/MarkdownText';
import { clockTime } from './clock';
import { causeLabel } from './model';

/** Read all bounded change pages without repeating the current item or losing large before-values. */
export async function loadItemChanges(service: RendererService, route: SessionRef, revision: number, itemId: string, signal: AbortSignal): Promise<Page<ItemChangeRecord>> {
  let cursor: QueryCursor | null = null;
  const changes: ItemChangeRecord[] = [], cursors = new Set<string>();
  do {
    signal.throwIfAborted();
    const result: ItemChangesProjection = await service.query({ session: route, request: { command: 'item_changes', params: { item_id: itemId, cursor, limit: 20 } } });
    const page: Page<ItemChangeRecord> = result.changes;
    if (result.item_id !== itemId || page.snapshot_revision !== revision || page.next_cursor && (page.next_cursor.revision !== revision || page.next_cursor.view !== 'item_changes')) throw new ServiceFailure('invalid_response');
    changes.push(...page.items);
    cursor = page.next_cursor;
    if (cursor) {
      const key = JSON.stringify(cursor);
      if (cursors.has(key)) throw new ServiceFailure('invalid_response');
      cursors.add(key);
    }
  } while (cursor);
  return { items: changes, next_cursor: null, snapshot_revision: revision };
}

/** The box's labels: the board names the note "Progress" while the item is in progress; for every other status it is "Notes". */
const labelFor = (field: ChangedField['field'], item: Immutable<Item>) => field === 'note' && item.status === 'in_progress' ? 'Progress' : fieldNames[field];

/** "Status  ~~Open~~ → Decided": one row per changed field, then the agent's reason. */
function ChangeRows({ session, item, records, onOpenAnswer }: { readonly session: Immutable<Session>; readonly item: Immutable<Item>;
  readonly records: readonly Immutable<ItemChangeRecord>[]; readonly onOpenAnswer: (itemId: string, messageId: string) => void }) {
  const row = useMemo(() => changeRow(session, item, records), [session, item, records]);
  const cause = session.messages.find(message => message.id === records.at(-1)?.cause_message_id);
  const answer = cause?.input_id ? session.answers.find(value => value.input_id === cause.input_id) : null;
  const input = cause?.input_id ? session.inputs[cause.input_id] : null;
  const sourceItem = answer?.item_id ?? input?.target.item_id;
  const sourceMessage = answer?.message_id ?? input?.message_id;
  const reasonLabel = row.fields.some(field => field.field === 'why') ? 'Agent’s reason' : 'Why';
  return <div className="change-rows">
    {row.fields.map(field => {
      // A multi-line value stacks: the struck before as a block, then → and the after as a block. A one-line value keeps its line.
      const stacked = isBlockValue(field.before, field.field) || isBlockValue(field.current, field.field);
      return <div className="change-row" key={field.field}>
        <span className="change-row-label">{labelFor(field.field, item)}</span>
        <span className="change-row-value" data-testid="change-row-value" data-stacked={stacked || undefined}><del className="change-before"><ChangeValue value={field.before} field={field.field} session={session} block={stacked} /></del>
          <span className="change-arrow" aria-hidden="true">→</span><span className="change-after"><ChangeValue value={field.current} field={field.field} session={session} block={stacked} /></span></span>
      </div>;
    })}
    {row.reasons.length ? <div className="change-row"><span className="change-row-label">{reasonLabel}</span><span className="change-row-value" data-testid="change-row-value"><Markdown text={row.reasons.join('\n\n')} inline /></span></div>
      : !row.fields.length && <p className="change-row-plain">The agent updated this item.</p>}
    {cause?.input_id && sourceItem && sourceMessage && <button type="button" className="change-link change-origin" onClick={() => onOpenAnswer(sourceItem, sourceMessage)}>{causeLabel(session, cause.input_id)}</button>}
  </div>;
}

/** The timeline: left rule, a 40px time column, what happened, and "· not counted as a change" for a rewording. */
function Timeline({ session, item, records, loading, error, retry, onOpenAnswer }: { readonly session: Immutable<Session>; readonly item: Immutable<Item>;
  readonly records: readonly Immutable<ItemChangeRecord>[]; readonly loading: boolean; readonly error: unknown; readonly retry: () => void;
  readonly onOpenAnswer: (itemId: string, messageId: string) => void }) {
  return <div className="change-timeline" data-testid="change-timeline">
    {loading && <p role="status">Reading change history…</p>}
    {!!error && <p role="status">Change history could not be read. <button type="button" className="change-link" onClick={retry}>Try again</button></p>}
    <ol>{records.map(record => {
      const reworded = record.wording_only, before = reworded && typeof record.before.question === 'string' ? record.before.question : null;
      const text = record.reason || (reworded ? `Reworded${before ? ` from “${before}”` : ''}` : 'The agent updated this item.');
      return <li className="change-event" key={record.revision}>
        <time dateTime={record.at} title={new Date(record.at).toLocaleString()}>{clockTime(record.at)}</time>
        <span className="change-event-text">{text}{reworded && <span className="change-muted"> · not counted as a change</span>}
          <ChangeEventExtras session={session} item={item} record={record} onOpenAnswer={onOpenAnswer} /></span>
      </li>;
    })}</ol>
    {!records.length && !loading && <p className="change-muted">No older changes</p>}
  </div>;
}

/** Before → after and the source-answer link for one timeline entry. */
function ChangeEventExtras({ session, item, record, onOpenAnswer }: { readonly session: Immutable<Session>; readonly item: Immutable<Item>;
  readonly record: Immutable<ItemChangeRecord>; readonly onOpenAnswer: (itemId: string, messageId: string) => void }) {
  const row = useMemo(() => changeRow(session, item, [record]), [session, item, record]);
  const cause = session.messages.find(message => message.id === record.cause_message_id);
  const answer = cause?.input_id ? session.answers.find(value => value.input_id === cause.input_id) : null;
  const input = cause?.input_id ? session.inputs[cause.input_id] : null;
  const sourceItem = answer?.item_id ?? input?.target.item_id, sourceMessage = answer?.message_id ?? input?.message_id;
  return <>
    <Compare row={row} session={session} variant="link" />
    {cause?.input_id && sourceItem && sourceMessage && <button type="button" className="change-link change-origin" onClick={() => onOpenAnswer(sourceItem, sourceMessage)}>{causeLabel(session, cause.input_id)}</button>}
  </>;
}

/**
 * The change box (SPEC 6.7) and the history. The box shows for an item with a recorded change: the changes unseen when Details
 * opened, or the latest one for an item already seen. The 1 s dwell or Mark seen changes only its head ("Changed since you looked
 * · 20:51" becomes "Changed at 20:51"), so the explanation stays for this visit. With no box but a history, "HISTORY N events" lists it.
 * `part` splits the two for the body's layout (SPEC 5.3, 9.11): the box sits under the "why", the bare history after the conversation.
 */
export function ItemChanges({ service, store, session, item, seen, onOpenAnswer, onMarkSeen, part = 'both' }: { readonly service: RendererService; readonly store: SessionStore;
  readonly session: Immutable<Session>; readonly item: Immutable<Item>; readonly seen: SeenState; readonly onOpenAnswer: (itemId: string, messageId: string) => void;
  /** Saves "seen" for this item at its current revision. Without it the box has no button. */
  readonly onMarkSeen?: (itemId: string, revision: number) => void;
  /** Which of the two to draw: `box` is nothing when there is no box, `history` is nothing when there is one. */
  readonly part?: 'both' | 'box' | 'history' }) {
  const [openingSeen] = useState(seen), [asked, setAsked] = useState<boolean | null>(null);
  const readRevision = openingSeen?.items.find(value => value.item_id === item.id)?.revision ?? 0;
  const meaningful = useMemo(() => (item.changes ?? []).filter(record => !record.wording_only), [item]);
  // What the box explains: the changes the owner had not seen when Details opened; for an item already seen, its latest change
  // ("Changed at 20:51", SPEC 6.7). A rewording alone is never headlined.
  const currentRecords = useMemo(() => {
    const unseenAtOpen = meaningful.filter(record => record.revision > readRevision && Date.parse(record.at) > Date.parse(openingSeen?.since ?? ''));
    return unseenAtOpen.length && isChangedSinceRead(item, openingSeen) ? unseenAtOpen : meaningful.slice(-1);
  }, [item, meaningful, openingSeen, readRevision]);
  const showBox = currentRecords.length > 0;
  // The box's "Older history" starts closed; with no box the HISTORY list is the content, so it starts open (SPEC 5.3 item 9, 9.11).
  const historyOpen = asked ?? !showBox;
  const drawn = part === 'both' || (part === 'box') === showBox;
  const history = useHistory(service, store, historyOpen && drawn ? item.id : '', loadItemChanges);
  const unseen = isChangedSinceRead(item, seen);
  const known = history.data?.items ?? item.changes ?? [];
  const older = (showBox ? known.filter(record => !currentRecords.some(current => current.revision === record.revision)) : known).slice().reverse();
  const toggle = () => setAsked(!historyOpen);
  const timeline = historyOpen && <Timeline session={session} item={item} records={older} loading={history.loading} error={history.error} retry={history.retry} onOpenAnswer={onOpenAnswer} />;
  if (!drawn) return null;
  const at = clockTime(currentRecords.at(-1)?.at ?? item.updated_at ?? Date.now());
  const title = unseen ? `Changed since you looked · ${at}` : `Changed at ${at}`;
  if (showBox) return <section className="change-box" data-state={unseen ? 'unseen' : 'seen'} data-testid="change-box" aria-label="What changed">
    <div className="change-box-head">
      <span className="change-box-title" title={title}>{unseen && <i className="change-diamond" aria-hidden="true" />}<span className="change-box-title-text">{title}</span></span>
      {unseen && onMarkSeen && <button type="button" className="btn btn-secondary change-box-mark" onClick={() => onMarkSeen(item.id, item.revision)}>
        <i className="ph ph-check" aria-hidden="true" />Mark seen</button>}
    </div>
    <ChangeRows session={session} item={item} records={currentRecords} onOpenAnswer={onOpenAnswer} />
    {older.length > 0 || historyOpen ? <button type="button" className="change-box-older" aria-expanded={historyOpen} onClick={toggle}>
      <i className={historyOpen ? 'ph ph-caret-down' : 'ph ph-caret-right'} aria-hidden="true" />Older history ({older.length})</button> : null}
    {timeline}
  </section>;
  if (!known.length) return null;
  return <section className="change-history" aria-label="History">
    <button type="button" className="change-history-head" aria-expanded={historyOpen} onClick={toggle}>
      <span className="detail-label">History</span><span className="change-muted">{known.length} {known.length === 1 ? 'event' : 'events'}</span>
      <i className={historyOpen ? 'ph ph-caret-down' : 'ph ph-caret-right'} aria-hidden="true" /></button>
    {timeline}
  </section>;
}
