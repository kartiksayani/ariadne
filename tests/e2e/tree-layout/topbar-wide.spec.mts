// The window minimum is 1100 wide (alpha.22 E3, was 1300). The top bar keeps its wide form from 1100 up (narrow is below 1100), so
// it must hold every control, without overflow or overlap, across 1100-1299, the widths no one drew a board for.
import { test, expect } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import type { Server } from 'node:http';

for (const width of [1100, 1200, 1299]) {
  test(`the wide top bar holds every control without overflow or overlap at ${width} wide`, async ({ page }) => {
    const server = await createServer({ configFile: false, root: resolve('.'), publicDir: resolve('apps/desktop/public'), plugins: [react()],
      logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
    try {
      await server.listen();
      const address = (server.httpServer as Server).address();
      if (!address || typeof address === 'string') throw new Error('Missing layout fixture server address');
      const origin = `http://127.0.0.1:${address.port}`;
      await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
      await page.setViewportSize({ width, height: 700 });
      await page.goto(`${origin}/tests/e2e/tree-layout/fixture.html?still`);
      const bar = page.getByRole('banner');
      await expect(bar).toBeVisible();
      await expect(bar).not.toHaveClass(/tb-narrow/);
      await page.evaluate(async () => { await document.fonts.ready; });
      const placed = await bar.evaluate(element => {
        const edge = element.getBoundingClientRect();
        const controls = [...element.querySelectorAll<HTMLElement>('button, [role="search"]')].filter(control => control.getClientRects().length > 0)
          .map(control => { const box = control.getBoundingClientRect(); return { name: control.getAttribute('aria-label') ?? control.textContent ?? '', left: box.left, right: box.right }; });
        return { scroll: element.scrollWidth, client: element.clientWidth, left: edge.left, right: edge.right, controls };
      });
      expect(placed.scroll, 'the bar does not scroll sideways').toBeLessThanOrEqual(placed.client);
      expect(placed.controls.length).toBeGreaterThan(6);
      const ordered = [...placed.controls].sort((a, b) => a.left - b.left);
      for (const [index, control] of ordered.entries()) {
        expect(control.left, `${control.name} starts inside the bar`).toBeGreaterThanOrEqual(placed.left);
        expect(control.right, `${control.name} ends inside the bar`).toBeLessThanOrEqual(placed.right);
        if (index > 0) expect(control.left, `${control.name} does not overlap ${ordered[index - 1]!.name}`).toBeGreaterThanOrEqual(ordered[index - 1]!.right - 0.5);
      }
    } finally { await server.close(); }
  });
}
