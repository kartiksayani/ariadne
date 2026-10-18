import type { Item, ItemStatus, Session } from '../../generated/domain/models';
import type { Immutable } from '../../data';
import { itemRemoved } from '../removed';

const LIVE: ReadonlySet<ItemStatus> = new Set(['open', 'waiting_on_me', 'in_progress']);
const SETTLED: ReadonlySet<ItemStatus> = new Set(['decided', 'done', 'dropped', 'replaced']);

/** A live item is blocked while something it depends on is still unsettled. A dependency that is missing or removed counts
 * as settled, and a blocked dependency still blocks only by its own status: a chain is read one hop at a time. A Map display
 * status only; the dock and the peek do not read it. */
export function isBlocked(session: Immutable<Session>, item: Immutable<Item>): boolean {
  if (!LIVE.has(item.status)) return false;
  return (item.depends_on ?? []).some(id => {
    const dependency = session.items[id];
    return !!dependency && !itemRemoved(session, id) && !SETTLED.has(dependency.status);
  });
}
