import { describe, expect, it } from 'vitest';
import { fitBounds, fitsAtMinimum, zoomAt } from '../../../src/graph/layout/viewport';

describe('local graph viewport', () => {
  it('anchors the same world point under the cursor through zoom and range clamping', () => {
    const before = { x: 60, y: -25, scale: 0.75 }, cursor = { x: 220, y: 110 };
    for (const requested of [1.5, 20, 0.001]) {
      const after = zoomAt(before, cursor, requested);
      expect((cursor.x - after.x) / after.scale).toBeCloseTo((cursor.x - before.x) / before.scale);
      expect((cursor.y - after.y) / after.scale).toBeCloseTo((cursor.y - before.y) / before.scale);
      expect(after.scale).toBe(Math.max(0.25, Math.min(2, requested)));
    }
  });
  it('fits full bounds with 32px padding and centers nonzero geometry', () => {
    const bounds = { x: 20, y: 40, width: 800, height: 400 }, view = fitBounds(bounds, 864, 600);
    expect(view).toEqual({ scale: 1, x: 12, y: 60 });
    expect(bounds.x * view.scale + view.x).toBe(32);
    expect((bounds.x + bounds.width) * view.scale + view.x).toBe(832);
    expect(fitsAtMinimum(bounds, 864, 600)).toBe(true);
  });
  it('keeps the zoom range for enormous full geometry rather than cropping or relaxing the minimum', () => {
    const bounds = { x: 0, y: 0, width: 10000, height: 66 }, view = fitBounds(bounds, 800, 400);
    expect(view.scale).toBe(0.25); expect(view.x).toBe(-850); expect(view.y).toBe(191.75);
    expect(fitsAtMinimum(bounds, 800, 400)).toBe(false);
    expect(fitBounds({x:0,y:0,width:0,height:0}, 800, 400)).toEqual({x:400,y:200,scale:1});
    expect(fitBounds({x:0,y:0,width:1,height:1}, 800, 400).scale).toBe(2);
  });
});
