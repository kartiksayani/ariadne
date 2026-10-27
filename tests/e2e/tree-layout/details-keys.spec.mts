// ⌥↑ / ⌥↓ scroll Details in a real browser: a tap is one eased step of at most a tenth of the panel, a hold is a smooth constant
// scroll with no jump, and key up stops it. The fixture is the real shell, column and detail CSS with the App root's own key
// handler (fixture.tsx, `?details`), so layout, smooth-scroll CSS and requestAnimationFrame are the browser's.
import { test, expect, type Locator, type Page } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import type { Server } from 'node:http';

// The suite runs with reduced motion on; the animated scroll is what the owner has by default, so most tests turn it off.
async function withFixture(page: Page, query: string, run: () => Promise<void>, reducedMotion: 'reduce' | 'no-preference' = 'no-preference', frameMs = 0) {
  const server = await createServer({ configFile: false, root: resolve('.'), publicDir: resolve('apps/desktop/public'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  try {
    await server.listen();
    const address = (server.httpServer as Server).address();
    if (!address || typeof address === 'string') throw new Error('Missing layout fixture server address');
    const origin = `http://127.0.0.1:${address.port}`;
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
    // A slow machine (CI runners draw well under 60 frames a second) is a page whose frames come every `frameMs`: CPU throttling
    // alone leaves the frame rate at 60, so the page's own requestAnimationFrame is what is slowed.
    if (frameMs > 0) await page.addInitScript(ms => {
      const ids = new Map<number, number>(); let next = 1;
      window.requestAnimationFrame = callback => { const id = next++; ids.set(id, window.setTimeout(() => { ids.delete(id); callback(performance.now()); }, ms)); return id; };
      window.cancelAnimationFrame = id => { clearTimeout(ids.get(id)); ids.delete(id); };
    }, frameMs);
    await page.emulateMedia({ reducedMotion });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${origin}/tests/e2e/tree-layout/fixture.html?${query}`);
    // The bigger view covers the column (it leaves the accessibility tree), so wait on whichever body shows.
    await expect((query.includes('closed') ? page.getByTestId('map-scroll') : page.getByTestId('detail-body').last())).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });
    await run();
  } finally { await server.close(); }
}

const column = (page: Page) => page.getByRole('complementary', { name: 'Item detail' }).getByTestId('detail-body');
const bigger = (page: Page) => page.getByTestId('bigger-view').getByTestId('detail-body');

interface Recorded { frames: number[]; times: number[]; upAt: number | null; state: { on: boolean } }
/** Records the scroll position of `body` and the time on every frame, and when the first key came up, until `stopRecording`. */
const record = (body: Locator) => body.evaluate(element => {
  const recorded: Recorded = { frames: [element.scrollTop], times: [performance.now()], upAt: null, state: { on: true } };
  const tick = () => { recorded.frames.push(element.scrollTop); recorded.times.push(performance.now()); if (recorded.state.on) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  window.addEventListener('keyup', () => { recorded.upAt ??= performance.now(); }, true);
  (window as unknown as { recorded: Recorded }).recorded = recorded;
});
const stopRecording = (page: Page) => page.evaluate(() => {
  const recorded = (window as unknown as { recorded: Recorded }).recorded;
  recorded.state.on = false; return { frames: recorded.frames, times: recorded.times, upAt: recorded.upAt };
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
      const { frames } = await stopRecording(page);
      // Eased: no frame jumps by more than 5% of the height.
      for (let index = 1; index < frames.length; index++) expect(Math.abs(frames[index]! - frames[index - 1]!)).toBeLessThan(0.05 * height);
      // At rest afterwards.
      await page.waitForTimeout(200);
      expect(await top(scroller)).toBe(back);
    });
  });

  // Judged by the clock, not by counting frames: a CI runner draws far fewer than 60 a second, so the same hold is run on a page
  // whose frames come every 100 ms as well.
  for (const [pace, frameMs] of [['', 0], [' when frames are slow (10 a second)', 100]] as const) {
    test(`holding ⌥↓ scrolls ${name} smoothly and steadily, and key up stops it${pace}`, async ({ page }) => {
      await withFixture(page, query, async () => {
        const scroller = body(page), height = await visible(scroller);
        await focus(page).focus();
        await record(scroller);
        await page.keyboard.down('Alt'); await page.keyboard.down('ArrowDown');
        await page.waitForTimeout(1200);
        await page.keyboard.up('ArrowDown'); await page.keyboard.up('Alt');
        await page.waitForTimeout(1000);
        const { frames, times, upAt } = await stopRecording(page);
        expect(upAt).not.toBeNull();
        const end = frames.at(-1)!;
        // About half the visible height a second, less the ease-in; slow frames cover less, never more.
        expect(end).toBeGreaterThan(0.1 * height);
        expect(end).toBeLessThan(0.8 * height);
        expect(frames.every((value, index) => index === 0 || value >= frames[index - 1]!)).toBe(true);
        const gaps = frames.slice(1).map((value, index) => value - frames[index]!);
        // It was driven frame by frame, not stepped or jumped.
        expect(gaps.filter(gap => gap > 0).length).toBeGreaterThan(5);
        expect(Math.max(...gaps)).toBeLessThan(0.05 * height);
        // Steady: from 0.5 s in until the key came up, nearly every frame moved it.
        const first = times[frames.findIndex(value => value > 0)]!;
        const cruising = gaps.filter((_, index) => times[index + 1]! >= first + 500 && times[index + 1]! <= upAt!);
        expect(cruising.length).toBeGreaterThan(3);
        expect(cruising.filter(gap => gap > 0).length).toBeGreaterThanOrEqual(0.9 * cruising.length);
        // Key up stops it within 250 ms (and the length of the longest frame, which is when a stop can first be drawn):
        // from then on every frame shows the same position, however many frames that is.
        const longest = Math.max(...times.slice(1).map((time, index) => time >= first ? time - times[index]! : 0));
        const settled = frames.filter((_, index) => times[index]! >= upAt! + 250 + longest);
        expect(settled.length).toBeGreaterThan(2);
        expect(Math.max(...settled) - Math.min(...settled)).toBe(0);
      }, 'no-preference', frameMs);
    });
  }
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

// WebKit's own ⌥↓ pages the focused scroller, here the Map, and a held key repeats it ~30 times a second. Playwright's held key
// sends no repeats, so the repeats are dispatched explicitly: each must be consumed (defaultPrevented) and the Map must not move,
// wherever the hold's scroll stands.
const map = (page: Page) => page.getByTestId('map-scroll');
/** A ⌥-arrow keydown on the focused element, as the OS key-repeat sends it; whether the workspace consumed it. */
const keydown = (page: Page, key: 'ArrowUp' | 'ArrowDown', repeat: boolean) => page.evaluate(([name, again]) => {
  const event = new KeyboardEvent('keydown', { key: name as string, code: name as string, altKey: true, repeat: again as boolean, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event.defaultPrevented;
}, [key, repeat]);
async function repeatsAreConsumed(page: Page) {
  const scroller = map(page);
  expect(await scroller.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(500);
  for (let count = 0; count < 5; count++) {
    expect(await keydown(page, 'ArrowDown', true)).toBe(true);
    expect(await keydown(page, 'ArrowUp', true)).toBe(true);
  }
  await page.waitForTimeout(300);
  expect(await top(scroller)).toBe(0);
}

test('held ⌥↓ repeats are consumed after the scroll reached the end of Details, and the Map stays', async ({ page }) => {
  await withFixture(page, 'details', async () => {
    const scroller = column(page);
    await page.getByRole('button', { name: 'Map' }).focus();
    await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const end = await top(scroller);
    await page.keyboard.down('Alt'); await page.keyboard.down('ArrowDown');
    await page.waitForTimeout(400);
    expect(await keydown(page, 'ArrowDown', false)).toBe(true);
    await repeatsAreConsumed(page);
    await page.keyboard.up('ArrowDown'); await page.keyboard.up('Alt');
    expect(await top(scroller)).toBe(end);
  });
});

test('⌥↓ and its repeats are consumed with Details closed, and the Map stays', async ({ page }) => {
  await withFixture(page, 'details&closed', async () => {
    await page.getByRole('button', { name: 'Map' }).focus();
    expect(await keydown(page, 'ArrowDown', false)).toBe(true);
    await repeatsAreConsumed(page);
  });
});

test('⌥↓ and its repeats are consumed with Details folded, and the Map stays', async ({ page }) => {
  await withFixture(page, 'details', async () => {
    await page.getByRole('button', { name: 'Fold Details' }).click();
    await expect(page.getByRole('button', { name: 'Show Details' })).toBeVisible();
    await page.getByRole('button', { name: 'Map' }).focus();
    expect(await keydown(page, 'ArrowDown', false)).toBe(true);
    await repeatsAreConsumed(page);
  });
});

test('with reduced motion the repeats of ⌥↓ are consumed, Details moves one step only, and the Map stays', async ({ page }) => {
  await withFixture(page, 'details', async () => {
    const scroller = column(page), height = await visible(scroller);
    await page.getByRole('button', { name: 'Map' }).focus();
    expect(await keydown(page, 'ArrowDown', false)).toBe(true);
    await repeatsAreConsumed(page);
    expect(await top(scroller)).toBe(Math.round(0.09 * height));
  }, 'reduce');
});

test('the repeats of a held ⌥↓ are consumed after the wheel scrolled Details away from the hold, and the Map stays', async ({ page }) => {
  await withFixture(page, 'details', async () => {
    const scroller = column(page);
    await page.getByRole('button', { name: 'Map' }).focus();
    await page.keyboard.down('Alt'); await page.keyboard.down('ArrowDown');
    await page.waitForTimeout(250);
    const box = (await scroller.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(600);
    const away = await top(scroller);
    expect(away).toBeGreaterThan(300);
    await repeatsAreConsumed(page);
    expect(await top(scroller)).toBe(away);
    await page.keyboard.up('ArrowDown'); await page.keyboard.up('Alt');
  });
});
