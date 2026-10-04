import { useState } from 'react';
import { CoreFailure, useSession } from '../../data';
import type { OwnerCommand } from '../../generated/core';
import type { AdapterConfig } from '../../generated/domain/models';
import { ReferenceDialog } from '../reference/ReferenceDialog';
import { EdgeState } from '../edge-states/EdgeState';
import { SessionActions, useSessionActions } from './actions';
import { qualifiedPresence } from './presence';
import './controls.css';

type Action = 'connect' | 'pause' | 'resume' | 'disconnect';
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
export function BindingControls({ actions }: { actions: SessionActions }) {
  const state = useSession(actions.session), operation = useSessionActions(actions);
  const [review, setReview] = useState<{ action: Action; revision: number } | null>(null);
  const snapshot = state.snapshot?.session;
  const binding = snapshot?.active_binding_id ? snapshot.bindings[snapshot.active_binding_id] : null;
  if (!snapshot || !binding) return <p className="lifecycle-muted">No selected binding. Connect an existing host from the registered project.</p>;
  const presence = qualifiedPresence(binding, state.presence[binding.id]);
  const disabled = state.status !== 'ready' || !!state.error || operation.writing || !!operation.pending;
  const changed = review && review.revision !== snapshot.revision;
  const submit = async () => {
    if (!review || changed) return;
    const command: OwnerCommand = review.action === 'connect' ? { command: 'binding_connect', api_version: 1, op_id: '', params: {
      project_id: snapshot.project_id, adapter_id: binding.adapter_id, external_session_id: binding.external_session_id,
      endpoint: structuredClone(binding.endpoint), configuration: structuredClone(binding.adapter_config) as AdapterConfig, existing_session_id: snapshot.id,
    } } : { command: `binding_${review.action}`, api_version: 1, op_id: '', params: { binding_id: binding.id, expected_generation: binding.generation } };
    if (await actions.execute(command, review.revision)) setReview(null);
  };
  return <section className="ariadne-reference lifecycle-binding" aria-label="Binding lifecycle">
    {operation.writing && operation.pending?.command.command === 'binding_connect' && <EdgeState kind="reconnecting" />}
    <div><strong>{binding.adapter_id} · {binding.external_session_id}</strong><p>{binding.connection_state} · dispatch {binding.dispatch_state.replace(/_/g, ' ')}
      {binding.owner_paused && ' · paused by you'}{binding.pause_reason && ` · ${binding.pause_reason.replace(/_/g, ' ')}`}</p>
      <p>{presence.label}</p><p className="lifecycle-muted">Generation <code>{binding.generation}</code></p></div>
    <div className="lifecycle-buttons">{(['connect', 'pause', 'resume', 'disconnect'] as const).map(action => <button key={action}
      type="button" className="ref-button ref-secondary" disabled={disabled || (action === 'resume' && (snapshot.state !== 'active'
        || binding.connection_state !== 'connected' || !!binding.pause_reason || Object.values(snapshot.inputs).some(input => input?.state === 'needs_attention' && input.binding_id === binding.id)))}
      onClick={() => setReview({ action, revision: snapshot.revision })}>{action === 'connect' ? 'Connect' : action === 'pause' ? 'Pause dispatch' : action === 'resume' ? 'Resume dispatch' : 'Disconnect'}</button>)}</div>
    <p className="lifecycle-muted">Pause prevents additional sends. Interrupt active host work in the terminal.</p>
    {!review && <ActionFailure actions={actions} />}
    {operation.receipt && <p role="status">Action saved. Review the current binding before any further dispatch.</p>}
    {review && <ReferenceDialog title={`Confirm ${review.action}`} onCancel={() => { if (!operation.writing) setReview(null); }} actions={<>
      <button type="button" className="ref-button ref-secondary" disabled={operation.writing} onClick={() => setReview(null)}>Cancel</button>
      <button type="button" className="ref-button ref-primary" disabled={disabled || !!changed} onClick={() => { void submit(); }}>Confirm {review.action}</button></>}>
      <div className="lifecycle-dialog"><ActionFailure actions={actions} /><p>{snapshot.title} · {binding.external_session_id}</p>
        <p>{review.action === 'connect' ? 'Verify and reconnect this exact host identity. Generation rotates; an owner pause remains paused.'
          : review.action === 'resume' ? 'Enable delivery of saved queued inputs after all recovery blockers are resolved.'
          : review.action === 'pause' ? 'Persist an owner pause. Already delivered host work can continue.' : 'Disconnect Ariadne from this host. Already delivered host work can continue.'}</p>
        {changed && <p role="alert">The session changed. Close this confirmation and review the current binding.</p>}
      </div></ReferenceDialog>}
  </section>;
}
