// An answered question leaves the owner's queue. Its delivery evidence tells
// whether the reply is still queued locally or has been sent to the agent.
import type { Item, ItemStatus, Session } from '../../generated/domain/models';
import type { Immutable } from '../../data';
import { deliveryEvidence } from './delivery';

/** Local delivery projections never change the persisted item status. */
export type DisplayStatus = ItemStatus | 'sent' | 'queued';

// Handled replies count for Open/InProgress Ack items, never a still-waiting ask.
// A handled Bring/Reopen requests an ask; it does not answer that ask.
// Failed delivery (needs_attention), cancelled and skipped inputs need the owner again.
const replyKinds = new Set(['answer', 'reply', 'note', 'followup', 'drop']);
const needsOwner = new Set(['cancelled', 'skipped', 'needs_attention']);

/**
 * True when the item waits on the owner but the owner already sent something to
 * its current question (answer, reply, note, drop...) that is on its way,
 * or an answer to it stands (the agent has not opened a new round yet). Mirrors core's
 * `waiting_unanswered`, so every count agrees.
 */
export function currentQuestionReplied(session: Immutable<Session>, item: Immutable<Item>): boolean {
  const canRetain = item.status === 'open' || item.status === 'in_progress';
  const round = !canRetain ? null : item.current_round_id ? session.rounds[item.current_round_id]
    : Object.values(session.rounds).filter(round => round?.item_id === item.id).sort((a, b) => b!.ordinal - a!.ordinal)[0];
  // Leaving Waiting advances the item revision while preserving the answered round's question.
  // A genuinely revised question or ask uses the item's new episode instead.
  const retained = !!round && item.question_revision === round.question_revision + 1
    && item.question === round.question_snapshot && item.ask === round.ask_snapshot
    && item.options.length === round.options_snapshot.length && item.options.every((option, index) => {
      const previous = round.options_snapshot[index];
      return option.id === previous.id && option.label === previous.label && option.consequence === previous.consequence
        && option.recommended === previous.recommended;
    });
  const questionRevisions = new Set([item.question_revision, ...retained ? [round.question_revision] : []]);
  const superseded = (answerId: string | null) => !!answerId && session.answers.some(newer => newer.supersedes_answer_id === answerId);
  const pending = Object.values(session.inputs).some(input => !!input && input.target.item_id === item.id
    && (input.state === 'queued' || input.state === 'in_flight' || canRetain && input.state === 'handled' && replyKinds.has(input.kind))
    && questionRevisions.has(input.payload.target_snapshot.question_revision ?? -1) && !superseded(input.answer_id));
  return pending || session.answers.some(answer => answer.item_id === item.id && questionRevisions.has(answer.question_revision)
    && !superseded(answer.id) && !needsOwner.has(session.inputs[answer.input_id]?.state ?? 'handled'));
}

export const ownerReplied = (session: Immutable<Session>, item: Immutable<Item>): boolean =>
  item.status === 'waiting_on_me' && currentQuestionReplied(session, item);

export function displayStatus(session: Immutable<Session>, item: Immutable<Item>): DisplayStatus {
  if (!ownerReplied(session, item)) return item.status;
  const input = Object.values(session.inputs).filter(input => !!input && input.target.item_id === item.id
    && (input.state === 'queued' || input.state === 'in_flight')
    && input.payload.target_snapshot.question_revision === item.question_revision
    && (!input.answer_id || !session.answers.some(answer => answer.supersedes_answer_id === input.answer_id)))
    .sort((a, b) => b!.seq - a!.seq)[0];
  // A standing answer remains Sent until the agent changes the item itself.
  if (!input) return 'sent';
  const binding = session.bindings[input.binding_id];
  const evidence = deliveryEvidence(input, binding ? { ...binding, presence: null } : null, session.operation_receipts);
  return ['sending', 'sent', 'received', 'published', 'waiting_result'].includes(evidence.kind) ? 'sent' : 'queued';
}
