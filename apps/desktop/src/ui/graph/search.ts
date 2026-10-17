// Stand-in for the Tree core's MapSearch (ui/tree/mapSearch.ts on redesign/a20-t, ec6219f1): the same shape and names,
// so integration only re-points the imports at '../tree/mapSearch' and deletes this file.
import { createContext, useContext } from 'react';

export type MatchField = 'question' | 'outcome';
export interface MapMatch { readonly id: string; readonly field: MatchField }
export interface MapSearch {
  /** The search as typed, trimmed; '' while there is none. */
  readonly query: string;
  readonly terms: readonly string[];
  /** The matches the Map shows, in Map order, one per field. */
  readonly matches: readonly MapMatch[];
  /** The items with a shown match: the Graph tints these. */
  readonly ids: ReadonlySet<string>;
  /** The current match: the Graph rings it. */
  readonly current: MapMatch | null;
  /** Bumps on `step` only, never on typing: the Graph scrolls the current match into view and selects nothing. */
  readonly stepped: number;
  readonly hidden: number;
  readonly collapsed: number;
  readonly step: (by: 1 | -1) => void;
  readonly showThem: () => void;
  readonly clear: () => void;
}

const none = () => {};
export const NO_SEARCH: MapSearch = Object.freeze({ query: '', terms: [], matches: [], ids: new Set<string>(), current: null, stepped: 0,
  hidden: 0, collapsed: 0, step: none, showThem: none, clear: none });
export const MapSearchContext = createContext<MapSearch>(NO_SEARCH);
export const useMapSearch = (): MapSearch => useContext(MapSearchContext);
