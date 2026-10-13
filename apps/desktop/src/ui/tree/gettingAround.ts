import type { Immutable } from '../../data';
import type { Session } from '../../generated/domain/models';
import type { Row } from './model';

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

export function focusedRows(rows: readonly Row[], session: Immutable<Session>, root: string | null): readonly Row[] {
  if (!root) return rows;
  const item = session.items[root];
  if (!item || item.parent) return rows;
  const ids = branchItems(session, root);
  return rows.filter(row => row.kind === 'topic' ? row.topic.id === item.topic_id
    : row.kind === 'item' ? ids.has(row.item.id) : !!row.parent && ids.has(row.parent));
}

/** The nearest three ancestors keep deep locations useful without a long path. */
export function breadcrumbItems(session: Immutable<Session>, itemId: string): readonly string[] {
  const ids: string[] = [], seen = new Set<string>([itemId]);
  let parent = session.items[itemId]?.parent;
  while (parent && !seen.has(parent)) {
    seen.add(parent); ids.unshift(parent); parent = session.items[parent]?.parent;
  }
  return ids.slice(-3);
}
