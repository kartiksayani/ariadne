import { test, expect, type Page } from '@playwright/test';
import { serve, settle } from './serve.mts';
import { viewportPlace } from '../map-viewport.mts';

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

/** The node's top-left in the window (the Graph's scroller can itself move); with no id, the first node fully below the scroller's top edge. */
const where = (page: Page, id: string | null) => page.evaluate(wanted => {
  const box = document.querySelector('.graph-scroll')!.getBoundingClientRect();
  const nodes = [...document.querySelectorAll<HTMLElement>('.graph-node[data-item-id]')];
  const element = wanted ? nodes.find(node => node.dataset.itemId === wanted)
    : nodes.map(node => ({ node, rect: node.getBoundingClientRect() })).filter(({ rect }) => rect.top >= box.top)
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)[0]?.node;
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  const canvas = document.querySelector('.graph-canvas')!.getBoundingClientRect(), round = (value: number) => Math.round(value * 10) / 10;
  return { id: element.dataset.itemId!, x: round(rect.left), y: round(rect.top), inCanvas: round(rect.top - canvas.top) };
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

// ---- D24, the Graph part: the hold keeps the node's position in the window, and survives the node leaving.

/** Every drawn node in reading order (top, then left) with its viewport y. */
const order = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.graph-node[data-item-id]')]
  .map(node => ({ id: node.dataset.itemId!, rect: node.getBoundingClientRect() }))
  .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
  .map(({ id, rect }) => ({ id, y: Math.round(rect.top * 10) / 10 })));
const open = async (page: Page, query: Record<string, string>) => {
  const { origin, server } = await serve(page);
  await page.goto(`${origin}/tests/e2e/graph/anchor.html?${new URLSearchParams(query)}`);
  await expect(page.locator('.graph-node[data-item-id="5.3"]')).toHaveCount(1);
  return server;
};
/** The owner scrolled `id` to `offset` px below the scroller's top. */
const scrollNodeTo = async (page: Page, id: string, offset: number) => {
  await page.evaluate(([wanted, at]) => {
    const box = document.querySelector<HTMLElement>('.graph-scroll')!;
    const node = box.querySelector(`.graph-node[data-item-id="${wanted}"]`)!;
    box.scrollTop += node.getBoundingClientRect().top - box.getBoundingClientRect().top - Number(at);
    box.dispatchEvent(new Event('scroll'));
  }, [id, String(offset)]);
  await settle(page);
};
const scrollEdge = async (page: Page, edge: 'top' | 'bottom') => {
  await page.evaluate(place => {
    const box = document.querySelector<HTMLElement>('.graph-scroll')!;
    box.scrollTop = place === 'top' ? 0 : box.scrollHeight;
    box.dispatchEvent(new Event('scroll'));
  }, edge);
  await settle(page);
};
const afterTrigger = async (page: Page) => { await settle(page); await page.waitForTimeout(60); await settle(page); };

for (const reader of ['the selected node', 'the first node in view'] as const) {
  const leaves: readonly { readonly name: string; readonly start: Record<string, string>; readonly act: (page: Page, id: string) => Promise<unknown> }[] = [
    { name: 'it leaves the filter', start: { filter: 'open' }, act: (page, id) => anchor(page, `window.__anchor.status(${JSON.stringify(id)}, "decided")`) },
    { name: 'it is hidden', start: {}, act: (page, id) => anchor(page, `window.__anchor.remove([${JSON.stringify(id)}])`) },
  ];
  for (const leave of leaves) {
    test(`${reader} is replaced by the nearest node below, which holds still, when ${leave.name}`, async ({ page }) => {
      const server = await open(page, leave.start);
      try {
        if (reader === 'the selected node') await anchor(page, 'window.__anchor.select("5.3")');
        await settle(page);
        await scrollNodeTo(page, '5.3', 220);
        const held = reader === 'the selected node' ? '5.3' : (await where(page, null))!.id;
        const before = await order(page), at = before.findIndex(node => node.id === held);
        expect(at).toBeGreaterThanOrEqual(0);
        await leave.act(page, held);
        await afterTrigger(page);
        const after = await order(page);
        expect(after.some(node => node.id === held), `${held} left the Graph`).toBe(false);
        const below = before.slice(at + 1).find(node => after.some(value => value.id === node.id))!;
        expect(below, `a node below ${held} survives`).toBeTruthy();
        expect(after.find(node => node.id === below.id)!.y, `${below.id} (below ${held}) after ${leave.name}`).toBeCloseTo(below.y, 0);
      } finally { await server.close(); }
    });
  }
}

