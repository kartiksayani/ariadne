// The dock's pure model: which questions it holds, their order, paths, ages and the "N sent" count.
import type { Immutable } from '../../data/session-store';
import type { Item, Session } from '../../generated/domain/models';
import { waitingOnOwner } from '../../selectors/waiting/rows';
import { itemRemoved } from '../../selectors/removed';
import { receiptWithdrawn, type OwnerDraftStore } from '../../state/drafts/store';
import type { DockQuestion } from '../../state/dock/store';
import { detailPath } from '../detail/model';
import { peekNames } from '../peek/names';
import { dayWord } from '../shell/model';
import type { ConnectionKind } from '../topbar/model';

export const dockQuestionId = (session: Immutable<Session>, itemId: string) => `${itemId}:${session.items[itemId]?.question_revision}`;

/**
 * The session's unsent waiting questions, oldest first (`waiting_since`, then the item number). The same eligibility as
 * the waiting counts (`waitingOnOwner`: waiting on me, not replied, topic and item present); an answer whose receipt is in
 * leaves at once, unless that answer was cancelled or skipped. `hide` drops items a pending removal hides, and the one Details answers.
 */
export function dockQuestions(session: Immutable<Session> | null | undefined, drafts: OwnerDraftStore, hide: (itemId: string) => boolean = () => false): DockQuestion[] {
  if (!session) return [];
  const route = { project_id: session.project_id, session_id: session.id };
  return Object.values(session.items).filter((item): item is Immutable<Item> => {
    if (!item || !waitingOnOwner(session, item) || itemRemoved(session, item.id) || hide(item.id)) return false;
    const entry = drafts.find(route, item.id, 'answer');
    const input = entry?.receipt?.data.kind === 'input_submit' ? session.inputs[entry.receipt.data.input_id] : null;
    // A failed answer (needs attention) stays in place with its delivery bar and Retry; a cancelled or skipped one is back.
    return !entry?.receipt || entry.draft.question_revision !== item.question_revision || receiptWithdrawn(entry, session) || input?.state === 'needs_attention';
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

/** The other-sessions list groups its questions by session, ordered by project and then session name (as the board lists them), not by who waited longest. */
export const compareOtherGroups = (a: { readonly project: string; readonly name: string }, b: { readonly project: string; readonly name: string }): number =>
  a.project.localeCompare(b.project) || a.name.localeCompare(b.name);

export interface PathPart { readonly label: string; readonly full: string; readonly itemId: string | null; readonly more?: boolean }

/** Topic and ancestors, as the board draws it: the question itself is the title below, not a segment. Past three parts: first, second, "…", last, unless `expanded`. */
export function dockPath(session: Immutable<Session>, itemId: string, expanded = false): PathPart[] {
  const names = peekNames(session), item = session.items[itemId], path = detailPath(session, itemId);
  if (!item || !path.length) return [];
  const topic = session.topics[item.topic_id];
  const name = (id: string) => ({ label: names.get(id) ?? session.items[id]?.question ?? '', full: session.items[id]?.question ?? '', itemId: id });
  const parts: PathPart[] = [...path.map(crumb => crumb.itemId === null
    ? { label: crumb.label ?? topic?.name ?? '', full: topic?.name ?? crumb.label ?? '', itemId: null }
    : name(crumb.itemId))];
  if (expanded || parts.length <= 3) return parts;
  return [parts[0]!, parts[1]!, { label: '…', full: 'Show the full path', itemId: null, more: true }, parts[parts.length - 1]!];
}

/** The dock line's chip while the connection is not live: where answers wait (SPEC 5.12, "Dock line"). The narrow label is the 900px one. */
export interface DockStateChip { readonly icon: string; readonly wide: string; readonly narrow: string }
const chips: Partial<Record<ConnectionKind, DockStateChip>> = {
  none: { icon: 'ph ph-plugs', wide: 'Answers wait here until an agent connects', narrow: 'Held here' },
  off: { icon: 'ph ph-hourglass', wide: 'Answers queue until it runs', narrow: 'Answers queue' },
  reconnect: { icon: 'ph ph-hourglass', wide: 'Answers wait until it’s back', narrow: 'Answers wait' },
  stale: { icon: 'ph ph-clock-counter-clockwise', wide: 'Answers wait until it can be read again', narrow: 'Answers wait' },
  // Unreadable with a last read still shown: its questions stay in the dock, and answers wait like a stale read's.
  unreadable: { icon: 'ph ph-clock-counter-clockwise', wide: 'Answers wait until it can be read again', narrow: 'Answers wait' },
};
export const dockStateChip = (kind: ConnectionKind): DockStateChip | null => chips[kind] ?? null;

/** "Read-only. 2 questions were waiting when this session closed." The count is the questions still marked waiting on me. */
export function closedLine(session: Immutable<Session> | null | undefined): string {
  const count = session ? Object.values(session.items).filter(item => item && item.status === 'waiting_on_me' && !itemRemoved(session, item.id)).length : 0;
  return count ? `Read-only. ${count} question${count === 1 ? ' was' : 's were'} waiting when this session closed.` : 'Read-only.';
}
