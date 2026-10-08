import { test, expect, type Page } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import type { Server } from 'node:http';

// Real-browser checks of the session tree's layout promises: a long preview folds to
// six lines, hovering a row never rewraps its text, and clicking a row never scrolls.
async function openTree(page: Page, origin: string) {
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(`${origin}/tests/e2e/tree-layout/fixture.html`);
  await page.locator('[data-shell-tab="projects"]').click();
  await page.locator('.pw-project-open').first().click();
  const session = page.locator('button[data-session-id]').first();
  await expect(session).toBeEnabled(); await session.click();
  await expect(page.locator('.tree-session-bar').getByRole('button', { name: 'Close session' })).toBeEnabled();
}

test('folds a long preview to six lines, never rewraps on hover and never scrolls on a click', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const server = await createServer({ configFile: false, root: resolve('.'), publicDir: resolve('apps/desktop/public'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  try {
    await server.listen();
    const address = (server.httpServer as Server).address();
    if (!address || typeof address === 'string') throw new Error('Missing layout fixture server address');
    await openTree(page, `http://127.0.0.1:${address.port}`);

    // Six lines, a Show more control, and the title whole.
    const first = page.locator('.tree-item[data-item-id="1"]');
    const text = first.locator('.tree-clamp'), line = await text.evaluate(element => parseFloat(getComputedStyle(element).lineHeight));
    const folded = (await text.boundingBox())!.height;
    expect(folded).toBeLessThanOrEqual(line * 6 + 1); expect(folded).toBeGreaterThanOrEqual(line * 5);
    await expect(first.getByRole('button', { name: 'Show more' })).toBeVisible();
    await expect(page.locator('.tree-item[data-item-id="5"]').getByRole('button', { name: /^Show / })).toHaveCount(0);
    await first.getByRole('button', { name: 'Show more' }).click();
    expect((await text.boundingBox())!.height).toBeGreaterThan(line * 15);
    await first.getByRole('button', { name: 'Show less' }).click();
    expect((await text.boundingBox())!.height).toBeLessThanOrEqual(line * 6 + 1);

    // Hovering a row keeps its text column and its line count exactly as they were.
    const wrapped = page.locator('.tree-item[data-item-id="5"]'), body = wrapped.locator('.tree-body'), outcome = wrapped.locator('.tree-clamp');
    await page.mouse.move(0, 0);
    const width = (await body.boundingBox())!.width, height = (await outcome.boundingBox())!.height;
    await expect(wrapped.locator('.tree-actions')).toHaveCSS('opacity', '0');
    await wrapped.hover();
    await expect(wrapped.locator('.tree-actions')).toHaveCSS('opacity', '1');
    expect((await body.boundingBox())!.width).toBe(width); expect((await outcome.boundingBox())!.height).toBe(height);
    // A selected row is the same, with or without the pointer on it (selecting opens the detail, which narrows the tree).
    await wrapped.click(); await page.mouse.move(0, 0);
    await expect(wrapped).toHaveAttribute('aria-selected', 'true');
    await expect(wrapped.locator('.tree-actions')).toHaveCSS('opacity', '1');
    const selectedWidth = (await body.boundingBox())!.width, selectedHeight = (await outcome.boundingBox())!.height;
    await wrapped.hover();
    expect((await body.boundingBox())!.width).toBe(selectedWidth); expect((await outcome.boundingBox())!.height).toBe(selectedHeight);

    // A click on a row in view leaves the tree exactly where it was.
    const scroller = page.locator('.tree-scroll');
    const target = page.locator('.tree-item[data-item-id="3"]');
    await target.evaluate(element => element.scrollIntoView({ block: 'start' }));
    await scroller.evaluate(element => { element.scrollTop -= 120; });
    await expect(target).toBeInViewport({ ratio: 1 });
    const before = await scroller.evaluate(element => element.scrollTop);
    await target.click();
    await expect(target).toHaveAttribute('aria-selected', 'true');
    await page.waitForTimeout(400);
    expect(await scroller.evaluate(element => element.scrollTop)).toBe(before);
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});
