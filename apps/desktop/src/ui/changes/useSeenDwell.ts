import { useEffect } from 'react';

export const SEEN_DWELL_MS = 1000;

/** Detail today, preview later: changing capture or closing cancels the observation. N never calls this hook. */
export function useSeenDwell(itemKey: string | null, revision: number | null | undefined, observe: (() => void) | undefined) {
  useEffect(() => {
    if (!itemKey || revision == null || !observe) return;
    const timer = setTimeout(observe, SEEN_DWELL_MS);
    return () => clearTimeout(timer);
  }, [itemKey, revision, observe]);
}
