// A refresh never blocks what the owner just did (alpha.23 F1). A row click opens from the copy on screen: a session read held
// for 6 s (past the 5 s budget the old click joined) neither delays the open nor shows "still loading".
import { test, expect, type Page } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import type { Server } from 'node:http';

const agent = (page: Page, change: string) => page.evaluate(value => (window as unknown as { treeLayout: { agent(change: string): void } }).treeLayout.agent(value), change);

async function serve(run: (origin: string) => Promise<void>) {
  const server = await createServer({ configFile: false, root: resolve('.'), publicDir: resolve('apps/desktop/public'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  try {
    await server.listen();
    const address = (server.httpServer as Server).address();
    if (!address || typeof address === 'string') throw new Error('Missing layout fixture server address');
    await run(`http://127.0.0.1:${address.port}`);
  } finally { await server.close(); }
}

async function open(page: Page, origin: string) {
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(`${origin}/tests/e2e/tree-layout/fixture.html?still`);
  await page.locator('[data-popover-trigger="switcher"]').click();
  await page.getByRole('dialog', { name: 'Switch session or project' }).getByRole('button', { name: 'All sessions' }).click();
  const session = page.locator('button[data-session-id]').first();
  await expect(session).toBeEnabled(); await session.click();
  await expect(page.getByRole('region', { name: 'Session tree' })).toHaveAttribute('data-session-busy', 'false');
  const close = page.getByRole('button', { name: 'Close detail' });
  if (await close.count()) await close.click();
}

for (const how of ['click', 'Enter'] as const) {
  test(`a row opens within a second while the session read is held for 6 s (${how})`, async ({ page }) => {
    test.setTimeout(30_000);
    await serve(async origin => {
      await open(page, origin);
      await agent(page, 'read-hold');
      await expect(page.getByRole('region', { name: 'Session tree' })).toHaveAttribute('data-session-status', 'stale');
      const row = page.locator('[role="treeitem"][data-item-id]').nth(2);
      const id = (await row.getAttribute('data-item-id'))!;
      if (how === 'click') await row.click(); else { await row.focus(); await page.keyboard.press('Enter'); }
      await expect(page.locator(`[data-detail-item-id="${id}"]`)).toBeVisible({ timeout: 1000 });
      // The read is still held, and the budget passes without a refusal.
      await expect(page.getByRole('region', { name: 'Session tree' })).toHaveAttribute('data-session-status', 'stale');
      await page.waitForTimeout(5200);
      await expect(page.getByText(/could not be opened/)).toHaveCount(0);
      await expect(page.locator(`[data-detail-item-id="${id}"]`)).toBeVisible();
      await agent(page, 'read-release');
    });
  });
}
