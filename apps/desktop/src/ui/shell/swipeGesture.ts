// The two-finger trackpad swipe (alpha.24 P2), read from wheel events. WKWebView delivers it as a stream of wheel events with a
// horizontal delta: a swipe right (the fingers move right, the content is pulled right) has a negative `deltaX`, as scrolling toward
// the left edge does. That is "back", like Safari; a swipe left is "forward". This file holds the decisions and no DOM: the detector
// takes wheel samples and says what the gesture is doing; SwipeNavigation reads the events and does the work.

export type SwipeDirection = 'back' | 'forward';

/** The distance (px of horizontal wheel delta, summed over one gesture) that commits the swipe. */
export const SWIPE_THRESHOLD = 100;
/** A gesture says which way it goes once its wheel deltas sum to this much (px), so a first tiny event cannot decide it. */
export const SWIPE_DECIDE = 12;
/** Quiet this long (ms) and the gesture is over; the next wheel event starts another. Momentum events follow each other, so they stay in the same gesture. */
export const SWIPE_GAP_MS = 120;
/** The gesture counts as horizontal when its horizontal travel is more than this many times its vertical travel. */
export const SWIPE_DOMINANCE = 2;

export interface WheelSample {
  /** Pixels; positive = the content scrolls toward its right end (the fingers move left). */
  readonly dx: number;
  readonly dy: number;
  /** Milliseconds, any clock that does not run backwards (`event.timeStamp`). */
  readonly time: number;
  /** The wheel is scrolling something horizontally right here: an element under the pointer can still move in this direction. */
  readonly scrolls: boolean;
}

export type SwipeOutcome =
  | { readonly kind: 'none' }
  /** The swipe is under way and the card at the edge should follow it: `progress` 0..1 of the threshold. */
  | { readonly kind: 'move'; readonly direction: SwipeDirection; readonly progress: number }
  /** Past the threshold: do it, once for this gesture. */
  | { readonly kind: 'commit'; readonly direction: SwipeDirection }
  /** The gesture stopped, or something else took it, before it committed: take the feedback away. */
  | { readonly kind: 'end' };

type Phase = 'idle' | 'deciding' | 'swiping' | 'ignored' | 'fired';

/**
 * One gesture at a time:
 *  - the first events decide whether it is horizontal (|dx| > 2|dy| over its first SWIPE_DECIDE px); a vertical or diagonal gesture
 *    is ignored whole, so a scroll with a little sideways drift never navigates. The rule holds to the commit: a gesture whose
 *    travel turns vertical later is latched as ignored until it ends;
 *  - a wheel that scrolls something (a wide table, the Graph) owns the whole gesture: it is never a swipe, even after the scroller
 *    reaches its edge (the momentum that runs on would otherwise navigate). A new gesture started at the edge is a swipe;
 *  - it commits once, when the summed horizontal delta passes SWIPE_THRESHOLD; the momentum that follows is ignored until the gap.
 */
export class SwipeDetector {
  private phase: Phase = 'idle';
  private last = Number.NEGATIVE_INFINITY;
  private sum = 0;
  private across = 0;
  private along = 0;

  feed(sample: WheelSample): SwipeOutcome {
    if (sample.time - this.last > SWIPE_GAP_MS) this.reset();
    this.last = sample.time;
    if (sample.dx === 0 && sample.dy === 0) return { kind: 'none' };
    if (this.phase === 'fired' || this.phase === 'ignored') return { kind: 'none' };
    if (sample.scrolls) return this.ignore();
    this.sum += sample.dx; this.along += Math.abs(sample.dx); this.across += Math.abs(sample.dy);
    if (this.phase === 'idle') this.phase = 'deciding';
    if (this.phase === 'deciding') {
      if (this.along + this.across < SWIPE_DECIDE) return { kind: 'none' };
      this.phase = 'swiping';
    }
    // Checked on every sample, not only the first: a gesture that turns vertical after it began is dropped for good.
    if (this.along <= SWIPE_DOMINANCE * this.across) return this.ignore();
    if (this.sum === 0) return { kind: 'none' };
    const direction: SwipeDirection = this.sum < 0 ? 'back' : 'forward';
    if (Math.abs(this.sum) >= SWIPE_THRESHOLD) { this.phase = 'fired'; return { kind: 'commit', direction }; }
    return { kind: 'move', direction, progress: Math.abs(this.sum) / SWIPE_THRESHOLD };
  }

  /** No wheel event for SWIPE_GAP_MS (the caller's timer): the gesture is over. */
  end(): SwipeOutcome {
    const was = this.phase;
    this.reset();
    return was === 'swiping' ? { kind: 'end' } : { kind: 'none' };
  }

  /** Forgets the gesture, silently: something outside it (a dialog opened, the pointer left the window) made it moot. */
  reset(): void {
    this.phase = 'idle'; this.sum = 0; this.across = 0; this.along = 0;
  }

  private ignore(): SwipeOutcome {
    const was = this.phase;
    this.phase = 'ignored';
    return was === 'swiping' ? { kind: 'end' } : { kind: 'none' };
  }
}

/**
 * Whether an element at or above `target` can still scroll horizontally toward `dx`'s side: it overflows sideways, its overflow-x lets
 * the owner scroll it, and it is not already at that end. The page's own scroller counts even with overflow `visible`.
 */
export function canScrollHorizontally(target: EventTarget | null, dx: number): boolean {
  if (dx === 0 || !(target instanceof Element)) return false;
  const root = target.ownerDocument.scrollingElement;
  for (let element: Element | null = target; element; element = element.parentElement) {
    const overflow = getComputedStyle(element).overflowX;
    const scrollable = overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay' || (element === root && overflow === 'visible');
    if (!scrollable || element.scrollWidth <= element.clientWidth + 1) continue;
    if (dx < 0 ? element.scrollLeft > 0 : element.scrollLeft + element.clientWidth < element.scrollWidth - 1) return true;
  }
  return false;
}
