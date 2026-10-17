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
    const rows = await placed(page), read = await reading(page);
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

// ------------------------------------------------------------------- D24: the hold at every scroll position
// Measured in window coordinates (map-viewport.mts): some triggers move the scroller itself. The reading row is the selected
// row while it is on screen, else the first item row whole below the sticky band. When it goes (filtered out, hidden or
// removed), the nearest surviving row below it, else above it, keeps its own window place.
// The boundaries: at `scrollTop = 0`, content at or above the reading row that shrinks lets the rows below rise into the gap
// (`rise`: no top spacer); at the bottom a shrink keeps the scroll extent with a spacer, which an owner scroll trims.
type Where = 'top' | 'middle' | 'bottom';
type Expectation = 'held' | 'rise';
// [name, where, expectation, before, change (given the reading row), done]
type Hold = readonly [name: string, where: Where, expectation: Expectation, before: (page: Page) => Promise<void>,
  change: (page: Page, reading: string) => Promise<void>, done: (page: Page, reading: string) => Promise<void>];
const scroller = (page: Page) => page.locator('.tree-scroll');
const goTo = (page: Page, where: Where) => where === 'middle' ? Promise.resolve()
  : scroller(page).evaluate((box, to) => { box.scrollTop = to === 'top' ? 0 : box.scrollHeight; }, where);
/** Every item row in Map order, and the reading row: the selected row while on screen, else the first whole below the band. */
const readingRow = (page: Page) => scroller(page).evaluate(box => {
  const edge = box.getBoundingClientRect();
  let bar = 0;
  for (const header of box.querySelectorAll('.tree-topic')) {
    const rect = header.getBoundingClientRect();
    if (rect.top <= edge.top && rect.bottom > edge.top) bar = Math.max(bar, rect.bottom - edge.top);
  }
  const rows = [...box.querySelectorAll<HTMLElement>('.tree-item')];
  const shown = (element: HTMLElement) => { const top = element.getBoundingClientRect().top; return top >= edge.top + bar - 1 && top < edge.bottom; };
  const reading = rows.find(element => element.getAttribute('aria-selected') === 'true' && shown(element)) ?? rows.find(shown)!;
  return { key: reading.dataset.row!, keys: rows.map(element => element.dataset.row!) };
});
const windowTop = async (page: Page, key: string) => (await viewportPlace(page, `.tree-item[data-row="${key}"]`))?.y ?? null;
const scrollTopOf = (page: Page) => scroller(page).evaluate(box => box.scrollTop);
const filter = (page: Page, statuses: string[]) =>
  page.evaluate(value => (window as unknown as { treeLayout: { filter(statuses: string[]): void } }).treeLayout.filter(value), statuses);
const hide = async (page: Page, id: string) => { await point(page, id); await press(row(page, id).getByRole('button', { name: /^Hide/ })); };
// In the Open view item 1 shows only as 1.1's context, so 1.1 leaving takes it along.
const leave = (page: Page, reading: string) => agent(page, `leave:${reading === '1' ? '1.1' : reading}`);
const goes = (page: Page, reading: string) => expect(row(page, reading)).toHaveCount(0);
/** Item 12 is selected with Details closed, below the first row in view, and the owner has scrolled a little since. */
const selectTwelve = async (page: Page) => {
  await press(row(page, '12').getByText('Another item 12'));
  const close = page.getByRole('button', { name: 'Close detail' });
  if (await close.count()) await close.click();
  await expect(row(page, '12')).toHaveAttribute('aria-selected', 'true');
  await page.mouse.wheel(0, 20);
  await settle(page);
};
const everywhere = (name: string, expectation: (where: Where) => Expectation, before: Hold[3], change: Hold[4], done: Hold[5]): Hold[] =>
  (['top', 'middle', 'bottom'] as const).map(where => [name, where, expectation(where), before, change, done]);
