import type { Item, Session } from '../generated/domain/models';
import type { Immutable } from '../data';
import { ownerReplied } from './waiting/replied';

/** Archiving ends delivery too; restoring alone does not reopen the session. */
export const sessionEnded = (session: Immutable<Session>): boolean => session.state === 'closed' || session.archived_at != null;
export const closedSessionQuestion = (session: Immutable<Session>, item: Immutable<Item>): boolean =>
  sessionEnded(session) && item.status === 'waiting_on_me' && !ownerReplied(session, item);
export const waitingOnOwner = (session: Immutable<Session>, item: Immutable<Item>): boolean =>
  !sessionEnded(session) && item.status === 'waiting_on_me' && !ownerReplied(session, item);

export const sessionClosedReason = 'This session is closed. Reopen it to answer.';
export const sessionAnswerBlocked = (session: Immutable<Session>): string => session.archived_at != null
  ? 'This session is archived. Restore it, then reopen it to answer.' : sessionClosedReason;
