import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detailBody, startDetailScroll, stopDetailScroll } from '../../../src/ui/shell/detailScroll';

const HEIGHT = 500, FRAME = 16;

beforeEach(() => { vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date', 'setTimeout', 'clearTimeout'] }); });
afterEach(() => { stopDetailScroll(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

/** A Details body with a layout jsdom does not compute: `HEIGHT` visible, `content` tall in all. */
function body(content = 5000, parent: Element = document.body, className = 'detail-body') {
  const element = parent.appendChild(document.createElement('div'));
  element.className = className;
  Object.defineProperty(element, 'clientHeight', { value: HEIGHT });
  Object.defineProperty(element, 'scrollHeight', { value: content });
  return element;
}
const key = (type: 'keydown' | 'keyup', name: string) => window.dispatchEvent(new KeyboardEvent(type, { key: name, altKey: true, bubbles: true }));
/** Runs `ms` of frames and returns the scroll position after each. */
function run(element: HTMLElement, ms: number) {
  const seen: number[] = [];
  for (let spent = 0; spent < ms; spent += FRAME) { vi.advanceTimersByTime(FRAME); seen.push(element.scrollTop); }
  return seen;
}
const steps = (seen: readonly number[], from = 0) => seen.map((value, index) => Math.abs(value - (index === 0 ? from : seen[index - 1]!)));

describe('⌥↑ / ⌥↓ scrolling of Details', () => {
  it('moves a tap by less than 10% of the visible height, eased, then rests', () => {
    const element = body();
    expect(startDetailScroll('down', { key: 'ArrowDown' })).toBe(true);
    key('keyup', 'ArrowDown');
    const seen = run(element, 1000);
    const end = seen.at(-1)!;
    expect(end).toBeGreaterThan(0.06 * HEIGHT);
    expect(end).toBeLessThanOrEqual(0.1 * HEIGHT);
    expect(seen.every((value, index) => index === 0 || value >= seen[index - 1]!)).toBe(true);
    expect(Math.max(...steps(seen))).toBeLessThan(0.05 * HEIGHT);
    // At rest: no frame is pending and nothing moves later.
    expect(vi.getTimerCount()).toBe(0);
    expect(run(element, 200).at(-1)).toBe(end);
  });

  it('keeps a tap under 10% even when frames come slowly', () => {
    for (const slow of [33, 50, 120]) {
      const element = body();
      startDetailScroll('down', { key: 'ArrowDown' }); key('keyup', 'ArrowDown');
      for (let spent = 0; spent < 1500; spent += slow) vi.advanceTimersByTime(slow);
      expect(element.scrollTop).toBeGreaterThan(0.05 * HEIGHT);
      expect(element.scrollTop).toBeLessThanOrEqual(0.1 * HEIGHT);
      stopDetailScroll(); element.remove();
    }
  });

  it('scrolls up by a tap too', () => {
    const element = body(); element.scrollTop = 1000;
    startDetailScroll('up', { key: 'ArrowUp' }); key('keyup', 'ArrowUp');
    const end = run(element, 1000).at(-1)!;
    expect(1000 - end).toBeGreaterThan(0.06 * HEIGHT);
    expect(1000 - end).toBeLessThanOrEqual(0.1 * HEIGHT);
  });

  it('keeps scrolling smoothly at a slow constant speed while held, with no jump, and stops when the key comes up', () => {
    const element = body();
    startDetailScroll('down', { key: 'ArrowDown' });
    const seen = run(element, 1000);
    // About 10% of the visible height per 200 ms once up to speed: 0.5 heights a second, less the ease-in.
    expect(seen.at(-1)!).toBeGreaterThan(0.4 * HEIGHT);
    expect(seen.at(-1)!).toBeLessThanOrEqual(0.5 * HEIGHT);
    expect(seen.every((value, index) => index === 0 || value >= seen[index - 1]!)).toBe(true);
    const gaps = steps(seen);
    expect(Math.max(...gaps)).toBeLessThan(0.05 * HEIGHT);
    // Constant after the ease-in (the first ~8 frames): no frame differs from the one before by more than a pixel.
    const cruise = gaps.slice(10);
    expect(Math.max(...cruise) - Math.min(...cruise)).toBeLessThan(1);
    // More time, more distance: it is still going.
    const later = run(element, 500);
    expect(later.at(-1)!).toBeGreaterThan(seen.at(-1)! + 0.2 * HEIGHT);
    key('keyup', 'ArrowDown');
    const braking = run(element, 400), rest = braking.at(-1)!;
    expect(rest - later.at(-1)!).toBeLessThan(0.06 * HEIGHT);
    expect(run(element, 400).at(-1)).toBe(rest);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets go when Alt comes up first, and when the window loses focus', () => {
    const element = body();
    startDetailScroll('down', { key: 'ArrowDown' });
    run(element, 400); key('keyup', 'Alt');
    const stopped = run(element, 400).at(-1)!;
    expect(run(element, 400).at(-1)).toBe(stopped);
    startDetailScroll('down', { key: 'ArrowDown' });
    run(element, 200); window.dispatchEvent(new Event('blur'));
    const blurred = element.scrollTop;
    expect(run(element, 400).at(-1)).toBe(blurred);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets go when focus moves into a text field, and when the owner scrolls some other way', () => {
    const element = body(); const field = document.body.appendChild(document.createElement('textarea'));
    startDetailScroll('down', { key: 'ArrowDown' });
    run(element, 300); field.focus();
    const stopped = element.scrollTop;
    expect(run(element, 300).at(-1)).toBe(stopped);
    startDetailScroll('down', { key: 'ArrowDown' });
    run(element, 100); element.scrollTop += 300;
    const moved = element.scrollTop;
    expect(run(element, 300).at(-1)).toBe(moved);
  });

  it('stops cleanly at the bottom and at the top', () => {
    const element = body(HEIGHT + 100);
    startDetailScroll('down', { key: 'ArrowDown' });
    expect(run(element, 1000).at(-1)).toBe(100);
    expect(vi.getTimerCount()).toBe(0);
    key('keyup', 'ArrowDown');
    startDetailScroll('up', { key: 'ArrowUp' });
    expect(run(element, 1000).at(-1)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('has nothing to scroll when Details is closed, folded or hidden', () => {
    expect(startDetailScroll('down', { key: 'ArrowDown' })).toBe(false);
    const aside = document.body.appendChild(document.createElement('aside')); aside.setAttribute('inert', '');
    body(5000, aside);
    expect(startDetailScroll('down', { key: 'ArrowDown' })).toBe(false);
    const hidden = document.body.appendChild(document.createElement('aside')); hidden.setAttribute('aria-hidden', 'true');
    body(5000, hidden);
    expect(detailBody()).toBeNull();
  });

  it.each([
    ['inert (a folded column)', 'inert', ''],
    ['aria-hidden', 'aria-hidden', 'true'],
    ['hidden', 'hidden', ''],
  ])('stops a running scroll when its panel turns %s, and shows the same position when it comes back', (_name, attribute, value) => {
    const aside = document.body.appendChild(document.createElement('aside'));
    const element = body(5000, aside);
    startDetailScroll('down', { key: 'ArrowDown' });
    run(element, 400);
    const folded = element.scrollTop;
    expect(folded).toBeGreaterThan(0);
    aside.setAttribute(attribute, value);
    // The body stays mounted with its dimensions, the key is still down; it must not move another pixel.
    expect(run(element, 600).every(seen => seen === folded)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    aside.removeAttribute(attribute);
    expect(element.scrollTop).toBe(folded);
    expect(run(element, 400).every(seen => seen === folded)).toBe(true);
  });

  it('stops a running scroll on the column when the bigger view opens over it, and a bigger view\'s when it closes', () => {
    const column = body();
    startDetailScroll('down', { key: 'ArrowDown' });
    run(column, 300);
    const stopped = column.scrollTop;
    const view = document.body.appendChild(document.createElement('div')); view.className = 'item-conversation';
    const bigger = body(5000, view);
    expect(run(column, 300).every(seen => seen === stopped)).toBe(true);
    expect(bigger.scrollTop).toBe(0);
    startDetailScroll('down', { key: 'ArrowDown' });
    run(bigger, 300);
    const reading = bigger.scrollTop;
    expect(reading).toBeGreaterThan(0);
    view.remove();
    expect(run(bigger, 300).every(seen => seen === reading)).toBe(true);
  });

  it('scrolls the bigger view\'s body rather than the Details column behind it', () => {
    const column = body();
    const view = document.body.appendChild(document.createElement('div')); view.className = 'item-conversation';
    const bigger = body(5000, view);
    expect(detailBody()).toBe(bigger);
    startDetailScroll('down', { key: 'ArrowDown' }); key('keyup', 'ArrowDown');
    run(bigger, 600);
    expect(bigger.scrollTop).toBeGreaterThan(0);
    expect(column.scrollTop).toBe(0);
  });

  it('steps once by 9% where the owner asks for reduced motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query }));
    const element = body();
    expect(startDetailScroll('down', { key: 'ArrowDown' })).toBe(true);
    expect(element.scrollTop).toBe(Math.round(0.09 * HEIGHT));
    expect(vi.getTimerCount()).toBe(0);
  });
});
