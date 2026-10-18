// The Map never moves for a notice or a toast (alpha.21 E19, E20). The stack and the toast float over the Map, so raising, stacking,
// expanding and dismissing them leaves every row in view where it was (position, height, text width), at the top, in the middle and at
// the bottom of the Map, in the Tree and the Graph. The stack hangs below the topic band and stays above the open dock.
import { test, expect, type Page } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import type { Server } from 'node:http';

const settle = (page: Page) => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
type Floating = { notices: { push(notice: object): string; dismiss(id: string): void }; toasts: { show(toast: object): string; dismiss(id: string): void } };
const push = (page: Page, id: string, tone: 'neutral' | 'warn' | 'problem', text: string) => page.evaluate(({ id, tone, text }) => {
  (window as unknown as { floating: Floating }).floating.notices.push({ id, icon: 'ph ph-info', tone, text, actions: [{ label: 'Go', run: () => {} }] });
}, { id, tone, text });
const toast = (page: Page, text: string) => page.evaluate(value => (window as unknown as { floating: Floating }).floating.toasts.show({ text: value, undo: () => {}, ms: 60_000 }), text);

/** Every row, node and band in view with its window place: a floating layer that moved any of them would show here. */
const placed = (page: Page, scroller: string) => page.locator(scroller).evaluate(box => {
  const edge = box.getBoundingClientRect();
  return [...box.querySelectorAll<HTMLElement>('.tree-item, .tree-topic, .graph-node')].flatMap(row => {
    const rect = row.getBoundingClientRect();
    if (rect.bottom <= edge.top || rect.top >= edge.bottom) return [];
    const text = row.querySelector('.tree-question')?.getBoundingClientRect().width ?? 0;
    return [{ key: row.dataset.row ?? row.dataset.itemId ?? row.className, top: Math.round(rect.top * 2) / 2, left: Math.round(rect.left * 2) / 2,
      height: Math.round(rect.height * 2) / 2, text: Math.round(text * 2) / 2 }];
  });
});

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
  await settle(page);
}

type View = 'Tree' | 'Graph';
type Spot = 'top' | 'middle' | 'bottom';
const scrollerOf = (view: View) => view === 'Tree' ? '.tree-scroll' : '.graph-scroll';
async function scrollTo(page: Page, view: View, spot: Spot) {
  await page.locator(scrollerOf(view)).evaluate((box, where) => {
    box.scrollTop = where === 'top' ? 0 : where === 'bottom' ? box.scrollHeight : Math.round((box.scrollHeight - box.clientHeight) / 2);
  }, spot);
  await settle(page);
}
const stack = (page: Page) => page.getByRole('region', { name: 'Notifications' });
const cards = (page: Page) => page.getByTestId('notice');

type Step = readonly [name: string, run: (page: Page) => Promise<void>, done: (page: Page) => Promise<void>];
const steps: readonly Step[] = [
  ['a notice appears', page => push(page, 'n1', 'warn', 'The first notice.'), page => expect(cards(page)).toHaveCount(1)],
  ['a second notice stacks on top', page => push(page, 'n2', 'problem', 'A second, longer notice that has to wrap over a line or two when the Map is narrow enough.'),
    page => expect(cards(page)).toHaveCount(2)],
  ['a third notice folds into the pill', page => push(page, 'n3', 'neutral', 'The third notice.'), page => expect(page.getByTestId('notice-pill')).toBeVisible()],
  ['the pill expands them all', page => page.getByTestId('notice-pill').getByRole('button', { name: /^⌄ \d+ more$/ }).click(), page => expect(cards(page)).toHaveCount(3)],
  ['one is dismissed with ×', page => cards(page).first().getByRole('button', { name: 'Dismiss' }).click(), page => expect(cards(page)).toHaveCount(2)],
  ['a fourth notice folds again', page => push(page, 'n4', 'neutral', 'The fourth notice.'), page => expect(page.getByTestId('notice-pill')).toBeVisible()],
  ['Dismiss all clears the stack', page => page.getByRole('button', { name: 'Dismiss all' }).click(), page => expect(cards(page)).toHaveCount(0)],
  ['a toast appears', page => toast(page, 'Hid “x”.'), page => expect(page.getByTestId('toast')).toBeVisible()],
  ['a second toast replaces it', page => toast(page, 'Removed “y”.'), page => expect(page.getByTestId('toast')).toContainText('Removed “y”.')],
  ['the toast is closed with ×', page => page.getByTestId('toast').getByRole('button', { name: 'Dismiss' }).click(), page => expect(page.getByTestId('toast')).toHaveCount(0)],
];

for (const view of ['Tree', 'Graph'] as const) for (const spot of ['top', 'middle', 'bottom'] as const) {
  test(`${view}: raising, stacking, expanding and dismissing notices and toasts never moves the Map (${spot})`, async ({ page }) => {
    await serve(async origin => {
      await open(page, origin);
      if (view === 'Graph') { await page.getByRole('button', { name: 'Graph' }).click(); await expect(page.locator('.graph-scroll')).toBeVisible(); await settle(page); }
      await scrollTo(page, view, spot);
      const before = await placed(page, scrollerOf(view)), top = await page.locator(scrollerOf(view)).evaluate(box => box.scrollTop);
      for (const [name, run, done] of steps) {
        await run(page);
        await done(page);
        // The store shows a notice 300 ms after it is raised.
        await page.waitForTimeout(350);
        await settle(page);
        expect(await placed(page, scrollerOf(view)), `after: ${name}`).toEqual(before);
        expect(await page.locator(scrollerOf(view)).evaluate(box => box.scrollTop), `scrollTop after: ${name}`).toBe(top);
      }
    });
  });
}

test('the stack hangs below the topic band, and above the open dock', async ({ page }) => {
  await serve(async origin => {
    await open(page, origin);
    await scrollTo(page, 'Tree', 'top');
    await page.keyboard.press(']');
    const dock = page.getByRole('region', { name: 'Answer dock' });
    await expect(dock).toBeVisible();
    await settle(page);
    await push(page, 'n1', 'warn', 'The first notice.');
    await push(page, 'n2', 'warn', 'The second notice.');
    await page.waitForTimeout(400);
    await expect(cards(page)).toHaveCount(2);
    const band = await page.locator('.tree-topic').first().boundingBox(), first = await cards(page).first().boundingBox();
    const bottom = await cards(page).last().boundingBox(), dockBox = await dock.boundingBox();
    expect(first!.y, 'the first card starts under the band').toBeGreaterThanOrEqual(band!.y + band!.height);
    expect(bottom!.y + bottom!.height, 'the stack ends above the open dock').toBeLessThanOrEqual(dockBox!.y);
    const region = await stack(page).boundingBox(), map = await page.locator('.tree-scroll').boundingBox();
    expect(region!.x, 'left 10 of the Map region').toBeCloseTo(map!.x + 10, 0);
  });
});
