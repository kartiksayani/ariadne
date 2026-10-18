import type { Immutable } from '../../data/session-store';
import type { Item, ItemChangeRecord, Session } from '../../generated/domain/models';
import { activeItems } from '../removed';

export const CHANGED_LATELY_LIMIT = 6;

export interface LatelyChange {
  readonly item: Immutable<Item>;
  /** The latest change that was not only a rewording; null for an item that has never changed (it is new). */
  readonly record: Immutable<ItemChangeRecord> | null;
  /** The records after `record`, oldest first: `changeLabel` reads the "after" values from them. */
  readonly later: readonly Immutable<ItemChangeRecord>[];
  readonly at: string;
}

/**
 * The items that changed most recently, newest first (SPEC 6.11, D19). Independent of what the owner has seen.
 * Rewordings never count. Creation makes no record, so an item with none is ranked by when it was created.
 */
export function changedLately(session: Immutable<Session>, limit = CHANGED_LATELY_LIMIT): readonly LatelyChange[] {
  const result: LatelyChange[] = [];
  for (const item of activeItems(session)) {
    if (session.topics[item.topic_id]?.archived_at != null) continue;
    const all = (item.changes ?? []).slice().sort((left, right) => left.revision - right.revision);
    const record = all.filter(value => !value.wording_only).at(-1) ?? null;
    result.push({ item, record, later: record ? all.filter(value => value.revision > record.revision) : [], at: record?.at ?? item.created_at });
  }
  return result.sort((left, right) => Date.parse(right.at) - Date.parse(left.at) || right.item.ordinal - left.item.ordinal).slice(0, limit);
}
