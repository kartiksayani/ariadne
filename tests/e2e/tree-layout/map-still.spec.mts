// The Map never moves on its own (alpha.20 "The Map"): one table row per trigger, each measured in a real browser.
// `still` triggers change no row's height or text width, so every row in view keeps its exact place (a marker, an Ack, the
// band's counts, hover and the search). `held` triggers add or fold rows on purpose; the row the owner reads keeps its
// place below the sticky topic band. The width triggers (Details fold and resize, window resize) are the `widthTriggers`
// table in tree-layout.spec.mts. The band's own buttons (Next unseen, Focus, the "…" menu) join this table with the band.
import { test, expect, type Locator, type Page } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import type { Server } from 'node:http';
import { viewportPlace } from '../map-viewport.mts';

interface Placed { readonly key: string; readonly top: number; readonly height: number; readonly text: number }

/** Every row and band in view: where it sits, how tall it is and how wide its text runs. */
const placed = (page: Page): Promise<Placed[]> => page.locator('.tree-scroll').evaluate(box => {
  const edge = box.getBoundingClientRect();
  return [...box.querySelectorAll<HTMLElement>('.tree-item, .tree-topic')].flatMap(row => {
    const rect = row.getBoundingClientRect();
    if (rect.bottom <= edge.top || rect.top >= edge.bottom) return [];
    const text = row.querySelector('.tree-question, .tree-topic-name')?.getBoundingClientRect().width ?? 0;
    return [{ key: row.dataset.row!, top: Math.round(rect.top * 2) / 2, height: Math.round(rect.height * 2) / 2, text: Math.round(text * 2) / 2 }];
  });
});
/** The first item row reaching below the sticky band, and its offset from the band's bottom. */
const reading = (page: Page, key?: string) => page.locator('.tree-scroll').evaluate((box, wanted) => {
  const edge = box.getBoundingClientRect().top;
  let bar = 0;
  for (const header of box.querySelectorAll('.tree-topic')) {
    const rect = header.getBoundingClientRect();
    if (rect.top <= edge && rect.bottom > edge) bar = Math.max(bar, rect.bottom - edge);
  }
  const rows = [...box.querySelectorAll<HTMLElement>('.tree-item')];
  const row = wanted ? rows.find(element => element.dataset.row === wanted)! : rows.find(element => element.getBoundingClientRect().bottom > edge + bar + 1)!;
  return { key: row.dataset.row!, top: row.getBoundingClientRect().top - edge - bar };
}, key);
const settle = (page: Page) => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const agent = (page: Page, change: string) => page.evaluate(value => (window as unknown as { treeLayout: { agent(change: string): void } }).treeLayout.agent(value), change);
const seen = (page: Page, id: string) => page.evaluate(value => (window as unknown as { treeLayout: { seen(id: string): void } }).treeLayout.seen(value), id);
const search = async (page: Page, words: string) => {
  if (!await page.getByRole('textbox', { name: 'Search the Map' }).count()) await page.getByRole('button', { name: 'Search the Map' }).click();
  await page.getByRole('textbox', { name: 'Search the Map' }).fill(words);
};
const row = (page: Page, id: string) => page.locator(`.tree-item[data-item-id="${id}"]`);
/** The sticky band over the reading row: the topic holding items 8 to 18. */
const band = (page: Page) => page.locator('.tree-topic-group', { has: row(page, '10') }).locator('.tree-topic');

/** The pointer goes to a row without Playwright's scroll-into-view: the owner moves the mouse, the Map does not move. */
const point = async (page: Page, id: string) => {
  const box = (await row(page, id).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 12);
};
/** A click where the control is on screen. Playwright's own scroll-into-view puts a sticky band's button where its section
 * starts, which the owner's click never does. */
const press = async (control: Locator) => {
  const box = (await control.boundingBox())!;
  await control.page().mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};

// [name, kind, subject (a row that must be in view, or null), before, change, done]
type Trigger = readonly [name: string, kind: 'still' | 'held', subject: string | null, before: (page: Page) => Promise<void>,
  change: (page: Page) => Promise<void>, done: (page: Page) => Promise<void>];