test('clicking a folded node above the selection keeps the clicked node under the pointer', async ({ page }) => {
  const server = await open(page, { folded: '4' });
  try {
    await anchor(page, 'window.__anchor.select("5.1")');
    await settle(page);
    await scrollNodeTo(page, '4', 200);
    const folded = '.graph-node[data-item-id="4"]', before = await viewportPlace(page, folded);
    expect(before).not.toBeNull();
    await page.click('.graph-node[data-item-id="4"]');
    await afterTrigger(page);
    await expect(page.locator('.graph-node[data-item-id="4.1"]')).toHaveCount(1);
    const after = await viewportPlace(page, folded);
    expect(after && { x: after.x, y: after.y }, 'the clicked node after it unfolded').toEqual({ x: before!.x, y: before!.y });
  } finally { await server.close(); }
});

// The filter row opens above the Graph: the scroller's own top moves 40px, so the node is measured in the window.
const barTriggers = [
  { name: 'the filter row opens', start: {}, act: (page: Page) => anchor(page, 'window.__anchor.bar(true)') },
  { name: 'the filter row closes', start: { bar: '1' }, act: (page: Page) => anchor(page, 'window.__anchor.bar(false)') },
] as const;
for (const reader of ['the selected node', 'the first node in view'] as const) {
  for (const edge of ['top', 'middle', 'bottom'] as const) {
    for (const trigger of barTriggers) {
      // At the very top there is nothing above to scroll into, so closing the row there moves the Map (plan D24).
      if (edge === 'top' && trigger.name === 'the filter row closes') continue;
      test(`${reader} holds its place in the window at the ${edge} of the Graph when ${trigger.name}`, async ({ page }) => {
        const server = await open(page, trigger.start);
        try {
          const selected = reader === 'the selected node' ? '5.3' : null;
          if (selected) await anchor(page, `window.__anchor.select("${selected}")`);
          await settle(page);
          if (edge === 'middle') await scrollNodeTo(page, '5.3', 220); else await scrollEdge(page, edge);
          const before = await where(page, selected);
          expect(before).not.toBeNull();
          await trigger.act(page);
          await afterTrigger(page);
          const after = await where(page, before!.id);
          expect(after && { id: after.id, y: after.y }, `${before!.id} after ${trigger.name}`).toEqual({ id: before!.id, y: before!.y });
        } finally { await server.close(); }
      });
    }
  }
}

test('the first node in view holds still when nodes below the view are removed at the bottom of the Graph', async ({ page }) => {
  const server = await open(page, {});
  try {
    await settle(page);
    await scrollEdge(page, 'bottom');
    const before = await where(page, null);
    expect(before).not.toBeNull();
    await anchor(page, 'window.__anchor.remove(["8.10", "8.9", "8.8"])');
    await afterTrigger(page);
    const after = await where(page, before!.id);
    expect(after && { id: after.id, y: after.y }, `${before!.id} after the bottom shrank`).toEqual({ id: before!.id, y: before!.y });
  } finally { await server.close(); }
});

test('a node reached by key lands above the legend card', async ({ page }) => {
  const server = await open(page, {});
  try {
    await page.focus('.graph-node[data-item-id="5.3"]');
    await page.keyboard.press('End');
    await afterTrigger(page);
    const rects = await page.evaluate(() => {
      const node = document.querySelector('.graph-node[aria-selected="true"]')!.getBoundingClientRect();
      const legend = document.querySelector('.graph-legend')!.getBoundingClientRect();
      return { nodeBottom: node.bottom, nodeLeft: node.left, nodeRight: node.right, legendTop: legend.top, legendLeft: legend.left, legendRight: legend.right };
    });
    const overlapsAcross = rects.nodeLeft < rects.legendRight && rects.nodeRight > rects.legendLeft;
    expect(overlapsAcross, 'the legend sits across the last node, so the check is not vacuous').toBe(true);
    expect(rects.nodeBottom).toBeLessThanOrEqual(rects.legendTop + 0.5);
  } finally { await server.close(); }
});
