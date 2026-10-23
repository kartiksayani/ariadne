// The two-finger swipe detector (alpha.24 P2): threshold, horizontal dominance, one trigger per gesture, momentum, the edge rule.
import { describe, expect, it } from 'vitest';
import { SWIPE_DECIDE, SWIPE_GAP_MS, SWIPE_THRESHOLD, SwipeDetector, canScrollHorizontally, type SwipeOutcome, type WheelSample } from '../../../src/ui/shell/swipeGesture';

const FRAME = 16;
/** `count` wheel events 16 ms apart, from `start`, each `dx` by `dy`. */
function stream(detector: SwipeDetector, dx: number, count: number, { dy = 0, start = 0, scrolls = false }: { dy?: number; start?: number; scrolls?: boolean } = {}) {
  const outcomes: SwipeOutcome[] = [];
  for (let index = 0; index < count; index++) outcomes.push(detector.feed({ dx, dy, time: start + index * FRAME, scrolls } satisfies WheelSample));
  return outcomes;
}
const commits = (outcomes: readonly SwipeOutcome[]) => outcomes.filter(outcome => outcome.kind === 'commit');

describe('two-finger swipe detector', () => {
  it('a swipe right (negative deltaX) commits back, once the summed distance passes the threshold', () => {
    const outcomes = stream(new SwipeDetector(), -10, 30);
    const at = outcomes.findIndex(outcome => outcome.kind === 'commit');
    expect(at + 1).toBe(SWIPE_THRESHOLD / 10);
    expect(outcomes[at]).toEqual({ kind: 'commit', direction: 'back' });
  });

  it('a swipe left (positive deltaX) commits forward', () => {
    expect(commits(stream(new SwipeDetector(), 12, 30))).toEqual([{ kind: 'commit', direction: 'forward' }]);
  });

  it('commits at the threshold and not a pixel before', () => {
    const detector = new SwipeDetector();
    expect(detector.feed({ dx: -(SWIPE_THRESHOLD - 1), dy: 0, time: 0, scrolls: false }).kind).toBe('move');
    expect(detector.feed({ dx: -1, dy: 0, time: FRAME, scrolls: false }).kind).toBe('commit');
  });

  it('moves with the fingers: progress is the share of the threshold covered, in the direction of the sum', () => {
    const detector = new SwipeDetector();
    const moves = stream(detector, -10, 5).filter(outcome => outcome.kind === 'move');
    expect(moves.at(-1)).toEqual({ kind: 'move', direction: 'back', progress: 0.5 });
    // Fingers back the other way: the progress falls and, past zero, the direction turns.
    expect(detector.feed({ dx: 20, dy: 0, time: 5 * FRAME, scrolls: false })).toEqual({ kind: 'move', direction: 'back', progress: 0.3 });
    expect(detector.feed({ dx: 40, dy: 0, time: 6 * FRAME, scrolls: false })).toEqual({ kind: 'move', direction: 'forward', progress: 0.1 });
  });

  it('says nothing while the first events are too small to tell which way the gesture goes', () => {
    const detector = new SwipeDetector();
    expect(detector.feed({ dx: -2, dy: 0, time: 0, scrolls: false }).kind).toBe('none');
    expect(detector.feed({ dx: -2, dy: 1, time: FRAME, scrolls: false }).kind).toBe('none');
    expect(SWIPE_DECIDE).toBeGreaterThan(4);
  });

  it('commits once per gesture: the momentum after the commit never fires again', () => {
    const detector = new SwipeDetector();
    const first = stream(detector, -20, 6);
    // Momentum: events keep coming, decaying, with no gap longer than a frame or two.
    const tail = stream(detector, -12, 60, { start: 6 * FRAME });
    expect(commits(first)).toHaveLength(1);
    expect(commits(tail)).toHaveLength(0);
    expect(tail.every(outcome => outcome.kind === 'none')).toBe(true);
  });

  it('a new gesture after a quiet gap commits again', () => {
    const detector = new SwipeDetector();
    expect(commits(stream(detector, -20, 6))).toHaveLength(1);
    expect(detector.end()).toEqual({ kind: 'none' });
    expect(commits(stream(detector, -20, 6, { start: 6 * FRAME + SWIPE_GAP_MS + 1 }))).toHaveLength(1);
  });

  it('a gap alone, with no end() call, also starts a new gesture', () => {
    const detector = new SwipeDetector();
    stream(detector, -20, 6);
    expect(commits(stream(detector, 20, 6, { start: 6 * FRAME + SWIPE_GAP_MS + 1 }))).toEqual([{ kind: 'commit', direction: 'forward' }]);
  });

  it('a vertical scroll, even with sideways drift, never navigates', () => {
    expect(commits(stream(new SwipeDetector(), -4, 200, { dy: 12 }))).toHaveLength(0);
    // Diagonal: |dx| is not more than twice |dy|.
    expect(commits(stream(new SwipeDetector(), -10, 100, { dy: 5 }))).toHaveLength(0);
    expect(commits(stream(new SwipeDetector(), -10, 100, { dy: 6 }))).toHaveLength(0);
  });

  it('a swipe a little off the horizontal still counts (|dx| over twice |dy|)', () => {
    expect(commits(stream(new SwipeDetector(), -12, 30, { dy: 5 }))).toEqual([{ kind: 'commit', direction: 'back' }]);
  });

  it('a gesture that began vertical stays vertical to its end, whatever it does after', () => {
    const detector = new SwipeDetector();
    stream(detector, 0, 5, { dy: 10 });
    expect(commits(stream(detector, -30, 20, { start: 5 * FRAME }))).toHaveLength(0);
  });

  it('a gesture that stops short ends without committing, and the next one starts clean', () => {
    const detector = new SwipeDetector();
    expect(stream(detector, -5, 6).some(outcome => outcome.kind === 'commit')).toBe(false);
    expect(detector.end()).toEqual({ kind: 'end' });
    expect(commits(stream(detector, -20, 6, { start: 1000 }))).toHaveLength(1);
  });

  it('a wheel that scrolls something owns the whole gesture, even after the scroller reaches its edge', () => {
    const detector = new SwipeDetector();
    // The wheel scrolls a wide table for 10 events; then it is at its edge and the same gesture runs on (its momentum).
    expect(commits(stream(detector, 20, 10, { scrolls: true }))).toHaveLength(0);
    expect(commits(stream(detector, 20, 40, { start: 10 * FRAME }))).toHaveLength(0);
    // The next gesture, started at that edge, is a swipe.
    expect(commits(stream(detector, 20, 8, { start: 60 * FRAME + SWIPE_GAP_MS }))).toEqual([{ kind: 'commit', direction: 'forward' }]);
  });

  it('a swipe under way that meets a scroller (the pointer moved onto one) is dropped and ends its feedback', () => {
    const detector = new SwipeDetector();
    stream(detector, -5, 4);
    expect(detector.feed({ dx: -5, dy: 0, time: 4 * FRAME, scrolls: true })).toEqual({ kind: 'end' });
    expect(commits(stream(detector, -30, 10, { start: 5 * FRAME }))).toHaveLength(0);
  });

  it('events with no movement are ignored and never start a gesture', () => {
    const detector = new SwipeDetector();
    expect(detector.feed({ dx: 0, dy: 0, time: 0, scrolls: false })).toEqual({ kind: 'none' });
    expect(detector.end()).toEqual({ kind: 'none' });
  });

  it('reset drops a gesture silently', () => {
    const detector = new SwipeDetector();
    stream(detector, -5, 6);
    detector.reset();
    expect(detector.end()).toEqual({ kind: 'none' });
  });
});

