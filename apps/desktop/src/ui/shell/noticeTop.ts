import { useLayoutEffect, useState, type RefObject } from 'react';

/** The gap between the band (or the Map's top edge) and the first notice. */
const GAP = 8;

/**
 * Where the notice stack hangs from over a Map, in pixels from the top of the body: the Map's scroll shell top, which sits under
 * every in-flow line above it (connection line, filter row), plus the topic band's height in the Tree (fixed since alpha.20),
 * plus 8. Null where no Map is drawn (a page), so the stack keeps its place there. The stack floats, so measuring it never moves
 * the Map; this only follows the Map's own top as lines above it come and go.
 */
export function useMapNoticeTop(viewport: RefObject<HTMLElement | null>, active: boolean): number | null {
  const [top, setTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const host = viewport.current;
    if (!active || !host) { setTop(null); return undefined; }
    let frame = 0;
    const place = () => {
      frame = 0;
      const shell = host.querySelector<HTMLElement>('.shell-center .tree-scroll-shell, .shell-center .graph-view');
      if (!shell) { setTop(null); return; }
      const band = shell.matches('.tree-scroll-shell') ? shell.querySelector<HTMLElement>('.tree-topic')?.offsetHeight ?? 0 : 0;
      const next = Math.max(0, Math.round(shell.getBoundingClientRect().top - host.getBoundingClientRect().top)) + band + GAP;
      setTop(previous => previous === next ? previous : next);
    };
    // Measuring in a frame keeps the observers from reporting a resize loop.
    const schedule = () => { if (!frame) frame = requestAnimationFrame(place); };
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    const watched = new Set<Element>();
    const watch = () => {
      const next = new Set<Element>([host, ...host.querySelectorAll('.shell-center .tree-scroll-shell, .shell-center .graph-view, .shell-center .tree-topic')]);
      for (const element of watched) if (!next.has(element)) { resize?.unobserve(element); watched.delete(element); }
      for (const element of next) if (!watched.has(element)) { resize?.observe(element); watched.add(element); }
    };
    const center = host.querySelector('.shell-center');
    // A line above the Map, a band, or a page swapping for a Map all change the DOM before they change a size.
    const mutate = new MutationObserver(() => { watch(); schedule(); });
    if (center) mutate.observe(center, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    watch(); place();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resize?.disconnect(); mutate.disconnect(); window.removeEventListener('resize', schedule);
    };
  }, [viewport, active]);
  return active ? top : null;
}
