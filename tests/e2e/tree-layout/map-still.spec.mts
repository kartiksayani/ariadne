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

/** `pinned`: a topic bar stuck to the Map's top edge, which goes where the Map's edge goes. */
interface Placed { readonly key: string; readonly top: number; readonly height: number; readonly text: number; readonly pinned: boolean }
const mapTop = (page: Page) => page.locator('.tree-scroll').evaluate(box => box.getBoundingClientRect().top);

/** Every row and band in view: where it sits, how tall it is and how wide its text runs. */
const placed = (page: Page): Promise<Placed[]> => page.locator('.tree-scroll').evaluate(box => {
  const edge = box.getBoundingClientRect();
  return [...box.querySelectorAll<HTMLElement>('.tree-item, .tree-topic')].flatMap(row => {
    const rect = row.getBoundingClientRect();
    if (rect.bottom <= edge.top || rect.top >= edge.bottom) return [];
    const text = row.querySelector('.tree-question, .tree-topic-name')?.getBoundingClientRect().width ?? 0;
    // Viewport coordinates: a bar inserted above the Map counts as movement.
    return [{ key: row.dataset.row!, top: Math.round(rect.top * 2) / 2, height: Math.round(rect.height * 2) / 2, text: Math.round(text * 2) / 2,
      pinned: row.classList.contains('tree-topic') && rect.top <= edge.top + 0.5 }];
  });
});
/** The first item row reaching below the sticky band, and its top in the window: a bar opening above the Map moves the Map's own
 * edge, so the window place is what the owner sees hold. */