const nothing = async () => {};
const triggers: readonly Trigger[] = [
  ['a New marker clears', 'still', '11', nothing, page => seen(page, '11'), page => expect(row(page, '11').locator('.tree-change-marker')).toHaveCount(0)],
  ['a Changed marker clears', 'still', '12', nothing, page => seen(page, '12'), page => expect(row(page, '12').locator('.tree-change-marker')).toHaveCount(0)],
  // The band's Ack all goes with the topic's only result to ack.
  ['an Ack lands: the row\'s Ack and the band\'s Ack all go', 'still', '12', nothing, page => agent(page, 'ack-lands'), async page => {
    await expect(row(page, '12').getByRole('button', { name: /^Ack/ })).toHaveCount(0);
    await expect(band(page).getByRole('button', { name: /^Ack all/ })).toHaveCount(0);
  }],
  ['Ack all holds with its Undo in the band', 'still', null, nothing, async page => {
    await press(band(page).getByRole('button', { name: /^Ack all/ }));
    await page.getByRole('dialog').getByRole('button', { name: 'Ack all' }).click();
  }, page => expect(page.getByRole('button', { name: 'Undo Ack all' })).toBeVisible()],
  ['the band\'s counts change', 'still', null, nothing, page => agent(page, 'counts'), page => expect(band(page)).toContainText('in progress')],
  // In a narrow Map a longer counts line would wrap under itself; the band keeps its height.
  ['the band\'s counts change in a narrow window', 'still', null, page => page.setViewportSize({ width: 640, height: 700 }), page => agent(page, 'counts'),
    page => expect(band(page)).toContainText('in progress')],
  ['the band\'s Ack all goes in a narrow window', 'still', null, page => page.setViewportSize({ width: 640, height: 700 }), page => agent(page, 'ack-lands'),
    page => expect(band(page).getByRole('button', { name: /^Ack all/ })).toHaveCount(0)],
  ['the pointer rests on a row', 'still', '11', nothing, page => point(page, '11'), page => expect(row(page, '11').getByRole('button', { name: /^Hide/ })).toBeVisible()],
  ['typing a search', 'still', null, nothing, page => search(page, 'Another item'), page => expect(page.locator('.tree-hit').first()).toBeVisible()],
  ['typing a search that matches nothing', 'still', null, nothing, page => search(page, 'zzz'), page => expect(page.getByText('No matches')).toBeVisible()],
  ['stepping to a match already in view', 'still', '11', page => search(page, 'Another item 11'),
    page => page.getByRole('textbox', { name: 'Search the Map' }).press('Enter'), async page => {
      // Every word of the current match is ringed, all on 11's question.
      await expect(row(page, '11').locator('.tree-question .tree-hit[data-current]')).toHaveCount(3);
      await expect(page.locator('.tree-hit[data-current]')).toHaveCount(3);
    }],
  ['a new agent row above the reading row', 'held', null, nothing, page => agent(page, 'add-above'), page => expect(row(page, '3.1')).toHaveCount(1)],
  ['a new agent row below the reading row', 'still', null, nothing, page => agent(page, 'add-below'), page => expect(row(page, '40')).toHaveCount(1)],
  ['Show them reveals a folded match above', 'held', null, page => search(page, 'receipt'),
    page => page.getByRole('button', { name: 'Show them' }).click(), page => expect(row(page, '1.1')).toHaveCount(1)],
  ['Show more on the reading row', 'held', '10', nothing, page => press(row(page, '10').getByRole('button', { name: 'Show more' })),
    page => expect(row(page, '10').getByRole('button', { name: 'Show less' })).toHaveCount(1)],
];

async function open(page: Page, origin: string) {
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(`${origin}/tests/e2e/tree-layout/fixture.html?still`);
  await page.locator('[data-popover-trigger="switcher"]').click();
  await page.getByRole('dialog', { name: 'Switch session or project' }).getByRole('button', { name: 'All sessions' }).click();
  const session = page.locator('button[data-session-id]').first();
  await expect(session).toBeEnabled(); await session.click();
  await expect(page.getByRole('region', { name: 'Session tree' })).toHaveAttribute('data-session-busy', 'false');
  await page.evaluate(async () => { await document.fonts.ready; });
  const close = page.getByRole('button', { name: 'Close detail' });
  if (await close.count()) await close.click();
  // Item 10 (a seven-line finding that folds behind Show more) is the reading row: its top just under the band.
  await row(page, '10').evaluate(element => {
    const box = element.closest('.tree-scroll')!, header = element.closest('.tree-topic-group')!.querySelector('.tree-topic')!;
    box.scrollTop += element.getBoundingClientRect().top - box.getBoundingClientRect().top - header.getBoundingClientRect().height + 4;
  });
  await settle(page);
  await page.mouse.move(2, 690);
}

