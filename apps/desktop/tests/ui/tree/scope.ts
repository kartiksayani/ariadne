// The Graph's rows take a FilterScope (D17). Tests that pose a session, a saved view and the Later set keep their shape.
import type { SessionPreferences } from '../../../src/generated/core';
import type { Session } from '../../../src/generated/domain/models';
import type { Immutable } from '../../../src/data';
import type { LocalChip } from '../../../src/selectors/tree/filter';
import { sentenceRows as rowsOf } from '../../../src/selectors/tree/rows';

export function sentenceRows(session: Immutable<Session>, view: Immutable<SessionPreferences>, later: ReadonlySet<string>,
  temporaryAncestors: readonly string[] = [], revealedItemId: string | null = null, filterCollapsedItemIds: ReadonlySet<string> = new Set(),
  local: readonly LocalChip[] = []) {
  return rowsOf({ session, view, later, local }, temporaryAncestors, revealedItemId, filterCollapsedItemIds);
}
