import { useState } from 'react';
import type { Immutable } from '../../data/session-store';
import type { Item } from '../../generated/domain/models';
import { isChangedSinceRead, isNewToOwner, type SeenState } from '../../selectors/changes/seen';
import type { MarkerKind } from './ChangeMarker';

const markerOf = (item: Immutable<Item>, seen: SeenState): 'new' | 'changed' | null =>
  isNewToOwner(item, seen) ? 'new' : isChangedSinceRead(item, seen) ? 'changed' : null;

/**
 * The marker in Details' badge row (SPEC 9.10): New or Changed while the item is unseen, and "Seen" for the rest of this
 * visit once the 1 s dwell or Mark seen clears it. A change that arrives later brings the marker back. Details remounts per
 * item, so the opening state is this visit's.
 */
export function useDetailMarker(item: Immutable<Item> | null | undefined, seen: SeenState): MarkerKind | null {
  const [opening] = useState(() => item ? markerOf(item, seen) : null);
  const now = item ? markerOf(item, seen) : null;
  return now ?? (opening ? 'seen' : null);
}
