import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyStopsLanding, LANDING_MS, landingMoves, startLanding, wheelScrolls, type Offset } from '../../../src/ui/shared/landing';

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
