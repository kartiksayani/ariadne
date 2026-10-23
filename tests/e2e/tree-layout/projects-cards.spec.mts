// Projects page cards (alpha.24 P1): every card is as tall as a card with five session rows, whatever it holds, and a card with
// more than five sessions shows five and scrolls the rest inside itself.
import { test, expect, type Locator, type Page } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import type { Server } from 'node:http';

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

async function open(page: Page, origin: string, width: number) {
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  await page.setViewportSize({ width, height: 700 });
  await page.goto(`${origin}/tests/e2e/tree-layout/projects-fixture.html`);
  await expect(page.getByTestId('project-card')).toHaveCount(6);
}

const round = (value: number) => Math.round(value * 10) / 10;
/** The card named `name`: the one holding that project's name button. */
const card = (page: Page, name: string) => page.getByTestId('project-card').filter({ has: page.getByRole('button', { name, exact: true }) });
/** For each card, the distance between two of its parts' edges, rounded. */
const spans = (page: Page, from: 'top' | 'bottom', part: string, edge: 'top' | 'bottom') => page.getByTestId('project-card').evaluateAll(
  (cards, [testid, fromSide, edgeSide]) => cards.map(item => {
    const box = item.getBoundingClientRect(), inner = item.querySelector(`[data-testid="${testid}"]`)!.getBoundingClientRect();
    return Math.round((fromSide === 'top' ? inner[edgeSide as 'top' | 'bottom'] - box.top : box.bottom - inner[edgeSide as 'top' | 'bottom']) * 10) / 10;
  }), [part, from, edge]);
/** Whether row `index` of the list lies fully inside the list's own box. */
const rowShown = (list: Locator, index: number) => list.evaluate((box, at) => {
  const frame = box.getBoundingClientRect(), place = box.querySelectorAll('[data-testid="project-session"]')[at]!.getBoundingClientRect();
  return place.top >= frame.top - 0.5 && place.bottom <= frame.bottom + 0.5;
}, index);

for (const width of [1000, 640, 380]) {
  test(`every project card has one height: none, one, five, seven or twelve sessions, a long name (${width}px)`, async ({ page }) => {
    await serve(async origin => {
      await open(page, origin, width);
      const all = (await page.getByTestId('project-card').evaluateAll(cards => cards.map(item => item.getBoundingClientRect().height))).map(round);
      expect(new Set(all).size, `card heights ${all.join(', ')}`).toBe(1);
      // The footer sits at the same distance from the card's bottom in every card, so the footers line up in a row.
      const gaps = await spans(page, 'bottom', 'project-footer', 'bottom');
      expect(new Set(gaps).size, `footer gaps ${gaps.join(', ')}`).toBe(1);
      // The header never grows: name and path stay on one line each, so the list starts at the same depth.
      const tops = await spans(page, 'top', 'project-sessions', 'top');
      expect(new Set(tops).size, `list tops ${tops.join(', ')}`).toBe(1);
    });
  });
}

test('a card with five sessions or fewer does not scroll; the empty card keeps its text at the top', async ({ page }) => {
  await serve(async origin => {
    await open(page, origin, 1000);
    for (const name of ['notes-empty', 'notes-one', 'notes-five']) {
      const list = card(page, name).getByTestId('project-sessions');
      expect(await list.evaluate(element => element.scrollHeight <= element.clientHeight), name).toBe(true);
    }
    await expect(card(page, 'notes-empty').getByText(/No sessions\. Its last one/)).toBeVisible();
    await expect(card(page, 'notes-five').getByTestId('project-session')).toHaveCount(5);
  });
});

test('a card with seven sessions shows five rows, and the wheel scrolls the list to the sixth and seventh, not the page', async ({ page }) => {
  await serve(async origin => {
    await open(page, origin, 1000);
    const list = card(page, 'notes-seven').getByTestId('project-sessions');
    await expect(list.getByTestId('project-session')).toHaveCount(7);
    expect(await Promise.all([0, 1, 2, 3, 4, 5, 6].map(index => rowShown(list, index)))).toEqual([true, true, true, true, true, false, false]);
    expect(await list.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    const scroller = page.getByRole('region', { name: 'Projects' });
    const before = await scroller.evaluate(element => element.scrollTop);
    await list.hover();
    await page.mouse.wheel(0, 40);
    await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    expect(await scroller.evaluate(element => element.scrollTop)).toBe(before);
    await page.mouse.wheel(0, 600);
    await expect.poll(() => list.evaluate(element => Math.round(element.scrollTop) >= element.scrollHeight - element.clientHeight - 1)).toBe(true);
    expect(await rowShown(list, 5)).toBe(true);
    expect(await rowShown(list, 6)).toBe(true);
    expect(await scroller.evaluate(element => element.scrollTop)).toBe(before);
  });
});

test('a scrolling card is framed so the owner can see the list scrolls; a card that fits is not', async ({ page }) => {
  await serve(async origin => {
    await open(page, origin, 1000);
    const frame = (name: string) => card(page, name).getByTestId('project-sessions').evaluate(element => getComputedStyle(element).boxShadow);
    expect(await frame('notes-seven')).not.toBe('none');
    expect(await frame('notes-twelve')).not.toBe('none');
    expect(await frame('notes-five')).toBe('none');
    expect(await frame('notes-empty')).toBe('none');
  });
});

test('the first row of a card is at the same place whether or not the list scrolls', async ({ page }) => {
  await serve(async origin => {
    await open(page, origin, 1000);
    const offset = (name: string) => card(page, name).evaluate(element => Math.round((element.querySelector('[data-testid="project-session"]')!.getBoundingClientRect().top - element.getBoundingClientRect().top) * 10) / 10);
    expect(await offset('notes-seven')).toBe(await offset('notes-five'));
  });
});
