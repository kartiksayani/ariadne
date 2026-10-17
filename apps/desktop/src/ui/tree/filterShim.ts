// The Map's filter as the row model reads it. Until the filter piece supplies `filterOf`, this builds the same
// predicate from the saved filters: owners, Later and statuses. The model owns the scope (archived, hidden).
import type { Item, Session } from '../../generated/domain/models';
import type { SessionPreferences } from '../../generated/core';
import type { Immutable } from '../../data';
import { activeItems } from '../../selectors/removed';
import { sameOwner } from '../../selectors/tree/rows';
import { hasStatusFilter } from '../../selectors/tree/folds';
import { displayStatus, type DisplayStatus } from '../../selectors/waiting/replied';
import { waitingOnOwner } from '../../selectors/sessionClosed';
import { statusIn, type TreeFilter } from './model';

export function shimFilter(session: Immutable<Session>, view: Immutable<SessionPreferences>, later: ReadonlySet<string>): TreeFilter {
  const { statuses, owners, hide_later: hideLater } = view.filters, byStatus = hasStatusFilter(statuses);
  let shows: Map<string, DisplayStatus> | null = null;
  return {
    active: byStatus || owners.length > 0 || hideLater,
    matches: (item: Immutable<Item>) => {
      if (owners.length && !owners.some(owner => sameOwner(owner, item.owner))) return false;
      if (hideLater && later.has(item.id)) return false;
      if (!byStatus) return true;
      shows ??= new Map(activeItems(session).map(value => [value.id, displayStatus(session, value)]));
      const display = shows.get(item.id) ?? item.status;
      return (display !== 'waiting_on_me' || waitingOnOwner(session, item)) && statusIn(statuses, display);
    },
  };
}
