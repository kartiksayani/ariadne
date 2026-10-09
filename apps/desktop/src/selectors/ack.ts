import type { Item, Session } from '../generated/domain/models';
import type { Immutable } from '../data/session-store';
import { currentQuestionReplied } from './waiting/replied';

/** Ack closes the item locally, only once its current question no longer needs the owner. */
export function ackTarget(session: Immutable<Session>, item: Immutable<Item>) {
  return session.archived_at == null && (item.status === 'open' || item.status === 'in_progress') && item.ack_to
    && !(item.ask?.trim() && !currentQuestionReplied(session, item)) ? item.ack_to : null;
}
