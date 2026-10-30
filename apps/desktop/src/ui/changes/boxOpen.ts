// Which change boxes the owner has opened ("Changed at 02:30 · Name, Notes"). The box starts collapsed for every item; opening or
// closing it is kept in memory for the running app, per item, so Details, the larger Conversation view and a remounted Details
// all show it as the owner left it. Nothing is saved to disk.
import { useCallback, useSyncExternalStore } from 'react';

const opened = new Set<string>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const keyOf = (project: string, session: string, id: string) => `${project}/${session}/${id}`;

/** Whether the item's change box is open, and a toggle that remembers the choice. */
export function useBoxOpen(project: string, session: string, id: string): readonly [boolean, () => void] {
  const key = keyOf(project, session, id);
  const open = useSyncExternalStore(subscribe, () => opened.has(key));
  const toggle = useCallback(() => {
    if (opened.has(key)) opened.delete(key); else opened.add(key);
    listeners.forEach(listener => listener());
  }, [key]);
  return [open, toggle];
}

/** Test only: forget every remembered choice, because the set outlives a test. */
export function resetBoxOpen(): void {
  opened.clear();
  listeners.forEach(listener => listener());
}
