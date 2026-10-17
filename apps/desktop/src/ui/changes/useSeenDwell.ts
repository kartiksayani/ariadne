import { useEffect, useState } from 'react';

export const SEEN_DWELL_MS = 1000;

/** The owner can see the window: it is on screen and in front. A hidden or blurred window is not reading anything. */
const attending = () => document.visibilityState === 'visible' && document.hasFocus();

/**
 * Detail or dock: the item has been open for a second. Changing the capture or closing cancels the observation, and so
 * does the window being hidden or losing focus; it then starts again from zero (D20). N never calls this hook.
 */
export function useSeenDwell(itemKey: string | null, revision: number | null | undefined, observe: (() => void) | undefined) {
  const [watching, setWatching] = useState(attending);
  useEffect(() => {
    const update = () => setWatching(attending());
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    update();
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  useEffect(() => {
    if (!watching || !itemKey || revision == null || !observe) return;
    const timer = setTimeout(observe, SEEN_DWELL_MS);
    return () => clearTimeout(timer);
  }, [watching, itemKey, revision, observe]);
}
