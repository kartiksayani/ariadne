import { test, expect, type Page } from '@playwright/test';
import { serve, settle } from './serve.mts';

// The Graph never moves on its own (alpha.20 plan, "Map still"): under every trigger the owner did not aim at the
// view, the node the owner is looking at keeps its screen position, across and down. That node is the selection when
// it is in view, otherwise the first node in view (top, then left). Real layout: Chromium, the app's CSS, a Details
// column beside the Graph as the window lays them out.

interface Start { readonly details?: number; readonly folded?: string }
/** `shifts`: the trigger moves the node inside the canvas, so holding it took a scroll (the row is not vacuous). */
interface Trigger { readonly name: string; readonly start?: Start; readonly shifts?: boolean; readonly act: (page: Page) => Promise<unknown> }

const anchor = (page: Page, call: string) => page.evaluate(call);
const triggers: readonly Trigger[] = [
  { name: 'Details opens', act: page => anchor(page, 'window.__anchor.details(400)') },
  { name: 'Details folds to its rail', start: { details: 400 }, act: page => anchor(page, 'window.__anchor.details(36)') },
  { name: 'Details is dragged wider', start: { details: 400 }, act: page => anchor(page, 'window.__anchor.details(560)') },
  { name: 'the window is resized', act: page => page.setViewportSize({ width: 860, height: 560 }) },
  { name: 'an agent adds a node above the view', shifts: true, act: page => anchor(page, 'window.__anchor.add("1.11", "1")') },
  { name: 'a branch above the view folds', shifts: true,
    act: page => anchor(page, 'window.__anchor.expanded(["1", "3", "4", "5", "6", "7", "8", "4.1", "4.1.1"])') },
  { name: 'a branch above the view unfolds', shifts: true, start: { folded: '2' },
    act: page => anchor(page, 'window.__anchor.expanded(["1", "2", "3", "4", "5", "6", "7", "8", "4.1", "4.1.1"])') },
  { name: 'a search highlights matches', act: page => anchor(page, 'window.__anchor.search("Anchor question 6")') },
  { name: 'the pointer rests on a node', act: page => page.hover('.graph-node[data-item-id="5.5"]') },
];

/** The node's top-left in the Graph scroller's box; with no id, the first node fully below the scroller's top edge. */
const where = (page: Page, id: string | null) => page.evaluate(wanted => {
  const box = document.querySelector('.graph-scroll')!.getBoundingClientRect();
  const nodes = [...document.querySelectorAll<HTMLElement>('.graph-node[data-item-id]')];
  const element = wanted ? nodes.find(node => node.dataset.itemId === wanted)
    : nodes.map(node => ({ node, rect: node.getBoundingClientRect() })).filter(({ rect }) => rect.top >= box.top)
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)[0]?.node;
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  const canvas = document.querySelector('.graph-canvas')!.getBoundingClientRect(), round = (value: number) => Math.round(value * 10) / 10;
  return { id: element.dataset.itemId!, x: round(rect.left - box.left), y: round(rect.top - box.top), inCanvas: round(rect.top - canvas.top) };
}, id);

for (const reader of ['the selected node', 'the first node in view'] as const) {
  for (const trigger of triggers) {
    test(`${reader} holds still when ${trigger.name}`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const { origin, server } = await serve(page);
      try {
        const query = new URLSearchParams();
        if (trigger.start?.details) query.set('details', String(trigger.start.details));
        if (trigger.start?.folded) query.set('folded', trigger.start.folded);
        await page.goto(`${origin}/tests/e2e/graph/anchor.html?${query}`);
        await expect(page.locator('.graph-node[data-item-id="5.3"]')).toHaveCount(1);
        const selected = reader === 'the selected node' ? '5.3' : null;
        if (selected) await anchor(page, `window.__anchor.select(${JSON.stringify(selected)})`);
        await settle(page);
        // The owner scrolled 5.3 to 220px below the top of the view.
        await page.evaluate(() => {
          const box = document.querySelector<HTMLElement>('.graph-scroll')!;
          const node = box.querySelector('.graph-node[data-item-id="5.3"]')!;
          box.scrollTop += node.getBoundingClientRect().top - box.getBoundingClientRect().top - 220;
          box.dispatchEvent(new Event('scroll'));
        });
        await settle(page);
        const before = await where(page, selected);
        expect(before).not.toBeNull();
        await trigger.act(page);
        await settle(page); await page.waitForTimeout(60); await settle(page);
        const after = await where(page, before!.id);
        expect(after && { id: after.id, x: after.x, y: after.y }, `${before!.id} after ${trigger.name}`).toEqual({ id: before!.id, x: before!.x, y: before!.y });
        if (trigger.shifts) expect(after!.inCanvas, 'the trigger moved the node inside the canvas').not.toBe(before!.inCanvas);
        expect(errors).toEqual([]);
      } finally { await server.close(); }
    });
  }
}
