import type { Immutable } from '../data/session-store';
import type { Message, Session } from '../generated/domain/models';
import { itemRemoved } from './removed';

/** The same associations that make saved messages reachable in an item's conversation. */
export function inItemConversation(session: Immutable<Session>, message: Immutable<Message>): boolean {
  // Removed by agent retains conversation messages, but explicitly excludes lifecycle notices.
  const reachable = (id: string) => !!session.items[id] && (message.kind !== 'lifecycle' || !itemRemoved(session, id));
  return !!(message.item_id && reachable(message.item_id)) || message.items_touched.some(reachable)
    || Object.values(session.items).some(item => item && reachable(item.id) && (item.created_message_id === message.id || item.updated_message_ids.includes(message.id)))
    || Object.values(session.rounds).some(round => round && reachable(round.item_id) && (round.opened_message_id === message.id
      || round.agent_message_ids.includes(message.id) || round.owner_message_ids.includes(message.id)));
}
