// Whether Ariadne is sending to the session's agent, in the owner's words.
// One reading for the session bar chip, the project page card and the paused
// warning in the editors: Sending / Paused (by you) / Not sending: <reason> /
// Disconnected. Built from the binding (or its catalogue summary), the inputs
// needing a decision and, when the desktop supervisor drives the binding, its
// health. No internal state names reach the owner.
import type { SupervisorHealth } from '../../data/service';
import type { ConnectionState, DispatchState, PauseReason, PresenceObservation } from '../../generated/domain/models';
import type { Immutable } from '../../data/session-store';
import { connectionOf } from '../../ui/shared/connection';

export type DispatchKind = 'sending' | 'paused' | 'blocked' | 'waiting' | 'reconnecting' | 'disconnected' | 'closed' | 'none';

export interface DispatchStatus {
  readonly kind: DispatchKind;
  /** The chip and card text: "Sending", "Paused (by you)", "Not sending: …", "Disconnected". */
  readonly label: string;
  /** Why nothing is sent, in plain words, or null while sending. */
  readonly reason: string | null;
  /** The one-click action: Pause while sending, Resume while paused by the owner. */
  readonly action: 'pause' | 'resume' | null;
  /** True while inputs reach the agent (sending or reconnecting): the card's green dot. */
  readonly live: boolean;
  readonly color: string;
}

interface BindingLike {
  readonly generation: string;
  readonly dispatch_state: DispatchState;
  readonly owner_paused: boolean;
  readonly pause_reason: PauseReason | null;
  readonly connection_state: ConnectionState;
  readonly presence?: Immutable<PresenceObservation> | null;
}

export interface DispatchFacts {
  readonly binding: BindingLike | null | undefined;
  readonly closed: boolean;
  /** An input on this binding waits for the owner's recovery decision. */
  readonly needsDecision?: boolean;
  /** Words of the delivered message whose answer is still missing. */
  readonly waitingAnswer?: string | null;
  readonly presence?: Immutable<PresenceObservation> | null;
  /** The desktop supervisor's health for this binding generation; null when unknown (Claude Code bindings have none). */
  readonly health?: SupervisorHealth | null;
  /** The agent's name, e.g. "codex". */
  readonly agent?: string;
  /** The time the retry countdown is read at; now by default. */
  readonly now?: number;
}

const reasons: Readonly<Record<PauseReason, string>> = {
  result_missing: 'the agent hasn’t saved its answer yet',
  uncertain: 'Ariadne isn’t sure your last message arrived',
  host_failure: 'the agent’s last turn failed',
  store_error: 'Ariadne couldn’t save to disk',
  incompatible: 'this agent version isn’t supported',
};
const decision = 'a message needs your decision';
const neutral = 'color-mix(in srgb, var(--color-text) 60%, transparent)';

const status = (kind: DispatchKind, label: string, reason: string | null, action: DispatchStatus['action'], color: string): DispatchStatus =>
  Object.freeze({ kind, label, reason, action, live: kind === 'sending' || kind === 'reconnecting', color });

/** Seconds left before the supervisor retries, counted from its update; null unless it backs off with a retry. */
export function retryIn(health: SupervisorHealth | null | undefined, now: number): number | null {
  if (health?.state !== 'backing_off' || !health.retry_in_seconds) return null;
  return Math.max(0, health.retry_in_seconds - Math.max(0, now - Date.parse(health.updated_at)) / 1000);
}

/** The supervisor's own words, with the retry countdown (from its update time to `now`) while it backs off. */
export function healthReason(health: SupervisorHealth | null | undefined, now = Date.now()): string | null {
  if (!health || health.state === 'running') return null;
  const reason = health.reason?.trim() || (health.state === 'stopped' ? 'Ariadne’s sender stopped' : 'Ariadne hit an error');
  const left = retryIn(health, now);
  if (left === null) return reason;
  return left > 0 ? `${reason} · retrying in ${Math.ceil(left)}s` : `${reason} · retrying now`;
}

export function dispatchStatus({ binding, closed, needsDecision = false, waitingAnswer = null, presence = null, health = null, agent = 'the agent', now = Date.now() }: DispatchFacts): DispatchStatus {
  if (!binding) return status('none', 'No agent connected', null, null, neutral);
  if (closed) return status('closed', 'Session closed', 'the session is closed', null, neutral);
  const connection = connectionOf(binding, presence);
  if (connection === 'not_running') {
    return status('disconnected', 'Disconnected', binding.connection_state === 'disconnected' || binding.dispatch_state === 'disconnected'
      ? `${agent} is disconnected` : `${agent} isn’t running`, null, neutral);
  }
  if (binding.pause_reason && binding.pause_reason !== 'result_missing') {
    const reason = reasons[binding.pause_reason];
    return status('blocked', `Not sending: ${reason}`, reason, null, 'var(--a-warn)');
  }
  const unhealthy = healthReason(health, now);
  if (waitingAnswer !== null && unhealthy) return status('blocked', `Not sending: ${unhealthy}`, unhealthy, 'pause', 'var(--a-warn)');
  if (waitingAnswer !== null) {
    const text = `Waiting for ${agent} to answer “${waitingAnswer.length > 40 ? `${waitingAnswer.slice(0, 38).trimEnd()}…` : waitingAnswer}”`;
    return status('waiting', text, text, null, neutral);
  }
  // A recovery blocker outranks the owner's pause: Resume cannot clear it.
  const blocker = binding.pause_reason ? reasons[binding.pause_reason] : needsDecision ? decision : null;
  if (blocker) return status('blocked', `Not sending: ${blocker}`, blocker, null, 'var(--a-warn)');
  if (binding.owner_paused || binding.dispatch_state === 'paused') return status('paused', 'Paused (by you)', 'you paused sending', 'resume', 'var(--a-warn)');
  // A settled recovery with nothing left to decide waits for the owner's Resume.
  if (binding.dispatch_state === 'recovery_required') return status('paused', 'Paused', 'sending waits for you to resume', 'resume', 'var(--a-warn)');
  if (unhealthy) return status('blocked', `Not sending: ${unhealthy}`, unhealthy, 'pause', 'var(--a-warn)');
  if (connection === 'reconnecting') return status('reconnecting', 'Reconnecting…', null, 'pause', 'var(--st-progress)');
  return status('sending', 'Sending', null, 'pause', 'var(--st-done)');
}

/** The editors' inline warning while sending is paused or blocked; null while sending. */
export function pausedNote(dispatch: DispatchStatus, agent: string): string | null {
  if (dispatch.kind === 'waiting') return `${dispatch.label}. Your next message waits here until this is answered or you stop waiting.`;
  if (dispatch.kind === 'paused') return `Sending is paused — your message waits here until you resume.`;
  if (dispatch.kind === 'blocked') return `Not sending to ${agent}: ${dispatch.reason}. Your message waits until that’s sorted.`;
  return null;
}
