// Back and Forward show in a wide window only (1100px and up, SPEC 5.3); jsdom's 1024px counts as narrow.
import { afterEach, beforeEach } from 'vitest';

export function useWideWindow(width = 1280) {
  let before = window.innerWidth;
  beforeEach(() => {
    before = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  });
  afterEach(() => { Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: before }); });
}
