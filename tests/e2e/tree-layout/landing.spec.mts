// Landing and markers (alpha.24 P3-P5). ⌘[ / ⌘] (the swipe calls the same) and `n` bring their item into view over a few eased
// frames instead of jumping, and end where the jump ends; reduced motion jumps; the owner's wheel, click or key stops a landing where
// it is, and so does a hide (the Map stays still). The page clock is paused while a landing runs, so each frame is stepped by hand.
// The keyboard focus and the `n` target draw their boxes in the selected box's place: a soft dotted ring, a dashed red one.
import { test, expect, type Page } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import type { Server } from 'node:http';

type Motion = 'reduce' | 'no-preference';
const row = (page: Page, id: string) => page.locator(`[role="treeitem"][data-item-id="${id}"]`);
const scroller = (page: Page) => page.getByTestId('map-scroll');
const scrollTop = (page: Page) => scroller(page).evaluate(box => box.scrollTop);
/** Two real frames; only while the page clock runs. */
const settle = (page: Page) => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const quiet = async (page: Page) => {
  await settle(page); await page.waitForTimeout(250);
  await scroller(page).evaluate(box => { box.dispatchEvent(new Event('scroll')); });
  await settle(page);
};
/** Window tops of the item rows in view, by id. */
const tops = (page: Page) => scroller(page).evaluate(box => {
  const edge = box.getBoundingClientRect(), out: Record<string, number> = {};
  for (const element of box.querySelectorAll<HTMLElement>('[role="treeitem"][data-item-id]')) {
    const rect = element.getBoundingClientRect();
    if (rect.bottom > edge.top && rect.top < edge.bottom) out[element.dataset.itemId!] = Math.round(rect.top * 2) / 2;
  }
  return out;
});
/** The same rows in view, each within a pixel of where it was. */
function same(now: Record<string, number>, was: Record<string, number>) {
  expect(Object.keys(now)).toEqual(Object.keys(was));
  for (const key of Object.keys(was)) expect(Math.abs(now[key]! - was[key]!), `${key}: ${JSON.stringify({ now, was })}`).toBeLessThanOrEqual(1);
}
/** Stops the page clock where it is: no animation frame runs until `frames` steps it. */
const pause = async (page: Page) => {
  // The page's time runs on while this asks it: a moment it has already passed is asked for again, a little later.
  for (let ahead = 20; ; ahead *= 2) {
    try { await page.clock.pauseAt(await page.evaluate(by => Date.now() + by, ahead)); return; } catch (error) {
      if (ahead > 2000 || !String(error).includes('to the past')) throw error;
    }
  }
};
/** Steps `count` frames of 16 ms and returns the scroll position after each. */
async function frames(page: Page, count: number, read: () => Promise<number> = () => scrollTop(page)) {
  const seen: number[] = [];
  for (let index = 0; index < count; index++) { await page.clock.runFor(16); seen.push(await read()); }
  return seen;
}

