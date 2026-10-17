// The local chips (To ack, Sent, Blocked, Later) live in this browser only, never in ui.json (D15). Tree, Graph and the top
// bar read the same pick through one store, so they cannot disagree.
import { useCallback, useSyncExternalStore } from 'react';
import { LOCAL_CHIPS_KEY, loadLocalChips, saveLocalChips, type LocalChip } from '../../selectors/tree/filter';

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const NONE: readonly LocalChip[] = Object.freeze([]);
let memo: { raw: string | null; sessions: Map<string, readonly LocalChip[]> } = { raw: null, sessions: new Map() };

function raw(): string | null {
  try { return localStorage.getItem(LOCAL_CHIPS_KEY); } catch { return null; }
}
/** One stable array per stored value, so the snapshot only changes when the pick does. */
function snapshot(sessionId: string): readonly LocalChip[] {
  const stored = raw();
  if (memo.raw !== stored) memo = { raw: stored, sessions: new Map() };
  let chips = memo.sessions.get(sessionId);
  if (!chips) { const loaded = loadLocalChips(sessionId); chips = loaded.length ? Object.freeze(loaded) : NONE; memo.sessions.set(sessionId, chips); }
  return chips;
}

export function useLocalChips(sessionId: string): { readonly chips: readonly LocalChip[]; readonly set: (next: readonly LocalChip[]) => void } {
  const read = useCallback(() => snapshot(sessionId), [sessionId]);
  const chips = useSyncExternalStore(subscribe, read, read);
  const set = useCallback((next: readonly LocalChip[]) => {
    saveLocalChips(sessionId, next);
    memo = { raw: null, sessions: new Map() };
    listeners.forEach(listener => listener());
  }, [sessionId]);
  return { chips, set };
}