const held = (): Expectation => 'held', risesAtTop = (where: Where): Expectation => where === 'top' ? 'rise' : 'held';
const holds: readonly Hold[] = [
  ...everywhere('a new agent row lands above the reading row', held, nothing, page => agent(page, 'add-top'),
    page => expect(row(page, '0')).toHaveCount(1)),
  ...everywhere('the reading row leaves the filter on its own', risesAtTop, page => filter(page, ['open']), leave, goes),
  ...everywhere('the owner hides the reading row', risesAtTop, nothing, hide, goes),
  ...everywhere('the agent removes the reading row', risesAtTop, nothing, (page, reading) => agent(page, `remove:${reading}`), goes),
  // Rows above the reading row go or come back. While the "Showing N of M" banner shows a status filter, it opens or closes
  // above the Map too, so the scroller itself moves (D13); the chip row's own rows are the filter row block's.
  ...everywhere('a saved filter lands', held, nothing, page => filter(page, ['open']),
    page => expect(row(page, '5')).toHaveCount(0)),
  ...everywhere('a saved filter clears', risesAtTop, page => filter(page, ['open']), page => filter(page, []),
    page => expect(row(page, '5')).toHaveCount(1)),
  ['a row below the reading row goes and the scroll range shrinks', 'bottom', 'held', nothing, page => agent(page, 'remove:18'),
    page => expect(row(page, '18')).toHaveCount(0)],
  ['the selected row is the reading row: a row above it grows', 'middle', 'held', selectTwelve, page => agent(page, 'grow:11'),
    page => expect(row(page, '11')).toContainText('A longer title')],
];

