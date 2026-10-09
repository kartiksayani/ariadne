// The session's "Sending and connection" and Close dialogs, in the owner's
// words. Sending reads like the session bar's chip (components/bindings/dispatch);
// Reconnect checks the same agent session again on the project-scoped path.
// Close is one confirmation: it says what stays open and which unsent messages
// it cancels, then closes.
import { useRef } from 'react';
import { plainFailure, useSession, type SessionStore } from '../../data';
import type { OwnerCommand } from '../../generated/core';
import type { AdapterConfig } from '../../generated/domain/models';
import { useSessionActions, type SessionActions } from '../../components/bindings/actions';
import { useDispatch } from '../../components/bindings/DispatchChip';
import { closeImpact, closeWarning } from '../../components/history-actions/selectors';
import { connectionOf } from '../shared/connection';
import { sessionPhrase } from '../shell/model';
import { Dialog } from '../dialogs/Dialog';
import { notices } from './notices';

function Failure({ actions }: { readonly actions: SessionActions }) {
  const operation = useSessionActions(actions);
  if (!operation.error) return null;
  return <div className="pw-dialog-error" role="alert">{plainFailure(operation.error)}
    {operation.pending && ' Ariadne isn’t sure the change was saved. Check again before another change.'}</div>;
}

const connectionWords = { connected: 'Connected', reconnecting: 'Reconnecting…', not_running: 'Not running', none: 'Not connected' } as const;

/** Pause or resume sending, reconnect or disconnect the session's agent. */
export function DispatchDialog({ store, actions, agent, onClose, onSaved }: {
  readonly store: SessionStore; readonly actions: SessionActions; readonly agent: string; readonly onClose: () => void; readonly onSaved?: () => void;
}) {
  const state = useSession(store), operation = useSessionActions(actions), control = useDispatch(actions);
  const session = state.snapshot?.session;
  const binding = session?.active_binding_id ? session.bindings[session.active_binding_id] : null;
  const disabled = !session || state.status !== 'ready' || !!state.error || operation.writing || !!operation.pending;
  const reconnect = () => {
    if (!session || !binding || disabled) return;
    const command: OwnerCommand = { command: 'binding_connect', api_version: 1, op_id: '', params: {
      project_id: session.project_id, adapter_id: binding.adapter_id, external_session_id: binding.external_session_id,
      endpoint: structuredClone(binding.endpoint), configuration: structuredClone(binding.adapter_config) as AdapterConfig, existing_session_id: session.id,
    } };
    void actions.execute(command, session.revision);
  };
  const disconnect = () => {
    if (!session || !binding || disabled) return;
    void actions.execute({ command: 'binding_disconnect', api_version: 1, op_id: '', params: { binding_id: binding.id, expected_generation: binding.generation } }, session.revision);
  };
  const button = (label: string, icon: string, run: () => void, off = false) => <button type="button" className="btn btn-secondary"
    disabled={disabled || off} onClick={run}><i className={icon} aria-hidden="true" />{label}</button>;
  const title = `Sending to ${agent}`;
  return <Dialog label={title} width={520} onCancel={() => { if (!operation.writing) onClose(); }}>
    <div className="dialog-title">{title}</div>
    {!session && <div className="pw-dialog-body" role="status">Reading the session…</div>}
    {session && !binding && <div className="pw-dialog-body">No agent is connected to this session. Connect one from the project page.</div>}
    {session && binding && <>
      <dl className="pw-dialog-facts">
        <dt>Sending</dt><dd data-dispatch={control.status.kind}>{control.status.label}{binding.owner_paused && control.status.kind !== 'paused' ? ' · paused by you' : ''}</dd>
        <dt>Agent</dt><dd>{connectionWords[connectionOf(binding, state.presence[binding.id] ?? null)]}</dd>
      </dl>
      <div className="pw-dialog-body">Pause stops Ariadne sending anything more to {agent}. Work already sent keeps running; interrupt it in the terminal. Reconnect checks the same {agent} session again.</div>
      <div className="pw-dialog-buttons">
        {/* Pausing while something blocks sending keeps it paused once the blocker clears. */}
        {button('Pause sending', 'ph ph-pause', () => { void control.pause(); }, binding.owner_paused || session.state === 'closed'
          || binding.dispatch_state === 'paused' || binding.dispatch_state === 'disconnected')}
        {button('Resume sending', 'ph ph-play', () => { void control.resume(); }, control.status.action !== 'resume')}
        {button('Reconnect', 'ph ph-arrows-clockwise', reconnect)}
        {button('Disconnect', 'ph ph-plugs', disconnect)}
      </div>
    </>}
    <Failure actions={actions} />
    <div className="dialog-actions">
      {operation.pending && <button type="button" className="btn btn-secondary" disabled={operation.writing} onClick={() => { void actions.retry().then(saved => { if (saved) onSaved?.(); }); }}>Check again</button>}
      <button type="button" className="btn btn-ghost" disabled={operation.writing} onClick={onClose}>Done</button>
    </div>
  </Dialog>;
}

