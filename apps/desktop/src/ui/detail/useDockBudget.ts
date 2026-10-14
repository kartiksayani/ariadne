import { useLayoutEffect, type RefObject } from 'react';

/**
 * The pinned question footer is as tall as its content, up to a cap that is a share of the view (CSS `--dock-cap`). Only its
 * options region gives way to the cap. Everything else in it (heading, question, status, retry and error rows, own words, Send)
 * is a fixed row and is never clipped, scrolled or painted over, so those rows are subtracted from the cap first and the options
 * get what is left, as the region's `--dock-options` height.
 *
 * - If the cap leaves room for a whole option, the options get all of it (and scroll beyond it).
 * - If it does not, one option still shows while that keeps the footer within half the view.
 * - Past that (a stack of recovery rows in a small view), `data-squeezed` folds the options away instead of leaving a
 *   cut-off sliver of one; the fixed rows keep their room and the chat gives way instead.
 */
export function useDockBudget(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useLayoutEffect(() => {
    const dock = ref.current, pane = dock?.parentElement;
    if (!dock || !pane || !active) return undefined;
    let last = '', frame = 0;
    const fit = () => {
      frame = 0;
      const choices = dock.querySelector<HTMLElement>('.answer-choices'), height = pane.clientHeight;
      if (!choices || !height) { dock.style.removeProperty('--dock-options'); dock.removeAttribute('data-squeezed'); last = ''; return; }
      const first = choices.querySelector<HTMLElement>('.answer-card, [data-answer-option]'), style = getComputedStyle(choices);
      const row = first ? first.getBoundingClientRect().height + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) : 0;
      const share = parseFloat(getComputedStyle(dock).getPropertyValue('--dock-cap')) / 100;
      if (!Number.isFinite(share)) return;
      // Nothing in the footer shrinks, so its height without the options region is exactly its fixed rows.
      const fixed = dock.offsetHeight - choices.offsetHeight, left = share * height - fixed;
      const budget = left >= row ? left : fixed + row <= height / 2 ? row : 0;
      const value = `${Math.max(0, Math.floor(budget))}px`;
      if (value === last) return;
      last = value;
      dock.style.setProperty('--dock-options', value);
      dock.toggleAttribute('data-squeezed', budget <= 0);
    };
    // Measuring in a frame keeps the observers from reporting a resize loop: the budget changes the very boxes they watch.
    const schedule = () => { if (!frame) frame = requestAnimationFrame(fit); };
    // Every element of the footer is watched (a row can change without the footer's own size doing so), and the view it is a share of.
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    const watched = new Set<Element>();
    const watch = () => {
      const next = new Set<Element>([pane, dock, ...dock.querySelectorAll('*')]);
      for (const element of watched) if (!next.has(element)) { resize?.unobserve(element); watched.delete(element); }
      for (const element of next) if (!watched.has(element)) { resize?.observe(element); watched.add(element); }
    };
    // Rows come and go with the answer's state; fit before the next paint so the footer never shows the unbudgeted layout.
    const mutate = new MutationObserver(() => { watch(); fit(); });
    mutate.observe(dock, { childList: true, subtree: true, characterData: true });
    window.addEventListener('resize', schedule);
    void document.fonts?.ready.then(schedule);
    watch(); fit();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resize?.disconnect(); mutate.disconnect(); window.removeEventListener('resize', schedule);
      dock.style.removeProperty('--dock-options'); dock.removeAttribute('data-squeezed');
    };
  }, [ref, active]);
}
