import type { Immutable } from '../../data/session-store';
import type { Item, ItemChangeRecord, Session } from '../../generated/domain/models';
import { ackTarget } from '../ack';
import { waitingOnOwner } from '../sessionClosed';
import { changeRow, type ChangeRow } from './card';
import { isNewToOwner, type SeenState } from './seen';
import { changeLabel } from './label';
import { sinceYouWereHere, type SinceYouWereHere } from './topic';

type Record_ = Immutable<ItemChangeRecord>;

export interface UnseenRow {
  readonly row: ChangeRow;
  /** The same rule as the Map's marker: New takes precedence over Changed. */
  readonly kind: 'new' | 'changed';
  /** The newest change the owner has not read; null for an item that is new. */
  readonly record: Record_ | null;
  readonly later: readonly Record_[];
  readonly at: string;
}

const newest = (row: ChangeRow) => Math.max(Date.parse(row.item.created_at), ...row.records.map(record => Date.parse(record.at)));

/** What the owner has not read in one topic: the rows behind the band's counts and the popover's list. Newest first. */
export function unseenTopicRows(session: Immutable<Session>, topicId: string, seen: SeenState, now = Date.now()) {
  const summary = sinceYouWereHere(session, topicId, seen, now);
  const reads = new Map(seen?.items.map(item => [item.item_id, item.revision]));
  const baseline = Date.parse(summary.baseline ?? '');
  const rows = [...summary.groups.updated, ...summary.groups.replaced, ...summary.groups.new].flatMap(row => {
    const records = row.records.filter(record => record.revision > (reads.get(row.item.id) ?? 0));
    const fresh = Date.parse(row.item.created_at) > baseline && !reads.has(row.item.id);
    return fresh || records.length ? [changeRow(session, row.item, records)] : [];
  }).sort((left, right) => newest(right) - newest(left));
  const count = rows.reduce((sum, row) => sum + row.records.length + Number(!reads.has(row.item.id) && Date.parse(row.item.created_at) > baseline), 0);
  const list: UnseenRow[] = rows.map(row => {
    const kind = isNewToOwner(row.item, seen) ? 'new' : 'changed';
    const meaningful = row.records.filter(record => !record.wording_only);
    const record = kind === 'new' ? null : meaningful.at(-1) ?? null;
    const later = record ? (row.item.changes ?? []).filter(value => value.revision > record.revision) : [];
    return { row, kind, record, later, at: record?.at ?? row.item.created_at };
  });
  return { summary, rows, list, count, newCount: list.filter(row => row.kind === 'new').length, changedCount: list.filter(row => row.kind === 'changed').length };
}

export interface AwayGroup { readonly key: 'waiting' | 'decided' | 'ack' | 'replaced' | 'progress'; readonly label: string; readonly items: readonly Immutable<Item>[]; readonly count: number }

/** A long absence in a few counted lines (SPEC 5.5.5): what needs the owner first, then what settled, then the quiet progress. */
export function awayGroups(session: Immutable<Session>, summary: SinceYouWereHere): readonly AwayGroup[] {
  const changed = [...summary.groups.updated, ...summary.groups.replaced, ...summary.groups.new];
  const items = changed.map(row => row.item);
  const notes = summary.groups.updated.flatMap(row => row.records.filter(record => changeLabel(row.item, record, row.records.filter(value => value.revision > record.revision)) === 'Progress')
    .map(() => row.item));
  const group = (key: AwayGroup['key'], label: (count: number) => string, list: readonly Immutable<Item>[]): AwayGroup | null =>
    list.length > 0 ? { key, label: label(list.length), items: [...new Map(list.map(item => [item.id, item])).values()], count: list.length } : null;
  return [
    group('waiting', () => 'waiting on you', items.filter(item => waitingOnOwner(session, item))),
    group('decided', () => 'decided', items.filter(item => item.status === 'decided')),
    group('ack', count => count === 1 ? 'finding to ack' : 'findings to ack', items.filter(item => ackTarget(session, item))),
    group('replaced', () => 'replaced', summary.groups.replaced.map(row => row.item)),
    group('progress', count => count === 1 ? 'progress note' : 'progress notes', notes),
  ].flatMap(value => value ? [value] : []);
}
