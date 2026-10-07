// The view of one message for both Message Excerpt variants (handoff README
// Components; Message Excerpt.dc.html): number, author, day and time, body.
import type { Immutable } from '../../data/session-store';
import type { Message } from '../../generated/domain/models';
import { clock, dayWord } from '../shell/model';

export interface ExcerptView {
  /** "#18". */
  readonly number: string;
  readonly author: 'me' | 'agent' | 'system';
  /** "You", "Agent" or "System". */
  readonly who: string;
  readonly icon: string;
  /** "15:04", or "Yesterday 17:18" before today. */
  readonly when: string;
  readonly body: string;
}

/** How a timeline entry relates to the item: where it was raised, updated, or its parent's origin. */
export type Mark = 'created' | 'updated' | 'origin';

export function excerptView(message: Immutable<Message>, now: number): ExcerptView {
  const at = Date.parse(message.created_at), day = Number.isNaN(at) ? '' : dayWord(at, now);
  const time = Number.isNaN(at) ? '' : clock(at);
  const author = message.author === 'owner' ? 'me' : message.author === 'agent' ? 'agent' : 'system';
  return {
    number: `#${message.number}`, author,
    who: author === 'me' ? 'You' : author === 'agent' ? 'Agent' : 'System',
    icon: author === 'me' ? 'ph ph-user' : author === 'agent' ? 'ph ph-robot' : 'ph ph-info',
    when: day ? `${day} ${time}` : time,
    body: message.body,
  };
}