const served = async (page: Page, run: () => Promise<void>) => {
  const server = await createServer({ configFile: false, root: resolve('.'), publicDir: resolve('apps/desktop/public'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  try {
    await server.listen();
    const address = (server.httpServer as Server).address();
    if (!address || typeof address === 'string') throw new Error('Missing layout fixture server address');
    await open(page, `http://127.0.0.1:${address.port}`);
    await run();
  } finally { await server.close(); }
};

for (const [name, where, expectation, before, change, done] of holds) {
  const label = expectation === 'rise' ? `top boundary: ${name}, so the rows below rise` : `${name} at the ${where}`;
  test(`the Map holds when ${label}`, ({ page }) => served(page, async () => {
    await before(page);
    await settle(page);
    await goTo(page, where);
    await settle(page);
    if (where === 'top') expect(await scrollTopOf(page)).toBe(0);
    if (where === 'bottom') expect(await scroller(page).evaluate(box => box.scrollHeight - box.clientHeight - box.scrollTop)).toBeLessThan(1);
    const read = await readingRow(page), was = new Map<string, number>();
    for (const key of read.keys) was.set(key, (await windowTop(page, key))!);
    await change(page, read.key);
    await done(page, read.key);
    await settle(page);
    const present = new Set(await page.locator('.tree-item').evaluateAll(rows => rows.map(element => (element as HTMLElement).dataset.row!)));
    const index = read.keys.indexOf(read.key);
    const survivor = present.has(read.key) ? read.key
      : read.keys.slice(index + 1).find(key => present.has(key)) ?? read.keys.slice(0, index).reverse().find(key => present.has(key))!;
    if (expectation === 'held') {
      await expect.poll(async () => Math.abs((await windowTop(page, survivor))! - was.get(survivor)!), `${survivor} keeps its window place`)
        .toBeLessThanOrEqual(3);
    } else {
      expect(await scrollTopOf(page)).toBe(0);
      const now = (await windowTop(page, survivor))!;
      expect(now, `${survivor} never moves down`).toBeLessThanOrEqual(was.get(survivor)! + 0.5);
      if (survivor !== read.key) expect(now, `${survivor} rises no higher than the row it replaces`).toBeGreaterThanOrEqual(was.get(read.key)! - 3);
    }
  }));
}

test('the Map holds at the bottom: an owner scroll trims the spacer and moves the Map only as far as it scrolls', ({ page }) => served(page, async () => {
  await goTo(page, 'bottom');
  await settle(page);
  /** The scroll range, and the blank the rows container keeps below its last topic (the spacer). */
  const extent = () => scroller(page).evaluate(box => {
    const rows = box.querySelector('.tree-rows')!;
    return { height: box.scrollHeight, blank: Math.round(rows.getBoundingClientRect().bottom - rows.lastElementChild!.getBoundingClientRect().bottom) };
  });
  expect((await extent()).blank).toBe(0);
  const read = await readingRow(page), y = (await windowTop(page, read.key))!;
  await agent(page, 'remove:18');
  await expect(row(page, '18')).toHaveCount(0);
  await settle(page);
  await expect.poll(async () => Math.abs((await windowTop(page, read.key))! - y), 'the shrink holds').toBeLessThanOrEqual(3);
  const kept = await extent();
  expect(kept.blank, 'a spacer keeps the scroll extent').toBeGreaterThan(0);
  const box = (await scroller(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -40);
  await expect.poll(async () => Math.round((await windowTop(page, read.key))! - y), 'the Map moves as far as the owner scrolled').toBe(40);
  await page.mouse.wheel(0, -600);
  await expect.poll(async () => Math.round((await windowTop(page, read.key))! - y)).toBeGreaterThan(300);
  // Once the blank end has left the view the spacer is gone, and the scroll range gives its room back.
  await expect.poll(async () => (await extent()).blank).toBe(0);
  expect((await extent()).height).toBe(kept.height - kept.blank);
}));

// A row taller than the window, clipped at the top, is the only row on screen: it is the reading row (the next row starts
// below the window), so the agent writing more on it never slides what the owner reads.
test('the Map holds when a tall clipped row grows while it is the only row on screen', ({ page }) => served(page, async () => {
  await page.setViewportSize({ width: 1000, height: 460 });
  await goTo(page, 'top');
  await settle(page);
  await row(page, '1').getByRole('button', { name: 'Show more' }).click();
  await expect(row(page, '1').getByRole('button', { name: 'Show less' })).toHaveCount(1);
  await row(page, '1').evaluate(element => {
    const box = element.closest('.tree-scroll')!;
    box.scrollTop += element.getBoundingClientRect().top - box.getBoundingClientRect().top + 60;
  });
  await settle(page);
  const clipped = await row(page, '1').evaluate(element => {
    const box = element.closest('.tree-scroll')!.getBoundingClientRect(), rect = element.getBoundingClientRect();
    return rect.top < box.top && rect.bottom > box.bottom;
  });
  expect(clipped, '1 is clipped at the top and runs past the window').toBe(true);
  await expect(row(page, '1')).not.toHaveAttribute('aria-selected', 'true');
  const y = (await windowTop(page, '1'))!;
  await agent(page, 'write:1');
  await expect(row(page, '1')).toContainText('More line 6');
  await settle(page);
  await expect.poll(async () => Math.abs((await windowTop(page, '1'))! - y), '1 keeps its window place').toBeLessThanOrEqual(3);
}));

// A short Map (its rows end above the window's bottom) still holds growth above the reading row and a scroller move:
// a bottom spacer makes the scroll room, and no more than that, so no blank band can be scrolled to.
const stale = (page: Page) => page.evaluate(() => (window as unknown as { treeLayout: { stale(): void } }).treeLayout.stale());
const shortMap: readonly (readonly [name: string, change: (page: Page) => Promise<void>, done: (page: Page) => Promise<void>])[] = [
  ['a row is added above', page => agent(page, 'add-top'), page => expect(row(page, '0')).toHaveCount(1)],
  ['a notice opens above', stale, page => expect(page.getByText('Showing last valid data')).toBeVisible()],
];
for (const [name, change, done] of shortMap) test(`the Map holds on a short Map when ${name}`, ({ page }) => served(page, async () => {
  await page.setViewportSize({ width: 1000, height: 4400 });
  await goTo(page, 'top');
  await settle(page);
  const short = await scroller(page).evaluate(box => box.getBoundingClientRect().bottom - box.querySelector('.tree-rows')!.getBoundingClientRect().bottom);
  expect(short, 'the rows end well above the window\'s bottom').toBeGreaterThan(300);
  const read = await readingRow(page), y = (await windowTop(page, read.key))!;
  await change(page);
  await done(page);
  await settle(page);
  await expect.poll(async () => Math.abs((await windowTop(page, read.key))! - y), `${read.key} keeps its window place`).toBeLessThanOrEqual(3);
  expect(await scroller(page).evaluate(box => box.scrollHeight - box.clientHeight - box.scrollTop), 'no spare room below').toBeLessThan(1);
}));
