// Hide moves on (alpha.24): hiding the selected item selects the next item on its level (else the previous, else the parent) and
// the Map does not move. Across a hide on screen the rows above the hidden row stay where they are and its space closes from below;
// a hide above the window leaves the reading row in place, as before. Measured in a real browser, in window coordinates, after the
// hold's own scroll events and observers have run. Rows are the plan's edge-case table.
import { test, expect, type Page } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import type { Server } from 'node:http';
import { closeDetails } from './closeDetails';

const row = (page: Page, id: string) => page.locator(`[role="treeitem"][data-item-id="${id}"]`);
const scroller = (page: Page) => page.getByTestId('map-scroll');
const settle = (page: Page) => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
/** Waits out the hold's own scroll event and the observers a commit sets off, then nudges a scroll event as an owner's idle wheel would. */
const quiet = async (page: Page) => {
  await settle(page); await page.waitForTimeout(250);
  await scroller(page).evaluate(box => { box.dispatchEvent(new Event('scroll')); });
  await settle(page);
};
const scrollTop = (page: Page) => scroller(page).evaluate(box => box.scrollTop);
/** Window tops of the item rows and strips in view, by row key. */
const tops = (page: Page) => scroller(page).evaluate(box => {
  const edge = box.getBoundingClientRect(), out: Record<string, number> = {};
  for (const element of box.querySelectorAll<HTMLElement>('[role="treeitem"][data-item-id], [role="treeitem"][data-strip]')) {
    const rect = element.getBoundingClientRect();
    if (rect.bottom > edge.top && rect.top < edge.bottom) out[element.dataset.row!] = Math.round(rect.top * 2) / 2;
  }
  return out;
});
const topOf = (page: Page, id: string) => row(page, id).evaluate(element => Math.round(element.getBoundingClientRect().top * 2) / 2);
const heightOf = (page: Page, id: string) => row(page, id).evaluate(element => element.getBoundingClientRect().height);
/** The rows in view before `id`, in Map order. */
const above = (page: Page, id: string) => scroller(page).evaluate((box, wanted) => {
  const keys = [...box.querySelectorAll<HTMLElement>('[role="treeitem"][data-item-id], [role="treeitem"][data-strip]')].map(element => element.dataset.row!);
  return keys.slice(0, keys.indexOf(wanted));
}, id);
/** Puts `id` just under the sticky band of its topic, `covered` px of it under the band. */
const placeUnderBand = (page: Page, id: string, covered = 0) => scroller(page).evaluate((box, [wanted, under]) => {
  const element = box.querySelector<HTMLElement>(`[role="treeitem"][data-item-id="${wanted}"]`)!;
  const header = [...box.querySelectorAll<HTMLElement>('[data-topic-id]')]
    .filter(topic => topic.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1)!;
  box.scrollTop += element.getBoundingClientRect().top - box.getBoundingClientRect().top - header.getBoundingClientRect().height + Number(under);
}, [id, covered] as const);
/** A pointer click where the control is on screen (no scroll into view). */
const press = async (page: Page, id: string) => {
  const box = (await row(page, id).boundingBox())!;
  await page.mouse.click(box.x + 60, box.y + 12);
};
const hoverHide = async (page: Page, id: string) => {
  const box = (await row(page, id).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 12);
  const hide = row(page, id).getByRole('button', { name: /^Hide/ });
  await expect(hide).toBeVisible();
  const place = (await hide.boundingBox())!;
  await page.mouse.click(place.x + place.width / 2, place.y + place.height / 2);
};
const selected = (page: Page) => page.locator('[role="treeitem"][aria-selected="true"]');