/** A box whose scroll metrics are the test's (jsdom lays nothing out). */
function scroller(parent: HTMLElement, overflowX: string, { scrollWidth = 500, clientWidth = 200, scrollLeft = 0 } = {}) {
  const element = parent.appendChild(document.createElement('div'));
  element.style.overflowX = overflowX;
  Object.defineProperties(element, { scrollWidth: { value: scrollWidth, configurable: true }, clientWidth: { value: clientWidth, configurable: true }, scrollLeft: { value: scrollLeft, configurable: true, writable: true } });
  return element;
}

describe('canScrollHorizontally (the edge rule)', () => {
  it('is true while a scroller under the pointer, or above it, can still move toward the wheel', () => {
    const host = document.body.appendChild(document.createElement('div'));
    const outer = scroller(host, 'auto', { scrollLeft: 100 });
    const inner = outer.appendChild(document.createElement('span'));
    expect(canScrollHorizontally(inner, -10)).toBe(true);
    expect(canScrollHorizontally(inner, 10)).toBe(true);
    host.remove();
  });

  it('is false at the edge the wheel pushes toward, and true toward the other', () => {
    const host = document.body.appendChild(document.createElement('div'));
    const atStart = scroller(host, 'scroll', { scrollLeft: 0 });
    expect(canScrollHorizontally(atStart, -10)).toBe(false);
    expect(canScrollHorizontally(atStart, 10)).toBe(true);
    const atEnd = scroller(host, 'auto', { scrollLeft: 300 });
    expect(canScrollHorizontally(atEnd, 10)).toBe(false);
    expect(canScrollHorizontally(atEnd, -10)).toBe(true);
    host.remove();
  });

  it('is false for a box that does not overflow, one whose overflow-x is hidden or visible, and for a vertical-only scroller', () => {
    const host = document.body.appendChild(document.createElement('div'));
    expect(canScrollHorizontally(scroller(host, 'auto', { scrollWidth: 200, clientWidth: 200 }), 10)).toBe(false);
    expect(canScrollHorizontally(scroller(host, 'hidden', { scrollLeft: 50 }), 10)).toBe(false);
    expect(canScrollHorizontally(scroller(host, 'visible', { scrollLeft: 50 }), 10)).toBe(false);
    const vertical = host.appendChild(document.createElement('div')); vertical.style.overflowY = 'auto';
    expect(canScrollHorizontally(vertical, 10)).toBe(false);
    host.remove();
  });

  it('looks through a non-scrolling box to the scroller above it, and ignores a scroller beside it', () => {
    const host = document.body.appendChild(document.createElement('div'));
    const outer = scroller(host, 'auto');
    const middle = outer.appendChild(document.createElement('div')); middle.style.overflowX = 'hidden';
    const leaf = middle.appendChild(document.createElement('p'));
    const beside = scroller(host, 'auto');
    expect(canScrollHorizontally(leaf, 10)).toBe(true);
    expect(canScrollHorizontally(host, 10)).toBe(false);
    expect(beside.isConnected).toBe(true);
    host.remove();
  });

  it('is false for no target and for no horizontal movement', () => {
    expect(canScrollHorizontally(null, 10)).toBe(false);
    expect(canScrollHorizontally(document.body, 0)).toBe(false);
  });
});
