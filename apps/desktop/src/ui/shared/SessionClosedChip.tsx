import { sessionClosedReason } from '../../selectors/sessionClosed';
import './shared.css';

export function SessionClosedChip({ reason = sessionClosedReason }: { readonly reason?: string }) {
  return <span className="session-closed-chip" title={reason}>Session closed</span>;
}
