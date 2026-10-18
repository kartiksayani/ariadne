// The Remove dialog copy of Ariadne.dc.html:1285-1316 (rmText), for each kind.
import type { ItemRoute, SessionRef } from '../../generated/core';
import { sessionPhrase } from '../shell/model';

/** What a confirmed Remove asks the owner of the callback to remove. */
export type RemoveTarget =
  | { readonly kind: 'project'; readonly project_id: string }
  | { readonly kind: 'session'; readonly session: SessionRef }
  | { readonly kind: 'topic'; readonly session: SessionRef; readonly topic_id: string }
  | { readonly kind: 'item'; readonly item: ItemRoute };
/** Runs after the owner confirms a Remove dialog, with what the dialog showed. Required wherever a Remove trigger renders. */
export type RemoveHandler = (target: RemoveTarget, subject: RemoveSubject) => void;

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

function tellText(tell: RemoveTell, them: boolean, topic = false): string {
  if (!tell) return '';
  const pronoun = them ? 'them' : 'it';
  const conversation = topic ? '' : ' The conversation so far doesn’t change.', end = topic ? '; after that it can’t be undone.' : '.';
  if (tell.mode === 'tell') return ` ${tell.agent} is told, so it stops working on ${pronoun} and won’t bring ${pronoun} up again.${conversation} You have 5 seconds to undo before it’s told${end}`;
  if (tell.mode === 'queued') return ` ${tell.agent} isn’t running, so it’s told when it runs again.${conversation} You have 5 seconds to undo${end}`;
  return ` The session is closed, so ${tell.agent} isn’t told.${conversation} You have 5 seconds to undo${end}`;
}

/** What the owner's words in a removal are (E27), for the warning: how many haven't reached the agent, and whether any are listed. */
export interface RemoveWords { readonly pending: number; readonly any: boolean }
/**
 * The danger warning of dialogs 10.2 and 10.14: the questions that go unanswered, then the words. Every word is quoted
 * below it, so the warning only asks the owner to copy them first. Empty when nothing goes.
 */
export function removeWarning(subject: Extract<RemoveSubject, { kind: 'item' | 'topic' }>, words: RemoveWords): string {
  const waiting = subject.waiting;
  const questions = !waiting ? '' : `${plural(waiting, 'question')} waiting on you ${waiting === 1 ? 'goes' : 'go'} with it${subject.kind === 'topic' ? ', unanswered' : ''}.`;
  const agent = subject.tell?.agent ?? 'the agent';
  const messages = words.pending === 1 ? `1 of your messages hasn’t reached ${agent} yet; removing cancels it; copy your words below first.`
    : words.pending > 1 ? `${words.pending} of your messages haven’t reached ${agent} yet; removing cancels them; copy your words below first.`
    : words.any ? 'Your words below go with it; copy them first.' : '';
  return [questions, messages].filter(Boolean).join(' ');
}

/** Dialogs 10.2 (an item and what's below it) and 10.14 (a topic), Round 4 copy (SPEC §8 q5). */
export function removePlacedCopy(subject: Extract<RemoveSubject, { kind: 'item' | 'topic' }>, words: RemoveWords): RemoveCopy {
  const warn = removeWarning(subject, words);
  if (subject.kind === 'topic') {
    return { title: `Remove the “${subject.name}” topic?`, warn, confirm: 'Remove topic',
      body: `The topic and its ${plural(subject.items, 'item')} are removed from Ariadne, with its bin.${tellText(subject.tell, true, true)}` };
  }
  const below = subject.items - 1;
  return { title: `Remove “${capital(subject.short)}”?`, warn, confirm: subject.items > 1 ? `Remove ${subject.items} items` : 'Remove item',
    body: (below > 0 ? `This item and the ${plural(below, 'item')} below it are removed from Ariadne.` : 'This item is removed from Ariadne.')
      + tellText(subject.tell, subject.items > 1) };
}

/** The owner's queued messages in what is removed: they haven't reached `agent` yet, and removing cancels them. */
export interface RemoveUnsent { readonly count: number; readonly agent: string; readonly cancelled?: number }

function warning(waiting: number, unsent: RemoveUnsent | undefined): string {
  const questions = waiting ? `${plural(waiting, 'question')} waiting on you ${waiting === 1 ? 'goes' : 'go'} with it.` : '';
  const messages = !unsent?.count ? '' : unsent.count === 1 ? `1 of your messages hasn’t reached ${unsent.agent} yet; removing cancels it.`
    : `${unsent.count} of your messages haven’t reached ${unsent.agent} yet; removing cancels them.`;
  const cancelled = unsent?.cancelled ? `Your ${plural(unsent.cancelled, 'cancelled message')} ${unsent.cancelled === 1 ? 'is' : 'are'} deleted forever.` : '';
  return [questions, messages, cancelled].filter(Boolean).join(' ');
}

interface Unsent { readonly unsent?: RemoveUnsent }
export type RemoveSubject = Unsent & (
  | { readonly kind: 'item'; readonly short: string; readonly items: number; readonly waiting: number; readonly tell: RemoveTell; readonly removed?: boolean }
  | { readonly kind: 'topic'; readonly name: string; readonly items: number; readonly waiting: number; readonly tell: RemoveTell; readonly removed?: boolean }
  | { readonly kind: 'session'; readonly agent: string; readonly when: string; /** The owner's name for the session, when set. */ readonly name?: string | null;
    readonly topics: number; readonly items: number;
    readonly shared: number; readonly waiting: number }
  | { readonly kind: 'project'; readonly name: string; readonly path: string; readonly sessions: number; readonly topics: number;
    readonly items: number; readonly waiting: number });

export function removeCopy(subject: RemoveSubject): RemoveCopy {
  const warn = warning(subject.waiting, subject.unsent);
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
    return { title: `Remove ${sessionPhrase({ name: subject.name }, subject.agent, subject.when)}?`, warn, confirm: 'Remove session',
      body: `Ariadne forgets this session${subject.topics ? ` and the ${plural(subject.topics, 'topic')} only it has (${plural(subject.items, 'item')})` : ''}.`
        + `${subject.shared ? ` ${plural(subject.shared, 'topic')} shared with other sessions ${subject.shared === 1 ? 'stays' : 'stay'}.` : ''}`
        + ' The session’s transcript on disk isn’t touched.' };
  }
  return { title: `Remove ${subject.name} from Ariadne?`, warn, confirm: 'Remove project',
    body: `Ariadne forgets the project, its ${plural(subject.sessions, 'session')}, ${plural(subject.topics, 'topic')} and ${plural(subject.items, 'item')}. `
      + `Nothing in ${subject.path} is touched; the project shows up again only if a new session starts there.` };
}
