// The Map's one filter (D14, D15, D17): the saved status chips plus the local chips, with the saved owners, archived and
// hide-later scope around them. The Tree and the Graph both read it through a FilterScope, so they never disagree.
import type { Item, ItemOwner, ItemStatus, Session } from '../../generated/domain/models';
import type { SessionPreferences } from '../../generated/core';
import type { Immutable } from '../../data';
import { activeItems } from '../removed';
import { ackTarget } from '../ack';
import { waitingOnOwner } from '../sessionClosed';
import { displayStatus } from '../waiting/replied';
import { hiddenItems } from '../../ui/tree/hidden';
import type { TreeFilter } from '../../ui/tree/model';
import { FILTER_STATUSES, hasStatusFilter } from './folds';
import { isBlocked } from './blocked';

export function sameOwner(left: Immutable<ItemOwner>, right: Immutable<ItemOwner>): boolean {
  return left.kind === right.kind && (left.kind === 'me' || (left.kind === 'agent' && right.kind === 'agent'
    && left.binding_id === right.binding_id) || (left.kind === 'other' && right.kind === 'other' && left.name === right.name));
}

export type Chip = 'waiting' | 'toack' | 'open' | 'progress' | 'sent' | 'blocked' | 'decided' | 'done' | 'later' | 'replaced';
export type LocalChip = 'toack' | 'sent' | 'blocked' | 'later';
export type FilterScope = {
  readonly session: Immutable<Session>; readonly view: Immutable<SessionPreferences>;
  readonly later: ReadonlySet<string>; readonly local: readonly LocalChip[];
};

/** Board order (D14). */
export const CHIP_ORDER: readonly Chip[] = ['waiting', 'toack', 'open', 'progress', 'sent', 'blocked', 'decided', 'done', 'later', 'replaced'];
export const LOCAL_CHIPS: readonly LocalChip[] = ['toack', 'sent', 'blocked', 'later'];
/** The saved status each saved chip stands for; the local chips have none. `dropped` has no chip. */
const SAVED: Readonly<Partial<Record<Chip, ItemStatus>>> = {
  waiting: 'waiting_on_me', open: 'open', progress: 'in_progress', decided: 'decided', done: 'done', replaced: 'replaced',
};
export const isLocalChip = (chip: Chip): chip is LocalChip => (LOCAL_CHIPS as readonly string[]).includes(chip);

/** The chips the saved statuses stand for; an empty or complete set is no filter at all. */
export function savedChips(statuses: readonly ItemStatus[]): readonly Chip[] {
  if (!hasStatusFilter(statuses)) return [];
  return CHIP_ORDER.filter(chip => { const status = SAVED[chip]; return !!status && statuses.includes(status); });
}

/** Every picked chip, saved or local, in board order. */
export function pickedChips(scope: FilterScope): readonly Chip[] {
  const saved = savedChips(scope.view.filters.statuses);
  return CHIP_ORDER.filter(chip => saved.includes(chip) || (isLocalChip(chip) && scope.local.includes(chip)));
}

/** Pick or drop one saved chip without changing the saved shape. Dropping the last one saves no filter. A legacy `dropped`
 * stays until Clear. */
export function toggleSavedChip(statuses: readonly ItemStatus[], chip: Chip): ItemStatus[] {
  const status = SAVED[chip];
  if (!status) return [...statuses];
  const next = new Set(hasStatusFilter(statuses) ? statuses : []);
  if (next.has(status)) next.delete(status); else next.add(status);
  const ordered = FILTER_STATUSES.filter(value => next.has(value));
  return ordered.length === FILTER_STATUSES.length ? [] : ordered;
}

export function toggleLocalChip(local: readonly LocalChip[], chip: LocalChip): LocalChip[] {
  return local.includes(chip) ? local.filter(value => value !== chip) : LOCAL_CHIPS.filter(value => value === chip || local.includes(value));
}

const inProgress = (display: ReturnType<typeof displayStatus>, item: Immutable<Item>) =>
  (item.status === 'in_progress' && display !== 'sent') || display === 'queued';

/** Each chip is its own predicate (D14). */
function predicate(scope: FilterScope, chip: Chip): (item: Immutable<Item>) => boolean {
  const { session, later } = scope;
  switch (chip) {
    case 'waiting': return item => waitingOnOwner(session, item);
    case 'toack': return item => !!ackTarget(session, item);
    case 'open': return item => displayStatus(session, item) === 'open';
    case 'progress': return item => inProgress(displayStatus(session, item), item);
    case 'sent': return item => displayStatus(session, item) === 'sent';
    case 'blocked': return item => isBlocked(session, item);
    case 'decided': return item => displayStatus(session, item) === 'decided';
    case 'done': return item => displayStatus(session, item) === 'done';
    case 'later': return item => later.has(item.id);
    case 'replaced': return item => displayStatus(session, item) === 'replaced';
  }
}

