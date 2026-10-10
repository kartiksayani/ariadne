// The session bar's dispatch chip and the editors' paused warning: whether
// Ariadne is sending to the agent, with Pause / Resume one click away.
import { useEffect, useRef, useState } from 'react';
import { useSession } from '../../data/session-store';
import type { OwnerCommand } from '../../generated/core';
import { agentName } from '../../ui/shell/model';
import { connectionOf, type Connection } from '../../ui/shared/connection';
import { useSessionActions, type SessionActions } from './actions';
import { dispatchStatus, pausedNote, type DispatchStatus } from './dispatch';
import { useSupervisorHealth } from './health';
import { awaitingAnswer, sentLabel, stoppedAttempt } from '../../selectors/waiting/stuck';
import { notices, type Notice } from '../../ui/pages/notices';
import { isViewConflict } from '../../ui/shared/conflictNotice';
import './controls.css';

export interface DispatchControl {
  readonly status: DispatchStatus;
  /** Whether the agent itself is connected (ui/shared/connection), apart from sending. */
  readonly connection: Connection;
  readonly agent: string;
  /** A write is running or a saved action is unconfirmed: the buttons wait. */
  readonly busy: boolean;
  /** The last failed Pause/Resume, in plain words. */
  readonly error: string | null;
  /** A saved session action awaits confirmation; `retry` replays it exactly. */
  readonly unconfirmed: boolean;
  readonly retry: () => Promise<boolean>;
  readonly pause: () => Promise<boolean>;
  readonly resume: () => Promise<boolean>;
}

/** The session's sending state and its one-click Pause / Resume. */
export function useDispatch(actions: SessionActions): DispatchControl {
  const reader = actions.session;
  const state = useSession(reader), operation = useSessionActions(actions);
  const session = state.snapshot?.session;
  const binding = session?.active_binding_id ? session.bindings[session.active_binding_id] ?? null : null;
  const health = useSupervisorHealth(actions.service, binding?.id, binding?.generation);
  const agent = binding ? agentName(binding.adapter_id) : 'the agent';
  const needsDecision = !!binding && Object.values(session?.inputs ?? {}).some(input => input?.binding_id === binding.id && input.state === 'needs_attention');
  const presence = binding ? state.presence[binding.id] ?? null : null;
  const waiting = Object.values(session?.inputs ?? {}).filter(input => !!input && input.binding_id === binding?.id
    && awaitingAnswer(input) && stoppedAttempt(input)?.binding_generation === binding?.generation).sort((a, b) => a!.seq - b!.seq)[0];
  const status = dispatchStatus({ binding, closed: session?.state === 'closed', needsDecision,
    waitingAnswer: waiting ? sentLabel(waiting) || 'your message' : null, presence, health, agent });
  const connection = connectionOf(binding, presence);
  const busy = !session || state.status !== 'ready' || !!state.error || operation.writing || !!operation.pending;
  const [error, setError] = useState<string | null>(null);
  const lifetime = useRef<{ cancelled: boolean; notice: Notice | null } | null>(null);
  const failureId = `dispatch-failed:${state.route.project_id}:${state.route.session_id}`;
  useEffect(() => {
    const scope: { cancelled: boolean; notice: Notice | null } = { cancelled: false, notice: null };
    lifetime.current = scope;
    setError(null);
    const closed = () => {
      if (reader.getSnapshot().status === 'closed') {
        scope.cancelled = true;
        setError(null);
        notices.dismiss(failureId);
      }
    };
    const unsubscribe = reader.subscribe(closed);
    closed();
    return () => {
      scope.cancelled = true;
      unsubscribe();
      if (scope.notice && notices.getSnapshot().includes(scope.notice)) notices.dismiss(failureId);
    };
  }, [actions, reader, failureId]);
  const run = async (kind: 'binding_pause' | 'binding_resume') => {
    if (!session || !binding || busy) return false;
    const scope = lifetime.current;
    setError(null);
    const command: OwnerCommand = { command: kind, api_version: 1, op_id: '', params: { binding_id: binding.id, expected_generation: binding.generation } };
    const saved = await actions.execute(command, session.revision);
    if (!scope || scope.cancelled || lifetime.current !== scope || actions.session !== reader || reader.getSnapshot().status === 'closed') return saved;
    // An unconfirmed save says so itself ("Your last change wasn’t confirmed"); only a refusal is a failure.
    if (!saved && !actions.getSnapshot().pending) {
      const error = kind === 'binding_pause' ? 'Pausing didn’t go through. Try again.' : 'Resuming didn’t go through. Try again.';
      setError(error);
      if (!isViewConflict(actions.getSnapshot().error)) {
        notices.push({ id: failureId, icon: 'ph ph-warning-circle', iconColor: 'var(--a-warn)', text: error });
        scope.notice = notices.getSnapshot().find(notice => notice.id === failureId) ?? null;
      }
    } else notices.dismiss(failureId);
    return saved;
  };
  // A saved action whose completion is unknown holds every session write; its exact replay frees them.
  const unconfirmed = !!operation.pending && !operation.writing;
  return { status, connection, agent, busy, error: error ?? (unconfirmed ? 'Your last change wasn’t confirmed.' : null), unconfirmed,
    retry: () => actions.retry(), pause: () => run('binding_pause'), resume: () => run('binding_resume') };
}

