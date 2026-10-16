// The Map's scroll helpers take the floating dock's height (`bottomInset`). With no dock (inset 0) they behave as
// before; with a dock, a row under it counts as hidden and is brought above it.
import { describe, expect, it } from 'vitest';
import { nearestDelta, openingTop } from '../../../src/ui/tree/scroll';
import { isVisibleInScroller, scrollIntoViewIfHidden } from '../../../src/ui/shared/scroll';

/** A scroller 400px tall at y=100, and a row at `top` (in the scroller's own coordinates) `height` tall. */
function boxes(top: number, height: number) {
  const rect = (y: number, h: number) => ({ top: y, bottom: y + h, height: h, left: 0, right: 300, width: 300, x: 0, y, toJSON: () => ({}) }) as DOMRect;
  // A plain scroller keeps the scrollTop it is given, which jsdom's elements do not lay out.
  const scroller = { scrollTop: 0, getBoundingClientRect: () => rect(100, 400) } as unknown as HTMLElement;
  const row = { getBoundingClientRect: () => rect(100 + top, height) } as unknown as Element;
  return { scroller, row };
}

describe('inset 0 behaves as today', () => {
  // Each case is today's call next to the same call with an explicit zero inset.
  it('openingTop with the default margin', () => { expect(openingTop(400, 40, 60, 8, 0)).toBe(openingTop(400, 40, 60)); });
  const placements: readonly (readonly [number, number, number, number])[] = [[400, 40, 60, 8], [400, 40, 220, 8], [400, 300, 60, 8], [400, 500, 60, 8], [250, 130, 96.5, 12]];
  it.each(placements)('openingTop(%d, %d, %d, %d)', (viewport, row, header, margin) => {
    expect(openingTop(viewport, row, header, margin, 0)).toBe(openingTop(viewport, row, header, margin));
  });
  const moves: readonly (readonly [number, number, number, number, number])[] = [[400, 120, 40, 60, 8], [400, 20, 40, 60, 8], [400, 380, 40, 60, 8], [400, 300, 500, 60, 8]];
  it.each(moves)('nearestDelta(%d, %d, %d, %d, %d)', (viewport, top, row, header, margin) => {
    expect(nearestDelta(viewport, top, row, header, margin, 0)).toBe(nearestDelta(viewport, top, row, header, margin));
  });
  it.each([[0, 40, true], [360, 40, true], [361, 40, false], [-1, 40, false]] as const)('a row at %dpx, %dpx tall, shows: %s', (top, height, shown) => {
    const { scroller, row } = boxes(top, height);
    expect(isVisibleInScroller(scroller, row)).toBe(shown);
    expect(isVisibleInScroller(scroller, row, { bottomInset: 0 })).toBe(shown);
  });
  it.each([[100, 0], [380, 20], [-30, -30]] as const)('a row at %dpx moves the scroller by %dpx', (top, moved) => {
    const { scroller, row } = boxes(top, 40);
    scroller.scrollTop = 500;
    scrollIntoViewIfHidden(scroller, row);
    expect(scroller.scrollTop - 500).toBe(moved);
  });
});

describe('an inset hides the bottom rows', () => {
  const dock = 120;
  it('opening placement centres the row in the area above the dock', () => {
    expect(openingTop(400, 40, 60, 8, dock)).toBe(120);
    expect(openingTop(400, 40, 60, 8, dock)).toBeLessThan(openingTop(400, 40, 60));
  });
  it('a row under the dock moves up to sit above it; a row above it stays', () => {
    // The row at 300–340 shows without a dock and sits under a 120px dock (visible area ends at 280).
    expect(nearestDelta(400, 300, 40, 60, 0)).toBe(0);
    expect(nearestDelta(400, 300, 40, 60, 0, dock)).toBe(60);
    expect(nearestDelta(400, 200, 40, 60, 0, dock)).toBe(0);
  });
  it.each([[200, 40, true], [240, 40, true], [241, 40, false], [300, 40, false]] as const)('a row at %dpx, %dpx tall, shows above the dock: %s', (top, height, shown) => {
    const { scroller, row } = boxes(top, height);
    expect(isVisibleInScroller(scroller, row, { bottomInset: dock })).toBe(shown);
  });
  it('scrolls the least distance that clears the dock, and nothing for a row above it', () => {
    const under = boxes(300, 40);
    under.scroller.scrollTop = 500;
    scrollIntoViewIfHidden(under.scroller, under.row, { bottomInset: dock });
    expect(under.scroller.scrollTop).toBe(560);
    const above = boxes(200, 40);
    above.scroller.scrollTop = 500;
    scrollIntoViewIfHidden(above.scroller, above.row, { bottomInset: dock });
    expect(above.scroller.scrollTop).toBe(500);
  });
  it('keeps the top room and the bottom margin with the dock', () => {
    const { scroller, row } = boxes(250, 40);
    // Visible area: 48 below the top to 400 − 120 − 8 = 272; the row ends at 290.
    expect(isVisibleInScroller(scroller, row, { top: 48, bottom: 8, bottomInset: dock })).toBe(false);
    scroller.scrollTop = 500;
    scrollIntoViewIfHidden(scroller, row, { top: 48, bottom: 8, bottomInset: dock });
    expect(scroller.scrollTop).toBe(518);
  });
});
