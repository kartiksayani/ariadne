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

/** Selects the reading row (its Details opens, then closes again, so the Map is as wide as before). Focus acts on it. */
const selectReading = async (page: Page) => {
  await press(row(page, '10').getByText('Another item 10'));
  const close = page.getByRole('button', { name: 'Close detail' });
  await expect(close).toBeVisible();
  await close.click();
  await settle(page);
  await page.mouse.move(2, 690);
};
const bandButton = (page: Page, name: string | RegExp) => band(page).getByRole('button', { name });
const moreActions = (page: Page) => bandButton(page, /^More actions for/);

// [name, kind, subject (a row that must be in view, or null), before, change, done]
type Trigger = readonly [name: string, kind: 'still' | 'held' | 'goes', subject: string | null, before: (page: Page) => Promise<void>,
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
  // The band (alpha.20 W3): its buttons, menu and popovers float or swap in place; none changes a row.
  ['Focus is turned on', 'held', null, selectReading, page => press(bandButton(page, 'Focus')),
    page => expect(bandButton(page, /^Unfocus/)).toBeVisible()],
  ['Focus is turned off', 'held', null, async page => { await selectReading(page); await press(bandButton(page, 'Focus')); await expect(bandButton(page, /^Unfocus/)).toBeVisible(); },
    page => press(bandButton(page, /^Unfocus/)), page => expect(bandButton(page, 'Focus')).toBeVisible()],
  ['the Next label changes while stepping', 'still', '11', nothing, page => press(bandButton(page, 'Next unseen')),
    page => expect(bandButton(page, /^Next unseen, 1 of 2/)).toBeVisible()],
  ['the "…" menu opens', 'still', null, nothing, page => press(moreActions(page)), page => expect(page.getByRole('menu')).toBeVisible()],
  ['Open the bin is chosen in the "…" menu: the bin opens and scrolls into view', 'goes', null, nothing, async page => {
    await press(moreActions(page));
    await page.getByRole('menuitem', { name: /^Open the bin/ }).click();
  }, async page => {
    const fold = page.getByRole('button', { name: /^Removed by agent/ });
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    await expect(fold).toBeInViewport();
  }],
  ['a topic reply opens under the band', 'held', null, nothing, async page => {
    await press(moreActions(page));
    await page.getByRole('menuitem', { name: /^Reply to topic/ }).click();
  }, page => expect(page.getByRole('textbox', { name: 'Reply to this topic' })).toBeVisible()],
  ['the Ack all popover opens', 'still', null, nothing, page => press(bandButton(page, /^Ack all/)),
    page => expect(page.getByRole('dialog', { name: /^Acknowledge results in/ })).toBeVisible()],
  ['the Ack all popover is cancelled', 'still', null, async page => { await press(bandButton(page, /^Ack all/)); },
    page => page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click(), page => expect(page.getByRole('dialog')).toHaveCount(0)],
  ['Ack all is undone', 'still', null, async page => {
    await press(bandButton(page, /^Ack all/));
    await page.getByRole('dialog').getByRole('button', { name: 'Ack all' }).click();
  }, page => press(bandButton(page, 'Undo Ack all')), page => expect(bandButton(page, /^Ack all \(/)).toBeVisible()],
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

for (const [name, kind, subject, before, change, done] of triggers) test(`the Map ${kind === 'goes' ? 'goes where the owner asked when' : 'stays still when'} ${name}`, async ({ page }) => {
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
    // An owner action that asks for a place ('goes') moves the Map there on purpose, so the reading row is not held.
    if (kind === 'goes') return;
    // The row the owner reads never moves (3px, as the width table allows for sub-pixel text reflow).
    await expect.poll(async () => Math.abs((await reading(page, read.key)).top - read.top)).toBeLessThanOrEqual(kind === 'held' ? 3 : 0.5);
    if (kind === 'still') {
      const after = new Map((await placed(page)).map(value => [value.key, value]));
      for (const value of rows) expect(after.get(value.key), `${value.key} keeps its place, height and text width`).toEqual(value);
    }
  } finally { await server.close(); }
});