const sameOwners = (owners: readonly Immutable<ItemOwner>[], item: Immutable<Item>) => !owners.length || owners.some(owner => sameOwner(owner, item.owner));

/** Today's scope outside the chips: the saved owners and hide-later. */
const inside = (scope: FilterScope, item: Immutable<Item>) =>
  sameOwners(scope.view.filters.owners, item) && !(scope.view.filters.hide_later && scope.later.has(item.id));

/** The live items of the shown topics (archived or not). */
function shownItems(scope: FilterScope): readonly Immutable<Item>[] {
  const { session, view } = scope;
  return activeItems(session).filter(item => {
    const topic = session.topics[item.topic_id];
    return !!topic && !topic.removed_at && (view.filters.archived ? topic.archived_at !== null : topic.archived_at === null);
  });
}
const hiddenOf = (scope: FilterScope) => hiddenItems(scope.session, new Set(scope.view.hidden_item_ids ?? []));

/** "Showing N of M items": the matching items over every item of the shown topics, hidden items left out of both. */
export function summaryCounts(scope: FilterScope): { readonly shown: number; readonly total: number } {
  const hidden = hiddenOf(scope), filter = filterOf(scope), live = shownItems(scope).filter(item => !hidden.has(item.id));
  return { shown: live.filter(item => filter.matches(item)).length, total: live.length };
}

/** Counts inside today's scope; hidden items are left out, except in Waiting on me, which never loses a question (D14). */
export function chipCounts(scope: FilterScope): Record<Chip, number> {
  const hidden = hiddenOf(scope);
  const items = shownItems(scope).filter(item => inside(scope, item)), counts = {} as Record<Chip, number>;
  for (const chip of CHIP_ORDER) {
    const test = predicate(scope, chip);
    counts[chip] = items.filter(item => (chip === 'waiting' || !hidden.has(item.id)) && test(item)).length;
  }
  return counts;
}

/** The scope's filter: picked chips combine with OR; nothing picked matches everything inside the owners and hide-later. */
export function filterOf(scope: FilterScope): TreeFilter {
  const { owners, hide_later: hideLater } = scope.view.filters;
  const picked = pickedChips(scope), saved = scope.view.filters.statuses, tests = picked.map(chip => predicate(scope, chip));
  // A legacy saved `dropped` still matches (D14); Clear removes it.
  const dropped = hasStatusFilter(saved) && saved.includes('dropped');
  return {
    active: tests.length > 0 || dropped || owners.length > 0 || hideLater,
    matches: item => inside(scope, item)
      && (!tests.length && !dropped || tests.some(test => test(item)) || dropped && displayStatus(scope.session, item) === 'dropped'),
  };
}

/** Only visible filters scope temporary folds; the retired saved topic filter is ignored, and so is the search, which
 * never scopes rows (SPEC §6.9): folding while searching is an ordinary fold. */
export function filterSignature(scope: Pick<FilterScope, 'view' | 'local'>): string {
  const { statuses, owners, hide_later: hideLater, archived } = scope.view.filters;
  return JSON.stringify([hasStatusFilter(statuses) ? [...new Set(statuses)].sort() : [], owners.map(owner => JSON.stringify(owner)).sort(),
    hideLater, archived, [...new Set(scope.local)].sort()]);
}

// ---------------------------------------------------------------- local chips (D15)

export const LOCAL_CHIPS_KEY = 'ariadne.map.filter.v1';
const SESSIONS_KEPT = 50;

function read(): Map<string, LocalChip[]> {
  const map = new Map<string, LocalChip[]>();
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LOCAL_CHIPS_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return map;
    for (const [session, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      const chips = LOCAL_CHIPS.filter(chip => value.includes(chip));
      if (chips.length) map.set(session, chips);
    }
  } catch { return new Map(); }
  return map;
}

/** The local chips picked in this session; anything unreadable is an empty pick. */
export function loadLocalChips(sessionId: string): LocalChip[] {
  return [...read().get(sessionId) ?? []];
}

/** Keeps the 50 most recently changed sessions. Storage that refuses the write loses only this preference. */
export function saveLocalChips(sessionId: string, chips: readonly LocalChip[]): void {
  const map = read();
  map.delete(sessionId);
  const valid = LOCAL_CHIPS.filter(chip => chips.includes(chip));
  if (valid.length) map.set(sessionId, valid);
  const kept = [...map].slice(-SESSIONS_KEPT);
  try { localStorage.setItem(LOCAL_CHIPS_KEY, JSON.stringify(Object.fromEntries(kept))); } catch { /* the pick lasts until reload */ }
}
