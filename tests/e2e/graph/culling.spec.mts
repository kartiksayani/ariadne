import { test, expect } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { Server } from 'node:http';

test('measures the actual 2,000-node SVG and preserves viewport, focus, selection and full Fit', async ({ page, browser }, testInfo) => {
  const repo = resolve('.'), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const server = await createServer({ configFile: false, root: repo, publicDir: resolve('apps/desktop/public'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  try {
    await server.listen(); const address = (server.httpServer as Server).address();
    if (!address || typeof address === 'string') throw new Error('Missing graph fixture server address');
    const origin = `http://127.0.0.1:${address.port}`;
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
    const start = Date.now(); await page.goto(`${origin}/tests/e2e/graph/fixture.html`);
    const canvas = page.getByLabel('Topic sentences'), nodes = page.locator('[data-graph-node]'), world = page.locator('[data-graph-world]');
    await expect(canvas).toBeVisible(); await expect(page.getByText(/2000 matching · 2000 in this topic/)).toBeVisible();
    const settle = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await settle(); const mountToSettledMs = Date.now() - start;
    const initial = await world.getAttribute('transform'), initialNodes = await nodes.count(), initialEdges = await page.locator('[data-edge]').count();
    expect(initialNodes).toBeGreaterThan(0); expect(initialNodes).toBeLessThan(200);
    await expect(page.locator('[data-edge="replacement:1.1:20.99"]')).toHaveCount(1);
    await expect(page.locator('[data-graph-node="1.1"], [data-graph-node="20.99"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Select off-screen item' }).click(); await settle();
    const selected = page.locator('[data-graph-node="20.99"]'); await expect(selected).toBeFocused();
    await expect(selected).toHaveAttribute('aria-pressed', 'true');
    const other = page.locator('[data-graph-node]:not([aria-pressed="true"])');
    const focusedId = await other.first().getAttribute('data-graph-node');
    await other.first().focus();
    const focused = page.locator(`[data-graph-node="${focusedId}"]`);
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + 5, box.y + 5); await page.mouse.down(); await page.mouse.move(box.x + 5, box.y + 300); await page.mouse.up();
    await settle(); await expect(focused).toBeFocused(); await expect(selected).toHaveCount(1);
    await page.mouse.wheel(0, -400); await settle(); await expect(focused).toBeFocused();
    await page.getByRole('button', { name: 'Fit', exact: true }).click(); await settle();
    await expect(world).toHaveAttribute('transform', initial!);
    await expect(page.getByText(/2000 matching · 2000 in this topic/)).toBeVisible();
    await page.getByRole('button', { name: 'Switch to tree' }).click(); await expect(page.getByText('Tree route requested')).toBeVisible();
    const frames = await page.evaluate(async () => {
      const samples: number[] = [], canvas = document.querySelector<SVGSVGElement>('.topic-graph-canvas')!, rect = canvas.getBoundingClientRect();
      for (let sample = 0; sample < 30; sample++) {
        const start = performance.now();
        for (let event = 0; event < 8; event++) canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
          clientX: rect.x + 100, clientY: rect.y + 100, deltaY: sample % 2 ? 8 : -8 }));
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        samples.push(performance.now() - start);
      }
      return samples;
    });
    const evidence = await page.evaluate(() => window.__graphEvidence);
    expect(evidence.mountMs.length).toBe(1); expect(evidence.updateMs.length).toBeGreaterThan(0);
    // Rendering work, not rAF waiting/network setup. Generous regression guards
    // tolerate shared CI hardware while catching accidental full-node rendering.
    expect(Math.max(...evidence.mountMs)).toBeLessThan(1000);
    expect(Math.max(...evidence.updateMs)).toBeLessThan(250);
    expect(errors).toEqual([]);
    const report = { source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), browser: browser.version(),
      fixture: '20 ordered trees x 100 nodes; replacement 1.1 → 20.99', platform: process.platform,
      node: process.version, viewport: testInfo.project.use.viewport, mountToSettledMs, initialNodes, initialEdges,
      ...evidence, frameBurstToSettledMs: frames, nativeAcceptance: 'pending assembled App/core/store join' };
    await mkdir(resolve('coverage/graph-performance'), { recursive: true });
    await writeFile(resolve('coverage/graph-performance/measurements.json'), JSON.stringify(report, null, 2));
    await page.screenshot({ path: resolve('coverage/graph-performance/graph-2000.png') });
    await testInfo.attach('graph-performance', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  } finally { await server.close(); }
});
