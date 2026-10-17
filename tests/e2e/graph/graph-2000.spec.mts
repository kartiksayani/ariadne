import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { serve, settle } from './serve.mts';

const selected = (page: Page) => page.locator('.graph-node[aria-selected="true"]').getAttribute('data-item-id');

test('renders the full 2,000-node graph and keeps selection, keys, folds and hover responsive', async ({ page, browser }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const { origin, server } = await serve(page);
  try {
    const start = Date.now(); await page.goto(`${origin}/tests/e2e/graph/fixture.html`);
    const nodes = page.locator('.graph-node'), scroller = page.locator('.graph-scroll');
    await expect(page.getByRole('tree')).toBeVisible();
    await expect(nodes).toHaveCount(2000);
    await settle(page); const mountToSettledMs = Date.now() - start;
    const initialEdges = await page.locator('[data-edge]').count();
    // One trunk, 20 branches off it into the top items and 1,980 parent elbows; no related line without a selection or hover.
    expect(initialEdges).toBe(2001);
    await expect(page.locator('[data-edge^="related:"]')).toHaveCount(0);
    // Orthogonal: the first child's elbow leaves the parent's right edge; later siblings continue the shared vertical.
    await expect(page.locator('[data-edge="parent:10:10.1"]')).toHaveAttribute('d', /^M[\d.]+ [\d.]+ H[\d.]+ V[\d.]+ H[\d.]+$/);
    await expect(page.locator('[data-edge="parent:10:10.50"]')).toHaveAttribute('d', /^M[\d.]+ [\d.]+ V[\d.]+ H[\d.]+$/);
    // SPEC 1.3: the column is fitted to the Map's width when the Graph opens; nodes are col − 26 wide and 40 high.
    const mapWidth = await scroller.evaluate(element => element.clientWidth);
    const column = Math.min(196, Math.max(150, Math.floor((mapWidth - 56) / 5)));
    const box = (await page.locator('.graph-node[data-item-id="10.50"]').boundingBox())!;
    expect([box.width, box.height]).toEqual([column - 26, 40]);
    await expect(page.locator('.graph-node[data-item-id="10.50"]')).toHaveAttribute('title', 'Graph question 10.50');

    // A selection made elsewhere does not move the Graph; an outside reveal (a link) centres its node.
    const off = page.locator('.graph-node[data-item-id="15.50"]');
    const scrollTop = await scroller.evaluate(element => element.scrollTop);
    await page.getByRole('button', { name: 'Select off-screen item' }).click(); await settle(page);
    await expect(off).toHaveAttribute('aria-selected', 'true');
    await expect(off).not.toBeInViewport();
    expect(await scroller.evaluate(element => element.scrollTop)).toBe(scrollTop);
    await expect(page.locator('[data-edge="path"]')).toHaveCount(1);
    await page.getByRole('button', { name: 'Reveal off-screen item' }).click();
    await expect(off).toBeInViewport(); await settle(page);
    const view = (await scroller.boundingBox())!, target = (await off.boundingBox())!;
    expect(Math.abs(target.y + target.height / 2 - (view.y + view.height / 2))).toBeLessThan(2);

    // ↑ moves in layout order, ← goes to the parent then folds it (a quiet "+99"), → unfolds it again, Enter opens detail.
    await off.focus();
    await page.keyboard.press('ArrowUp'); await expect.poll(() => selected(page)).toBe('15.49');
    await expect(page.locator('.graph-node[data-item-id="15.49"]')).toBeFocused();
    await page.keyboard.press('ArrowLeft'); await expect.poll(() => selected(page)).toBe('15');
    await page.keyboard.press('ArrowLeft');
    await expect(nodes).toHaveCount(1901);
    await expect(page.locator('.graph-node[data-item-id="15"] .graph-node-inside')).toHaveText('+99');
    await page.keyboard.press('ArrowRight'); await expect(nodes).toHaveCount(2000);
    await page.keyboard.press('Enter'); await expect(page.getByRole('status')).toHaveText('Detail 15');

    // ← folds item 1; clicking the folded node opens it again and its detail.
    await page.locator('.graph-node[data-item-id="1"]').click(); await expect(page.getByRole('status')).toHaveText('Detail 1');
    await page.keyboard.press('ArrowLeft'); await expect(nodes).toHaveCount(1901);
    await page.locator('.graph-node[data-item-id="1"]').click();
    await expect(nodes).toHaveCount(2000); await expect(page.getByRole('status')).toHaveText('Detail 1');

    // The pointer lights the hovered node's related line (1.1 to 20.99, across the whole canvas) without a relayout.
    const updates = await page.evaluate(() => window.__graphEvidence.updateMs.length);
    await page.locator('.graph-node[data-item-id="1.1"]').hover();
    await expect(page.locator('[data-edge="related:1.1:20.99"]')).toHaveCount(1);
    await expect(page.locator('.graph-node[data-item-id="20.99"]')).toHaveClass(/is-related/);
    const hoverMs = await page.evaluate(count => window.__graphEvidence.updateMs.slice(count), updates);
    await page.mouse.move(2, 2);
    await expect(page.locator('[data-edge^="related:"]')).toHaveCount(0);

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
    // Rendering work, not rAF waiting/network setup. The budgets are reports
    // (coverage/graph-performance), not gates: the guards only catch accidental
    // quadratic work. A loaded shared runner has measured 545 ms updates and a
    // 1,276 ms mount (145 ms locally), so the guard is coarse; latency is not a gate.
    expect(Math.max(...evidence.mountMs)).toBeLessThan(5000);
    expect(Math.max(...evidence.updateMs)).toBeLessThan(5000);
    expect(errors).toEqual([]);
    const report = { source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), browser: browser.version(),
      fixture: '20 ordered trees x 100 nodes, all expanded; related 1.1 ↔ 20.99', platform: process.platform,
      node: process.version, viewport: testInfo.project.use.viewport, mountToSettledMs, initialNodes: 2000, initialEdges, column,
      mountMs: evidence.mountMs, updateMs: evidence.updateMs, hoverMs, frameBurstToSettledMs: frames };
    await mkdir(resolve('coverage/graph-performance'), { recursive: true });
    await writeFile(resolve('coverage/graph-performance/measurements.json'), JSON.stringify(report, null, 2));
    await page.screenshot({ path: resolve('coverage/graph-performance/graph-2000.png') });
    await testInfo.attach('graph-performance', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  } finally { await server.close(); }
});
