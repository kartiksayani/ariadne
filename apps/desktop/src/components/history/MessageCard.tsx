import type { Message } from '../../generated/domain/models';
import type { Immutable } from '../../data/session-store';

export function messageItems(message: Immutable<Message>): readonly string[] {
  return [...new Set([...(message.item_id === null ? [] : [message.item_id]), ...message.items_touched])];
}
