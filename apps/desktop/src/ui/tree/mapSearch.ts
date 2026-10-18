// The Map's search, shared by the Tree, the Graph and the filter row (SPEC §6.9). TreeView owns it and provides it around
// both its rows and the Graph it hosts; the top bar gets the count, the arrows and the note through `MapSearchStatus`.
import { createContext, useContext } from 'react';
import type { MapMatch } from '../../selectors/tree/search';

export type { MapMatch, MatchField } from '../../selectors/tree/search';

export interface MapSearch {
  /** The search as typed, trimmed; '' while there is none. */
  readonly query: string;
  /** Its normalised words, for `hitSegments` (selectors/tree/search) or `segments(text, query)` (ui/tree/model). */
  readonly terms: readonly string[];
  /** The matches the Map shows, in Map order, one per field: the count "2 of 4" runs over these. */
  readonly matches: readonly MapMatch[];
  /** The items with a shown match: these get the highlight tint. */
  readonly ids: ReadonlySet<string>;
  /** The current match: the first until the owner steps, then the one stepped to. It gets the strong ring. */
  readonly current: MapMatch | null;
  /** Bumps on `step` only, never on typing: a view scrolls the current match into view when this changes. */
  readonly stepped: number;
  /** Matching items the Map does not show: in hidden items, and inside folded items or topics. */
  readonly hidden: number;
  readonly collapsed: number;
  /** Moves the current match and scrolls it into view. Selects nothing, opens nothing, marks nothing seen. */
  readonly step: (by: 1 | -1) => void;
  /** Shows the hidden and folded matches for this search, in memory; clearing the search folds them away again. */
  readonly showThem: () => void;
  /** Clears the search (as × or esc in the box). */
  readonly clear: () => void;
}

const none = () => {};
export const NO_SEARCH: MapSearch = Object.freeze({ query: '', terms: [], matches: [], ids: new Set<string>(), current: null, stepped: 0,
  hidden: 0, collapsed: 0, step: none, showThem: none, clear: none });

export const MapSearchContext = createContext<MapSearch>(NO_SEARCH);
/** The Map's search; the empty search outside a Map. */
export const useMapSearch = (): MapSearch => useContext(MapSearchContext);

/** What the top bar's search box shows while the Map has a search: null when there is none. */
export interface MapSearchStatus {
  /** "2 of 4" or "No matches". */
  readonly count: string;
  readonly onNext: () => void;
  readonly onPrev: () => void;
  /** "Also matching: 1 in a hidden item." with "Show them", while some matches do not show. */
  readonly note: { readonly text: string; readonly action: string; readonly onAction: () => void } | null;
}
