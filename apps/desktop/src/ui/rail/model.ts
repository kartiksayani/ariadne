// View model for the message rail, from Ariadne.dc.html renderVals (2193-2205)
// and the rail variant of Message Excerpt.dc.html.
import type { Immutable } from '../../data/session-store';
import type { Message } from '../../generated/domain/models';
import { clock, dayWord } from '../shell/model';

export interface ExcerptView {
  readonly number: string;
  readonly who: string;
  readonly icon: string;
  readonly when: string;
}

export function messageExcerpt(message: Immutable<Message>, now: number): ExcerptView {
  const at = Date.parse(message.created_at), day = Number.isNaN(at) ? '' : dayWord(at, now);
  const time = Number.isNaN(at) ? '' : clock(at);
  const who = message.author === 'owner' ? 'You' : message.author === 'agent' ? 'Agent' : 'System';
  return {
    number: `#${message.number}`, who,
    icon: message.author === 'owner' ? 'ph ph-user' : message.author === 'agent' ? 'ph ph-robot' : 'ph ph-info',
    when: day ? `${day} ${time}` : time,
  };
}

export function followButton(following: boolean): { readonly text: string; readonly icon: string; readonly color: string } {
  return following
    ? { text: 'Following latest', icon: 'ph ph-arrow-line-down', color: 'var(--a-acc-text)' }
    : { text: 'Follow latest', icon: 'ph ph-arrow-down', color: 'color-mix(in srgb, var(--color-text) 66%, transparent)' };
}

export const jumpText = (count: number) => `${count} new message${count > 1 ? 's' : ''} · Jump to latest`;
