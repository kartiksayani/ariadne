import { describe, expect, it } from 'vitest';
import { openingTop } from '../../../src/ui/tree/scroll';

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
