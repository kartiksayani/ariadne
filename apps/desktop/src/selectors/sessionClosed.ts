import type { Item, Session } from '../generated/domain/models';
import type { Immutable } from '../data';
import { ownerReplied } from './waiting/replied';

/** Archiving ends delivery too; restoring alone does not reopen the session. */
export const sessionEnded = (session: Immutable<Session>): boolean => session.state === 'closed' || session.archived_at != null;
export const closedSessionQuestion = (session: Immutable<Session>, item: Immutable<Item>): boolean =>
  sessionEnded(session) && item.status === 'waiting_on_me';
export const waitingOnOwner = (session: Immutable<Session>, item: Immutable<Item>): boolean =>
  !sessionEnded(session) && item.status === 'waiting_on_me' && !ownerReplied(session, item);

export const sessionClosedReason = 'The agent session that asked this has ended. Your answer would not be delivered.';
