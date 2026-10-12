import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { SessionPreferences, SessionRef } from '../../generated/core';
import type { Immutable } from '../../data';
import { filterSignature } from '../../selectors/tree/folds';

interface Folds { readonly signature: string; readonly items: ReadonlySet<string>; readonly topics: ReadonlySet<string> }
const empty: Folds = { signature: '', items: new Set(), topics: new Set() };
interface Store { readonly values: Map<string, Folds>; readonly listeners: Set<() => void> }
const stores = new WeakMap<object, Store>();

/** The router survives view switches; filter-specific choices do not enter the saved schema. */
export function useFilterFolds(router: object, route: Immutable<SessionRef>, filters: Immutable<SessionPreferences['filters']> | undefined, search?: string) {
  let store = stores.get(router);
  if (!store) { store = { values: new Map(), listeners: new Set() }; stores.set(router, store); }
  const current = store, key = JSON.stringify([route.project_id, route.session_id]);
  const signature = filters ? filterSignature(filters, search) : '';
  const subscribe = useCallback((listener: () => void) => { current.listeners.add(listener); return () => { current.listeners.delete(listener); }; }, [current]);
  const snapshot = useCallback(() => current.values.get(key) ?? empty, [current, key]);
  const folds = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (current.values.get(key)?.signature === signature) return;
    current.values.set(key, { signature, items: new Set(), topics: new Set() });
    current.listeners.forEach(listener => listener());
  }, [current, key, signature]);
  const setFold = useCallback((kind: 'items' | 'topics', id: string, folded: boolean) => {
    const previous = current.values.get(key), base = previous?.signature === signature ? previous : empty;
    const next = new Set(base[kind]);
    if (folded) next.add(id); else next.delete(id);
    current.values.set(key, { ...base, signature, [kind]: next });
    current.listeners.forEach(listener => listener());
  }, [current, key, signature]);
  return { ...(folds.signature === signature ? folds : empty), setFold };
}
