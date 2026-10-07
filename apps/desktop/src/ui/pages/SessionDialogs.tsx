// The session card's dispatch and Close dialogs. They keep the binding rules of
// the former BindingControls and HistoryActions: resume needs an active,
// connected binding with no pause reason or input needing attention; Close
// needs paused dispatch and no open items or pending inputs.
import { CoreFailure, useSession, type SessionStore } from '../../data';
import type { OwnerCommand } from '../../generated/core';
import type { AdapterConfig } from '../../generated/domain/models';
import { useSessionActions, type SessionActions } from '../../components/bindings/actions';
import { lifecycleBlockers } from '../../components/history-actions/selectors';
import { Dialog } from '../dialogs/Dialog';

type BindingAction = 'connect' | 'pause' | 'resume' | 'disconnect';
const words = (value: string) => value.replace(/_/g, ' ');

function Failure({ actions }: { readonly actions: SessionActions }) {
  const operation = useSessionActions(actions);
  if (!operation.error) return null;
  return <div className="pw-dialog-error" role="alert">{operation.error.message}
    {operation.error instanceof CoreFailure && ` ${operation.error.error.hint}`}
    {operation.pending && ' Completion is unknown. Reconcile the saved action before trying again.'}</div>;
}

/** Pause or resume dispatch, reconnect or disconnect the session's agent. */
export function DispatchDialog({ store, actions, agent, onClose }: {
  readonly store: SessionStore; readonly actions: SessionActions; readonly agent: string; readonly onClose: () => void;
}) {
  const state = useSession(store), operation = useSessionActions(actions);
  const session = state.snapshot?.session;
  const binding = session?.active_binding_id ? session.bindings[session.active_binding_id] : null;
  const disabled = !session || state.status !== 'ready' || !!state.error || operation.writing || !!operation.pending;
  const resumable = !!session && !!binding && session.state === 'active' && binding.connection_state === 'connected' && !binding.pause_reason
    && !Object.values(session.inputs).some(input => input?.state === 'needs_attention' && input.binding_id === binding.id);
  const run = (action: BindingAction) => {
    if (!session || !binding || disabled) return;
    const command: OwnerCommand = action === 'connect' ? { command: 'binding_connect', api_version: 1, op_id: '', params: {
      project_id: session.project_id, adapter_id: binding.adapter_id, external_session_id: binding.external_session_id,
      endpoint: structuredClone(binding.endpoint), configuration: structuredClone(binding.adapter_config) as AdapterConfig, existing_session_id: session.id,
    } } : { command: `binding_${action}`, api_version: 1, op_id: '', params: { binding_id: binding.id, expected_generation: binding.generation } };
    void actions.execute(command, session.revision);
  };
  const button = (action: BindingAction, label: string, icon: string, off = false) => <button type="button" className="btn btn-secondary"
    disabled={disabled || off} onClick={() => run(action)}><i className={icon} aria-hidden="true" />{label}</button>;
  return <Dialog label={`${agent} dispatch and connection`} width={520} onCancel={() => { if (!operation.writing) onClose(); }}>
    <div className="dialog-title">{agent} · dispatch and connection</div>
    {!session && <div className="pw-dialog-body" role="status">Reading the session…</div>}
    {session && !binding && <div className="pw-dialog-body">No agent is connected to this session. Connect one from the project page.</div>}
    {session && binding && <>
      <dl className="pw-dialog-facts">
        <dt>Connection</dt><dd>{words(binding.connection_state)}</dd>
        <dt>Dispatch</dt><dd>{words(binding.dispatch_state)}{binding.owner_paused ? ' · paused by you' : ''}{binding.pause_reason ? ` · ${words(binding.pause_reason)}` : ''}</dd>
        <dt>Session</dt><dd>{binding.external_session_id}</dd>
      </dl>
      <div className="pw-dialog-body">Pause stops Ariadne sending anything more to {agent}. Work already sent keeps running; interrupt it in the terminal. Reconnect checks the same host session again.</div>
      <div className="pw-dialog-buttons">
        {button('pause', 'Pause dispatch', 'ph ph-pause', binding.dispatch_state === 'paused')}
        {button('resume', 'Resume dispatch', 'ph ph-play', !resumable)}
        {button('connect', 'Reconnect', 'ph ph-arrows-clockwise')}
        {button('disconnect', 'Disconnect', 'ph ph-plugs')}
      </div>
    </>}
    <Failure actions={actions} />
    <div className="dialog-actions">
      {operation.pending && <button type="button" className="btn btn-secondary" disabled={operation.writing} onClick={() => { void actions.retry(); }}>Reconcile saved action</button>}
      <button type="button" className="btn btn-ghost" disabled={operation.writing} onClick={onClose}>Done</button>
    </div>
  </Dialog>;
}

/** Shown when Close session cannot run straight away: dispatch must be paused and nothing left open. */
export function CloseSessionDialog({ store, actions, agent, when, onOpenSession, onClose }: {
  readonly store: SessionStore; readonly actions: SessionActions; readonly agent: string; readonly when: string;
  readonly onOpenSession: () => void; readonly onClose: () => void;
}) {
  const state = useSession(store), operation = useSessionActions(actions);
  const session = state.snapshot?.session;
  const binding = session?.active_binding_id ? session.bindings[session.active_binding_id] : null;
  const disabled = !session || state.status !== 'ready' || !!state.error || operation.writing || !!operation.pending;
  const error = operation.error instanceof CoreFailure ? operation.error.error : undefined;
  const blockers = session ? lifecycleBlockers(session, null, error) : [];
  const mustPause = !binding || binding.dispatch_state !== 'paused';
  const pause = () => {
    if (!session || !binding || disabled) return;
    void actions.execute({ command: 'binding_pause', api_version: 1, op_id: '', params: { binding_id: binding.id, expected_generation: binding.generation } }, session.revision);
  };
  const close = async () => {
    if (!session || disabled || mustPause || blockers.length) return;
    if (await actions.execute({ command: 'session_close', api_version: 1, op_id: '', params: { expected_revision: session.revision } }, session.revision)) onClose();
  };
  const title = `Close the ${agent} session from ${when.toLowerCase()}?`;
  return <Dialog label={title} width={520} onCancel={() => { if (!operation.writing) onClose(); }} onConfirm={() => { void close(); }}>
    <div className="dialog-title">{title}</div>
    <div className="pw-dialog-body">Ariadne marks the session Closed and keeps it read-only. The agent process isn’t touched.</div>
    {session && !binding && <div className="pw-dialog-warn">No agent binding can confirm that dispatch is paused. Connect the session before closing it.</div>}
    {session && binding && mustPause && <div className="pw-dialog-step"><span>Dispatch is on. Pause it first so nothing more is sent.</span>
      <button type="button" className="btn btn-secondary" disabled={disabled} onClick={pause}><i className="ph ph-pause" aria-hidden="true" />Pause dispatch</button></div>}
    {blockers.length > 0 && <div className="pw-dialog-body">These are still open. Settle them in the session first:
      <ul className="pw-dialog-list">{blockers.map(blocker => <li key={blocker.key}>{blocker.label}</li>)}</ul></div>}
    <Failure actions={actions} />
    <div className="dialog-actions">
      {blockers.length > 0 && <button type="button" className="btn btn-ghost" onClick={() => { onClose(); onOpenSession(); }}>Open the session</button>}
      <button type="button" className="btn btn-ghost" disabled={operation.writing} onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-primary" disabled={disabled || mustPause || blockers.length > 0} onClick={() => { void close(); }}>
        <i className="ph ph-x-circle" aria-hidden="true" />Close session</button>
    </div>
  </Dialog>;
}
