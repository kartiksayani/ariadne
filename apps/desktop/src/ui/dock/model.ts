// The dock's pure model: which questions it holds, their order, paths, ages and the "N sent" count.
import type { Immutable } from '../../data/session-store';
import type { Item, Session } from '../../generated/domain/models';
import { waitingOnOwner } from '../../selectors/waiting/rows';
import { itemRemoved } from '../../selectors/removed';
import type { OwnerDraftStore } from '../../state/drafts/store';
import type { DockQuestion } from '../../state/dock/store';
import { detailPath } from '../detail/model';
import { peekNames } from '../peek/names';
import { dayWord } from '../shell/model';

export const dockQuestionId = (session: Immutable<Session>, itemId: string) => `${itemId}:${session.items[itemId]?.question_revision}`;

/**
 * The session's unsent waiting questions, oldest first (`waiting_since`, then the item number). The same eligibility as
 * the waiting counts (`waitingOnOwner`: waiting on me, not replied, topic and item present); an answer whose receipt is in
 * leaves at once, unless that answer was cancelled. `hide` drops items a pending removal hides, and the one Details answers.
 */
export function dockQuestions(session: Immutable<Session> | null | undefined, drafts: OwnerDraftStore, hide: (itemId: string) => boolean = () => false): DockQuestion[] {
  if (!session) return [];
  const route = { project_id: session.project_id, session_id: session.id };
  return Object.values(session.items).filter((item): item is Immutable<Item> => {
    if (!item || !waitingOnOwner(session, item) || itemRemoved(session, item.id) || hide(item.id)) return false;
    const entry = drafts.find(route, item.id, 'answer');
    const input = entry?.receipt?.data.kind === 'input_submit' ? session.inputs[entry.receipt.data.input_id] : null;
    // A failed answer (needs attention) stays in place with its delivery bar and Retry.
    return !entry?.receipt || entry.draft.question_revision !== item.question_revision || input?.state === 'cancelled' || input?.state === 'needs_attention';
  }).sort((a, b) => (a.waiting_since ?? '').localeCompare(b.waiting_since ?? '') || a.id.localeCompare(b.id, undefined, { numeric: true }))
    .map(item => ({ id: dockQuestionId(session, item.id), itemId: item.id, question: item.question }));
}

/**
 * "N sent": answers sent and not yet picked up — saved inputs still `queued`, plus receipts the session read does not
 * show yet. A claim (in flight) is a pick-up; a failed one is not "sent".
 */
export function sentWaiting(session: Immutable<Session> | null | undefined, drafts: OwnerDraftStore): string[] {
  if (!session) return [];
  const route = { project_id: session.project_id, session_id: session.id };
  const ids = new Set(Object.values(session.inputs).filter(input => input?.kind === 'answer' && input.state === 'queued').map(input => input!.id));
  for (const entry of Object.values(drafts.getSnapshot().entries)) {
    if (entry.draft.intent !== 'answer' || entry.draft.session.project_id !== route.project_id || entry.draft.session.session_id !== route.session_id) continue;
    if (entry.receipt?.data.kind === 'input_submit' && !session.inputs[entry.receipt.data.input_id]) ids.add(entry.receipt.data.input_id);
  }
  return [...ids];
}

/** "34 min", "1 h 4 min", "since yesterday". */
export function waitingAge(at: number, now: number): string {
  const day = dayWord(at, now);
  if (day) return `since ${day === 'Yesterday' ? 'yesterday' : day}`;
  const minutes = Math.max(1, Math.floor((now - at) / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export interface PathPart { readonly label: string; readonly full: string; readonly itemId: string | null; readonly more?: boolean }

/** Topic and ancestors. Past three levels: first, second, "…", last, unless `expanded`. */
export function dockPath(session: Immutable<Session>, itemId: string, expanded = false): PathPart[] {
  const names = peekNames(session), item = session.items[itemId];
  const topic = item ? session.topics[item.topic_id] : undefined;
  const parts: PathPart[] = detailPath(session, itemId).map(crumb => crumb.itemId === null
    ? { label: crumb.label ?? topic?.name ?? '', full: topic?.name ?? crumb.label ?? '', itemId: null }
    : { label: names.get(crumb.itemId) ?? session.items[crumb.itemId]?.question ?? '', full: session.items[crumb.itemId]?.question ?? '', itemId: crumb.itemId });
  if (expanded || parts.length <= 3) return parts;
  return [parts[0]!, parts[1]!, { label: '…', full: 'Show the full path', itemId: null, more: true }, parts[parts.length - 1]!];
}