const reading = (page: Page, key?: string) => page.locator('.tree-scroll').evaluate((box, wanted) => {
  const edge = box.getBoundingClientRect().top;
  let bar = 0;
  for (const header of box.querySelectorAll('.tree-topic')) {
    const rect = header.getBoundingClientRect();
    if (rect.top <= edge && rect.bottom > edge) bar = Math.max(bar, rect.bottom - edge);
  }
  const rows = [...box.querySelectorAll<HTMLElement>('.tree-item')];
  const row = wanted ? rows.find(element => element.dataset.row === wanted)! : rows.find(element => element.getBoundingClientRect().bottom > edge + bar + 1)!;
  return { key: row.dataset.row!, top: row.getBoundingClientRect().top };
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
/** A click on a control above the viewport, where the owner's click would land: the DOM click, with no scroll into view. */
const click = (control: Locator) => control.evaluate(element => (element as HTMLElement).click());

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
  // The marker is there before the dwell, so its absence afterwards is a clear and not a row that never had one.
  ['a New marker clears', 'still', '11', page => expect(row(page, '11').getByTestId('change-marker')).toHaveCount(1), page => seen(page, '11'),
    page => expect(row(page, '11').getByTestId('change-marker')).toHaveCount(0)],
  ['a Changed marker clears', 'still', '12', page => expect(row(page, '12').getByTestId('change-marker')).toHaveCount(1), page => seen(page, '12'),
    page => expect(row(page, '12').getByTestId('change-marker')).toHaveCount(0)],
  // The popovers open over the Map and take no room in it (D18, D19).
  ['What changed opens', 'still', '12', nothing, page => press(bandButton(page, /new|changed|changes since/)),
    page => expect(page.getByRole('dialog', { name: 'What changed' })).toBeVisible()],
  ['Recent opens', 'still', '12', nothing, page => page.getByRole('button', { name: 'Recent' }).click(),
    page => expect(page.getByRole('dialog', { name: 'Recent items' })).toBeVisible()],
  // The band's Ack all goes with the topic's only result to ack.
  ['an Ack lands: the row\'s Ack and the band\'s Ack all go', 'still', '12', nothing, page => agent(page, 'ack-lands'), async page => {
    await expect(row(page, '12').getByRole('button', { name: /^Ack/ })).toHaveCount(0);
    await expect(band(page).getByRole('button', { name: /^Ack all/ })).toHaveCount(0);
  }],
  // A row's own Ack holds for 6 s with "Acked · Undo" in the Ack slot (D11); Undo puts the Ack back. No row changes size.
  ['Ack then Undo on a row', 'still', '12', nothing, async page => {
    await press(row(page, '12').getByRole('button', { name: /^Ack/ }));
    await expect(row(page, '12').getByRole('status')).toContainText('Acked');
    await press(row(page, '12').getByRole('button', { name: /^Undo Ack of/ }));
  }, page => expect(row(page, '12').getByRole('button', { name: /^Ack/ })).toBeVisible()],
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
  // The rows below change what is above the reading row, which is out of view: the owner's click is a DOM click.
  ['a child unfolds above the reading row', 'held', null, nothing, page => click(row(page, '1').getByRole('button', { name: 'Expand or collapse' })),
    page => expect(row(page, '1.1')).toHaveCount(1)],
  ['a child folds above the reading row', 'held', null, async page => {
    await click(row(page, '1').getByRole('button', { name: 'Expand or collapse' }));
    await expect(row(page, '1.1')).toHaveCount(1);
  }, page => click(row(page, '1').getByRole('button', { name: 'Expand or collapse' })), page => expect(row(page, '1.1')).toHaveCount(0)],
  ['an item above the reading row is hidden', 'held', null, nothing, page => click(row(page, '9').getByRole('button', { name: /^Hide/, includeHidden: true })),
    page => expect(row(page, '9')).toHaveCount(0)],
  // Item 1's long title and long finding each fold; one flag opens both.
  ['Show more above the reading row', 'held', null, nothing, page => click(row(page, '1').getByRole('button', { name: 'Show more' }).last()),
    page => expect(row(page, '1').getByRole('button', { name: 'Show less' })).toHaveCount(2)],
  ['an item above the reading row grows to more lines', 'held', null, nothing, page => agent(page, 'grow-above'),
    page => expect(row(page, '9').locator('.tree-question')).toContainText('renamed')],
  // The Map crosses 560px: the Changed pill in the marker slot collapses to its diamond (a container query on the Map).
  ['the Map narrows below 560px', 'held', null, async page => {
    await expect.poll(async () => (await page.locator('.tree-scroll').boundingBox())!.width).toBeGreaterThanOrEqual(560);
    await expect.poll(async () => (await row(page, '12').getByTestId('change-marker').boundingBox())!.width).toBeGreaterThan(20);
  }, page => page.setViewportSize({ width: 540, height: 700 }), async page => {
    await expect.poll(async () => (await page.locator('.tree-scroll').boundingBox())!.width).toBeLessThan(560);
    await expect.poll(async () => (await row(page, '12').getByTestId('change-marker').boundingBox())!.width).toBeLessThanOrEqual(16);
  }],
  // The chip takes the status badge's slot and width: no row changes its width or height. The closed-session notice pushes the
  // Map down; the rows hold their window place and only the topic bar stuck to the Map's edge goes with it.
  ['a session ends', 'still', '13', nothing, page => agent(page, 'session-ends'), page => expect(row(page, '13').getByText('Session closed')).toBeVisible()],
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

/** `under`: how many pixels of item 10's top the sticky band covers. */
async function open(page: Page, origin: string, under = 4) {
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
  // Item 10 (a four-line finding that folds behind Show more) is the reading row: its top just under the band.
  await row(page, '10').evaluate((element, covered) => {
    const box = element.closest('.tree-scroll')!, header = element.closest('.tree-topic-group')!.querySelector('.tree-topic')!;
    box.scrollTop += element.getBoundingClientRect().top - box.getBoundingClientRect().top - header.getBoundingClientRect().height + covered;
  }, under);
  await settle(page);
  await page.mouse.move(2, 690);
}

/** Serves the layout fixture for one test and hands its origin to `run`. */
async function serve(run: (origin: string) => Promise<void>) {
  const server = await createServer({ configFile: false, root: resolve('.'), publicDir: resolve('apps/desktop/public'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  try {
    await server.listen();
    const address = (server.httpServer as Server).address();
    if (!address || typeof address === 'string') throw new Error('Missing layout fixture server address');
    await run(`http://127.0.0.1:${address.port}`);
  } finally { await server.close(); }
}

// Show more holds the row it opens, where the owner sees it: item 10 keeps its window position whether the band covers
// 4px of its top or most of its first line.
for (const under of [4, 17, 40]) test(`Show more keeps the clicked row's window position with ${under}px of it under the band`, async ({ page }) => {
  await serve(async origin => {
    await open(page, origin, under);
    await settle(page);
    const top = () => row(page, '10').evaluate(element => element.getBoundingClientRect().top);
    const start = await top();
    await row(page, '10').getByRole('button', { name: 'Show more' }).evaluate(button => (button as HTMLElement).click());
    await expect(row(page, '10').getByRole('button', { name: 'Show less' })).toHaveCount(1);
    await settle(page);
    expect(Math.abs(await top() - start)).toBeLessThanOrEqual(0.5);
  });
});

for (const [name, kind, subject, before, change, done] of triggers) test(`the Map ${kind === 'goes' ? 'goes where the owner asked when' : 'stays still when'} ${name}`, async ({ page }) => {
  // The closed-session notice pushes the Map down; the Tree hold piece holds viewport y through its scroller observer.
  await serve(async origin => {
    await open(page, origin);
    await before(page);
    await settle(page);
    const rows = await placed(page), read = await reading(page), edge = await mapTop(page);
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
      // A bar opening above the Map (the closed-session notice) moves the Map's edge and the topic bar stuck to it; no row moves.
      const after = new Map((await placed(page)).map(value => [value.key, value])), edgeMoved = await mapTop(page) - edge;
      for (const value of rows) expect(after.get(value.key), `${value.key} keeps its place, height and text width`)
        .toEqual(value.pinned ? { ...value, top: value.top + edgeMoved } : value);
    }
  });
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

/** Every row (or Graph node) drawn now, and those standing above `heldId` with their heights. The sticky topic band stays and is left out. */
const rowsAround = (page: Page, view: View, heldId: string) => page.evaluate(({ kind, held }) => {
  const nodes = [...document.querySelectorAll<HTMLElement>(kind === 'Tree' ? '.tree-scroll [data-row]:not(.tree-topic)' : '.graph-scroll .graph-node[data-item-id]')];
  const keyOf = (element: HTMLElement) => (kind === 'Tree' ? element.dataset.row : element.dataset.itemId)!;
  const top = nodes.find(element => keyOf(element) === held)?.getBoundingClientRect().top ?? 0;
  return { drawn: nodes.map(keyOf), above: nodes.filter(element => element.getBoundingClientRect().top < top - 0.5)
    .map(element => ({ key: keyOf(element), height: element.getBoundingClientRect().height })) };
}, { kind: view, held: heldId });

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
      // How far the Map's own top edge moves in the window when the trigger opens or closes the rows above it, and which
      // rows above the held one are drawn before.
      const edgeBefore = (await viewportPlace(page, scrollerOf(view)))!, drawnBefore = await rowsAround(page, view, held.id);
      await trigger.change(page, view, reader);
      await trigger.done(page, view, reader);
      await settle(page); await page.waitForTimeout(60); await settle(page);
      const edgeMoved = Math.abs((await viewportPlace(page, scrollerOf(view)))!.y - edgeBefore.y);
      const drawnAfter = await rowsAround(page, view, held.id);
      const after = await viewportPlace(page, cellOf(view, held.id));
      expect(after, `${held.id} is still drawn`).not.toBeNull();
      const shift = after!.y - before.y;
      // What left at or above the held row: the Tree's rows (a strip leaves with the row it stood for) by their heights, the
      // Graph's nodes by the pitch between nodes.
      const gone = drawnBefore.above.filter(value => !drawnAfter.drawn.includes(value.key));
      const left = view === 'Tree' ? gone.reduce((sum, value) => sum + value.height, 0) : gone.length * Math.abs(cells[1]!.top - reader.top);
      // At the top an owner-caused boundary may carry the rows up (never down) by what left; anywhere else, nothing moves.
      const room = spot === 'top' && trigger.top ? (trigger.top === 'filter row' ? edgeMoved : left) + 1 : 1;
      expect(shift, `${held.id} moved ${shift}px in the window`).toBeGreaterThanOrEqual(-room);
      expect(shift, `${held.id} moved ${shift}px in the window`).toBeLessThanOrEqual(1);
      expect(Math.abs(after!.x - before.x), `${held.id} moved sideways`).toBeLessThanOrEqual(1);
    });
  }
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
  // The result's Show more (with the 3-line clamp the long question has its own, first).
  await row(page, '1').getByRole('button', { name: 'Show more' }).last().click();
  await expect(row(page, '1').getByRole('button', { name: 'Show less' }).first()).toBeVisible();
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
