// Why an owner message hasn't reached the agent, in one plain sentence:
// - the question changed (held: review and send again)
// - sending is paused, or not sending: <reason>
// - queued behind another message
// - the agent is busy, or hasn't picked it up yet
// - a delivery that stopped and needs a decision: "Couldn't deliver …", with
//   Retry (send it again) and Mark as done, or Mark as handled once the agent
//   saved its answer
// The tree rows, the detail tracker and the Waiting "Sent" rows show it with
// Cancel and, where it applies, Resume, Retry or "Review and send again".
import type { Attempt, Input, Message, PresenceObservation, Session } from '../../generated/domain/models';
import type { Immutable } from '../../data';
import type { SupervisorHealth } from '../../data/service';
import { dispatchStatus } from '../../components/bindings/dispatch';
import { agentName } from '../../ui/shell/model';

/** `sent` is not stuck at all: the message is on its way, and only Cancel applies (no text). */
export type StuckKind = 'held' | 'paused' | 'blocked' | 'behind' | 'busy' | 'waiting' | 'decision' | 'sent';
export interface Stuck {
  readonly kind: StuckKind;
  readonly text: string;
  /** Resume sending lets it go out. */
  readonly resume: boolean;
  /** It stopped mid-delivery: Retry sends it again. */
  readonly retry: boolean;
  /** The other answer to a stopped delivery: Mark as done (skip), or Mark as handled once the agent saved its answer. */
  readonly settle: 'skip' | 'accept_result' | null;
}

const quoted = (text: string) => `“${text.length > 40 ? `${text.slice(0, 38).trimEnd()}…` : text}”`;
/** What the message was about: its question, else its topic. */
export const inputAbout = (input: Immutable<Input>) => input.payload.target_snapshot.item_question ?? input.payload.target_snapshot.topic_name;
/** What the owner sent, on one line: the chosen option, else the text. */
const sentLabel = (input: Immutable<Input>) => input.payload.target_snapshot.options.find(option => option.id === input.payload.selected_option_id)?.label
  ?? input.payload.text.replace(/\s+/gu, ' ').trim();

/** Held: a queued message written for an older revision of its question; it waits for the owner to review it. */
export function heldInput(session: Immutable<Session>, input: Immutable<Input>): boolean {
  const item = input.target.item_id ? session.items[input.target.item_id] : null, written = input.payload.target_snapshot.question_revision;
  return input.state === 'queued' && !!item && written !== null && written < item.question_revision;
}

/** The input of an owner message that ended cancelled, whatever its cause; undefined for anything else. */
function cancelledInput(session: Immutable<Session>, message: Immutable<Message>): Immutable<Input> | undefined {
  const input = message.author === 'owner' && message.input_id ? session.inputs[message.input_id] : undefined;
  return input && input.state === 'cancelled' ? input : undefined;
}
/**
 * Only an edit sent again leaves the history: a later message carries its words.
 * Every owner cancellation stays visible, including stores from before core recorded a cause.
 */
export function withdrawn(session: Immutable<Session>, message: Immutable<Message>): boolean {
  // A message taken back to edit may have earlier attempts (it was re-queued): the take-back is the cause that counts.
  const edited = cancelledInput(session, message);
  return edited?.cancel_cause === 'owner_edit' && sentAgain(session, edited);
}

/** The quiet line explaining an owner cancellation, edit take-back, archive or close. */
export interface NotSent {
  readonly input: Immutable<Input>;
  /** The plain reason and, for an owner cancellation, whether the agent may have seen it. */
  readonly line: string;
  /** The owner already sent these same words again to the same item or topic, so "Put back in reply box" has nothing left to do. */
  readonly again: boolean;
}
const notSentLine = { owner_edit: 'Taken back to edit', topic_archived: 'Not sent: cancelled when you archived this topic',
  session_closed: 'Not sent: cancelled when you closed this session' } as const;
/** A later message of the owner's to the same item or topic carries the same words and is not itself cancelled: it was put back and sent. */
function sentAgain(session: Immutable<Session>, input: Immutable<Input>): boolean {
  const text = input.payload.text.trim(), option = input.payload.selected_option_id;
  return (!!text || !!option) && Object.values(session.inputs).some(other => !!other && other.seq > input.seq
    && other.target.topic_id === input.target.topic_id && other.target.item_id === input.target.item_id
    && other.state !== 'cancelled' && other.state !== 'skipped'
    && other.payload.text.trim() === text && other.payload.selected_option_id === option);
}
/**
 * Owner cancellations keep their words and explain whether a delivery was attempted. Archive and close keep
 * their line; one taken back to edit is hidden instead once its words were sent again (`withdrawn`).
 */