for (const [name, kind, subject, before, change, done] of triggers) test(`the Map stays still when ${name}`, async ({ page }) => {
  const server = await createServer({ configFile: false, root: resolve('.'), publicDir: resolve('apps/desktop/public'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  try {
    await server.listen();
    const address = (server.httpServer as Server).address();
    if (!address || typeof address === 'string') throw new Error('Missing layout fixture server address');
    await open(page, `http://127.0.0.1:${address.port}`);
    await before(page);
    await settle(page);
    const rows = await placed(page), read = await reading(page), scrollTop = await page.locator('.tree-scroll').evaluate(box => box.scrollTop);
    expect(scrollTop, 'the reading row is scrolled, so the hold applies').toBeGreaterThan(0);
    expect(read.key).toBe('10');
    if (subject) expect(rows.map(value => value.key), `${subject} is in view`).toContain(subject);
    await change(page);
    await done(page);
    await settle(page);
    // The row the owner reads never moves (3px, as the width table allows for sub-pixel text reflow).
    await expect.poll(async () => Math.abs((await reading(page, read.key)).top - read.top)).toBeLessThanOrEqual(kind === 'held' ? 3 : 0.5);
    if (kind === 'still') {
      const after = new Map((await placed(page)).map(value => [value.key, value]));
      for (const value of rows) expect(after.get(value.key), `${value.key} keeps its place, height and text width`).toEqual(value);
    }
  } finally { await server.close(); }
});

// ---- The filter row (D13-D17, D24). The chip row opens above the Map, and a chip, Clear, an Ack or an agent's change
// removes rows. The Map holds the reading row at its *viewport* place, so these rows are measured in window coordinates,
// in both views, with the Map scrolled to the top, the middle and the bottom.
type View = 'Tree' | 'Graph';
type Spot = 'top' | 'middle' | 'bottom';
interface Cell { readonly id: string; readonly top: number; readonly left: number; readonly height: number }
const views: readonly View[] = ['Tree', 'Graph'];
const spots: readonly Spot[] = ['top', 'middle', 'bottom'];
const scrollerOf = (view: View) => view === 'Tree' ? '.tree-scroll' : '.graph-scroll';
const cellOf = (view: View, id: string) => view === 'Tree' ? `.tree-item[data-item-id="${id}"]` : `.graph-node[data-item-id="${id}"]`;
const funnel = (page: Page) => page.getByRole('button', { name: /^Filter by status/ });
const chipRow = (page: Page) => page.getByRole('group', { name: 'Filter items' });
const chipButton = (page: Page, label: string) => chipRow(page).getByRole('button', { name: new RegExp(`^${label} \\d+$`) });
const chipLabel: Readonly<Record<string, string>> = { open: 'Open', done: 'Done', in_progress: 'In progress', waiting_on_me: 'Waiting on me', decided: 'Decided', replaced: 'Replaced' };
const statusOf = (page: Page, id: string) => page.evaluate(wanted => {
  const transport = (window as unknown as { treeLayout: { sessions: Map<string, { items: Record<string, { status: string }> }> } }).treeLayout;
  return [...transport.sessions.values()][0]!.items[wanted]!.status;
}, id);

/** Every item whole in view, in reading order: top to bottom, then left to right. The sticky band covers the Tree's first pixels. */
const wholeCells = (page: Page, view: View): Promise<Cell[]> => page.evaluate(({ scroller, kind }) => {
  const box = document.querySelector(scroller)!, edge = box.getBoundingClientRect();
  let bar = 0;
  if (kind === 'Tree') for (const header of box.querySelectorAll('.tree-topic')) {
    const rect = header.getBoundingClientRect();
    if (rect.top <= edge.top && rect.bottom > edge.top) bar = Math.max(bar, rect.bottom - edge.top);
  }
  return [...box.querySelectorAll<HTMLElement>(kind === 'Tree' ? '.tree-item[data-item-id]' : '.graph-node[data-item-id]')].flatMap(node => {
    const rect = node.getBoundingClientRect();
    return rect.top >= edge.top + bar - 0.5 && rect.bottom <= edge.bottom + 0.5 ? [{ id: node.dataset.itemId!, top: rect.top, left: rect.left, height: rect.height }] : [];
  }).sort((a, b) => a.top - b.top || a.left - b.left);
}, { scroller: scrollerOf(view), kind: view });

async function scrollTo(page: Page, view: View, spot: Spot) {
  await page.locator(scrollerOf(view)).evaluate((box, where) => {
    const max = box.scrollHeight - box.clientHeight;
    box.scrollTop = where === 'top' ? 0 : where === 'middle' ? Math.round(max / 2) : max;
    box.dispatchEvent(new Event('scroll'));
  }, spot);
  await settle(page);
  const { top, max } = await page.locator(scrollerOf(view)).evaluate(box => ({ top: box.scrollTop, max: box.scrollHeight - box.clientHeight }));
  expect(max, 'the list is longer than the window, so the Map can scroll').toBeGreaterThan(40);
  if (spot === 'top') expect(top).toBe(0);
  else if (spot === 'bottom') expect(max - top).toBeLessThanOrEqual(1);
  else { expect(top).toBeGreaterThan(0); expect(max - top).toBeGreaterThan(1); }
}

async function prepare(page: Page, origin: string, view: View) {
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  // Tall enough that, under every chip, at least one row is whole between the band and the bottom edge.
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto(`${origin}/tests/e2e/tree-layout/fixture.html?filter`);
  await page.locator('[data-popover-trigger="switcher"]').click();
  await page.getByRole('dialog', { name: 'Switch session or project' }).getByRole('button', { name: 'All sessions' }).click();
  const session = page.locator('button[data-session-id]').first();
  await expect(session).toBeEnabled(); await session.click();
  await expect(page.getByRole('region', { name: 'Session tree' })).toHaveAttribute('data-session-busy', 'false');
  await page.evaluate(async () => { await document.fonts.ready; });
  const close = page.getByRole('button', { name: 'Close detail' });
  if (await close.count()) await close.click();
  if (view === 'Graph') {
    await page.getByRole('button', { name: 'Graph', exact: true }).click();
    await expect(page.locator('.graph-scroll')).toBeVisible();
  }
  await settle(page);
}
const openRow = async (page: Page) => { await funnel(page).click(); await expect(chipRow(page)).toBeVisible(); await settle(page); };
const pick = async (page: Page, label: string) => {
  await chipButton(page, label).click();
  await expect(chipButton(page, label)).toHaveAttribute('aria-pressed', 'true');
  await settle(page);
};

// What an owner-caused boundary may do: at the very top the Map cannot scroll above its first row, so a row that shrinks the
// Map's top (the chip row closing) or removes the reading row may carry the rows up by that much, and never down.
type Allowance = 'filter row' | 'removed row' | null;
interface FilterTrigger {
  readonly name: string;
  /** The filter state before the owner scrolls. */
  readonly before: (page: Page) => Promise<void>;
  /** The row the Map holds: the reading row, or the row below it when the trigger removes the reading row. */
  readonly holds: 'reader' | 'next';
  readonly change: (page: Page, view: View, reader: Cell) => Promise<void>;
  readonly done: (page: Page, view: View, reader: Cell) => Promise<void>;
  readonly top: Allowance;
}
const filterTriggers: readonly FilterTrigger[] = [
  { name: 'the chip row opens', before: async () => {}, holds: 'reader', top: null,
    change: page => funnel(page).click(), done: page => expect(chipRow(page)).toBeVisible() },
  { name: 'the chip row closes', before: openRow, holds: 'reader', top: 'filter row',
    change: page => funnel(page).click(), done: page => expect(chipRow(page)).toHaveCount(0) },
  { name: 'a chip is picked', before: openRow, holds: 'reader', top: null,
    change: async (page, _view, reader) => { await chipButton(page, chipLabel[await statusOf(page, reader.id)]!).click(); },
    done: async (page, _view, reader) => { await expect(chipButton(page, chipLabel[await statusOf(page, reader.id)]!)).toHaveAttribute('aria-pressed', 'true'); } },
  // Clear empties the picked chips and closes the row: the rows come back and the Map's top moves up.
  { name: 'Clear empties the chips and closes the row', before: async page => { await openRow(page); await pick(page, 'Open'); }, holds: 'reader', top: 'filter row',
    change: page => chipRow(page).getByRole('button', { name: 'Clear' }).click(), done: page => expect(chipRow(page)).toHaveCount(0) },
  { name: 'the reading row leaves To ack after its Ack', before: async page => { await openRow(page); await pick(page, 'To ack'); }, holds: 'next', top: 'removed row',
    change: async (page, view, reader) => {
      // The Tree's Ack button; the Graph has none, so the Ack lands the way an Ack from the dock does.
      if (view === 'Tree') await press(page.locator(cellOf(view, reader.id)).getByRole('button', { name: /^Ack/ }));
      else await agent(page, `ack:${reader.id}`);
    },
    done: (page, view, reader) => expect(page.locator(cellOf(view, reader.id))).toHaveCount(0, { timeout: 15_000 }) },
  // Item 38 waits on item 2: when it is done, 38 leaves Blocked below the reading row and the Map's scroll range shrinks.
  { name: 'a dependency settles and an item leaves Blocked', before: async page => { await openRow(page); await pick(page, 'Blocked'); }, holds: 'reader', top: null,
    change: page => agent(page, 'settle'), done: (page, view) => expect(page.locator(cellOf(view, '38'))).toHaveCount(0) },
];

test.describe('the filter row never moves the Map', () => {
  // Each row opens a window, so a missing control fails fast instead of waiting for the suite's long limit.
  test.describe.configure({ timeout: 90_000 });
  let server: Awaited<ReturnType<typeof createServer>>, origin = '';
  test.beforeAll(async () => {
    server = await createServer({ configFile: false, root: resolve('.'), publicDir: resolve('apps/desktop/public'), plugins: [react()],
      logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
    await server.listen();
    const address = (server.httpServer as Server).address();
    if (!address || typeof address === 'string') throw new Error('Missing layout fixture server address');
    origin = `http://127.0.0.1:${address.port}`;
  });
  test.afterAll(async () => { await server.close(); });

  for (const view of views) for (const spot of spots) for (const trigger of filterTriggers) {
    test(`${view}, scrolled to the ${spot}: ${trigger.name}`, async ({ page }) => {
      await prepare(page, origin, view);
      await trigger.before(page);
      await scrollTo(page, view, spot);
      await page.mouse.move(2, 690);
      const cells = await wholeCells(page, view), reader = cells[0]!;
      expect(reader, 'a row is whole in view').toBeTruthy();
      // The row the Map must hold: the reading row, or the one under it when the trigger removes the reading row.
      const held = trigger.holds === 'reader' ? reader : cells[1]!;
      const before = (await viewportPlace(page, cellOf(view, held.id)))!;
      // How far the Map's own top edge moves in the window when the trigger opens or closes the rows above it.
      const edgeBefore = (await viewportPlace(page, scrollerOf(view)))!;
      await trigger.change(page, view, reader);
      await trigger.done(page, view, reader);
      await settle(page); await page.waitForTimeout(60); await settle(page);
      const edgeMoved = Math.abs((await viewportPlace(page, scrollerOf(view)))!.y - edgeBefore.y);
      const after = await viewportPlace(page, cellOf(view, held.id));
      expect(after, `${held.id} is still drawn`).not.toBeNull();
      const shift = after!.y - before.y;
      // At the top an owner-caused boundary may carry the rows up (never down) by the height that left; anywhere else, nothing moves.
      const room = spot === 'top' && trigger.top ? (trigger.top === 'filter row' ? edgeMoved : reader.height) + 1 : 1;
      expect(shift, `${held.id} moved ${shift}px in the window`).toBeGreaterThanOrEqual(-room);
      expect(shift, `${held.id} moved ${shift}px in the window`).toBeLessThanOrEqual(1);
      expect(Math.abs(after!.x - before.x), `${held.id} moved sideways`).toBeLessThanOrEqual(1);
    });
  }
});