async function serve(page: Page, run: (open: (query: string, motion: Motion) => Promise<void>) => Promise<void>) {
  const server = await createServer({ configFile: false, root: resolve('.'), publicDir: resolve('apps/desktop/public'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  try {
    await server.listen();
    const address = (server.httpServer as Server).address();
    if (!address || typeof address === 'string') throw new Error('Missing layout fixture server address');
    const origin = `http://127.0.0.1:${address.port}`;
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
    // Wide enough for the Details head's Back and Forward (from 1100 px): a spec waits on Back to know ⌘[ will act.
    await page.setViewportSize({ width: 1280, height: 700 });
    await page.clock.install();
    await run(async (query, motion) => {
      await page.clock.resume();
      await page.emulateMedia({ reducedMotion: motion });
      await page.goto(`${origin}/tests/e2e/tree-layout/fixture.html?${query}`);
      await page.locator('[data-popover-trigger="switcher"]').click();
      await page.getByRole('dialog', { name: 'Switch session or project' }).getByRole('button', { name: 'All sessions' }).click();
      const session = page.locator('button[data-session-id]').first();
      await expect(session).toBeEnabled(); await session.click();
      // The pointer leaves the Map: resting on a row that a big session draws under it would open that row's peek card.
      await page.mouse.move(1, 1);
      await expect(page.getByRole('region', { name: 'Session tree' })).toHaveAttribute('data-session-busy', 'false');
      await expect(page.getByRole('dialog', { name: /^Peek/ })).toHaveCount(0);
      await page.evaluate(async () => { await document.fonts.ready; });
    });
  } finally { await server.close(); }
}

/** Selects `id` with a pointer click on screen (scrolled to first when it is out of view); Details opens on it. */
async function select(page: Page, id: string) {
  const hidden = await row(page, id).evaluate(element => {
    const box = element.closest('[data-testid="map-scroll"]')!.getBoundingClientRect(), rect = element.getBoundingClientRect();
    return rect.top < box.top + 80 || rect.bottom > box.bottom - 80;
  });
  if (hidden) { await row(page, id).evaluate(element => element.scrollIntoView({ block: 'center' })); await quiet(page); }
  // A click while a view change saves is refused (a big session's first saves take a while): it is pressed again.
  await expect(async () => {
    const box = (await row(page, id).boundingBox())!;
    await page.mouse.click(box.x + 60, box.y + 12);
    await expect(row(page, id)).toHaveAttribute('aria-selected', 'true', { timeout: 2000 });
  }).toPass();
  await expect(page.locator(`[data-detail-item-id="${id}"]`).first()).toBeVisible();
  await quiet(page);
}
/**
 * Selects `first`, then `last` at the Map's end, so ⌘[ goes back to `first` from the bottom of the Map (or from scroll position `from`).
 * Returns the scroll position ⌘[ starts from.
 */
async function history(page: Page, first: string, last: string, from?: number) {
  await select(page, first);
  await scroller(page).evaluate(box => { box.scrollTop = box.scrollHeight; }); await quiet(page);
  await select(page, last);
  await scroller(page).evaluate((box, top) => { box.scrollTop = top ?? box.scrollHeight; }, from); await quiet(page);
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeEnabled();
  await expect(row(page, first)).not.toBeInViewport();
  return scrollTop(page);
}
/** ⌘[ with the clock paused: the selection moves at once, and no frame has run yet. */
async function back(page: Page, to: string) {
  await pause(page);
  await page.keyboard.press('Meta+BracketLeft');
  await expect(row(page, to)).toHaveAttribute('aria-selected', 'true');
}
/** Where reduced motion's jump puts the Map for ⌘[ from `history(first, last)`: the jump is there before any frame runs. */
async function jumpEnd(page: Page, open: (query: string, motion: Motion) => Promise<void>, query: string, first: string, last: string) {
  await open(query, 'reduce');
  await history(page, first, last);
  await back(page, first);
  const end = await scrollTop(page);
  expect(await frames(page, 3)).toEqual([end, end, end]);
  return end;
}
/** The frames of a landing from `start` to `end`: several distinct positions between them, in one direction, ending on `end`. */
function eased(seen: readonly number[], start: number, end: number) {
  const between = [...new Set(seen.filter(value => Math.abs(value - start) > 1 && Math.abs(value - end) > 1))];
  expect(between.length, `several frames between ${start} and ${end}: ${seen.join(', ')}`).toBeGreaterThanOrEqual(3);
  const sign = Math.sign(end - start);
  for (let index = 1; index < seen.length; index++) expect((seen[index]! - seen[index - 1]!) * sign).toBeGreaterThanOrEqual(-0.5);
  expect(Math.abs(seen.at(-1)! - end), `ends where the jump ends (${end}): ${seen.join(', ')}`).toBeLessThanOrEqual(1);
}

test.describe('landing', () => {
  test('⌘[ moves the Map over several frames and ends where the jump ends; reduced motion jumps', async ({ page }) => serve(page, async open => {
    const end = await jumpEnd(page, open, 'still', '2', '18');
    await open('still', 'no-preference');
    // Under one screen away (a row above the window lands at the same place from anywhere below it): no part of the way is jumped.
    const screen = await scroller(page).evaluate(box => box.clientHeight);
    const start = await history(page, '2', '18', end + Math.round(0.8 * screen));
    expect(start - end).toBeGreaterThan(0.7 * screen);
    await back(page, '2');
    expect(await scrollTop(page), 'nothing moves before the first frame').toBe(start);
    eased(await frames(page, 30), start, end);
  }));

  test('a long way jumps all but the last screen, then eases over it', async ({ page }) => serve(page, async open => {
    // The Map-still world with 2,000 one-line results after item 18.
    const end = await jumpEnd(page, open, 'still&many', '2', '2099');
    await open('still&many', 'no-preference');
    const start = await history(page, '2', '2099');
    const screen = await scroller(page).evaluate(box => box.clientHeight);
    expect(start - end).toBeGreaterThan(5 * screen);
    await back(page, '2');
    const jumped = await scrollTop(page);
    expect(Math.abs(jumped - end - screen)).toBeLessThanOrEqual(1);
    eased(await frames(page, 30), jumped, end);
  }));

  test('n moves the Map over several frames and ends where its jump ends', async ({ page }) => serve(page, async open => {
    const landOnNext = async () => {
      await scroller(page).evaluate(box => { box.scrollTop = 0; }); await quiet(page);
      await row(page, '1').focus();
      await pause(page);
      await page.keyboard.press('n');
      await expect(row(page, '11')).toHaveAttribute('data-next-unseen', 'true');
    };
    await open('still', 'reduce');
    await landOnNext();
    const end = await scrollTop(page);
    expect(end).toBeGreaterThan(0);
    await open('still', 'no-preference');
    await landOnNext();
    expect(await scrollTop(page)).toBe(0);
    eased(await frames(page, 30), 0, end);
  }));

  for (const input of ['wheel', 'pointer', 'key'] as const) {
    test(`the owner's ${input} stops a landing where it is`, async ({ page }) => serve(page, async open => {
      const end = await jumpEnd(page, open, 'still', '2', '18');
      await open('still', 'no-preference');
      const start = await history(page, '2', '18');
      await back(page, '2');
      await frames(page, 4);
      await scroller(page).evaluate((box, kind) => {
        if (kind === 'wheel') box.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, bubbles: true }));
        else if (kind === 'pointer') box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        else (document.activeElement ?? box).dispatchEvent(new KeyboardEvent('keydown', { key: 'q', bubbles: true }));
      }, input);
      const stopped = await scrollTop(page);
      expect(Math.abs(stopped - start)).toBeGreaterThan(1);
      expect(Math.abs(stopped - end)).toBeGreaterThan(1);
      expect(await frames(page, 30)).toEqual(Array(30).fill(stopped));
    }));
  }

  test('a sideways swipe at the Map\'s edge (the gesture that went back) leaves the landing on its way', async ({ page }) => serve(page, async open => {
    const end = await jumpEnd(page, open, 'still', '2', '18');
    await open('still', 'no-preference');
    const start = await history(page, '2', '18');
    await back(page, '2');
    await frames(page, 2);
    await scroller(page).evaluate(box => { box.dispatchEvent(new WheelEvent('wheel', { deltaX: -30, deltaY: 1, bubbles: true })); });
    eased([start, ...await frames(page, 30)], start, end);
  }));

  test('a hide while the Map lands stops it there, and the Map shows what the same hide shows with no landing', async ({ page }) => serve(page, async open => {
    // Details (outside the Map) hides the item the Map is landing on: no owner input reaches the Map.
    const hide = async () => {
      await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Hide' }).click();
      await expect(row(page, '2')).toHaveCount(0);
    };
    const end = await jumpEnd(page, open, 'still', '2', '18');
    await open('still', 'no-preference');
    await history(page, '2', '18');
    await back(page, '2');
    await frames(page, 4);
    const stopped = await scrollTop(page), before = await tops(page);
    expect(Math.abs(stopped - end)).toBeGreaterThan(1);
    await hide();
    // The hide's hold moves the scroller once, by the hidden row above the window; no frame moves it after that.
    const held = await scrollTop(page);
    expect(await frames(page, 30)).toEqual(Array(30).fill(held));
    await page.clock.resume(); await quiet(page);
    const after = await tops(page);
    // The same hide from the same place, reached with no landing (reduced motion jumps there, then the Map is put where the landing stopped).
    await open('still', 'reduce');
    await history(page, '2', '18');
    await back(page, '2');
    await page.clock.resume();
    await scroller(page).evaluate((box, top) => { box.scrollTop = top; }, stopped); await quiet(page);
    same(await tops(page), before);
    await hide(); await quiet(page);
    expect(Math.abs(await scrollTop(page) - held)).toBeLessThanOrEqual(1);
    same(await tops(page), after);
  }));

  test('the Graph lands ⌘[ over several frames, ends where its jump ends, and a wheel stops it', async ({ page }) => serve(page, async open => {
    const graph = page.getByTestId('graph-scroll'), node = (id: string) => graph.locator(`[data-item-id="${id}"]`);
    const position = () => graph.evaluate(box => box.scrollTop);
    const setUp = async (motion: Motion) => {
      await open('still', motion);
      await page.getByRole('button', { name: 'Graph', exact: true }).click();
      await expect(graph).toBeVisible();
      await node('2').click(); await expect(node('2')).toHaveAttribute('aria-selected', 'true');
      await graph.evaluate(box => { box.scrollTop = box.scrollHeight; }); await settle(page);
      await node('18').click(); await expect(node('18')).toHaveAttribute('aria-selected', 'true');
      await graph.evaluate(box => { box.scrollTop = box.scrollHeight; }); await settle(page); await page.waitForTimeout(250);
      await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeEnabled();
      const start = await position();
      await pause(page);
      await page.keyboard.press('Meta+BracketLeft');
      await expect(node('2')).toHaveAttribute('aria-selected', 'true');
      return start;
    };
    await setUp('reduce');
    const end = await position();
    expect(await frames(page, 3, position)).toEqual([end, end, end]);
    const start = await setUp('no-preference');
    expect(await position()).toBe(start);
    eased(await frames(page, 30, position), start, end);
    // Again, stopped by a wheel on the way.
    await page.clock.resume();
    await page.keyboard.press('Meta+BracketRight');
    await expect(node('18')).toHaveAttribute('aria-selected', 'true');
    await page.waitForTimeout(600);
    await pause(page);
    await page.keyboard.press('Meta+BracketLeft');
    await expect(node('2')).toHaveAttribute('aria-selected', 'true');
    await frames(page, 4, position);
    await graph.evaluate(box => { box.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, bubbles: true })); });
    const stopped = await position();
    expect(Math.abs(stopped - end)).toBeGreaterThan(1);
    expect(await frames(page, 30, position)).toEqual(Array(30).fill(stopped));
  }));
});

