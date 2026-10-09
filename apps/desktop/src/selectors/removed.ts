import type { Item, Session, Topic } from '../generated/domain/models';
import type { Immutable } from '../data/session-store';

const removedBySession = new WeakMap<Immutable<Session>, ReadonlySet<string>>();
/** Removal belongs to the whole subtree, even when only its root has a marker. */
export function removedItems(session: Immutable<Session>): ReadonlySet<string> {
  const cached = removedBySession.get(session);
  if (cached) return cached;
  const removed = new Set<string>();
  const visit = (item: Immutable<Item>, seen = new Set<string>()): boolean => {
    if (removed.has(item.id)) return true;
    if (seen.has(item.id)) throw new Error('Item ancestry cycle is invalid.');
    seen.add(item.id);
    const parent = item.parent ? session.items[item.parent] : null;
    if (item.removed_at || session.topics[item.topic_id]?.removed_at || parent && visit(parent, seen)) {
      removed.add(item.id); return true;
    }
    return false;
  };
  Object.values(session.items).forEach(item => { if (item) visit(item); });
  removedBySession.set(session, removed);
  return removed;
}
export const itemRemoved = (session: Immutable<Session>, id: string): boolean => removedItems(session).has(id);
export const activeItems = (session: Immutable<Session>): readonly Immutable<Item>[] =>
  Object.values(session.items).filter((item): item is Immutable<Item> => !!item && !itemRemoved(session, item.id));
export const activeTopics = (session: Immutable<Session>): readonly Immutable<Topic>[] =>
  Object.values(session.topics).filter((topic): topic is Immutable<Topic> => !!topic && !topic.removed_at);

/** Disjoint removed item roots for a live topic; nested removals stay inside their ancestor. */
export function removedRoots(session: Immutable<Session>, topicId: string): readonly Immutable<Item>[] {
  if (session.topics[topicId]?.removed_at) return [];
  return Object.values(session.items).filter((item): item is Immutable<Item> => !!item && item.topic_id === topicId
    && !!item.removed_at && (!item.parent || !itemRemoved(session, item.parent)));
}
export function removedSubtree(session: Immutable<Session>, root: string): readonly Immutable<Item>[] {
  return Object.values(session.items).filter((item): item is Immutable<Item> => {
    if (!item) return false;
    for (let id: string | null = item.id; id; id = session.items[id]?.parent ?? null) if (id === root) return true;
    return false;
  });
}
