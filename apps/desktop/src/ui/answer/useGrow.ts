// A chat box: one line when empty, growing with its text up to a third of its
// pane (the detail panel, `.item-detail`), then scrolling inside itself.
import { useLayoutEffect, type RefObject } from 'react';

/** The pane a box may take a third of; a box outside any pane takes a third of the window. */
export const PANE = '.item-detail';

export function useGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string, enabled = true) {
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box || !enabled) return;
    const fit = () => {
      const pane = box.closest<HTMLElement>(PANE), cap = Math.max(48, Math.floor((pane?.clientHeight || window.innerHeight) / 3));
      box.style.height = 'auto';
      // An empty box stays one row; scrollHeight also counts a wrapped placeholder.
      if (!value) { box.style.overflowY = 'hidden'; return; }
      // Not laid out (no height to measure): leave the browser's own size.
      if (!box.scrollHeight) return;
      // scrollHeight leaves out the borders; the box sizes by its border box.
      const wanted = box.scrollHeight + box.offsetHeight - box.clientHeight;
      box.style.height = `${Math.min(wanted, cap)}px`;
      box.style.overflowY = wanted > cap ? 'auto' : 'hidden';
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [ref, value, enabled]);
}
