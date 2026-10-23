// The two-finger swipe wired to the window (alpha.24 P2): the wheel events, the guards ⌘[ has, the edge rule, and the arrow.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { SWIPE_GAP_MS } from '../../../src/ui/shell/swipeGesture';
import { SWIPE_POP_MS, SwipeNavigation, type SwipeHistory } from '../../../src/ui/shell/SwipeNavigation';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

const controls = (patch: Partial<SwipeHistory> = {}): SwipeHistory => ({ canBack: true, canForward: true, back: vi.fn(() => true), forward: vi.fn(() => true), ...patch });
/** `count` wheel events (one frame apart) of `deltaX` on `target`. */
function swipe(target: Element,deltaX: number, count = 12, init: WheelEventInit = {}) {
  for (let index = 0; index < count; index++) act(() => { vi.advanceTimersByTime(16); fireEvent.wheel(target, { deltaX, deltaY: 0, ...init }); });
}
const arrow = () => document.querySelector('[data-testid="swipe-arrow"]');
/** A box whose scroll metrics are the test's (jsdom lays nothing out). */
function scroller(scrollLeft: number) {
  const element = document.body.appendChild(document.createElement('div'));
  element.style.overflowX = 'auto';
  Object.defineProperties(element, { scrollWidth: { value: 800 }, clientWidth: { value: 200 }, scrollLeft: { value: scrollLeft } });
  return element;
}

describe('two-finger swipe, same as Command+[ and Command+]', () => {
  it('a swipe right takes back once, a swipe left takes forward once', () => {
    const history = controls();
    render(<SwipeNavigation history={history} />);
    swipe(document.body, -10, 30);
    expect(history.back).toHaveBeenCalledTimes(1); expect(history.forward).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(SWIPE_GAP_MS + 1); });
    swipe(document.body, 10, 30);
    expect(history.forward).toHaveBeenCalledTimes(1); expect(history.back).toHaveBeenCalledTimes(1);
  });

  it('calls the history the app hands in, the latest one each time', () => {
    const first = controls(), second = controls();
    const { rerender } = render(<SwipeNavigation history={first} />);
    rerender(<SwipeNavigation history={second} />);
    swipe(document.body, -10, 12);
    expect(first.back).not.toHaveBeenCalled(); expect(second.back).toHaveBeenCalledTimes(1);
  });

  it('a short swipe, or a vertical scroll, does nothing', () => {
    const history = controls();
    render(<SwipeNavigation history={history} />);
    swipe(document.body, -3, 10);
    act(() => { vi.advanceTimersByTime(SWIPE_GAP_MS + 1); });
    for (let index = 0; index < 60; index++) act(() => { vi.advanceTimersByTime(16); fireEvent.wheel(document.body, { deltaX: -3, deltaY: 14 }); });
    expect(history.back).not.toHaveBeenCalled(); expect(history.forward).not.toHaveBeenCalled();
  });

  it('keeps the momentum that follows a swipe from taking a second step', () => {
    const history = controls();
    render(<SwipeNavigation history={history} />);
    swipe(document.body, -10, 12);
    swipe(document.body, -6, 80);
    expect(history.back).toHaveBeenCalledTimes(1);
  });

  it('reads a mouse wheel in lines, not pixels', () => {
    const history = controls();
    render(<SwipeNavigation history={history} />);
    swipe(document.body, 2, 4, { deltaMode: 1 });
    expect(history.forward).toHaveBeenCalledTimes(1);
  });
});

describe('the edge rule: a horizontal scroll is never stolen', () => {
  it('a scroller that can still move that way gets the whole gesture, momentum included', () => {
    const history = controls();
    render(<SwipeNavigation history={history} />);
    const box = scroller(300);
    swipe(box, -10, 12);
    swipe(box, -6, 40);
    expect(history.back).not.toHaveBeenCalled();
    // The same pointer, over the same scroller, but pushing toward the other end: that end is free, so it scrolls too.
    act(() => { vi.advanceTimersByTime(SWIPE_GAP_MS + 1); });
    swipe(box, 10, 12);
    expect(history.forward).not.toHaveBeenCalled();
  });

  it('at its edge a new gesture is a swipe', () => {
    const history = controls();
    render(<SwipeNavigation history={history} />);
    const atStart = scroller(0);
    swipe(atStart, -10, 12);
    expect(history.back).toHaveBeenCalledTimes(1);
  });

  it('counts a scroller above the pointer, and the elements inside it', () => {
    const history = controls();
    render(<SwipeNavigation history={history} />);
    const box = scroller(300), inner = box.appendChild(document.createElement('p'));
    swipe(inner, -10, 12);
    expect(history.back).not.toHaveBeenCalled();
  });
});

