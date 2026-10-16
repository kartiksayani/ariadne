// The loader: renders one state of the final design board (designs/Ariadne-final-board.zip) by its part and state
// id, offline and deterministically, and returns the frame as a PNG. The board is untrusted data: it runs only in
// the rendering page, which can reach nothing but the files served from the unzipped archive (final-source.mts).
//
// Determinism: the page runs on a fake clock that starts at the board's 21:25 and moves only when this module moves it
// (page.clock.runFor), so the board's own timers (it scrolls the selection into place 0, 0.5 and 1.5 s after it mounts, and
// its "Back to ..." pill follows) fire at the same moments every run and cost no waiting. Fonts are loaded before the shot,
// motion is off (reduced motion, and animation and transition are cut in the host page), and every request outside the
// served files is blocked and recorded.
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { finalNow, variants, type FinalState, type Variant } from './final-frames';
import { hostName, routeFinal } from './final-source.mts';

/**
 * The Claude Design screenshots carry a "Light" / "Dark" label above each frame, and are 28px taller than the frame
 * (1280 x 828, 900 x 678): the frame starts 27px down and one row of page background follows it.
 */
export const labelHeight = 27;

/** A context for board pages: UTC, no motion, every request outside the served files recorded in `denied` and blocked. */
export async function boardContext(browser: { newContext: (options: object) => Promise<BrowserContext> }, origin: string, denied: string[]): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light', reducedMotion: 'reduce' });
  await routeFinal(context, origin, denied);
  return context;
}

const drawn = ({ theme, width, height }: { theme: string; width: number; height: number }) => {
  const frame = document.querySelector('[data-theme]');
  if (!frame || document.querySelector('.sc-placeholder, .sc-missing, .sc-logic-error, .sc-placeholder-error')) return false;
  const rect = frame.getBoundingClientRect();
  return frame.getAttribute('data-theme') === theme && Math.round(rect.width) === width && Math.round(rect.height) === height;
};

/**
 * Opens the board on one state in a new page of the context, and returns it once the board is drawn and still:
 * the frame is the variant's size, fonts are loaded, and the board's timers (up to 1.5 s after its mount) have run.
 * The caller closes the page.
 */
export async function openBoard(context: BrowserContext, origin: string, part: string, sid: string, variant: Variant): Promise<Page> {
  const { theme, width, height, vi } = variants[variant], page = await context.newPage();
  await page.setViewportSize({ width: width + 120, height: height + 120 });
  await page.clock.install({ time: finalNow });
  const params = new URLSearchParams({ part, sid, th: theme, vi: String(vi) });
  await page.goto(`${origin}/final/${encodeURIComponent(hostName)}?${params}`);
  // Babel compiles the board in real time; the fake clock only moves a little at a time while it does, so the board's
  // mount-relative timers (the first fires 60 ms after the mount) start from the moment the frame appears, whatever the machine's speed.
  const deadline = Date.now() + 120_000;
  while (!await page.evaluate(drawn, { theme, width, height })) {
    if (Date.now() > deadline) throw new Error(`the board did not draw ${part} ${sid} ${theme} ${width}`);
    await page.clock.runFor(8);
    await page.waitForTimeout(10);
  }
  // The board measures its text when its first timer fires (the dock's height, the Map's scroll), so the fonts must be in
  // before the clock moves again: otherwise the result depends on whether they loaded in time.
  await page.evaluate(() => document.fonts.ready);
  await flush(page);
  // The board also sizes itself from what it measures (resize observers fire in real time, not on the fake clock): give it
  // a real moment to take those measurements before its first timer fires, so the timer always sees the same layout.
  await page.waitForTimeout(300);
  await flush(page);
  for (let elapsed = 0; elapsed < 2400; elapsed += 50) { await page.clock.runFor(50); await flush(page); }
  return page;
}

/** Lets the page run its pending real-time work (React's renders, image and font decoding) before the fake clock moves on. */
async function flush(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    for (let hop = 0; hop < 3; hop++) await new Promise<void>(resolve => { const channel = new MessageChannel(); channel.port1.onmessage = () => resolve(); channel.port2.postMessage(0); });
  });
}

/** The board frame of the open page, as a PNG of exactly the variant's size. */
export async function boardFrame(page: Page, variant: Variant): Promise<Buffer> {
  const { width, height } = variants[variant];
  const box = await page.locator('[data-theme]').first().evaluate(node => { const rect = node.getBoundingClientRect(); return { x: rect.x + window.scrollX, y: rect.y + window.scrollY }; });
  return page.screenshot({ animations: 'disabled', clip: { x: Math.round(box.x), y: Math.round(box.y), width, height } });
}

/** Renders one state of the board: open, check nothing outside the served files was asked for, return the frame. */
export async function renderBoard(context: BrowserContext, origin: string, state: Pick<FinalState, 'part' | 'sid'>, variant: Variant, denied: readonly string[]): Promise<Buffer> {
  const page = await openBoard(context, origin, state.part, state.sid, variant);
  try {
    const png = await boardFrame(page, variant);
    expect(denied, 'the board asked for nothing outside its own files').toEqual([]);
    return png;
  } finally { await page.close(); }
}

/** Fonts, then two frames of stillness, for the app's page (which runs on real time). */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(resolve => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), 300));
  });
}
