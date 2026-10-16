// C9: the Details column's width and fold. The resize table (every way the width can change, in a wide and a narrow
// window), the persistence round trip (the clamp at 320, a restart, bad stored values) and the fold's storage.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import {
  DETAILS_NARROW, DETAILS_RAIL, DETAILS_WIDE, DetailsColumnProvider, FOLDED_KEY, NARROW_BELOW, defaultWidth, fitWidth, readFolded,
  savedWidth, useDetailsColumn, useDetailsRange, widthRange,
} from '../../../src/state/details/column';

const WIDE = 1280, NARROW = 900;
const original = window.innerWidth;

function viewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  act(() => { window.dispatchEvent(new Event('resize')); });
}

beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); viewport(WIDE); });
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); viewport(original); });

/** The column inside its provider; `saved` is what ui.json holds, `save` is what the owner's choice is written through. */
function column(saved: number | null, save: (width: number) => void = vi.fn()) {
  const wrapper = ({ children }: { children: ReactNode }) => createElement(DetailsColumnProvider, { saved, onSave: save }, children);
  return renderHook(() => ({ ...useDetailsColumn(), range: useDetailsRange() }), { wrapper });
}
const settle = () => act(() => { vi.advanceTimersByTime(1000); });

describe('sizes', () => {
  it('is 400 wide and 340 narrow, with the 36px rail', () => {
    expect([DETAILS_WIDE, DETAILS_NARROW, DETAILS_RAIL]).toEqual([400, 340, 36]);
  });
  it.each([
    [1920, 400], [WIDE, 400], [NARROW_BELOW, 400], [NARROW_BELOW - 1, 340], [NARROW, 340], [760, 340],
  ])('defaults to the board size for a %ipx window: %ipx', (width, size) => {
    expect(defaultWidth(width)).toBe(size);
  });
  it.each([
    [WIDE, 320, 800], [1920, 320, 1440], [NARROW, 280, 520], [NARROW_BELOW, 320, 620], [NARROW_BELOW - 1, 280, 719],
    // The saved width's own ceiling is core's.
    [4000, 320, 2400],
    // A window too small for the rule still gives a usable range.
    [500, 280, 280],
  ])('lets a %ipx window take %i to %ipx', (width, min, max) => {
    expect(widthRange(width)).toEqual({ min, max });
  });
  it.each([
    [WIDE, 400, 400], [WIDE, 319.6, 320], [WIDE, 100, 320], [WIDE, 5000, 800], [NARROW, 300, 300], [NARROW, 100, 280], [NARROW, 900, 520],
  ])('fits %ipx of window: a wish of %i shows %ipx', (window, wish, shown) => {
    expect(fitWidth(wish, window)).toBe(shown);
  });
  it.each([[100, 320], [280, 320], [319, 320], [320, 320], [401.4, 401], [2400, 2400], [9000, 2400]])('saves a width of %i as %i', (width, saved) => {
    expect(savedWidth(width)).toBe(saved);
  });
});

describe('resize table', () => {
  // What the owner does, in which window, what Details shows, and what ui.json is told once they stop.
  it.each([
    ['drag wider', WIDE, 520, 520, 520],
    ['drag narrower', WIDE, 340, 340, 340],
    ['drag past the least', WIDE, 200, 320, 320],
    ['drag past the most', WIDE, 5000, 800, 800],
    ['drag in a narrow window', NARROW, 450, 450, 450],
    ['drag under 320 in a narrow window: used, saved as 320', NARROW, 300, 300, 320],
    ['drag under 280 in a narrow window', NARROW, 120, 280, 320],
    ['drag past the most in a narrow window', NARROW, 5000, 520, 520],
    ['the least, a keyboard Home', WIDE, widthRange(WIDE).min, 320, 320],
    ['the most, a keyboard End', NARROW, widthRange(NARROW).max, 520, 520],
  ])('%s (%ipx window, wish %i): shows %i, saves %i', (_name, window, wish, shown, saved) => {
    viewport(window);
    const save = vi.fn();
    const { result } = column(null, save);
    act(() => result.current.setWidth(wish));
    expect(result.current.width).toBe(shown);
    expect(save).not.toHaveBeenCalled();
    settle();
    expect(save).toHaveBeenCalledExactlyOnceWith(saved);
  });

  it('saves once, with the last width, however many steps a drag takes', () => {
    const save = vi.fn();
    const { result } = column(null, save);
    for (const wish of [410, 450, 500, 560, 600]) { act(() => result.current.setWidth(wish)); act(() => { vi.advanceTimersByTime(50); }); }
    expect(result.current.width).toBe(600);
    expect(save).not.toHaveBeenCalled();
    settle();
    expect(save).toHaveBeenCalledExactlyOnceWith(600);
  });

  it('keeps a width the owner stepped to even when Details closes before the pause ends', () => {
    const save = vi.fn();
    const { result, unmount } = column(null, save);
    act(() => result.current.setWidth(480));
    unmount();
    expect(save).toHaveBeenCalledExactlyOnceWith(480);
  });

  it('writes nothing for a width that is already the saved one', () => {
    const save = vi.fn();
    const { result } = column(500, save);
    act(() => result.current.setWidth(500));
    settle();
    expect(save).not.toHaveBeenCalled();
  });

  it('follows the window: the default narrows under the breakpoint, a chosen width stays and is fitted', () => {
    const { result } = column(null);
    expect(result.current.width).toBe(400);
    viewport(NARROW);
    expect(result.current.width).toBe(340);
    expect(result.current.range).toEqual({ min: 280, max: 520, standard: 340 });
    viewport(WIDE);
    expect(result.current.width).toBe(400);
    expect(result.current.range).toEqual({ min: 320, max: 800, standard: 400 });
    const chosen = column(700);
    expect(chosen.result.current.width).toBe(700);
    viewport(NARROW);
    expect(chosen.result.current.width).toBe(520);
    viewport(WIDE);
    expect(chosen.result.current.width).toBe(700);
  });

  it('shows the width at once, before the saved value catches up', () => {
    const { result } = column(null);
    act(() => result.current.setWidth(480));
    expect(result.current.width).toBe(480);
  });
});

