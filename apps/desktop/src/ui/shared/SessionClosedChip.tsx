import { sessionClosedReason } from '../../selectors/sessionClosed';
import './shared.css';

export function SessionClosedChip() {
  return <span className="session-closed-chip" title={sessionClosedReason}>Session closed</span>;
}
