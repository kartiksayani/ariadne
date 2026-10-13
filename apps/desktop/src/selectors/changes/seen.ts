import type { SessionSeen } from '../../generated/core';
import type { Item, Session } from '../../generated/domain/models';
import type { Immutable } from '../../data/session-store';
import { indexSession } from '../../data/selectors';

export type SeenState = Immutable<SessionSeen> | null | undefined;

/** The upgrade baseline suppresses old items until a real later creation. */
export function isNewToOwner(item: Immutable<Item>, seen: SeenState): boolean {
  return !!seen && Date.parse(item.created_at) > Date.parse(seen.since)
    && !seen.items.some(value => value.item_id === item.id);
}

/** The session baseline implicitly covers existing items until a later meaningful edit. */
export function isChangedSinceRead(item: Immutable<Item>, seen: SeenState): boolean {
  const read = seen?.items.find(value => value.item_id === item.id);
  return !!seen && (item.changes ?? []).some(change => !change.wording_only
    && change.revision > (read?.revision ?? 0) && Date.parse(change.at) > Date.parse(seen.since));
}

/** Complete preorder, independent of saved folds, filters and item-number spelling. */
export function changeTreeOrder(session: Immutable<Session>): readonly string[] {
  const indexes = indexSession(session);
  const roots = [...indexes.childrenByParent.get(null) ?? []].sort((left, right) =>
    (session.topics[left.topic_id]?.order ?? 0) - (session.topics[right.topic_id]?.order ?? 0)
      || left.ordinal - right.ordinal || left.id.localeCompare(right.id));
  const pending = roots.reverse(), order: string[] = [];
  while (pending.length) {
    const item = pending.pop()!;
    if (session.topics[item.topic_id]?.archived_at != null) continue;
    order.push(item.id);
    const children = indexes.childrenByParent.get(item.id) ?? [];
    for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
  }
  return Object.freeze(order);
}

/** Continue after the selected row without wrapping; callers may supply their visible tree order. */
export function nextUnseen(session: Immutable<Session>, seen: SeenState,
  order: readonly string[] = changeTreeOrder(session), afterItemId: string | null = null): Immutable<Item> | null {
  const eligible = new Set(changeTreeOrder(session));
  const start = afterItemId === null ? 0 : Math.max(0, order.indexOf(afterItemId) + 1);
  for (let index = start; index < order.length; index++) {
    const item = session.items[order[index]];
    if (item && eligible.has(item.id) && (isNewToOwner(item, seen) || isChangedSinceRead(item, seen))) return item;
  }
  return null;
}