async function serve(page: Page, run: () => Promise<void>) {
  const server = await createServer({ configFile: false, root: resolve('.'), publicDir: resolve('apps/desktop/public'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  try {
    await server.listen();
    const address = (server.httpServer as Server).address();
    if (!address || typeof address === 'string') throw new Error('Missing layout fixture server address');
    const origin = `http://127.0.0.1:${address.port}`;
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto(`${origin}/tests/e2e/tree-layout/fixture.html?still`);
    await page.locator('[data-popover-trigger="switcher"]').click();
    await page.getByRole('dialog', { name: 'Switch session or project' }).getByRole('button', { name: 'All sessions' }).click();
    const session = page.locator('button[data-session-id]').first();
    await expect(session).toBeEnabled(); await session.click();
    await expect(page.getByRole('region', { name: 'Session tree' })).toHaveAttribute('data-session-busy', 'false');
    await page.evaluate(async () => { await document.fonts.ready; });
    await closeDetails(page);
    await run();
  } finally { await server.close(); }
}
/** Selects `id` with a click (Details opens beside the Map) and waits until that layout settles. */
async function select(page: Page, id: string) {
  await press(page, id);
  await expect(row(page, id)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator(`[data-detail-item-id="${id}"]`).first()).toBeVisible();
  await quiet(page);
}
/** After a hide of `gone`: rows above it hold their window place, and the row after it takes its old top. */
async function closesFromBelow(page: Page, before: Record<string, number>, rowsAbove: readonly string[], gone: string, next: string, nextTop?: number) {
  for (const key of rowsAbove) {
    if (before[key] === undefined) continue;
    await expect.poll(async () => Math.abs((await tops(page))[key]! - before[key]!), `${key} above the hidden row keeps its place`).toBeLessThanOrEqual(1);
  }
  if (nextTop !== undefined) expect(Math.abs((await topOf(page, next)) - nextTop), `${next} closes ${gone}'s space`).toBeLessThanOrEqual(1);
}
/** Undo on the "Hid …" toast. */
const undo = (page: Page) => page.getByRole('button', { name: 'Undo', exact: true }).click();
/** After an Undo of `id`'s hide: the rows above it are where they were before the hide, and so is `id`. */
async function comesBack(page: Page, before: Record<string, number>, rowsAbove: readonly string[], id: string, place: number) {
  await expect(row(page, id)).toHaveCount(1);
  for (const key of rowsAbove) {
    if (before[key] === undefined) continue;
    await expect.poll(async () => Math.abs((await tops(page))[key]! - before[key]!), `${key} above ${id} keeps its place`).toBeLessThanOrEqual(1);
  }
  expect(Math.abs((await topOf(page, id)) - place), `${id} is back in its place`).toBeLessThanOrEqual(1);
}

test.describe('hide moves on, and the Map stays still', () => {
  test('row 1: x on the selected middle row selects the next row, in view, with scrollTop unchanged', async ({ page }) => serve(page, async () => {
    await placeUnderBand(page, '10', 4); await settle(page);
    await select(page, '12');
    const before = await tops(page), was = await scrollTop(page), rowsAbove = await above(page, '12'), place = await topOf(page, '12');
    await page.keyboard.press('x');
    await expect(row(page, '12')).toHaveCount(0);
    await expect(row(page, '13')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-detail-item-id="13"]').first()).toBeVisible();
    await quiet(page);
    expect(Math.abs((await scrollTop(page)) - was)).toBeLessThanOrEqual(1);
    await closesFromBelow(page, before, rowsAbove, '12', '13', place);
    await expect(row(page, '13')).toBeInViewport();
    await expect(page.getByRole('button', { name: /^Back to “/ })).toHaveCount(0);
  }));

  test('row 2: x on the selected last row of its level selects the previous row; the rows above stay, scrollTop unchanged', async ({ page }) => serve(page, async () => {
    // 7 is topic A's last root: 6 before it takes the selection, and topic B's band below closes 7's space.
    await placeUnderBand(page, '5', 4); await settle(page);
    await select(page, '7');
    const before = await tops(page), was = await scrollTop(page), rowsAbove = await above(page, '7');
    expect(rowsAbove).toContain('6');
    await page.keyboard.press('x');
    await expect(row(page, '7')).toHaveCount(0);
    await expect(row(page, '6')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-detail-item-id="6"]').first()).toBeVisible();
    await quiet(page);
    expect(Math.abs((await scrollTop(page)) - was)).toBeLessThanOrEqual(1);
    await closesFromBelow(page, before, rowsAbove, '7', '6');
    await expect(row(page, '6')).toBeInViewport();
    await expect(page.getByRole('button', { name: /^Back to “/ })).toHaveCount(0);
  }));

  test('row 8: in an open hidden group the row dims at the group’s end; the view does not follow it', async ({ page }) => serve(page, async () => {
    // At the foot of the Map 17 is hidden and its group opened; then back to the middle.
    await scroller(page).evaluate(box => { box.scrollTop = box.scrollHeight; }); await quiet(page);
    await hoverHide(page, '17');
    await expect(row(page, '17')).toHaveCount(0);
    const strip = page.getByRole('treeitem', { name: /^1 hidden/ });
    await quiet(page);
    const box = (await strip.boundingBox())!;
    await page.mouse.click(box.x + 40, box.y + box.height / 2);
    await expect(row(page, '17')).toHaveCount(1);
    await placeUnderBand(page, '10', 4); await quiet(page);
    await select(page, '12');
    const before = await tops(page), was = await scrollTop(page), rowsAbove = await above(page, '12'), place = await topOf(page, '12');
    await page.keyboard.press('x');
    await expect(row(page, '13')).toHaveAttribute('aria-selected', 'true');
    // 12 is still drawn, dimmed, after the visible rows of its level.
    await expect(row(page, '12')).toHaveCount(1);
    await quiet(page);
    expect(Math.abs((await scrollTop(page)) - was)).toBeLessThanOrEqual(1);
    await closesFromBelow(page, before, rowsAbove, '12', '13', place);
  }));

  test('row 9: Details Hide on the selected row on screen moves the same way', async ({ page }) => serve(page, async () => {
    await placeUnderBand(page, '10', 4); await settle(page);
    await select(page, '12');
    const before = await tops(page), was = await scrollTop(page), rowsAbove = await above(page, '12'), place = await topOf(page, '12');
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Hide' }).click();
    await expect(row(page, '12')).toHaveCount(0);
    await expect(page.locator('[data-detail-item-id="13"]').first()).toBeVisible();
    await quiet(page);
    expect(Math.abs((await scrollTop(page)) - was)).toBeLessThanOrEqual(1);
    await closesFromBelow(page, before, rowsAbove, '12', '13', place);
  }));

  test('S10: Hide on an unrelated row above the selected one keeps the rows above it; the selected row closes the space', async ({ page }) => serve(page, async () => {
    await placeUnderBand(page, '10', 4); await settle(page);
    await select(page, '14');
    const before = await tops(page), rowsAbove = await above(page, '11'), place = await topOf(page, '14'), gap = await heightOf(page, '11');
    await hoverHide(page, '11');
    await expect(row(page, '11')).toHaveCount(0);
    await quiet(page);
    await expect(row(page, '14')).toHaveAttribute('aria-selected', 'true');
    await closesFromBelow(page, before, rowsAbove, '11', '12');
    expect(Math.abs((await topOf(page, '14')) - (place - gap)), 'the selected row moves up by the hidden row’s height').toBeLessThanOrEqual(1);
  }));

  test('row 11: Undo of x on the selected row puts it back in its place and selects it again; the rows above stay', async ({ page }) => serve(page, async () => {
    await placeUnderBand(page, '10', 4); await settle(page);
    await select(page, '12');
    const before = await tops(page), rowsAbove = await above(page, '12'), place = await topOf(page, '12');
    await page.keyboard.press('x');
    await expect(row(page, '12')).toHaveCount(0);
    await expect(row(page, '13')).toHaveAttribute('aria-selected', 'true');
    await quiet(page);
    await undo(page);
    await expect(row(page, '12')).toHaveAttribute('aria-selected', 'true');
    await quiet(page);
    await comesBack(page, before, rowsAbove, '12', place);
    expect(Math.abs((await topOf(page, '13')) - before['13']!), '13 makes room below it').toBeLessThanOrEqual(1);
  }));

  test('row 11: Undo of a hover Hide on an unrelated row puts it back; the rows above stay and the selection keeps its place', async ({ page }) => serve(page, async () => {
    await placeUnderBand(page, '10', 4); await settle(page);
    await select(page, '14');
    const before = await tops(page), rowsAbove = await above(page, '11'), place = await topOf(page, '11');
    await hoverHide(page, '11');
    await expect(row(page, '11')).toHaveCount(0);
    await quiet(page);
    await undo(page);
    await quiet(page);
    await comesBack(page, before, rowsAbove, '11', place);
    await expect(row(page, '14')).toHaveAttribute('aria-selected', 'true');
    expect(Math.abs((await topOf(page, '14')) - before['14']!), 'the selected row is back where it was').toBeLessThanOrEqual(1);
  }));

  test('row 20: the parent the hide selects is above the window: the Map stays and the Back-to pill points at it', async ({ page }) => serve(page, async () => {
    await row(page, '1').getByRole('button', { name: 'Expand or collapse' }).evaluate(element => (element as HTMLElement).click());
    await expect(row(page, '1.1')).toHaveCount(1);
    await placeUnderBand(page, '1.1', 0); await settle(page);
    await select(page, '1.1');
    await placeUnderBand(page, '1.1', 0); await quiet(page);
    const before = await tops(page), was = await scrollTop(page);
    await page.keyboard.press('x');
    await expect(row(page, '1.1')).toHaveCount(0);
    await expect(row(page, '1')).toHaveAttribute('aria-selected', 'true');
    await quiet(page);
    expect(Math.abs((await scrollTop(page)) - was)).toBeLessThanOrEqual(1);
    // 1 is above the reading edge: the pill points up at it.
    await expect(page.getByRole('button', { name: /^Back to “/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Back to “/ })).toHaveAttribute('data-edge', 'above');
    // What was below 1.1 rose into its place; nothing on screen went down.
    const after = await tops(page);
    for (const [key, top] of Object.entries(after)) if (before[key] !== undefined) expect(top, key).toBeLessThanOrEqual(before[key]! + 1);
  }));

  test('row 21: Details Hide of a selected row above the window leaves the view as it is', async ({ page }) => serve(page, async () => {
    await placeUnderBand(page, '10', 4); await settle(page);
    await select(page, '11');
    // The owner scrolls on, leaving 11 above the window.
    await placeUnderBand(page, '13', 0); await quiet(page);
    await expect(row(page, '11')).not.toBeInViewport();
    const before = await tops(page);
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Hide' }).click();
    await expect(row(page, '11')).toHaveCount(0);
    await expect(row(page, '12')).toHaveAttribute('aria-selected', 'true');
    await quiet(page);
    const after = await tops(page);
    const shared = Object.keys(before).filter(key => after[key] !== undefined);
    expect(shared.length).toBeGreaterThan(2);
    for (const key of shared) expect(Math.abs(after[key]! - before[key]!), key).toBeLessThanOrEqual(1);
  }));

  test('row 22: at the very bottom the rows above the hidden row stay still too (the bottom spacer keeps the extent)', async ({ page }) => serve(page, async () => {
    await scroller(page).evaluate(box => { box.scrollTop = box.scrollHeight; }); await quiet(page);
    await select(page, '17');
    await scroller(page).evaluate(box => { box.scrollTop = box.scrollHeight; }); await quiet(page);
    expect(await scroller(page).evaluate(box => box.scrollHeight - box.clientHeight - box.scrollTop)).toBeLessThan(1);
    const before = await tops(page), rowsAbove = await above(page, '17'), place = await topOf(page, '17');
    await page.keyboard.press('x');
    await expect(row(page, '17')).toHaveCount(0);
    await expect(row(page, '18')).toHaveAttribute('aria-selected', 'true');
    await quiet(page);
    await closesFromBelow(page, before, rowsAbove, '17', '18', place);
  }));

  test('row 10: the Graph’s x moves its selection without centring or scrolling', async ({ page }) => serve(page, async () => {
    await page.getByRole('button', { name: 'Graph' }).click();
    const graph = page.getByTestId('graph-scroll'), node = (id: string) => graph.locator(`[role="treeitem"][data-item-id="${id}"]`);
    await expect(node('12')).toBeVisible();
    await node('12').scrollIntoViewIfNeeded();
    const box = (await node('12').boundingBox())!;
    await page.mouse.click(box.x + 20, box.y + box.height / 2);
    await expect(node('12')).toHaveAttribute('aria-selected', 'true');
    await settle(page); await page.waitForTimeout(250);
    const at = () => graph.evaluate(element => Object.fromEntries([...element.querySelectorAll<HTMLElement>('[role="treeitem"][data-item-id]')]
      .map(value => [value.dataset.itemId!, Math.round(value.getBoundingClientRect().top * 2) / 2])));
    const was = await graph.evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft })), before = await at();
    await page.keyboard.press('x');
    await expect(node('12')).toHaveCount(0);
    await expect(node('13')).toHaveAttribute('aria-selected', 'true');
    await settle(page); await page.waitForTimeout(250);
    const now = await graph.evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft })), after = await at();
    // No centring and no scroll: the nodes drawn before the hidden one keep their window place (the Graph's S10).
    expect(Math.abs(now.top - was.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(now.left - was.left)).toBeLessThanOrEqual(1);
    for (const id of ['8', '9', '10', '11']) expect(Math.abs(after[id]! - before[id]!), id).toBeLessThanOrEqual(1);
  }));
});