/** After a saved close: say how many unsent messages it cancelled (receipt `cancelled_input_ids`), if any. */
export function announceClosed(actions: SessionActions, agent: string, name: string | null = null): void {
  const receipt = actions.getSnapshot().receipt;
  const data = receipt && 'data' in receipt ? receipt.data : undefined;
  const cancelled = data?.kind === 'session_lifecycle' ? data.cancelled_input_ids?.length ?? 0 : 0;
  if (cancelled) notices.push({ icon: 'ph ph-x-circle', dismissible: true,
    text: `Closed ${name ? `the “${name}”` : `the ${agent}`} session. ${cancelled} unsent message${cancelled === 1 ? ' was' : 's were'} cancelled.` }, 8000);
}

/** Close session: one confirmation in plain words, then close. Nothing has to be paused or settled first. */
export function CloseSessionDialog({ store, actions, agent, when, name = null, onClose }: {
  readonly store: SessionStore; readonly actions: SessionActions; readonly agent: string; readonly when: string;
  /** The owner's name for the session, when set; it stands in for the agent and day. */
  readonly name?: string | null; readonly onClose: () => void;
}) {
  const state = useSession(store), operation = useSessionActions(actions);
  const session = state.snapshot?.session;
  const disabled = !session || session.state === 'closed' || state.status !== 'ready' || !!state.error || operation.writing || !!operation.pending;
  const warning = session ? closeWarning(closeImpact(session), agent) : null;
  const close = async () => {
    if (!session || disabled) return;
    if (!await actions.execute({ command: 'session_close', api_version: 1, op_id: '', params: { expected_revision: session.revision } }, session.revision)) return;
    announceClosed(actions, agent, name);
    onClose();
  };
  const title = `Close ${sessionPhrase({ name }, agent, when)}?`;
  return <Dialog label={title} width={520} onCancel={() => { if (!operation.writing) onClose(); }} onConfirm={() => { void close(); }}>
    <div className="dialog-title">{title}</div>
    <div className="pw-dialog-body">Ariadne marks the session Closed and keeps it read-only. The agent process isn’t touched.</div>
    {warning && <div className="pw-dialog-body" data-close-warning>{warning}</div>}
    <Failure actions={actions} />
    <div className="dialog-actions">
      {operation.pending && <button type="button" className="btn btn-secondary" disabled={operation.writing} onClick={() => { void actions.retry(); }}>Check again</button>}
      <button type="button" className="btn btn-ghost" disabled={operation.writing} onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-primary" disabled={disabled} onClick={() => { void close(); }}>
        <i className="ph ph-x-circle" aria-hidden="true" />Close session</button>
    </div>
  </Dialog>;
}

/** Archive explains closing, waiting questions and message cancellation. */
export function ArchiveSessionDialog({ store, actions, agent, onClose, onSaved }: {
  readonly store: SessionStore; readonly actions: SessionActions; readonly agent: string; readonly onClose: () => void; readonly onSaved: (wasActive: boolean) => void;
}) {
  const state = useSession(store), operation = useSessionActions(actions), session = state.snapshot?.session;
  // Keep the state submitted with the exact operation, even if its response is
  // lost and the reader subsequently captures the already archived session.
  const wasActive = useRef<boolean | null>(null);
  const warning = session ? closeWarning(closeImpact(session), agent, 'archiving') : null;
  const disabled = !session || session.archived_at != null || state.status !== 'ready' || !!state.error || operation.writing || !!operation.pending;
  const archive = async () => {
    if (!session || disabled) return;
    wasActive.current = session.state === 'active';
    if (await actions.execute({ command: 'session_archive', api_version: 1, op_id: '', params: { expected_revision: session.revision } }, session.revision)) onSaved(wasActive.current);
  };
  return <Dialog label="Archive this session?" width={520} onCancel={() => { if (!operation.writing) onClose(); }} onConfirm={() => { void archive(); }}>
    <div className="dialog-title">Archive this session?</div>
    <div className="pw-dialog-body">{session?.state === 'active' ? 'Archiving closes this session and stops sending to the agent. ' : ''}All saved history stays. You can restore this session any time.</div>
    {warning && <div className="pw-dialog-body" data-close-warning>{warning}</div>}
    <Failure actions={actions} />
    <div className="dialog-actions">
      <button type="button" className="btn btn-ghost" disabled={operation.writing} onClick={onClose}>Cancel</button>
      {operation.pending
        ? <button type="button" className="btn btn-primary" disabled={operation.writing} onClick={() => { void actions.retry().then(saved => { if (saved) onSaved(wasActive.current ?? false); }); }}>Check again</button>
        : <button type="button" className="btn btn-primary" disabled={disabled} onClick={() => { void archive(); }}>Archive session</button>}
    </div>
  </Dialog>;
}
