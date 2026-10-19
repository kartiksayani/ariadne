// The session's "Connection to {agent}" and Close dialogs, in the owner's
// words. Sending reads like the session bar's chip (components/bindings/dispatch);
// Reconnect checks the same agent session again on the project-scoped path.
// Close is one confirmation: it says what stays open and which unsent messages
// it cancels, then closes.
import { useEffect, useRef, useState } from 'react';
import { plainFailure, useSession, type Immutable, type SessionStore } from '../../data';
import type { OwnerCommand } from '../../generated/core';
import type { AdapterConfig, Session } from '../../generated/domain/models';
import { useSessionActions, type SessionActions } from '../../components/bindings/actions';
import { useDispatch } from '../../components/bindings/DispatchChip';
import { closeImpact, closeWarning } from '../../components/history-actions/selectors';
import { connectionOf } from '../shared/connection';
import { sessionPhrase, sessionWhen } from '../shell/model';
import { Dialog } from '../dialogs/Dialog';
import { notices } from './notices';
import { copySessionReference } from '../shared/CopySessionId';
import { agentProduct } from '../../state/navigation/switcher';
import { waitForLifecycleReady } from '../shared/lifecycleReady';

/** A confirmation owns its wait; closing it cancels admission, never a saved write. */
function useLifecycleConfirmation(actions: SessionActions) {
  const active = useRef<{ cancelled: boolean; cancellation: Promise<boolean>; cancel: () => void; saving: boolean } | null>(null);
  const [busy, setBusy] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null);
  useEffect(() => () => active.current?.cancel(), []);
  const run = async (confirmed: (session: Immutable<Session>) => Promise<void>) => {
    if (active.current) return;
    let cancel!: () => void;
    const cancellation = new Promise<boolean>(resolve => { cancel = () => { attempt.cancelled = true; resolve(false); }; });
    const attempt = { cancelled: false, cancellation, cancel, saving: false };
    active.current = attempt;
    setBusy(true); setError(null);
    try {
      const ready = await waitForLifecycleReady(actions, attempt, true);
      if (!ready.ok) { if (ready.error) setError(ready.error); return; }
      attempt.saving = true; setSaving(true);
      await confirmed(ready.session);
    } catch (failure: unknown) { if (!attempt.cancelled) setError(plainFailure(failure)); }
    finally {
      if (active.current === attempt) active.current = null;
      if (!attempt.cancelled) { setBusy(false); setSaving(false); }
    }
  };
  const cancel = () => {
    if (active.current?.saving) return false;
    active.current?.cancel();
    return true;
  };
  return { busy, saving, error, setError, run, cancel };
}

const changedImpact = (before: Immutable<Session>, after: Immutable<Session>) => {
  const left = closeImpact(before), right = closeImpact(after);
  return before.state !== after.state || left.questions !== right.questions || left.unsent !== right.unsent || left.delivering !== right.delivering;
};
const confirmationChanged = 'The session changed. Check the updated details, then confirm again.';

function Failure({ actions }: { readonly actions: SessionActions }) {
  const operation = useSessionActions(actions);
  if (!operation.error) return null;
  return <div className="pw-dialog-error" role="alert">{plainFailure(operation.error)}
    {operation.pending && ' Ariadne isn’t sure the change was saved. Check again before another change.'}</div>;
}

/** Connects the session's agent again, to the same agent session ("Reconnect" here, "Try now" on the line above the Map). */
export function reconnectCommand(session: Immutable<Session>, binding: NonNullable<Immutable<Session>['bindings'][string]>): OwnerCommand {
  return { command: 'binding_connect', api_version: 1, op_id: '', params: {
    project_id: session.project_id, adapter_id: binding.adapter_id, external_session_id: binding.external_session_id,
    endpoint: structuredClone(binding.endpoint), configuration: structuredClone(binding.adapter_config) as AdapterConfig, existing_session_id: session.id,
  } };
}

const connectionWords = { connected: 'Connected', reconnecting: 'Reconnecting…', not_running: 'Not running', none: 'Not connected' } as const;

const notSavedText = 'That didn’t go through. Try again.';

