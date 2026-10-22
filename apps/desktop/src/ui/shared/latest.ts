// A stable handle on the latest callback (alpha.23 F6d): memoised rows and the Map get one function for the life of the
// component, so a new closure each render redraws nothing, while a call still runs what the caller rendered last.
import { useRef } from 'react';

export function useLatest<A extends unknown[], R>(callback: (...args: A) => R): (...args: A) => R {
  const latest = useRef(callback);
  latest.current = callback;
  const stable = useRef<((...args: A) => R) | null>(null);
  stable.current ??= (...args: A) => latest.current(...args);
  return stable.current;
}
