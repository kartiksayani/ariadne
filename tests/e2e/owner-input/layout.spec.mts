import { test, expect } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import type { Server } from 'node:http';

test('keeps saved owner controls below complete history in the ordinary App', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const server = await createServer({ configFile: false, root: resolve('.'), publicDir: resolve('apps/desktop/public'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  try {
    await server.listen();
    const address = (server.httpServer as Server).address();
    if (!address || typeof address === 'string') throw new Error('Missing layout fixture server address');
    const origin = `http://127.0.0.1:${address.port}`;
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
    await page.goto(`${origin}/tests/e2e/owner-input/fixture.html`);
    const session = page.locator('button[data-session-id]').first();
    await expect(session).toBeEnabled(); await session.click();
    await expect(page.getByRole('button', { name: 'Pause dispatch' })).toBeEnabled();
    await page.locator('[data-item-id="2"]').click();
    const detail = page.locator('.ref-detail-scroll'), history = detail.locator('.item-history');
    await expect(history.getByRole('heading', { name: 'Which native delivery window should we use?', level: 3 })).toBeVisible();
    await detail.getByLabel('Reply in your own words').fill('Use the saved native delivery option.');
    await detail.getByRole('button', { name: 'Send answer', exact: true }).click();
    const receipt = detail.getByRole('status').filter({ hasText: 'Saved · Queue position' });
    const another = detail.getByRole('button', { name: 'Write another input' });
    await expect(receipt).toBeVisible(); await expect(another).toBeEnabled();
    // Check actual rectangles at the reported size, the supported minimum and
    // the wide workspace, including a shorter window that requires scrolling.
    for (const viewport of [{ width: 900, height: 650 }, { width: 1000, height: 700 }, { width: 1600, height: 960 }, { width: 1000, height: 500 }]) {
      await page.setViewportSize(viewport);
      await page.locator('.ref-workspace-scroll').evaluate(element => { element.scrollLeft = element.scrollWidth; });
      await another.scrollIntoViewIfNeeded();
      const historyBox = (await history.boundingBox())!, receiptBox = (await receipt.boundingBox())!, buttonBox = (await another.boundingBox())!;
      expect(receiptBox.y, `receipt below history at ${viewport.width}×${viewport.height}`).toBeGreaterThanOrEqual(historyBox.y + historyBox.height);
      expect(buttonBox.y, `button below receipt at ${viewport.width}×${viewport.height}`).toBeGreaterThanOrEqual(receiptBox.y + receiptBox.height);
      for (const content of await history.locator('h2, h3, .history-body, .history-options').all()) {
        const box = (await content.boundingBox())!;
        expect(box.y + box.height, `history content above receipt at ${viewport.width}×${viewport.height}`).toBeLessThanOrEqual(receiptBox.y);
      }
      if (viewport.width === 1000 && viewport.height === 700) await page.screenshot({ path: testInfo.outputPath('saved-answer.png') });
    }
    await another.click();
    await expect(detail.getByLabel('Reply in your own words')).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});