/** True when the last saved receipt says this binding is now Disconnected (a confirmed Disconnect, not a retry still in doubt). */
function disconnectConfirmed(actions: SessionActions, bindingId: string): boolean {
  const receipt = actions.getSnapshot().receipt;
  const data = receipt && 'data' in receipt ? receipt.data : undefined;
  return data?.kind === 'binding_state' && data.binding_id === bindingId && data.connection_state === 'disconnected';
}

/**
 * After a confirmed Disconnect: one notice, in the agent's own words for connecting again. Claude's has Copy session ID,
 * because the command it names takes that ID; Codex connects from a list, so there is nothing to copy.
 */
export function announceDisconnected(actions: SessionActions, adapterId: string): void {
  const route = actions.session.getSnapshot().route, id = `session-disconnected:${route.project_id}:${route.session_id}`;
  const claude = agentProduct(adapterId) === 'Claude Code', codex = adapterId === 'codex';
  notices.push({ id, icon: 'ph ph-plugs', text: claude
    ? 'Disconnected. Run /ariadne-connect followed by the session ID in Claude to connect again.'
    : codex ? 'Disconnected. Use Connect existing session to connect again.' : 'Disconnected.',
  ...claude ? { actions: [{ label: 'Copy session ID', dismissOnRun: true, run: () => { void copySessionReference(route.session_id); } }] } : {} }, 12_000);
}

/** Pause or resume sending, reconnect or disconnect the session's agent. */
export function DispatchDialog({ store, actions, agent, onClose, onSaved }: {
  readonly store: SessionStore; readonly actions: SessionActions; readonly agent: string; readonly onClose: () => void; readonly onSaved?: () => void;
}) {
  const state = useSession(store), operation = useSessionActions(actions), control = useDispatch(actions);
  // `execute` answers false without an error when it refuses to start; the owner still gets a line, in the error's place.
  const [notSaved, setNotSaved] = useState(false);
  const session = state.snapshot?.session;
  const binding = session?.active_binding_id ? session.bindings[session.active_binding_id] : null;
  const disabled = !session || state.status !== 'ready' || !!state.error || operation.writing || !!operation.pending;
  const settled = (saved: boolean) => { if (!saved && !actions.getSnapshot().error) setNotSaved(true); };
  const reconnect = () => {
    if (!session || !binding || disabled) return;
    setNotSaved(false);
    void actions.execute(reconnectCommand(session, binding), session.revision).then(settled);
  };
  const disconnect = () => {
    if (!session || !binding || disabled) return;
    setNotSaved(false);
    const { id, generation, adapter_id: adapterId } = binding;
    void actions.execute({ command: 'binding_disconnect', api_version: 1, op_id: '', params: { binding_id: id, expected_generation: generation } }, session.revision)
      .then(saved => {
        if (saved && disconnectConfirmed(actions, id)) { announceDisconnected(actions, adapterId); onClose(); } else settled(saved);
      });
  };
  // Check again retries whatever was pending: only a Disconnect that confirmed closes the dialog with the notice.
  const checkAgain = () => {
    const retried = operation.pending?.command, adapterId = binding?.adapter_id ?? '';
    setNotSaved(false);
    void actions.retry().then(saved => {
      if (saved) onSaved?.();
      if (saved && retried?.command === 'binding_disconnect' && disconnectConfirmed(actions, retried.params.binding_id)) {
        announceDisconnected(actions, adapterId); onClose();
      }
    });
  };
  const button = (label: string, icon: string, run: () => void, off = false) => <button type="button" className="btn btn-secondary"
    disabled={disabled || off} onClick={run}><i className={icon} aria-hidden="true" />{label}</button>;
  const title = `Connection to ${agent}`;
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
        {button('Pause sending', 'ph ph-pause', () => { setNotSaved(false); void control.pause(); }, binding.owner_paused || session.state === 'closed'
          || binding.dispatch_state === 'paused' || binding.dispatch_state === 'disconnected')}
        {button('Resume sending', 'ph ph-play', () => { setNotSaved(false); void control.resume(); }, control.status.action !== 'resume')}
        {button('Reconnect', 'ph ph-arrows-clockwise', reconnect)}
        {button('Disconnect', 'ph ph-plugs', disconnect)}
      </div>
    </>}
    <Failure actions={actions} />
    {notSaved && !operation.error && <div className="pw-dialog-error" role="alert">{notSavedText}</div>}
    <div className="dialog-actions">
      {operation.pending && <button type="button" className="btn btn-secondary" disabled={operation.writing} onClick={checkAgain}>Check again</button>}
      <button type="button" className="btn btn-ghost" disabled={operation.writing} onClick={onClose}>Done</button>
    </div>
  </Dialog>;
}

