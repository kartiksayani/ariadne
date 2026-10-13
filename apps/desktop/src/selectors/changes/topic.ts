import type { Immutable } from '../../data/session-store';
import type { Session } from '../../generated/domain/models';
import { activeItems } from '../removed';
import { changeRow, groupChanges, type ChangeGroups, type ChangeRow } from './card';
import { changeTreeOrder, type SeenState } from './seen';
import { waitingOnOwner } from '../sessionClosed';

export interface SinceYouWereHere {
  readonly baseline: string | null;
  readonly groups: ChangeGroups;
  readonly briefChanged: boolean;
  readonly changeCount: number;
  readonly longAbsence: boolean;
}

/** Topic catch-up time is distinct from reading individual items. */
export function sinceYouWereHere(session: Immutable<Session>, topicId: string, seen: SeenState,
  now: number = Date.now()): SinceYouWereHere {
  const baseline = seen ? seen.topics.find(topic => topic.topic_id === topicId)?.at ?? seen.since : null;
  const at = baseline === null ? Infinity : Date.parse(baseline);
  const items = activeItems(session).filter(item => item.topic_id === topicId);
  const created = (item: typeof items[number]) => Date.parse(item.created_at) > at;
  const records = (item: typeof items[number]) => (item.changes ?? []).filter(change => !change.wording_only && Date.parse(change.at) > at);
  const groups = groupChanges(session, items, created, records);
  const changeCount = items.reduce((count, item) => count + Number(created(item)) + records(item).length, 0);
  const briefAt = session.topics[topicId]?.brief_updated_at;
  return Object.freeze({ baseline, groups, changeCount, briefChanged: !!briefAt && Date.parse(briefAt) > at,
    longAbsence: baseline !== null && (now - at > 2 * 24 * 60 * 60 * 1000 || changeCount >= 30) });
}

export interface BriefLists {
  readonly yourTurn: readonly ChangeRow[];
  readonly decided: readonly ChangeRow[];
  readonly replaced: readonly ChangeRow[];
}

/** Brief links describe the current topic in the same order as the full tree. */
export function briefLists(session: Immutable<Session>, topicId: string): BriefLists {
  const ordered = new Map(changeTreeOrder(session).map((id, index) => [id, index]));
  const items = activeItems(session).filter(item => item.topic_id === topicId)
    .sort((left, right) => (ordered.get(left.id) ?? left.ordinal) - (ordered.get(right.id) ?? right.ordinal));
  const rows = (select: (item: typeof items[number]) => boolean) => Object.freeze(items.filter(select).map(item => changeRow(session, item, [])));
  return Object.freeze({ yourTurn: rows(item => waitingOnOwner(session, item)),
    decided: rows(item => item.status === 'decided'), replaced: rows(item => item.status === 'replaced') });
}
