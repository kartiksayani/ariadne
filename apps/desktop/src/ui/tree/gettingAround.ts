import type { Immutable } from '../../data';
import type { Session } from '../../generated/domain/models';

/** Branch membership is built once, rather than walking every row's ancestry on scroll. */
export function branchItems(session: Immutable<Session>, root: string): ReadonlySet<string> {
  const children = new Map<string, string[]>();
  for (const item of Object.values(session.items)) {
    if (!item?.parent) continue;
    const siblings = children.get(item.parent) ?? [];
    siblings.push(item.id); children.set(item.parent, siblings);
  }
  const ids = new Set<string>(), pending = [root];
  while (pending.length) {
    const id = pending.pop()!;
    if (ids.has(id)) continue;
    ids.add(id); pending.push(...children.get(id) ?? []);
  }
  return ids;
}
