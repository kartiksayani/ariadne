// "Waiting on agent": a question the owner already replied to is the agent's
// turn, not the owner's. It reads Waiting on agent (row badge, detail header,
// filter chips and counts) until the agent acts on the reply, and it leaves the
// "Waiting on me" queue and counts.
import type { Item, ItemStatus, Session } from '../../generated/domain/models';
import type { Immutable } from '../../data';

/** The status the owner sees: the item's status, or Waiting on agent once the owner replied. */
export type DisplayStatus = ItemStatus | 'waiting_on_agent';

// Still on its way to the agent. A failed delivery (needs_attention), a cancelled
// or a skipped input needs the owner again, so it never counts as a reply.
const onItsWay = new Set(['queued', 'in_flight']);
const needsOwner = new Set(['cancelled', 'skipped', 'needs_attention']);

/**
 * True when the item waits on the owner but the owner already sent something to
 * its current question (answer, reply, note, drop...) that is on its way, or an
 * answer to it stands (the agent has not opened a new round yet). Mirrors core's
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
  const pending = Object.values(session.inputs).some(input => !!input && input.target.item_id === item.id && onItsWay.has(input.state)
    && questionRevisions.has(input.payload.target_snapshot.question_revision ?? -1) && !superseded(input.answer_id));
  return pending || session.answers.some(answer => answer.item_id === item.id && questionRevisions.has(answer.question_revision)
    && !superseded(answer.id) && !needsOwner.has(session.inputs[answer.input_id]?.state ?? 'handled'));
}

export const ownerReplied = (session: Immutable<Session>, item: Immutable<Item>): boolean =>
  item.status === 'waiting_on_me' && currentQuestionReplied(session, item);

export const displayStatus = (session: Immutable<Session>, item: Immutable<Item>): DisplayStatus =>
  ownerReplied(session, item) ? 'waiting_on_agent' : item.status;
