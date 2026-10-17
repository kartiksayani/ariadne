// Stand-in for the Tree core's MapSearch (ui/tree/mapSearch.ts, contract C3) until it lands: the same names, only the
// fields the Graph reads. Replace the imports with '../tree/mapSearch' and delete this file then.
import { createContext, useContext } from 'react';

export interface MapMatch { readonly id: string; readonly field: 'question' | 'outcome' }
export interface MapSearch {
  /** Trimmed query, '' when search is off. */
  readonly query: string;
  /** Item ids with a visible match: the Graph tints these. */
  readonly ids: ReadonlySet<string>;
  /** The current match: the Graph rings it. */
  readonly current: MapMatch | null;
  /** Bumps only when the owner steps (↑ ↓ ↵): the Graph scrolls the current match into view and selects nothing. */
  readonly stepped: number;
}

const EMPTY: MapSearch = Object.freeze({ query: '', ids: new Set<string>(), current: null, stepped: 0 });
export const MapSearchContext = createContext<MapSearch>(EMPTY);
export const useMapSearch = (): MapSearch => useContext(MapSearchContext);
