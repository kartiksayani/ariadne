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
export function ownerReplied(session: Immutable<Session>, item: Immutable<Item>): boolean {
  if (item.status !== 'waiting_on_me') return false;
  const superseded = (answerId: string | null) => !!answerId && session.answers.some(newer => newer.supersedes_answer_id === answerId);
  const pending = Object.values(session.inputs).some(input => !!input && input.target.item_id === item.id && onItsWay.has(input.state)
    && input.payload.target_snapshot.question_revision === item.question_revision && !superseded(input.answer_id));
  return pending || session.answers.some(answer => answer.item_id === item.id && answer.question_revision === item.question_revision
    && !superseded(answer.id) && !needsOwner.has(session.inputs[answer.input_id]?.state ?? 'handled'));
}

export const displayStatus = (session: Immutable<Session>, item: Immutable<Item>): DisplayStatus =>
  ownerReplied(session, item) ? 'waiting_on_agent' : item.status;
