// ⌥↑ / ⌥↓ scroll Details in a real browser: a tap is one eased step of at most a tenth of the panel, a hold is a smooth constant
// scroll with no jump, and key up stops it. The fixture is the real shell, column and detail CSS with the App root's own key
// handler (fixture.tsx, `?details`), so layout, smooth-scroll CSS and requestAnimationFrame are the browser's.
import { test, expect, type Locator, type Page } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import type { Server } from 'node:http';

// The suite runs with reduced motion on; the animated scroll is what the owner has by default, so most tests turn it off.
async function withFixture(page: Page, query: string, run: () => Promise<void>, reducedMotion: 'reduce' | 'no-preference' = 'no-preference') {
  const server = await createServer({ configFile: false, root: resolve('.'), publicDir: resolve('apps/desktop/public'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  try {
    await server.listen();
    const address = (server.httpServer as Server).address();
    if (!address || typeof address === 'string') throw new Error('Missing layout fixture server address');
    const origin = `http://127.0.0.1:${address.port}`;
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
    await page.emulateMedia({ reducedMotion });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${origin}/tests/e2e/tree-layout/fixture.html?${query}`);
    // The bigger view covers the column (it leaves the accessibility tree), so wait on whichever body shows.
    await expect(page.getByTestId('detail-body').last()).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });
    await run();
  } finally { await server.close(); }
}

const column = (page: Page) => page.getByRole('complementary', { name: 'Item detail' }).getByTestId('detail-body');
const bigger = (page: Page) => page.getByTestId('bigger-view').getByTestId('detail-body');

/** Records the scroll position of `body` on every frame, until `stopRecording`. */
const record = (body: Locator) => body.evaluate(element => {
  const frames: number[] = [element.scrollTop], state = { on: true };
  const tick = () => { frames.push(element.scrollTop); if (state.on) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  (window as unknown as { recorded: { frames: number[]; state: { on: boolean } } }).recorded = { frames, state };
});
const stopRecording = (page: Page) => page.evaluate(() => {
  const recorded = (window as unknown as { recorded: { frames: number[]; state: { on: boolean } } }).recorded;
  recorded.state.on = false; return recorded.frames;
});
const visible = (body: Locator) => body.evaluate(element => element.clientHeight);
const top = (body: Locator) => body.evaluate(element => element.scrollTop);

for (const [name, query, body, focus] of [
  ['the Details column', 'details', column, (page: Page) => page.getByRole('button', { name: 'Map' })],
  ['the bigger view', 'details&bigger', bigger, (page: Page) => page.getByTestId('bigger-view')],
] as const) {
  test(`a tap of ⌥↓ then ⌥↑ moves ${name} by at most a tenth of its height each way, and rests`, async ({ page }) => {
    await withFixture(page, query, async () => {
      const scroller = body(page), height = await visible(scroller);
      await focus(page).focus();
      await record(scroller);
      await page.keyboard.down('Alt'); await page.keyboard.down('ArrowDown'); await page.keyboard.up('ArrowDown');
      await page.waitForTimeout(600);
      const down = await top(scroller);
      expect(down).toBeGreaterThan(0.04 * height);
      expect(down).toBeLessThanOrEqual(0.1 * height);
      await page.keyboard.down('ArrowUp'); await page.keyboard.up('ArrowUp'); await page.keyboard.up('Alt');
      await page.waitForTimeout(600);
      const back = await top(scroller);
      expect(back).toBeLessThan(down);
      expect(down - back).toBeLessThanOrEqual(0.1 * height);
      const frames = await stopRecording(page);
      // Eased: no frame jumps by more than 5% of the height.
      for (let index = 1; index < frames.length; index++) expect(Math.abs(frames[index]! - frames[index - 1]!)).toBeLessThan(0.05 * height);
      // At rest afterwards.
      await page.waitForTimeout(200);
      expect(await top(scroller)).toBe(back);
    });
  });

  test(`holding ⌥↓ scrolls ${name} smoothly and steadily, and key up stops it`, async ({ page }) => {
    await withFixture(page, query, async () => {
      const scroller = body(page), height = await visible(scroller);
      await focus(page).focus();
      await record(scroller);
      await page.keyboard.down('Alt'); await page.keyboard.down('ArrowDown');
      await page.waitForTimeout(1200);
      await page.keyboard.up('ArrowDown'); await page.keyboard.up('Alt');
      await page.waitForTimeout(500);
      const frames = await stopRecording(page);
      const end = frames.at(-1)!;
      // About half the visible height a second, less the ease-in, with room for a slow machine.
      expect(end).toBeGreaterThan(0.2 * height);
      expect(end).toBeLessThan(0.8 * height);
      expect(frames.every((value, index) => index === 0 || value >= frames[index - 1]!)).toBe(true);
      const gaps = frames.slice(1).map((value, index) => value - frames[index]!);
      // Several distinct frames moved it: it was driven continuously, not stepped or jumped.
      expect(gaps.filter(gap => gap > 0).length).toBeGreaterThan(20);
      expect(Math.max(...gaps)).toBeLessThan(0.05 * height);
      // Stopped: the last half-second of recording is flat.
      const settled = frames.slice(-20);
      expect(Math.max(...settled) - Math.min(...settled)).toBe(0);
    });
  });
}

test('with reduced motion ⌥↓ moves Details one step of 9% and a held key does not creep', async ({ page }) => {
  await withFixture(page, 'details', async () => {
    const scroller = column(page), height = await visible(scroller);
    await page.getByRole('button', { name: 'Map' }).focus();
    await page.keyboard.down('Alt'); await page.keyboard.down('ArrowDown');
    await page.waitForTimeout(500);
    await page.keyboard.up('ArrowDown'); await page.keyboard.up('Alt');
    expect(await top(scroller)).toBe(Math.round(0.09 * height));
  }, 'reduce');
});

test('⌥↓ in a text box leaves Details where it is', async ({ page }) => {
  await withFixture(page, 'details', async () => {
    await page.getByRole('textbox', { name: 'Reply' }).focus();
    await page.keyboard.down('Alt'); await page.keyboard.down('ArrowDown');
    await page.waitForTimeout(400);
    await page.keyboard.up('ArrowDown'); await page.keyboard.up('Alt');
    expect(await top(column(page))).toBe(0);
  });
});

test('⌥↓ stops at the end of a short panel instead of running on', async ({ page }) => {
  await withFixture(page, 'details', async () => {
    const scroller = column(page);
    await page.getByRole('button', { name: 'Map' }).focus();
    await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const end = await top(scroller);
    await page.keyboard.down('Alt'); await page.keyboard.down('ArrowDown');
    await page.waitForTimeout(500);
    await page.keyboard.up('ArrowDown'); await page.keyboard.up('Alt');
    expect(await top(scroller)).toBe(end);
  });
});