/** After a saved close: say how many unsent messages it cancelled (receipt `cancelled_input_ids`), if any. */
export function announceClosed(actions: SessionActions, agent: string, name: string | null = null): void {
  const receipt = actions.getSnapshot().receipt;
  const data = receipt && 'data' in receipt ? receipt.data : undefined;
  const cancelled = data?.kind === 'session_lifecycle' ? data.cancelled_input_ids?.length ?? 0 : 0;
  const state = actions.session.getSnapshot(), route = state.route;
  const when = state.snapshot ? sessionWhen(Date.parse(state.snapshot.session.created_at), Date.now()) : 'earlier';
  if (cancelled) notices.push({ id: `session-closed:${route.project_id}:${route.session_id}`, icon: 'ph ph-x-circle',
    text: `Closed ${sessionPhrase({ name }, agent, when)}. ${cancelled} unsent message${cancelled === 1 ? ' was' : 's were'} cancelled.` }, 8000);
}


/** Archive explains closing, waiting questions and message cancellation. */
export function ArchiveSessionDialog({ store, actions, agent, onClose, onSaved }: {
  readonly store: SessionStore; readonly actions: SessionActions; readonly agent: string; readonly onClose: () => void; readonly onSaved: (wasActive: boolean) => void;
}) {
  const state = useSession(store), operation = useSessionActions(actions), session = state.snapshot?.session;
  const confirmation = useLifecycleConfirmation(actions);
  // Keep the state submitted with the exact operation, even if its response is
  // lost and the reader subsequently captures the already archived session.
  const wasActive = useRef<boolean | null>(null);
  const warning = session ? closeWarning(closeImpact(session), agent, 'archiving') : null;
  const disabled = !session || session.archived_at != null || confirmation.busy;
  const archive = async () => {
    if (!session || disabled) return;
    await confirmation.run(async refreshed => {
      if (refreshed.archived_at != null) { confirmation.setError('This session is already archived.'); return; }
      if (changedImpact(session, refreshed)) { confirmation.setError(confirmationChanged); return; }
      wasActive.current = refreshed.state === 'active';
      if (await actions.execute({ command: 'session_archive', api_version: 1, op_id: '', params: { expected_revision: refreshed.revision } }, refreshed.revision)) onSaved(wasActive.current);
      else confirmation.setError(plainFailure(actions.getSnapshot().error, 'The session could not be archived. Try again.'));
    });
  };
  const archivePending = operation.pending?.command.command === 'session_archive';
  const cancel = () => { if (!(archivePending && operation.writing) && confirmation.cancel()) onClose(); };
  return <Dialog label="Archive this session?" width={520} onCancel={cancel} onConfirm={() => { void archive(); }}>
    <div className="dialog-title">Archive this session?</div>
    <div className="pw-dialog-body">{session?.state === 'active' ? 'Archiving closes this session and stops sending to the agent. ' : ''}All saved history stays. You can restore this session any time.</div>
    {warning && <div className="pw-dialog-body" data-close-warning>{warning}</div>}
    <Failure actions={actions} />
    {confirmation.error && <div className="pw-dialog-error" role="alert">{confirmation.error}</div>}
    <div className="dialog-actions">
      <button type="button" className="btn btn-ghost" disabled={confirmation.saving || archivePending && operation.writing} onClick={cancel}>Cancel</button>
      {archivePending
        ? <button type="button" className="btn btn-primary" disabled={operation.writing || confirmation.busy} onClick={() => { void actions.retry().then(saved => { if (saved) onSaved(wasActive.current ?? false); }); }}>Check again</button>
        : <button type="button" className="btn btn-primary" disabled={disabled} onClick={() => { void archive(); }}>Archive session</button>}
    </div>
  </Dialog>;
}
