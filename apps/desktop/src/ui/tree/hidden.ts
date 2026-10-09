import type { Session } from '../../generated/domain/models';
import type { Immutable } from '../../data';

/** Explicit preferences remain separate from inherited hiding, so restoring a parent
 * preserves children the owner hid on their own. */
export function hiddenItems(session: Immutable<Session>, explicit: ReadonlySet<string>): ReadonlySet<string> {
  const hidden = new Set<string>();
  for (const item of Object.values(session.items)) {
    if (!item) continue;
    const seen = new Set<string>();
    for (let id: string | null = item.id; id && !seen.has(id); id = session.items[id]?.parent ?? null) {
      if (explicit.has(id)) { hidden.add(item.id); break; }
      seen.add(id);
    }
  }
  return hidden;
}

export const hiddenGroupKey = (topicId: string, parent: string | null) => `hidden:${topicId}:${parent ?? ''}`;

/** Every hidden group on the route to an outside selection must open. */
export function hiddenGroupsFor(session: Immutable<Session>, explicit: ReadonlySet<string>, itemId: string): readonly string[] {
  const groups: string[] = [], seen = new Set<string>();
  for (let id: string | null = itemId; id && !seen.has(id); id = session.items[id]?.parent ?? null) {
    const item = session.items[id];
    if (!item) break;
    if (explicit.has(id)) groups.push(hiddenGroupKey(item.topic_id, item.parent));
    seen.add(id);
  }
  return groups;
}
