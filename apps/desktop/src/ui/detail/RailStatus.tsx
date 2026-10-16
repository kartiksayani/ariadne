import { useSession, type SessionStore } from '../../data/session-store';
import { itemRemoved } from '../../selectors/removed';
import { displayStatus } from '../../selectors/waiting/replied';
import { StatusBadge } from '../shared/StatusBadge';
import { statusKey } from '../shared/status';

/** The item's status icon, for the rail Details folds to. */
export function RailStatus({ store, itemId }: { readonly store: SessionStore; readonly itemId: string }) {
  const session = useSession(store).snapshot?.session, item = session?.items[itemId];
  return session && item && !itemRemoved(session, itemId) ? <StatusBadge status={statusKey[displayStatus(session, item)]} variant="icon" /> : null;
}
