// The Remove dialog copy of Ariadne.dc.html:1285-1316 (rmText), for each kind.
import type { ItemRoute, SessionRef } from '../../generated/core';

/** What a confirmed Remove asks the owner of the callback to remove. */
export type RemoveTarget =
  | { readonly kind: 'project'; readonly project_id: string }
  | { readonly kind: 'session'; readonly session: SessionRef }
  | { readonly kind: 'topic'; readonly session: SessionRef; readonly topic_id: string }
  | { readonly kind: 'item'; readonly item: ItemRoute };
/** Runs after the owner confirms a Remove dialog. Required wherever a Remove trigger renders. */
export type RemoveHandler = (target: RemoveTarget) => void;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const capital = (text: string) => text ? text.charAt(0).toUpperCase() + text.slice(1) : '';

export type RemoveKind = 'item' | 'topic' | 'session' | 'project';
export interface RemoveCopy {
  readonly title: string;
  readonly body: string;
  readonly confirm: string;
  readonly warn: string;
}

/** How the session's agent learns about an item or topic removal. */
export type RemoveTell = { readonly agent: string; readonly mode: 'tell' | 'queued' | 'closed' } | null;

function tellText(tell: RemoveTell, them: boolean): string {
  if (!tell) return '';
  const pronoun = them ? 'them' : 'it';
  if (tell.mode === 'tell') return ` ${tell.agent} is told, so it stops working on ${pronoun} and won’t bring ${pronoun} up again. The conversation so far doesn’t change. You have 5 seconds to undo before it’s told.`;
  if (tell.mode === 'queued') return ` ${tell.agent} isn’t running, so it’s told when it runs again. The conversation so far doesn’t change.`;
  return ` The session is closed, so ${tell.agent} isn’t told. The conversation doesn’t change.`;
}

function warning(waiting: number): string {
  return waiting ? `${plural(waiting, 'question')} waiting on you ${waiting === 1 ? 'goes' : 'go'} with it.` : '';
}

export type RemoveSubject =
  | { readonly kind: 'item'; readonly short: string; readonly items: number; readonly waiting: number; readonly tell: RemoveTell }
  | { readonly kind: 'topic'; readonly name: string; readonly items: number; readonly waiting: number; readonly tell: RemoveTell }
  | { readonly kind: 'session'; readonly agent: string; readonly when: string; readonly topics: number; readonly items: number;
    readonly shared: number; readonly waiting: number }
  | { readonly kind: 'project'; readonly name: string; readonly path: string; readonly sessions: number; readonly topics: number;
    readonly items: number; readonly waiting: number };

export function removeCopy(subject: RemoveSubject): RemoveCopy {
  const warn = warning(subject.waiting);
  if (subject.kind === 'item') {
    const below = subject.items - 1;
    return { title: `Remove “${capital(subject.short)}”?`, warn,
      body: (below > 0 ? `This item and the ${plural(below, 'item')} below it are removed from Ariadne.` : 'This item is removed from Ariadne.')
        + tellText(subject.tell, subject.items > 1),
      confirm: subject.items > 1 ? `Remove ${subject.items} items` : 'Remove item' };
  }
  if (subject.kind === 'topic') {
    return { title: `Remove the topic “${subject.name}”?`, warn, confirm: 'Remove topic',
      body: `The topic and its ${plural(subject.items, 'item')} are removed from Ariadne, in every session.${tellText(subject.tell, true)}` };
  }
  if (subject.kind === 'session') {
    const when = subject.when.toLowerCase();
    return { title: `Remove the ${subject.agent} session from ${when}?`, warn, confirm: 'Remove session',
      body: `Ariadne forgets this session${subject.topics ? ` and the ${plural(subject.topics, 'topic')} only it has (${plural(subject.items, 'item')})` : ''}.`
        + `${subject.shared ? ` ${plural(subject.shared, 'topic')} shared with other sessions ${subject.shared === 1 ? 'stays' : 'stay'}.` : ''}`
        + ' The session’s transcript on disk isn’t touched.' };
  }
  return { title: `Remove ${subject.name} from Ariadne?`, warn, confirm: 'Remove project',
    body: `Ariadne forgets the project, its ${plural(subject.sessions, 'session')}, ${plural(subject.topics, 'topic')} and ${plural(subject.items, 'item')}. `
      + `Nothing in ${subject.path} is touched; the project shows up again only if a new session starts there.` };
}