describe('persistence round trip', () => {
  it.each([
    ['400 is saved as 400', 400, 400],
    ['a wide window can save 320', 320, 320],
    ['a width under 320 is saved as 320', 300, 320],
  ])('%s, and a restart shows what was saved', (_name, wish, saved) => {
    viewport(NARROW);
    const store = vi.fn();
    const first = column(null, store);
    act(() => first.result.current.setWidth(wish));
    settle();
    expect(store).toHaveBeenCalledExactlyOnceWith(saved);
    first.unmount();
    // The restart: a fresh provider, given what ui.json now holds.
    const restarted = column(saved);
    expect(restarted.result.current.width).toBe(saved);
    viewport(WIDE);
    expect(restarted.result.current.width).toBe(saved);
  });

  it.each([
    ['nothing saved', null, 400],
    ['not a number', Number.NaN, 400],
    ['infinite', Number.POSITIVE_INFINITY, 400],
    ['zero', 0, 400],
    ['negative', -50, 400],
    ['more than the window can give', 3000, 800],
    ['less than the least', 100, 320],
  ])('opens with %s at %ipx in a wide window', (_name, saved, shown) => {
    expect(column(saved).result.current.width).toBe(shown);
  });

  it('opens with nothing saved at 340 in a narrow window', () => {
    viewport(NARROW);
    expect(column(null).result.current.width).toBe(340);
  });
});

describe('fold', () => {
  const stored = () => localStorage.getItem(FOLDED_KEY);

  it('starts unfolded, folds, unfolds, and keeps the width through both', () => {
    const { result } = column(520);
    expect(result.current.folded).toBe(false);
    act(() => result.current.fold());
    expect(result.current.folded).toBe(true);
    expect(result.current.width).toBe(520);
    act(() => result.current.unfold());
    expect(result.current.folded).toBe(false);
    expect(result.current.width).toBe(520);
  });

  it('saves the fold in localStorage, not in ui.json, and a restart reads it', () => {
    const save = vi.fn();
    const first = column(null, save);
    act(() => first.result.current.fold());
    expect(stored()).toBe('true');
    first.unmount();
    expect(column(null, save).result.current.folded).toBe(true);
    const again = column(null, save);
    act(() => again.result.current.unfold());
    expect(stored()).toBe('false');
    again.unmount();
    expect(column(null, save).result.current.folded).toBe(false);
    settle();
    expect(save).not.toHaveBeenCalled();
  });

  it('uses the one key ariadne.details.folded.v1', () => {
    expect(FOLDED_KEY).toBe('ariadne.details.folded.v1');
  });

  it.each([['banana'], ['1'], ['yes'], ['TRUE'], ['"true"'], ['null'], ['{}'], [''], [' true']])('falls back to unfolded for a stored %j', value => {
    localStorage.setItem(FOLDED_KEY, value);
    expect(readFolded()).toBe(false);
    expect(column(null).result.current.folded).toBe(false);
  });

  it('reads nothing as unfolded, and a stored false as unfolded', () => {
    expect(readFolded()).toBe(false);
    localStorage.setItem(FOLDED_KEY, 'false');
    expect(readFolded()).toBe(false);
  });

  it('still folds for this run when storage refuses to read or write', () => {
    const refuse = () => { throw new DOMException('denied', 'SecurityError'); };
    const spies = [vi.spyOn(Storage.prototype, 'getItem').mockImplementation(refuse), vi.spyOn(Storage.prototype, 'setItem').mockImplementation(refuse)];
    try {
      const { result } = column(null);
      expect(result.current.folded).toBe(false);
      act(() => result.current.fold());
      expect(result.current.folded).toBe(true);
      act(() => result.current.unfold());
      expect(result.current.folded).toBe(false);
    } finally { spies.forEach(spy => spy.mockRestore()); }
  });
});

describe('without a provider', () => {
  it('shows the wide default, unfolded, and ignores every change', () => {
    const { result } = renderHook(() => useDetailsColumn());
    expect(result.current).toMatchObject({ width: 400, folded: false });
    act(() => { result.current.setWidth(600); result.current.fold(); });
    expect(result.current).toMatchObject({ width: 400, folded: false });
    expect(localStorage.getItem(FOLDED_KEY)).toBeNull();
  });
});
