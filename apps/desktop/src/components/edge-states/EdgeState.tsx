import type { ReactNode } from 'react';
import { CoreFailure, ServiceFailure, type SessionState } from '../../data';
import { SessionActions, useSessionActions } from '../bindings/actions';
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
  return <div className="lifecycle-edge" data-edge-state={kind}>
    <div className="lifecycle-notice" role={['unavailable', 'malformed', 'write_failure'].includes(kind) ? 'alert' : 'status'}>
      <i className={icon} aria-hidden="true" /><div><strong>{heading}</strong><p>{text}</p>{detail}</div>
      {onRetry && <button type="button" className="btn btn-secondary" onClick={onRetry}>{retryLabel}</button>}
    </div>{children}
  </div>;
}
/** The saved action whose completion is unknown, with its reviewed parameters and a deliberate Reconcile. */
export function ActionFailure({ actions }: { actions: SessionActions }) {
  const state = useSessionActions(actions);
  const command = state.pending?.command;
  return state.error && <EdgeState kind="write_failure" detail={<><p>{state.error.message}
    {state.error instanceof CoreFailure && ` ${state.error.error.hint}`}</p>
    {command?.command === 'input_resolve' && <p>Pending {command.params.decision.replace(/_/g, ' ')} for input <code>{command.params.input_id}</code>
      {' · '}attempt <code>{command.params.attempt_id}</code> · reviewed revision {command.params.expected_revision}.</p>}
    {command && (command.command === 'binding_pause' || command.command === 'binding_resume' || command.command === 'binding_disconnect')
      && <p>Pending {command.command.replace('binding_', '')} · reviewed generation <code>{command.params.expected_generation}</code>.</p>}
    {command?.command === 'binding_connect' && <p>Pending connection to {command.params.adapter_id} · {command.params.external_session_id}.</p>}
    </>}
    onRetry={state.pending && !state.writing ? () => { void actions.retry(); } : undefined} retryLabel="Reconcile saved action" />;
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
