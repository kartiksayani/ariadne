import type { Immutable } from '../../data/session-store';
import type { Item, ItemChangeBefore, ItemChangeRecord, ItemStatus } from '../../generated/domain/models';
import { STATUS, statusKey } from '../../ui/shared/status';

type Record_ = Immutable<ItemChangeRecord>;
const has = (record: Record_, field: keyof ItemChangeBefore) => Object.prototype.hasOwnProperty.call(record.before, field);
const statusLabel = (status: ItemStatus | null | undefined) => status ? STATUS[statusKey[status]].label : 'None';

/**
 * What one change record did, in a few words (SPEC 5.3). It does not depend on what the owner has seen.
 * A record holds only the "before" values of the fields it changed. For each field the "after" value comes from the first
 * later record that has that field, else from the current item (the same rule as `changeRow`). Callers skip wording-only records.
 * No record means the item is new: creation makes no record.
 */
export function changeLabel(item: Immutable<Item>, record: Record_ | null, later: readonly Record_[]): string {
  if (!record) return 'New';
  const after = later.filter(value => value.revision > record.revision).sort((left, right) => left.revision - right.revision);
  const statusAfter = (): ItemStatus => after.find(value => has(value, 'status'))?.before.status ?? item.status;
  if (has(record, 'status')) return `${statusLabel(record.before.status)} → ${statusLabel(statusAfter())}`;
  if (has(record, 'options')) return 'Options changed';
  // A note or outcome edit while the item was in progress is the agent reporting progress.
  if ((has(record, 'note') || has(record, 'outcome')) && statusAfter() === 'in_progress') return 'Progress';
  return 'Changed';
}
