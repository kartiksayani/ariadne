import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyStopsLanding, LANDING_MS, landingMoves, reachable, startLanding, WheelStream, wheelScrolls, type Offset } from '../../../src/ui/shared/landing';
import { SWIPE_GAP_MS } from '../../../src/ui/shell/swipeGesture';

const FRAME = 16, SCREEN = 500;

beforeEach(() => { vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/** A scroller along one axis whose target sits at `target`; `drift` moves the target on the way (a row above it grows). */
function scroller(target: number, start = 0) {
  const state = { position: start, target, landed: 0, moves: [] as number[] };
  const landing = startLanding({
    remaining: () => Number.isNaN(state.target) ? null : { top: state.target - state.position, left: 0 },
    move: (by: Offset) => { state.position += by.top; state.moves.push(by.top); },
    screen: () => ({ top: SCREEN, left: SCREEN }),
    landed: () => { state.landed++; },
  });
  return { state, landing };
}
/** Runs `ms` of frames and returns the position after each. */
function run(state: { position: number }, ms: number) {
  const seen: number[] = [];
  for (let spent = 0; spent < ms; spent += FRAME) { vi.advanceTimersByTime(FRAME); seen.push(state.position); }
  return seen;
}

describe('landing', () => {
  it('moves over several eased frames, ends exactly on the target, lands once and leaves nothing pending', () => {
    const { state, landing } = scroller(400);
    expect(state.position).toBe(0);
    const seen = run(state, LANDING_MS + 100);
    expect(state.position).toBe(400);
    expect(state.landed).toBe(1);
    expect(landing.running()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const between = seen.filter(value => value > 1 && value < 399);
    expect(between.length).toBeGreaterThanOrEqual(5);
    // Ease-out: the first steps are the longest.
    const steps = seen.map((value, index) => value - (seen[index - 1] ?? 0)).filter(step => step > 0);
    expect(steps[0]).toBeGreaterThan(steps.at(-1)!);
    expect(seen.every((value, index) => index === 0 || value >= seen[index - 1]!)).toBe(true);
  });

  it('jumps all but the last screen of a long way at once, either way', () => {
    for (const target of [5000, -5000]) {
      const { state } = scroller(target);
      expect(state.position).toBe(target - Math.sign(target) * SCREEN);
      run(state, LANDING_MS + 100);
      expect(state.position).toBe(target);
    }
  });

  it('takes up a target that moves on the way and still ends on it', () => {
    const { state } = scroller(400);
    run(state, 5 * FRAME);
    state.target = 460;
    run(state, LANDING_MS);
    expect(state.position).toBe(460);
  });

  it('stops where it is when cancelled, and when its target goes; neither lands', () => {
    const { state, landing } = scroller(400);
    run(state, 3 * FRAME);
    landing.cancel();
    const stopped = state.position;
    expect(stopped).toBeGreaterThan(0); expect(stopped).toBeLessThan(400);
    expect(run(state, LANDING_MS).at(-1)).toBe(stopped);
    expect(state.landed).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    landing.cancel();
    const gone = scroller(400);
    run(gone.state, 2 * FRAME);
    gone.state.target = Number.NaN;
    const at = gone.state.position;
    expect(run(gone.state, LANDING_MS).at(-1)).toBe(at);
    expect(gone.state.landed).toBe(0);
    expect(gone.landing.running()).toBe(false);
  });

  it('eases toward the place it can reach, not past the end of the scroll range where it would stop dead at full speed', () => {
    const box = { scrollTop: 100, scrollLeft: 0, scrollHeight: 1000, clientHeight: 500, scrollWidth: 400, clientWidth: 400 } as Element;
    const cut = (top: number, left: number) => { const out = reachable(box, { top, left }); return [out.top, out.left].map(value => value + 0); };
    expect(cut(-300, 0)).toEqual([-100, 0]);
    expect(cut(300, 50)).toEqual([300, 0]);
    expect(cut(450, -20)).toEqual([400, 0]);
    // A landing measured through it stops smoothly at the end.
    const state = { position: 100 };
    startLanding({
      remaining: () => reachable({ ...box, scrollTop: state.position } as Element, { top: 900 - state.position, left: 0 }),
      move: by => { state.position += by.top; }, screen: () => ({ top: SCREEN, left: SCREEN }), landed: () => {},
    });
    const seen = run(state, LANDING_MS + 100);
    expect(state.position).toBe(500);
    const steps = seen.map((value, index) => value - (seen[index - 1] ?? 100)).filter(step => step > 0.5);
    expect(steps.at(-1)!).toBeLessThan(0.1 * 400);
  });

  it('lands at once with no way to go, and never starts without a target', () => {
    const there = scroller(0.2);
    expect(there.state.landed).toBe(1);
    expect(there.landing.running()).toBe(false);
    const none = scroller(Number.NaN);
    expect(none.landing.running()).toBe(false);
    expect(none.state.landed).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('moves only where media queries say motion is welcome', () => {
    expect(landingMoves()).toBe(false);
    for (const reduce of [true, false]) {
      vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduce && query === '(prefers-reduced-motion: reduce)' }));
      expect(landingMoves()).toBe(!reduce);
    }
  });

  it('is stopped by a wheel that scrolls and by a key, not by a sideways swipe at the edge, a repeat or a bare modifier', () => {
    const box = { scrollLeft: 0, clientWidth: 400, scrollWidth: 400 } as Element;
    expect(wheelScrolls({ deltaX: 0, deltaY: 4 }, box)).toBe(true);
    expect(wheelScrolls({ deltaX: 2, deltaY: -4 }, box)).toBe(true);
    expect(wheelScrolls({ deltaX: 0, deltaY: 0 }, box)).toBe(false);
    expect(wheelScrolls({ deltaX: -30, deltaY: 1 }, box)).toBe(false);
    expect(wheelScrolls({ deltaX: 30, deltaY: 1 }, box)).toBe(false);
    const wide = { scrollLeft: 100, clientWidth: 400, scrollWidth: 900 } as Element;
    expect(wheelScrolls({ deltaX: -30, deltaY: 1 }, wide)).toBe(true);
    expect(wheelScrolls({ deltaX: 30, deltaY: 1 }, wide)).toBe(true);
    expect(wheelScrolls({ deltaX: 30, deltaY: 1 }, { scrollLeft: 500, clientWidth: 400, scrollWidth: 900 } as Element)).toBe(false);
    expect(keyStopsLanding({ key: 'ArrowDown', repeat: false })).toBe(true);
    expect(keyStopsLanding({ key: 'ArrowDown', repeat: true })).toBe(false);
    for (const key of ['Meta', 'Shift', 'Alt', 'Control']) expect(keyStopsLanding({ key, repeat: false })).toBe(false);
  });
});

describe('the wheel events of the swipe that started a landing', () => {
  /** A Graph whose horizontal room the landing itself opens up: the box can scroll left once the landing has moved it. */
  const edge = (scrollLeft: number) => ({ scrollLeft, clientWidth: 400, scrollWidth: 900 }) as Element;
  const wheel = (timeStamp: number, deltaX: number, deltaY = 1) => ({ timeStamp, deltaX, deltaY });

  it('never stop the landing, though the landing has moved the box so that the same wheel now scrolls it', () => {
    const stream = new WheelStream();
    // The swipe at the left edge: nothing to scroll that way yet, so no wheel stops anything.
    expect(stream.stops(wheel(0, -40), edge(0))).toBe(false);
    expect(stream.stops(wheel(16, -60), edge(0))).toBe(false);
    stream.carry();
    // The landing now moves the box right; the swipe's trailing momentum (a negative deltaX) would scroll it, read from the box alone.
    expect(wheelScrolls(wheel(32, -30), edge(120))).toBe(true);
    for (let time = 32; time < 900; time += 16) expect(stream.stops(wheel(time, -30), edge(120)), `at ${time} ms`).toBe(false);
  });

  it('stop it for the owner: a vertical wheel, a new gesture after a gap, or a stream that turns vertical', () => {
    const stream = new WheelStream();
    stream.stops(wheel(0, -80, 2), edge(0));
    stream.carry();
    expect(stream.stops(wheel(16, 0, 4), edge(120)), 'a little vertical in a sideways stream is still the swipe').toBe(false);
    expect(stream.stops(wheel(32, -2, 90), edge(120)), 'the stream turned vertical').toBe(true);
    const next = new WheelStream();
    next.stops(wheel(0, -80, 2), edge(0));
    next.carry();
    expect(next.stops(wheel(16, -20), edge(120))).toBe(false);
    // A gap of more than SWIPE_GAP_MS: a new gesture is the owner's own and scrolls the box where it can.
    expect(next.stops(wheel(16 + SWIPE_GAP_MS + 1, -20), edge(120))).toBe(true);
    expect(next.stops(wheel(16 + SWIPE_GAP_MS + 17, -20), edge(0))).toBe(false);
  });

  it('shield only the stream running when the landing begins (a ⌘[ from the keyboard, long after, has none)', () => {
    const stream = new WheelStream();
    stream.stops(wheel(0, -80, 2), edge(0));
    stream.carry();
    stream.stops(wheel(16, -80, 2), edge(0));
    // Another landing begins from the keyboard long after: the stream that ended is not carried over.
    stream.stops(wheel(1000, 0, 0), edge(0));
    stream.carry();
    expect(stream.stops(wheel(1016, -30), edge(120))).toBe(false);
    expect(stream.stops(wheel(2000, -30), edge(120))).toBe(true);
  });
});