export function notSent(session: Immutable<Session>, message: Immutable<Message>): NotSent | null {
  const input = cancelledInput(session, message);
  if (!input) return null;
  const cause = input.cancel_cause ?? 'owner', again = sentAgain(session, input);
  if (cause === 'owner_edit' && again) return null;
  const warning = input.attempts.length === 0
    ? 'Cancelled before it reached the agent' : 'Cancelled — the agent may already have seen it';
  const line = cause === 'owner_edit' ? `${notSentLine.owner_edit}. ${warning}`
    : cause === 'owner' || input.attempts.length > 0 ? warning : notSentLine[cause];
  return { input, line, again: cause === 'owner' ? false : again };
}

/**
 * True when an owner message counts as something the owner said to the agent: false for any message whose input ended
 * cancelled, whatever the cause (deleted, taken back to edit, archive, close) and whether or not it had earlier attempts.
 * Their saved choice and words remain visible with a cancellation label. Core's `waiting_unanswered` reads a cancelled
 * input the same way (queries/counts.rs).
 */
export const counted = (session: Immutable<Session>, message: Immutable<Message>): boolean => !cancelledInput(session, message);

/** What went wrong with a stopped delivery, in one plain sentence. */
export function recoveryProblem(attempt: Immutable<Attempt>, agent: string): string {
  if (attempt.result_state === 'committed') return `${agent} saved its answer, but the message wasn’t marked handled.`;
  if (attempt.acceptance === 'uncertain') return `Ariadne isn’t sure it reached ${agent}.`;
  if (attempt.turn_state === 'completed') return `${agent} finished without saving its answer.`;
  if (attempt.turn_state === 'failed' || attempt.turn_state === 'interrupted') return `${agent}’s turn stopped before it answered.`;
  if (attempt.acceptance === 'rejected') return `${agent} didn’t take it.`;
  return 'It needs your decision.';
}

/** The current, unsealed attempt of a stopped delivery: the one a decision applies to. */
export function stoppedAttempt(input: Immutable<Input>): Immutable<Attempt> | null {
  if (input.state !== 'needs_attention') return null;
  return input.attempts.find(value => value.id === input.active_attempt_id && value.sealed_at === null) ?? null;
}

const stuck = (kind: StuckKind, text: string, { resume = false, retry = false, settle = null }:
  Partial<Pick<Stuck, 'resume' | 'retry' | 'settle'>> = {}): Stuck => Object.freeze({ kind, text, resume, retry, settle });

/** Why `input` hasn't reached the agent; a `sent` note (Cancel only) while it is in flight; null once settled. */
export function stuckInput(session: Immutable<Session>, input: Immutable<Input>,
  presence: Immutable<PresenceObservation> | null = null, health: SupervisorHealth | null = null): Stuck | null {
  const binding = session.bindings[input.binding_id] ?? null, agent = binding ? agentName(binding.adapter_id) : 'the agent';
  if (input.state === 'needs_attention') {
    const attempt = stoppedAttempt(input), label = sentLabel(input);
    if (attempt?.result_state === 'committed') return stuck('decision', recoveryProblem(attempt, agent), { settle: 'accept_result' });
    const lead = label ? `Couldn’t deliver ${quoted(label)}.` : 'Couldn’t deliver your message.';
    return stuck('decision', `${lead} ${attempt ? recoveryProblem(attempt, agent) : 'It needs your decision.'}`,
      { retry: !!attempt, settle: attempt ? 'skip' : null });
  }
  // On its way: nothing to explain, but the owner can still call it back (core cancels in-flight inputs too).
  if (input.state === 'in_flight') return stuck('sent', '');
  if (input.state !== 'queued') return null;
  if (heldInput(session, input)) return stuck('held', 'The question changed — review and send again');
  const others = Object.values(session.inputs).filter((other): other is Immutable<Input> => !!other && other.binding_id === input.binding_id);
  // Only this binding generation's health speaks for it.
  const own = health && binding && health.binding_id === binding.id && health.generation === binding.generation ? health : null;
  const status = dispatchStatus({ binding, closed: session.state === 'closed', presence, health: own, agent,
    needsDecision: others.some(other => other.state === 'needs_attention') });
  if (status.kind === 'paused') return stuck('paused', 'Sending is paused — it goes out when you resume', { resume: status.action === 'resume' });
  if (status.kind === 'blocked' || status.kind === 'disconnected' || status.kind === 'closed' || status.kind === 'none') {
    return stuck('blocked', `Not sending: ${status.reason ?? status.label}`);
  }
  // FIFO per binding: the oldest earlier message still unsettled (held ones step aside).
  const ahead = others.filter(other => other.seq < input.seq && (other.state === 'in_flight' || other.state === 'needs_attention'
    || other.state === 'queued' && !heldInput(session, other))).sort((a, b) => a.seq - b.seq)[0];
  if (ahead) return stuck('behind', `Queued behind your message on ${quoted(inputAbout(ahead))}`);
  if (presence && presence.generation === binding?.generation && presence.freshness === 'fresh'
      && ['running', 'waiting_for_approval'].includes(presence.execution_state)) return stuck('busy', `Waiting for ${agent} to finish what it’s doing`);
  return stuck('waiting', `${agent} hasn’t picked it up yet`);
}
