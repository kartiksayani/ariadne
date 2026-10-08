import { createContext, useLayoutEffect, useRef, useState } from 'react';

export const ITEM_HISTORY_LIMIT = 100;
export type HistoryDirection = 'back' | 'forward';
interface History { items: string[]; index: number }

export interface ItemHistoryControls {
  readonly canBack: boolean;
  readonly canForward: boolean;
  readonly back: () => boolean;
  readonly forward: () => boolean;
}

/** Session navigation is ephemeral; shell chrome reads it without changing persisted view contracts. */
export const ItemHistoryContext = createContext<ItemHistoryControls | null>(null);

function destination(history: History | undefined, direction: HistoryDirection, exists: (id: string) => boolean): number | null {
  if (!history) return null;
  const step = direction === 'back' ? -1 : 1;
  for (let index = history.index + step; index >= 0 && index < history.items.length; index += step) {
    if (exists(history.items[index])) return index;
  }
  return null;
}

/** Watches the effective selection, so every entry point shares one history per session view. */
export function useItemHistory(sessionKey: string, selectedId: string | null, exists: (id: string) => boolean) {
  const histories = useRef(new Map<string, History>());
  const pending = useRef<{ key: string; history: History; previous: number; target: string; observed: boolean } | null>(null);
  const [, refresh] = useState(0);
  useLayoutEffect(() => {
    if (pending.current && pending.current.key !== sessionKey) {
      if (!pending.current.observed) pending.current.history.index = pending.current.previous;
      pending.current = null;
      refresh(value => value + 1);
    }
    if (!sessionKey || !selectedId || !exists(selectedId)) return;
    const history = histories.current.get(sessionKey);
    const traversal = pending.current;
    if (history?.items[history.index] === selectedId) { if (traversal && traversal.history === history) traversal.observed = true; return; }
    if (traversal && traversal.history === history && !traversal.observed && selectedId === history?.items[traversal.previous]) return;
    // A newer deliberate selection cancels a pending traversal and starts a new branch.
    pending.current = null;
    if (traversal && history && traversal.history === history && !traversal.observed) history.index = traversal.previous;
    const items = [...(history?.items.slice(0, history.index + 1) ?? []), selectedId].slice(-ITEM_HISTORY_LIMIT);
    histories.current.set(sessionKey, { items, index: items.length - 1 });
    refresh(value => value + 1);
  }, [sessionKey, selectedId, exists]);
  const history = histories.current.get(sessionKey);
  const busy = pending.current !== null;
  const navigate = (direction: HistoryDirection, open: (id: string) => Promise<boolean>): boolean => {
    const history = histories.current.get(sessionKey), index = destination(history, direction, exists);
    if (!history || index === null || pending.current) return false;
    const traversal = { key: sessionKey, history, previous: history.index, target: history.items[index], observed: false };
    pending.current = traversal;
    history.index = index;
    refresh(value => value + 1);
    void open(traversal.target).then(opened => {
      if (pending.current !== traversal) return;
      if (!opened && !traversal.observed) history.index = traversal.previous;
      pending.current = null;
      refresh(value => value + 1);
    }, () => {
      if (pending.current !== traversal) return;
      if (!traversal.observed) history.index = traversal.previous;
      pending.current = null;
      refresh(value => value + 1);
    });
    return true;
  };
  return { canBack: !busy && destination(history, 'back', exists) !== null,
    canForward: !busy && destination(history, 'forward', exists) !== null, navigate };
}