describe('the guards of Command+[', () => {
  it.each([
    ['a text field', () => document.body.appendChild(document.createElement('input'))],
    ['a textarea', () => document.body.appendChild(document.createElement('textarea'))],
    ['editable content', () => { const box = document.body.appendChild(document.createElement('div')); box.setAttribute('contenteditable', 'true'); return box; }],
    ['a dialog', () => { const box = document.body.appendChild(document.createElement('div')); box.setAttribute('role', 'dialog'); return box; }],
  ])('does nothing over %s', (_name, make) => {
    const history = controls();
    render(<SwipeNavigation history={history} />);
    swipe(make(), -10, 20);
    expect(history.back).not.toHaveBeenCalled();
  });

  it('does nothing while a text field has focus, or an overlay (switcher, help, a menu) is open', () => {
    const history = controls();
    render(<SwipeNavigation history={history} />);
    const field = document.body.appendChild(document.createElement('input')); field.focus();
    swipe(document.body, -10, 20);
    field.blur(); field.remove();
    const overlay = document.body.appendChild(document.createElement('div')); overlay.setAttribute('data-workspace-overlay', 'switcher');
    swipe(document.body, -10, 20);
    expect(history.back).not.toHaveBeenCalled();
    overlay.remove();
    act(() => { vi.advanceTimersByTime(SWIPE_GAP_MS + 1); });
    swipe(document.body, -10, 12);
    expect(history.back).toHaveBeenCalledTimes(1);
  });

  it.each([['a pinch (ctrl)', { ctrlKey: true }], ['a Command chord', { metaKey: true }], ['an Option chord', { altKey: true }], ['Shift+wheel, a mouse\'s sideways scroll', { shiftKey: true }]])('ignores %s', (_name, init) => {
    const history = controls();
    render(<SwipeNavigation history={history} />);
    swipe(document.body, -10, 20, init);
    expect(history.back).not.toHaveBeenCalled();
  });

  it('ignores a wheel another handler already took', () => {
    const history = controls();
    render(<SwipeNavigation history={history} />);
    // A pan or zoom handler on an element (body and window listeners are passive by default, and cannot take a wheel).
    const canvas = document.body.appendChild(document.createElement('div'));
    canvas.addEventListener('wheel', event => event.preventDefault(), { passive: false });
    swipe(canvas, -10, 20);
    expect(history.back).not.toHaveBeenCalled();
  });

  it('stops listening when the app unmounts', () => {
    const history = controls();
    const { unmount } = render(<SwipeNavigation history={history} />);
    unmount();
    swipe(document.body, -10, 20);
    expect(history.back).not.toHaveBeenCalled();
  });
});

describe('the edge arrow', () => {
  it('follows the swipe from the left edge for back, then pops at the commit and goes', () => {
    render(<SwipeNavigation history={controls()} />);
    expect(arrow()).toBeNull();
    swipe(document.body, -10, 5);
    expect(arrow()?.getAttribute('data-side')).toBe('left');
    expect(arrow()?.getAttribute('style')).toContain('--swipe-progress: 0.5');
    expect(arrow()?.firstElementChild?.className).toBe('ph ph-arrow-left');
    swipe(document.body, -10, 6);
    expect(arrow()?.hasAttribute('data-done')).toBe(true);
    act(() => { vi.advanceTimersByTime(SWIPE_POP_MS + 1); });
    expect(arrow()).toBeNull();
  });

  it('comes from the right edge for forward', () => {
    render(<SwipeNavigation history={controls()} />);
    swipe(document.body, 10, 4);
    expect(arrow()?.getAttribute('data-side')).toBe('right');
    expect(arrow()?.firstElementChild?.className).toBe('ph ph-arrow-right');
  });

  it('goes when the fingers stop short', () => {
    render(<SwipeNavigation history={controls()} />);
    swipe(document.body, -10, 5);
    expect(arrow()).not.toBeNull();
    act(() => { vi.advanceTimersByTime(SWIPE_GAP_MS + 1); });
    expect(arrow()).toBeNull();
  });

  it('draws nothing when there is no entry that way, and does not look for one in the other direction', () => {
    const history = controls({ canBack: false, back: vi.fn(() => false) });
    render(<SwipeNavigation history={history} />);
    swipe(document.body, -10, 12);
    expect(arrow()).toBeNull();
    // The same keys' rule: the action is asked for, and refuses.
    expect(history.back).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(SWIPE_GAP_MS + 1); });
    swipe(document.body, 10, 4);
    expect(arrow()?.getAttribute('data-side')).toBe('right');
  });

  it('does not pop when the action does nothing', () => {
    render(<SwipeNavigation history={controls({ back: vi.fn(() => false) })} />);
    swipe(document.body, -10, 12);
    expect(arrow()).toBeNull();
  });

  it('with reduced motion draws no arrow at all, only the action', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const history = controls();
    render(<SwipeNavigation history={history} />);
    swipe(document.body, -10, 5);
    expect(arrow()).toBeNull();
    swipe(document.body, -10, 6);
    expect(arrow()).toBeNull();
    expect(history.back).toHaveBeenCalledTimes(1);
  });

  it('is not in the accessibility tree and takes no clicks', () => {
    render(<SwipeNavigation history={controls()} />);
    swipe(document.body, -10, 5);
    expect(arrow()?.getAttribute('aria-hidden')).toBe('true');
  });
});
