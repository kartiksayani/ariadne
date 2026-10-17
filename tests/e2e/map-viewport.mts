import type { Page } from '@playwright/test';

// Shared by the Map-still specs of both views (alpha.20 plan D24). The Map holds the row the owner is reading at its
// *viewport* position, so a trigger that moves the scroller itself (the filter row opening above it) is measured
// against the window, never against the scroller's own edge.

/** Where an element sits in the window, in px rounded to 0.1; null when it is not drawn. */
export interface ViewportPlace { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

const round = (value: number) => Math.round(value * 10) / 10;

/** The element's box in viewport coordinates (`getBoundingClientRect`), or null when nothing matches. */
export const viewportPlace = (page: Page, selector: string): Promise<ViewportPlace | null> => page.evaluate(wanted => {
  const element = document.querySelector(wanted);
  if (!element) return null;
  const rect = element.getBoundingClientRect(), r = (value: number) => Math.round(value * 10) / 10;
  return { x: r(rect.left), y: r(rect.top), width: r(rect.width), height: r(rect.height) };
}, selector);

/** The distance between two places' tops, rounded the same way the helper rounds, for `toBeCloseTo` style checks. */
export const viewportShift = (before: ViewportPlace, after: ViewportPlace): number => round(after.y - before.y);