/** Pause and play drawn inline: the bundled icon font maps only the handoff's glyphs, and these are not among them. */
function Glyph({ kind }: { readonly kind: 'pause' | 'play' }) {
  return <svg className="dispatch-glyph" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
    {kind === 'pause'
      ? <><rect x="2.5" y="2" width="2.5" height="8" rx=".6" fill="currentColor" /><rect x="7" y="2" width="2.5" height="8" rx=".6" fill="currentColor" /></>
      : <path d="M3.5 2.2v7.6a.5.5 0 0 0 .76.43l6.1-3.8a.5.5 0 0 0 0-.86l-6.1-3.8a.5.5 0 0 0-.76.43z" fill="currentColor" />}
  </svg>;
}

/** "Sending" with a Pause icon, "Paused (by you)" with a Resume icon, "Not sending: …", "Disconnected". */
export function DispatchChip({ actions, onDetails }: { readonly actions: SessionActions; readonly onDetails?: () => void }) {
  const control = useDispatch(actions), { status } = control;
  return <span className="tree-run dispatch-chip" data-dispatch={status.kind} data-running={status.live || undefined} data-connection={control.connection}
    role="group" aria-label="Sending to the agent">
    <span className="dispatch-dot" style={{ background: status.live ? status.color : 'transparent', boxShadow: status.live ? 'none' : `inset 0 0 0 1.5px ${status.color}` }} />
    {onDetails
      ? <button type="button" className="dispatch-label dispatch-details" style={{ color: status.color }} title="Sending and connection" onClick={onDetails}>{status.label}</button>
      : <span className="dispatch-label" style={{ color: status.color }}>{status.label}</span>}
    {/* Icon buttons, so the chip fits the bar's text line; the name and tooltip say what they do. */}
    {status.action === 'pause' && <button type="button" className="btn btn-ghost dispatch-action dispatch-icon" disabled={control.busy}
      aria-label="Pause" title={`Pause: stop sending to ${control.agent}`}
      onClick={() => { void control.pause(); }}><Glyph kind="pause" /></button>}
    {status.action === 'resume' && <button type="button" className="btn btn-secondary dispatch-action dispatch-icon" disabled={control.busy}
      aria-label="Resume" title={`Resume: send to ${control.agent} again`}
      onClick={() => { void control.resume(); }}><Glyph kind="play" /></button>}
    {control.unconfirmed && <span className="dispatch-error" role="alert">{control.error}</span>}
    {control.unconfirmed && <button type="button" className="btn btn-ghost dispatch-action" onClick={() => { void control.retry(); }}>Try again</button>}
  </span>;
}

/** The editors' inline "Sending is paused — Resume" while the session's sending is paused or blocked. */
export function PausedNote({ actions }: { readonly actions: SessionActions }) {
  const control = useDispatch(actions), note = pausedNote(control.status, control.agent);
  if (!note) return null;
  return <div className="dispatch-note" role="status" data-dispatch-note={control.status.kind}>
    <i className="ph ph-pause-circle" aria-hidden="true" /><span>{note}</span>
    {control.status.action === 'resume' && <button type="button" className="btn btn-secondary dispatch-action" disabled={control.busy}
      onClick={() => { void control.resume(); }}><i className="ph ph-play" aria-hidden="true" />Resume</button>}
  </div>;
}
