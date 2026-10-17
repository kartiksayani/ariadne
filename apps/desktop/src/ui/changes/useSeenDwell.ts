import { useEffect, useState } from 'react';

export const SEEN_DWELL_MS = 1000;

const visibleNow = () => document.visibilityState === 'visible';

/** Whether an event came from the owner and not a script. A seam only so a test (jsdom cannot forge `isTrusted`) can say so. */
export const origin = { trusted: (event: Event) => event.isTrusted };

/**
 * Detail or dock: the item has been open for a second. Changing the capture or closing cancels the observation, and so
 * does the window being hidden or losing focus; it then starts again from zero (D20). N never calls this hook.
 *
 * Attending means visible and not blurred. Blurred starts from `document.hasFocus()`, is set by the window's `blur` and
 * cleared by its `focus`. A webview can be in front without ever having fired `focus` (nothing has been clicked yet), so a
 * real press or key in the page also clears it: the owner is plainly there.
 */
export function useSeenDwell(itemKey: string | null, revision: number | null | undefined, observe: (() => void) | undefined) {
  const [visible, setVisible] = useState(visibleNow);
  const [blurred, setBlurred] = useState(() => !document.hasFocus());
  useEffect(() => {
    const here = (event: Event) => { if (origin.trusted(event)) setBlurred(false); };
    const focus = () => setBlurred(false), blur = () => setBlurred(true), change = () => setVisible(visibleNow());
    window.addEventListener('focus', focus);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', change);
    document.addEventListener('pointerdown', here, true);
    document.addEventListener('keydown', here, true);
    change();
    return () => {
      window.removeEventListener('focus', focus);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', change);
      document.removeEventListener('pointerdown', here, true);
      document.removeEventListener('keydown', here, true);
    };
  }, []);
  const watching = visible && !blurred;
  useEffect(() => {
    if (!watching || !itemKey || revision == null || !observe) return;
    const timer = setTimeout(observe, SEEN_DWELL_MS);
    return () => clearTimeout(timer);
  }, [watching, itemKey, revision, observe]);
}
