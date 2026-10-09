import type { SessionRef } from '../../generated/core';
import type { Input, Session } from '../../generated/domain/models';
import type { Immutable } from '../../data';

const terminal = new Set(['decided', 'done', 'dropped', 'replaced']);
const pending = new Set(['queued', 'in_flight', 'needs_attention']);

/**
 * What archiving a topic touches (ADR-0090): its open items stay as they are; the owner's
 * messages on it that haven't reached the agent (queued or failed) and those being
 * delivered (in flight) are cancelled.
 */
export interface ArchiveImpact { readonly open: number; readonly unsent: number; readonly delivering: number }
export function archiveImpact(session: Immutable<Session>, topicId: string): ArchiveImpact {
  const inputs = Object.values(session.inputs).filter(input => input?.target.topic_id === topicId && pending.has(input.state));
  return { open: Object.values(session.items).filter(item => item?.topic_id === topicId && !terminal.has(item.status)).length,
    unsent: inputs.filter(input => input?.state !== 'in_flight').length,
    delivering: inputs.filter(input => input?.state === 'in_flight').length };
}
/**
 * "3 open items stay as they are. 2 of your messages haven’t reached codex yet; archiving cancels them.
 * You can restore it any time." Sentences that don't apply are dropped; null when nothing applies.
 */
export function archiveWarning({ open, unsent, delivering }: ArchiveImpact, agent: string): string | null {
  const items = open ? `${open} open item${open === 1 ? ' stays as it is' : 's stay as they are'}.` : '';
  const sent = unsent ? `${unsent} of your messages ${unsent === 1 ? 'hasn’t' : 'haven’t'} reached ${agent} yet` : '';
  const being = !delivering ? '' : `${delivering}${sent ? '' : ' of your messages'} ${delivering === 1 ? 'is' : 'are'} being delivered${sent ? '' : ` to ${agent}`}`;
  const messages = [sent, being].filter(Boolean).join(' and ');
  if (!items && !messages) return null;
  const them = unsent + delivering === 1 ? 'it' : 'them';
  return [items, messages && `${messages}; archiving cancels ${them}.`, 'You can restore it any time.'].filter(Boolean).join(' ');
}

/** A saved domain result is handled by Close, rather than cancelled. */
export function cancellableInput(input: Immutable<Input>): boolean {
  return pending.has(input.state) && !input.attempts.some(attempt =>
    attempt.sealed_at == null && attempt.result_state === 'committed' && attempt.domain_result != null);
}

/**
 * What closing the session leaves behind: open questions stay; the owner's messages that haven't
 * reached the agent (queued or failed) and those being delivered (in flight) are cancelled.
 */
export interface CloseImpact { readonly questions: number; readonly unsent: number; readonly delivering: number }
export function closeImpact(session: Immutable<Session>): CloseImpact {
  const inputs = Object.values(session.inputs).filter(input => input && cancellableInput(input));
  return { questions: Object.values(session.items).filter(item => item?.status === 'waiting_on_me').length,
    unsent: inputs.filter(input => input && pending.has(input.state) && input.state !== 'in_flight').length,
    delivering: inputs.filter(input => input?.state === 'in_flight').length };
}
/** "1 question is still open, 2 of your messages haven’t reached codex and 1 is being delivered — closing cancels those messages." */
export function closeWarning({ questions, unsent, delivering }: CloseImpact, agent: string, action: 'closing' | 'archiving' = 'closing'): string | null {
  const waiting = action === 'archiving' && questions ? `${questions} question${questions === 1 ? ' is' : 's are'} waiting for your answer; ${questions === 1 ? 'it leaves' : 'they leave'} Waiting until you restore the session.` : '';
  const open = action === 'archiving' ? '' : questions ? `${questions} question${questions === 1 ? ' is' : 's are'} still open` : '';
  const sent = unsent ? `${unsent} of your messages ${unsent === 1 ? 'hasn’t' : 'haven’t'} reached ${agent}` : '';
  const being = !delivering ? '' : `${delivering}${sent ? '' : ' of your messages'} ${delivering === 1 ? 'is' : 'are'} being delivered${sent ? '' : ` to ${agent}`}`;
  const parts = [open, sent, being].filter(Boolean), messages = unsent + delivering;
  if (!parts.length) return waiting || null;
  const said = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  if (!messages) return `${said} — ${questions === 1 ? 'it stays' : 'they stay'} in the closed session.`;
  const them = open ? (messages === 1 ? 'that message' : 'those messages') : messages === 1 ? 'it' : 'them';
  return [waiting, `${said} — ${action} cancels ${them}.`].filter(Boolean).join(' ');
}
export function sameRoute(left: Immutable<SessionRef>, right: Immutable<SessionRef>): boolean {
  return left.project_id === right.project_id && left.session_id === right.session_id;
}