/** A row's marker box (`which`: its ::before or ::after, or the selected box) relative to the row, with its line. */
const boxOf = (page: Page, id: string, which: '::before' | '::after' | 'selected') => row(page, id).evaluate((element, part) => {
  const rect = element.getBoundingClientRect();
  if (part === 'selected') {
    const box = element.querySelector('[data-testid="selected-box"]');
    if (!box) return null;
    const inner = box.getBoundingClientRect(), style = getComputedStyle(box);
    return { left: inner.left - rect.left, top: inner.top - rect.top, right: rect.right - inner.right, bottom: rect.bottom - inner.bottom,
      line: style.boxShadow, radius: style.borderTopLeftRadius };
  }
  const style = getComputedStyle(element, part);
  if (style.content === 'none' || style.display === 'none') return null;
  return { left: parseFloat(style.left), top: parseFloat(style.top), right: parseFloat(style.right), bottom: parseFloat(style.bottom),
    line: `${style.borderTopStyle} ${style.borderTopColor}`, radius: style.borderTopLeftRadius };
}, which);

/** The outline a row draws round its whole width: 'none', or its style, width, colour and offset. */
const outlineOf = (page: Page, id: string) => row(page, id).evaluate(element => {
  const style = getComputedStyle(element);
  return style.outlineStyle === 'none' || parseFloat(style.outlineWidth) === 0 ? 'none'
    : `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor} offset ${style.outlineOffset}`;
});

