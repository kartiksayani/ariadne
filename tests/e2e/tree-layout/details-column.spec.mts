// The Details column in a real browser: where it sits and how wide, its 36px rail, its resize edge, and that the open dock
// never covers any of it. The fixture is the real shell with the real column and the detail's own CSS (fixture.tsx, `?details`).
import { test, expect, type Page } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import type { Server } from 'node:http';

async function withFixture(page: Page, query: string, size: { width: number; height: number }, run: () => Promise<void>) {
  const server = await createServer({ configFile: false, root: resolve('.'), publicDir: resolve('apps/desktop/public'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  try {
    await server.listen();
    const address = (server.httpServer as Server).address();
    if (!address || typeof address === 'string') throw new Error('Missing layout fixture server address');
    const origin = `http://127.0.0.1:${address.port}`;
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
    await page.setViewportSize(size);
    await page.goto(`${origin}/tests/e2e/tree-layout/fixture.html?${query}`);
    await expect(page.locator('.shell-detail')).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });
    await run();
  } finally { await server.close(); }
}

const box = async (page: Page, selector: string) => (await page.locator(selector).boundingBox())!;
const WIDE = { width: 1280, height: 800 }, NARROW = { width: 900, height: 650 };

for (const [name, size, expected] of [['wide', WIDE, 400], ['narrow', NARROW, 340]] as const) {
  test(`Details sits beside the Map at ${expected}px in a ${name} window, with the Map left of it and the same height`, async ({ page }) => {
    await withFixture(page, 'details', size, async () => {
      const side = await box(page, '.shell-detail'), map = await box(page, '.shell-center');
      expect(side.width).toBe(expected);
      expect(side.x + side.width).toBe(size.width);
      expect(map.x + map.width).toBeLessThanOrEqual(side.x);
      expect(side.y).toBe(map.y);
      expect(side.height).toBe(map.height);
      expect(await page.locator('.shell-body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    });
  });
}

test('Details follows the window across the breakpoint without a reload', async ({ page }) => {
  await withFixture(page, 'details', WIDE, async () => {
    expect((await box(page, '.shell-detail')).width).toBe(400);
    await page.setViewportSize(NARROW);
    await expect.poll(async () => (await box(page, '.shell-detail')).width).toBe(340);
    await page.setViewportSize(WIDE);
    await expect.poll(async () => (await box(page, '.shell-detail')).width).toBe(400);
  });
});

test('Details folds to a 36px rail and unfolds from a click on the rail, keeping its scroll position', async ({ page }) => {
  await withFixture(page, 'details', WIDE, async () => {
    const body = page.locator('.detail-body');
    await body.evaluate(element => { element.scrollTop = 300; });
    const scrolled = await body.evaluate(element => element.scrollTop);
    expect(scrolled).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Fold Details' }).click();
    await expect.poll(async () => (await box(page, '.shell-detail')).width).toBe(36);
    const rail = page.getByRole('button', { name: 'Show Details' });
    await expect(rail).toBeVisible();
    // The rail fills the strip and reads "Details" on its side; the content stays out of sight.
    const strip = await box(page, '.shell-detail'), railBox = (await rail.boundingBox())!;
    // The strip's divider is an inset shadow, as on the board, so the rail spans the whole strip.
    expect(railBox.width).toBe(strip.width);
    expect(railBox.height).toBeGreaterThan(300);
    expect(await page.locator('.shell-detail-rail-label').evaluate(element => getComputedStyle(element).writingMode)).toBe('vertical-rl');
    await expect(page.locator('.detail-body')).toBeHidden();
    const map = await box(page, '.shell-center');
    expect(map.x + map.width).toBeLessThanOrEqual(strip.x);
    expect(strip.x + strip.width).toBe(WIDE.width);
    await rail.click();
    await expect.poll(async () => (await box(page, '.shell-detail')).width).toBe(400);
    await expect(page.locator('.detail-body')).toBeVisible();
    expect(await body.evaluate(element => element.scrollTop)).toBe(scrolled);
  });
});

test('Details keeps its folded state through a reload', async ({ page }) => {
  await withFixture(page, 'details', WIDE, async () => {
    await page.getByRole('button', { name: 'Fold Details' }).click();
    await expect.poll(async () => (await box(page, '.shell-detail')).width).toBe(36);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Show Details' })).toBeVisible();
    expect((await box(page, '.shell-detail')).width).toBe(36);
  });
});

test('Details resizes from an 8px edge on its left, by drag and by keys, inside the window range', async ({ page }) => {
  await withFixture(page, 'details', WIDE, async () => {
    const edge = page.getByRole('separator', { name: 'Resize detail panel' });
    const handle = (await edge.boundingBox())!, side = await box(page, '.shell-detail');
    expect(handle.width).toBe(8);
    // left: -4px from the column's padding edge, inside its 1px divider.
    expect(handle.x).toBe(side.x - 3);
    expect(handle.height).toBe(side.height);
    await expect(edge).toHaveCSS('cursor', 'col-resize');
    const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 120, y, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await box(page, '.shell-detail')).width).toBe(520);
    await edge.focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await box(page, '.shell-detail')).width).toBe(536);
    await page.keyboard.press('Home');
    await expect.poll(async () => (await box(page, '.shell-detail')).width).toBe(320);
    await page.keyboard.press('End');
    // The most is the window less 480.
    await expect.poll(async () => (await box(page, '.shell-detail')).width).toBe(WIDE.width - 480);
    expect(await page.locator('.shell-body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  });
});

test('Details in a narrow window goes down to 280, and no lower', async ({ page }) => {
  await withFixture(page, 'details', NARROW, async () => {
    const edge = page.getByRole('separator', { name: 'Resize detail panel' });
    await edge.focus();
    await page.keyboard.press('Home');
    await expect.poll(async () => (await box(page, '.shell-detail')).width).toBe(280);
    await page.keyboard.press('ArrowRight');
    expect((await box(page, '.shell-detail')).width).toBe(280);
    await page.keyboard.press('End');
    await expect.poll(async () => (await box(page, '.shell-detail')).width).toBe(NARROW.width - 380);
  });
});

// The dock floats over the bottom of the window. Everything in Details stays above it: the conversation scrolls above the
// composer, and the composer is the last thing above the dock.
for (const dock of [0, 40, 200, 400]) {
  test(`Details keeps its composer above a dock ${dock}px tall, and the conversation scrolls clear of it`, async ({ page }) => {
    await withFixture(page, `details&dock=${dock}`, WIDE, async () => {
      const floor = dock ? (await box(page, '[data-testid="dock"]')).y : WIDE.height;
      if (dock) expect((await box(page, '[data-testid="dock"]')).height).toBe(dock);
      const composer = await box(page, '.detail-dock'), scroll = page.locator('.detail-body');
      expect(composer.y + composer.height).toBeLessThanOrEqual(floor);
      expect((await box(page, '.shell-detail-scroll')).y + (await box(page, '.shell-detail-scroll')).height).toBeLessThanOrEqual(floor);
      expect((await box(page, '.detail-body')).y + (await box(page, '.detail-body')).height).toBeLessThanOrEqual(composer.y + 0.5);
      // The conversation scrolls, to its last message, which ends above the composer.
      await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
      const last = await box(page, '.fixture-message:last-child');
      expect(last.y + last.height).toBeLessThanOrEqual(composer.y + 0.5);
      // No control in the column sits under the dock.
      const covered = await page.locator('.shell-detail').evaluate((column, top) => [...column.querySelectorAll('textarea, button')]
        .filter(element => element.getBoundingClientRect().bottom > top).map(element => element.textContent || element.tagName), floor);
      expect(covered).toEqual([]);
      // Typing in the composer works with the dock open.
      await page.getByRole('textbox', { name: 'Reply' }).fill('Still reachable');
      await expect(page.getByRole('textbox', { name: 'Reply' })).toHaveValue('Still reachable');    });
  });
}

test('Details folded to the rail ends above the dock too, and the dock floats across the full width over it', async ({ page }) => {
  await withFixture(page, 'details&dock=200', WIDE, async () => {
    await page.getByRole('button', { name: 'Fold Details' }).click();
    await expect.poll(async () => (await box(page, '.shell-detail')).width).toBe(36);
    const dock = await box(page, '[data-testid="dock"]'), rail = (await page.getByRole('button', { name: 'Show Details' }).boundingBox())!;
    expect(rail.y + rail.height).toBeLessThanOrEqual(dock.y);
    expect(dock.x).toBe(0);
    expect(dock.width).toBe(WIDE.width);
  });
});

// The bigger view takes the Map's place and the dock still floats over it: its composer stays above the dock.
for (const dock of [40, 200, 400]) {
  test(`The bigger view keeps its composer above a dock ${dock}px tall`, async ({ page }) => {
    await withFixture(page, `details&bigger&dock=${dock}`, WIDE, async () => {
      const floor = (await box(page, '[data-testid="dock"]')).y;
      const view = await box(page, '.shell-conversation'), composer = await box(page, '[data-testid="bigger-composer"]');
      expect(view.y + view.height).toBe(floor);
      expect(composer.y + composer.height).toBeLessThanOrEqual(floor);
      await page.getByRole('textbox', { name: 'Reply in the bigger view' }).fill('Still reachable');
      await expect(page.getByRole('textbox', { name: 'Reply in the bigger view' })).toHaveValue('Still reachable');
    });
  });
}