test('row 23: Focus on a root that is hidden ends in the same write: one layout change, and the next root is selected', async ({ page }) => serve(page, async () => {
  await placeUnderBand(page, '10', 4); await settle(page);
  await select(page, '12');
  await page.keyboard.press('Shift+F');
  await expect(page.getByRole('button', { name: /^Unfocus/ }).first()).toBeVisible();
  await quiet(page);
  const band = page.getByRole('treeitem', { name: 'Continued context', exact: true }), was = (await band.boundingBox())!.y;
  const place = await topOf(page, '12');
  await row(page, '12').focus();
  await page.keyboard.press('x');
  await expect(row(page, '13')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: /^Unfocus/ })).toHaveCount(0);
  await settle(page);
  const first = await tops(page);
  await quiet(page);
  // Focus ended with the hide: no second change follows it.
  expect(await tops(page)).toEqual(first);
  // The rows that come back go above, off-screen: the selected row takes the hidden row's place, under the same band.
  expect(Math.abs((await topOf(page, '13')) - place)).toBeLessThanOrEqual(1);
  expect(Math.abs((await band.boundingBox())!.y - was)).toBeLessThanOrEqual(1);
  // Undo is the way back in one change: Focus returns with the selection, 12 takes 13's place again (its own), under the same band.
  await undo(page);
  await expect(page.getByRole('button', { name: /^Unfocus/ }).first()).toBeVisible();
  await expect(row(page, '12')).toHaveAttribute('aria-selected', 'true');
  await settle(page);
  const back = await tops(page);
  await quiet(page);
  expect(await tops(page)).toEqual(back);
  expect(Math.abs((await topOf(page, '12')) - place)).toBeLessThanOrEqual(1);
  expect(Math.abs((await band.boundingBox())!.y - was)).toBeLessThanOrEqual(1);
}));

test('row 4: hiding the only root of a topic selects nothing and the Map stays', async ({ page }) => serve(page, async () => {
  await placeUnderBand(page, '10', 4); await settle(page);
  // Topic B's roots 9 to 18 go first, leaving 8 alone on its level.
  for (const id of ['9', '10', '11', '13', '14', '15', '16', '17', '18', '12']) {
    await placeUnderBand(page, id, 0); await quiet(page);
    await hoverHide(page, id); await expect(row(page, id)).toHaveCount(0);
    await quiet(page);
  }
  await placeUnderBand(page, '8', 0); await quiet(page);
  await select(page, '8');
  const topic = page.getByRole('treeitem', { name: 'Continued context', exact: true });
  const was = (await topic.boundingBox())!.y;
  await page.keyboard.press('x');
  await expect(row(page, '8')).toHaveCount(0);
  await expect(selected(page)).toHaveCount(0);
  await expect(page.locator('[data-detail-item-id]')).toHaveCount(0);
  await expect(topic).toBeFocused();
  await quiet(page);
  // Details closes and the Map widens; the topic's row keeps its window place through it.
  expect(Math.abs((await topic.boundingBox())!.y - was)).toBeLessThanOrEqual(1);
}));
