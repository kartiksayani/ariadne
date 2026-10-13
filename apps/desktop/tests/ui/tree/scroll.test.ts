import { describe, expect, it } from 'vitest';
import { nearestDelta, openingTop } from '../../../src/ui/tree/scroll';

describe('Map opening placement', () => {
  it('keeps the usual centre when the whole row fits below the topic header', () => {
    expect(openingTop(400, 40, 60)).toBe(180);
  });
  it('moves the opening row below a tall sticky header', () => {
    expect(openingTop(400, 40, 220)).toBe(228);
  });
  it('keeps the entire long row visible when it fits in the reading area', () => {
    const top = openingTop(400, 300, 60);
    expect(top).toBe(92);
    expect(top).toBeGreaterThanOrEqual(68);
    expect(top + 300).toBeLessThanOrEqual(392);
  });
  it('aligns an oversized row at the clear top instead of clipping its title', () => {
    expect(openingTop(400, 500, 60)).toBe(68);
  });
  it('uses the measured header and reveal margin rather than fixed bar heights', () => {
    expect(openingTop(250, 130, 96.5, 12)).toBe(108.5);
  });
});

describe('Map nearest reveal placement', () => {
  it('leaves a fully visible row stationary', () => { expect(nearestDelta(400, 120, 40, 60, 8)).toBe(0); });
  it('clears a measured sticky header', () => { expect(nearestDelta(400, 20, 40, 60, 8)).toBe(-48); });
  it('moves only enough to show the bottom of a row', () => { expect(nearestDelta(400, 380, 40, 60, 8)).toBe(28); });
  it('aligns an oversized row at the clear top', () => { expect(nearestDelta(400, 300, 500, 60, 8)).toBe(232); });
});
