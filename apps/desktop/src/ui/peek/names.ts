import type { Immutable } from '../../data/session-store';
import type { Session } from '../../generated/domain/models';
import { itemRemoved } from '../../selectors/removed';
import { itemLabels } from '../shared/short';

const names = new WeakMap<Immutable<Session>, ReadonlyMap<string, string>>();
/** Immutable snapshots share one disambiguation pass across every reference chip. */
export function peekNames(session: Immutable<Session>): ReadonlyMap<string, string> {
  let labels = names.get(session);
  if (!labels) {
    labels = itemLabels(Object.values(session.items).flatMap(item => item && !itemRemoved(session, item.id) ? [item] : []), session.topics);
    names.set(session, labels);
  }
  return labels;
}
