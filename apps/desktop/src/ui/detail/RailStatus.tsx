import { useSession, type SessionStore } from '../../data/session-store';
import type { SeenState } from '../../selectors/changes/seen';
import { itemRemoved } from '../../selectors/removed';
import { displayStatus } from '../../selectors/waiting/replied';
import { StatusBadge } from '../shared/StatusBadge';
import { statusKey } from '../shared/status';
import { conversationDivider } from './conversationSeen';

/**
 * The item's status icon, for the rail Details folds to, and the board's New diamond (SPEC 3.6) when its conversation has
 * messages since the owner last looked: the same rule that draws the "New since you last looked" divider.
 */
export function RailStatus({ store, itemId, seen }: { readonly store: SessionStore; readonly itemId: string; readonly seen: SeenState }) {
  const session = useSession(store).snapshot?.session, item = session?.items[itemId];
  if (!session || !item || itemRemoved(session, itemId)) return null;
  const fresh = conversationDivider(session, itemId, seen) !== null;
  return <>
    <StatusBadge status={statusKey[displayStatus(session, item)]} variant="icon" />
    {fresh && <span className="shell-detail-rail-new" role="img" aria-label="New messages" title="New messages" />}
  </>;
}
