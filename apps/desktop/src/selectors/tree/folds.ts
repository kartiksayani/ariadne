import type { SessionPreferences } from '../../generated/core';
import type { Immutable } from '../../data';
import type { ItemStatus } from '../../generated/domain/models';
import type { DisplayStatus } from '../waiting/replied';

export const FILTER_STATUSES: readonly ItemStatus[] = ['waiting_on_me', 'open', 'in_progress', 'decided', 'done', 'dropped', 'replaced'];
export const hasStatusFilter = (statuses: readonly ItemStatus[]) => statuses.length > 0 && !FILTER_STATUSES.every(status => statuses.includes(status));
export const matchesStatus = (statuses: readonly ItemStatus[], status: DisplayStatus) =>
  !hasStatusFilter(statuses) || statuses.includes(status === 'waiting_on_agent' ? 'in_progress' : status);

/** Only visible filters scope temporary folds; the retired saved topic filter is ignored. */
export function filterSignature(filters: Immutable<SessionPreferences['filters']>, search = filters.search): string {
  return JSON.stringify([search.normalize('NFKC').toLowerCase().trim().split(/\s+/u).sort(),
    hasStatusFilter(filters.statuses) ? [...new Set(filters.statuses)].sort() : [], filters.owners.map(owner => JSON.stringify(owner)).sort(), filters.hide_later, filters.archived]);
}

/** Saved folds yield to matching descendants, until folded explicitly under this filter. */
export function matchExpansion(saved: readonly string[], temporary: readonly string[], ancestors: Iterable<string>,
  filtering: boolean, folded: ReadonlySet<string> = new Set()): Set<string> {
  const expanded = new Set([...saved, ...temporary]);
  if (filtering) for (const id of ancestors) if (!folded.has(id)) expanded.add(id);
  for (const id of folded) expanded.delete(id);
  return expanded;
}
