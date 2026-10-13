import { useMemo, useState } from 'react';
import type { Immutable, SessionStore } from '../../data/session-store';
import type { Item, ItemChangeRecord, ItemChangesProjection, Page, QueryCursor, Session } from '../../generated/domain/models';
import type { SessionRef } from '../../generated/core';
import { ServiceFailure, type RendererService } from '../../data/service';
import { useHistory } from '../../components/history/useHistory';
import { changeRow } from '../../selectors/changes/card';
import { isChangedSinceRead, type SeenState } from '../../selectors/changes/seen';
import { Compare } from './Compare';
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

function ChangeRecord({ session, item, records, onOpenAnswer }: { readonly session: Immutable<Session>; readonly item: Immutable<Item>;
  readonly records: readonly Immutable<ItemChangeRecord>[]; readonly onOpenAnswer: (itemId: string, messageId: string) => void }) {
  const row = useMemo(() => changeRow(session, item, records), [session, item, records]);
  const cause = session.messages.find(message => message.id === records.at(-1)?.cause_message_id);
  const answer = cause?.input_id ? session.answers.find(value => value.input_id === cause.input_id) : null;
  const input = cause?.input_id ? session.inputs[cause.input_id] : null;
  const sourceItem = answer?.item_id ?? input?.target.item_id;
  const sourceMessage = answer?.message_id ?? input?.message_id;
  return <div>
    {row.reasons.length ? row.reasons.map(reason => <p key={reason}>{reason}</p>) : <p>The agent updated this item.</p>}
    <Compare row={row} session={session} />
    {cause?.input_id && sourceItem && sourceMessage && <button type="button" className="change-link change-origin" onClick={() => onOpenAnswer(sourceItem, sourceMessage)}>{causeLabel(session, cause.input_id)}</button>}
  </div>;
}

export function ItemChanges({ service, store, session, item, seen, onOpenAnswer }: { readonly service: RendererService; readonly store: SessionStore;
  readonly session: Immutable<Session>; readonly item: Immutable<Item>; readonly seen: SeenState; readonly onOpenAnswer: (itemId: string, messageId: string) => void }) {
  // Keep the explanation on the open screen after its read dwell clears attention elsewhere.
  const [openingSeen] = useState(seen), [historyOpen, setHistoryOpen] = useState(false);
  const readRevision = openingSeen?.items.find(value => value.item_id === item.id)?.revision ?? 0;
  const currentRecords = useMemo(() => (item.changes ?? []).filter(record => !record.wording_only && record.revision > readRevision
    && Date.parse(record.at) > Date.parse(openingSeen?.since ?? '')), [item, openingSeen, readRevision]);
  const history = useHistory(service, store, historyOpen ? item.id : '', loadItemChanges);
  const older = (history.data?.items ?? item.changes ?? []).filter(record => !currentRecords.some(current => current.revision === record.revision)).slice().reverse();
  return <>
    {isChangedSinceRead(item, openingSeen) && currentRecords.length > 0 && <section className="what-changed change-surface" aria-label="What changed">
      <h3>What changed</h3><ChangeRecord session={session} item={item} records={currentRecords} onOpenAnswer={onOpenAnswer} />
    </section>}
    {(item.changes?.length || history.data?.items.length) ? <details className="change-history" open={historyOpen} onToggle={event => setHistoryOpen(event.currentTarget.open)}>
      <summary>Change history</summary>
      {history.loading && <p role="status">Reading change history…</p>}
      {history.error && <p role="status">Change history could not be read. <button type="button" className="change-link" onClick={history.retry}>Try again</button></p>}
      {older.map(record => <section className="change-history-entry change-surface" key={record.revision}>
        <time dateTime={record.at}>{new Date(record.at).toLocaleString()}</time>{record.wording_only && <span className="change-muted"> · Rewording</span>}
        <ChangeRecord session={session} item={item} records={[record]} onOpenAnswer={onOpenAnswer} />
      </section>)}
      {!older.length && !history.loading && <p className="change-muted">No older changes</p>}
    </details> : null}
  </>;
}