for (const theme of ['light', 'dark'] as const) test(`the focus and n boxes sit in the selected box's place; n wins over selected over focus (${theme})`, async ({ page }) => serve(page, async open => {
  await open('still', 'reduce');
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  await select(page, '9');
  const selected = (await boxOf(page, '9', 'selected'))!;
  expect(selected.line).toContain('1.5px');
  // The ring the selected box draws, 1.5px outside it, is where the other boxes draw their line.
  const ring = { left: selected.left - 1.5, top: selected.top - 1.5, right: selected.right - 1.5, bottom: selected.bottom - 1.5 };
  const sameBox = (box: { left: number; top: number; right: number; bottom: number } | null) => {
    expect(box).not.toBeNull();
    for (const side of ['left', 'top', 'right', 'bottom'] as const) expect(Math.abs(box![side] - ring[side]), side).toBeLessThanOrEqual(0.5);
  };
  await page.keyboard.press('ArrowDown');
  await expect(row(page, '10')).toBeFocused();
  // Focus: a soft dotted ring on the item, no box across the Map.
  const focus = await boxOf(page, '10', '::before');
  sameBox(focus);
  expect(focus!.line).toMatch(/^dotted /);
  // rgba(r, g, b, a) or color(srgb r g b / a), as the browser serialises a mix.
  const alpha = Number(/(?:,|\/)\s*([\d.]+)\)$/.exec(focus!.line)?.[1] ?? 1);
  expect(alpha, 'visible but soft').toBeGreaterThan(0.4); expect(alpha).toBeLessThan(1);
  await expect(row(page, '10')).toHaveCSS('box-shadow', 'none');
  expect(await outlineOf(page, '10')).toBe('none');
  // Selected and focused: the selected box alone.
  await page.keyboard.press('ArrowUp');
  await expect(row(page, '9')).toBeFocused();
  expect(await boxOf(page, '9', '::before')).toBeNull();
  // n: a dashed box in the attention colour, on the item; no focus box with it, no band across the Map.
  await page.keyboard.press('n');
  await expect(row(page, '11')).toHaveAttribute('data-next-unseen', 'true');
  await expect(row(page, '11')).toBeFocused();
  const attention = await row(page, '11').getByTestId('change-marker').evaluate(element => getComputedStyle(element).backgroundColor);
  const next = await boxOf(page, '11', '::after');
  sameBox(next);
  expect(next!.line).toBe(`dashed ${attention}`);
  expect(next!.radius).toBe(focus!.radius);
  expect(await boxOf(page, '11', '::before')).toBeNull();
  expect(await outlineOf(page, '11')).toBe('none');
  await expect(row(page, '11')).toHaveCSS('box-shadow', 'none');
  // Opened, it is selected too: its dashed box stays, and the selected box keeps its wash without its own ring.
  await page.keyboard.press('Enter');
  await expect(row(page, '11')).toHaveAttribute('aria-selected', 'true');
  await expect(row(page, '11')).toHaveAttribute('data-next-unseen', 'true');
  sameBox(await boxOf(page, '11', '::after'));
  expect((await boxOf(page, '11', 'selected'))!.line).not.toContain('1.5px');
}));
