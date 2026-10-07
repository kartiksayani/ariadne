import { test, expect, type Page } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { Server } from 'node:http';

const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const selected = (page: Page) => page.locator('.graph-node[aria-selected="true"]').getAttribute('data-item-id');

test('renders the full 2,000-node graph and keeps selection, keys and collapse responsive', async ({ page, browser }, testInfo) => {
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
    const nodes = page.locator('.graph-node'), scroller = page.locator('.graph-scroll');
    await expect(page.getByRole('tree')).toBeVisible();
    await expect(nodes).toHaveCount(2000);
    await settle(page); const mountToSettledMs = Date.now() - start;
    const initialEdges = await page.locator('[data-edge]').count();
    // 20 topic edges, 1,980 parent edges and the replacement arc.
    expect(initialEdges).toBe(2001);
    await expect(page.locator('[data-edge="replacement:1.1:20.99"]')).toHaveCount(1);
    const box = (await page.locator('.graph-node[data-item-id="10.50"]').boundingBox())!;
    expect([box.width, box.height]).toEqual([190, 66]);
    await expect(page.locator('.graph-node[data-item-id="10.50"]')).toHaveAttribute('title', 'Graph question 10.50');

    // A selection outside the viewport is centred by Reveal selected.
    await page.getByRole('button', { name: 'Select off-screen item' }).click();
    const off = page.locator('.graph-node[data-item-id="15.50"]');
    await expect(off).toHaveAttribute('aria-selected', 'true');
    await expect(off).not.toBeInViewport();
    await page.getByRole('button', { name: 'Reveal selected' }).click(); await settle(page);
    const view = (await scroller.boundingBox())!, target = (await off.boundingBox())!;
    expect(Math.abs(target.y + target.height / 2 - (view.y + view.height / 2))).toBeLessThan(2);

    // ↑ moves in layout order, ← goes to the parent then collapses it, → expands it again.
    await off.focus();
    await page.keyboard.press('ArrowUp'); await expect.poll(() => selected(page)).toBe('15.49');
    await expect(page.locator('.graph-node[data-item-id="15.49"]')).toBeFocused();
    await page.keyboard.press('ArrowLeft'); await expect.poll(() => selected(page)).toBe('15');
    await page.keyboard.press('ArrowLeft');
    await expect(nodes).toHaveCount(1901);
    await expect(page.locator('.graph-node[data-item-id="15"] .graph-node-below')).toHaveText('+99');
    await page.keyboard.press('ArrowRight'); await expect(nodes).toHaveCount(2000);
    await page.keyboard.press('Enter'); await expect(page.getByRole('status')).toHaveText('Detail 15');

    // "−" collapses a branch; clicking the collapsed node opens it and its detail.
    await page.locator('.graph-node[data-item-id="1"] .graph-node-collapse').click();
    await expect(nodes).toHaveCount(1901);
    await page.locator('.graph-node[data-item-id="1"]').click();
    await expect(nodes).toHaveCount(2000); await expect(page.getByRole('status')).toHaveText('Detail 1');

    const frames = await page.evaluate(async () => {
      const samples: number[] = [], scroll = document.querySelector<HTMLElement>('.graph-scroll')!;
      for (let sample = 0; sample < 30; sample++) {
        const start = performance.now();
        scroll.scrollTop += sample % 2 ? 600 : -300;
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        samples.push(performance.now() - start);
      }
      return samples;
    });
    const evidence = await page.evaluate(() => window.__graphEvidence);
    expect(evidence.mountMs.length).toBe(1); expect(evidence.updateMs.length).toBeGreaterThan(0);
    expect(evidence.saved.at(-1)?.expanded_item_ids).toEqual(expect.arrayContaining(['1', '15']));
    // Rendering work, not rAF waiting/network setup. Generous regression guards
    // tolerate shared CI hardware while catching accidental quadratic work.
    expect(Math.max(...evidence.mountMs)).toBeLessThan(1000);
    expect(Math.max(...evidence.updateMs)).toBeLessThan(250);
    await expect(page.locator('.graph-error')).toHaveCount(0);
    expect(errors).toEqual([]);
    const report = { source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), browser: browser.version(),
      fixture: '20 ordered trees x 100 nodes, all expanded; replacement 1.1 → 20.99', platform: process.platform,
      node: process.version, viewport: testInfo.project.use.viewport, mountToSettledMs, initialNodes: 2000, initialEdges,
      mountMs: evidence.mountMs, updateMs: evidence.updateMs, frameBurstToSettledMs: frames };
    await mkdir(resolve('coverage/graph-performance'), { recursive: true });
    await writeFile(resolve('coverage/graph-performance/measurements.json'), JSON.stringify(report, null, 2));
    await page.screenshot({ path: resolve('coverage/graph-performance/graph-2000.png') });
    await testInfo.attach('graph-performance', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  } finally { await server.close(); }
});
