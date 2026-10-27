// Two-finger swipe back and forward (alpha.24 P2): the same actions as ⌘[ and ⌘], from the trackpad. It listens to the window's wheel
// events (WKWebView sends the swipe as horizontal wheel events; the app has no page history, so the web view's own back/forward
// gesture stays off), asks the detector (swipeGesture.ts) what the gesture is doing, and draws a small round arrow at the edge that
// follows it, as Safari and Chrome do. Nothing is drawn when there is no entry that way. It never takes a horizontal scroll: a
// scroller under the pointer that can still move that way gets the wheel, and the swipe counts only from its edge.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { historyBlockedAt } from './windowKeys';
import { canScrollHorizontally, SWIPE_GAP_MS, SwipeDetector, type SwipeDirection } from './swipeGesture';
import './swipe.css';

/** The history ⌘[ and ⌘] use (App's `historyControls`). */
export interface SwipeHistory {
  readonly canBack: boolean;
  readonly canForward: boolean;
  readonly back: () => boolean;
  readonly forward: () => boolean;
}

/** How long the arrow's "done" pop lasts (ms); swipe.css animates it over the same time. */
export const SWIPE_POP_MS = 420;

interface Arrow { readonly direction: SwipeDirection; readonly progress: number; readonly done: boolean }

const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function SwipeNavigation({ history }: { readonly history: SwipeHistory }) {
  const latest = useRef(history);
  latest.current = history;
  const [arrow, setArrow] = useState<Arrow | null>(null);
  useEffect(() => {
    const detector = new SwipeDetector();
    let quiet: ReturnType<typeof setTimeout> | undefined, pop: ReturnType<typeof setTimeout> | undefined;
    const available = (direction: SwipeDirection) => direction === 'back' ? latest.current.canBack : latest.current.canForward;
    const hidePop = () => { clearTimeout(pop); setArrow(null); };
    // The "done" pop has its own timer and finishes on its own; any other arrow goes with the gesture it followed.
    const dropArrow = () => setArrow(current => current?.done ? current : null);
    const wheel = (event: WheelEvent) => {
      // A pinch (ctrl), a chord, Shift+wheel (a mouse's sideways scroll) and a wheel something else already took are not the swipe.
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      // Only a trackpad's pixel deltas: a mouse wheel, even a dedicated sideways one, reports lines or pages and never navigates.
      if (event.deltaMode !== 0) return;
      // Blocked (a text field, a dialog, an overlay): the gesture is over and its arrow and quiet timer go with it.
      if (historyBlockedAt(event.target, document)) { detector.reset(); clearTimeout(quiet); dropArrow(); return; }
      const dx = event.deltaX, dy = event.deltaY;
      const outcome = detector.feed({ dx, dy, time: event.timeStamp, scrolls: dx !== 0 && canScrollHorizontally(event.target, dx) });
      clearTimeout(quiet);
      quiet = setTimeout(() => { detector.end(); dropArrow(); }, SWIPE_GAP_MS);
      if (outcome.kind === 'move') setArrow(available(outcome.direction) && !reducedMotion() ? { direction: outcome.direction, progress: outcome.progress, done: false } : null);
      else if (outcome.kind === 'end') dropArrow();
      else if (outcome.kind === 'commit') {
        const did = (outcome.direction === 'back' ? latest.current.back : latest.current.forward)();
        clearTimeout(pop);
        if (did && !reducedMotion()) {
          setArrow({ direction: outcome.direction, progress: 1, done: true });
          pop = setTimeout(hidePop, SWIPE_POP_MS);
        } else setArrow(null);
      }
    };
    window.addEventListener('wheel', wheel, { passive: true });
    return () => { window.removeEventListener('wheel', wheel); clearTimeout(quiet); clearTimeout(pop); };
  }, []);
  if (!arrow) return null;
  return <div className="swipe-arrow" data-testid="swipe-arrow" role="presentation" aria-hidden="true" data-side={arrow.direction === 'back' ? 'left' : 'right'}
    data-done={arrow.done || undefined} style={{ '--swipe-progress': arrow.progress } as CSSProperties}>
    <i className={arrow.direction === 'back' ? 'ph ph-arrow-left' : 'ph ph-arrow-right'} aria-hidden="true" />
  </div>;
}
