import type { ReactNode } from 'react';
import { CoreFailure, ServiceFailure, type SessionState } from '../../data';
import '../bindings/controls.css';

export type EdgeKind = 'empty' | 'loading' | 'all_clear' | 'no_results' | 'stale' | 'unavailable' | 'malformed' | 'write_failure' | 'reconnecting';
const copy: Record<EdgeKind, readonly [string, string, string]> = {
  empty: ['No items yet', 'This registered session has no items. Agent updates will appear here.', 'ph ph-tree-structure'],
  loading: ['Loading session', 'Reading the registered session. Your saved drafts remain available.', 'ph ph-hourglass'],
  all_clear: ['Nothing waiting on you', 'All registered sessions are up to date.', 'ph ph-check-circle'],
  no_results: ['No matching items', 'Adjust the search or filters to see more items.', 'ph ph-magnifying-glass'],
  stale: ['Showing last valid data', 'Current data is stale. Refresh to reconcile before taking an action.', 'ph ph-clock'],
  unavailable: ['Session unavailable', 'Restore access and refresh. Unavailable data is not an empty session.', 'ph ph-warning'],
  malformed: ['Session cannot be read', 'Stored data is malformed or uses an unsupported schema. The last valid view and drafts are retained.', 'ph ph-warning'],
  write_failure: ['Save not confirmed', 'Your text is retained. Reconcile the same operation before starting another action.', 'ph ph-warning'],
  reconnecting: ['Reconnecting', 'The session and unsent drafts remain visible while the host connection is verified.', 'ph ph-plugs'],
};
export function EdgeState({ kind, children, detail, onRetry, retryLabel = 'Refresh' }: {
  kind: EdgeKind; children?: ReactNode; detail?: ReactNode; onRetry?: () => void; retryLabel?: string;
}) {
  const [heading, text, icon] = copy[kind];
  return <div className="ariadne-reference lifecycle-edge" data-edge-state={kind}>
    <div className="lifecycle-notice" role={['unavailable', 'malformed', 'write_failure'].includes(kind) ? 'alert' : 'status'}>
      <i className={icon} aria-hidden="true" /><div><strong>{heading}</strong><p>{text}</p>{detail}</div>
      {onRetry && <button type="button" className="ref-button ref-secondary" onClick={onRetry}>{retryLabel}</button>}
    </div>{kind === 'loading' && <div className="ref-waiting-skeleton" aria-hidden="true"><span /><span /><span /></div>}{children}
  </div>;
}
export function SessionNotice({ state, refresh }: { state: SessionState; refresh: () => void }) {
  const error = state.error;
  const malformed = error instanceof ServiceFailure && error.reason === 'invalid_response'
    || error instanceof CoreFailure && ['corrupt_session', 'future_schema'].includes(error.error.code);
  const kind: EdgeKind | null = malformed ? 'malformed' : state.status === 'loading' ? 'loading'
    : state.status === 'inaccessible' || state.status === 'closed' ? 'unavailable' : state.status === 'stale' ? 'stale' : null;
  return kind && <EdgeState kind={kind} onRetry={refresh}
    detail={error instanceof CoreFailure ? <p>{error.error.message} {error.error.hint}</p> : undefined} />;
}
