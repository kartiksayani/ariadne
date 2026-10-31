// Landing and markers (alpha.24 P3-P5). ⌘[ / ⌘] (the swipe calls the same) and `n` bring their item into view over a few eased
// frames instead of jumping, and end where the jump ends; reduced motion jumps; the owner's wheel, click or key stops a landing where
// it is, and so does a hide (the Map stays still). The page clock is paused while a landing runs, so each frame is stepped by hand.
// The keyboard focus and the `n` target draw their boxes in the selected box's place: a soft dotted ring, a dashed red one.
import { test, expect, type Page } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import type { Server } from 'node:http';
import { closeDetails } from './closeDetails';

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
/**
 * Where the Map must end for row `id`, worked out from the rows as they stand now (before the way is taken), not from the jump: the
 * row nearest in view, 8px clear of the topic band, of the dock and of the Back-to pill on screen at this moment.
 */
const mapEnd = (page: Page, id: string) => scroller(page).evaluate((box, key) => {
  const element = box.querySelector<HTMLElement>(`[role="treeitem"][data-item-id="${key}"]`)!;
  const a = box.getBoundingClientRect(), b = element.getBoundingClientRect(), margin = 8;
  // The topic band of the row's group, the Back-to pill (the one button with an edge) and the answer dock.
  let group = element.parentElement;
  while (group && !group.querySelector(':scope > [data-topic-id]')) group = group.parentElement;
  const band = group?.querySelector(':scope > [data-topic-id]')?.getBoundingClientRect().height ?? 0;
  const back = box.parentElement?.querySelector<HTMLElement>('button[data-edge]'), pill = back?.getBoundingClientRect();
  const solid = !!pill && pill.height > 0, dock = document.querySelector('[aria-label="Answer dock"]')?.getBoundingClientRect().top;
  const top = Math.max(band + margin, solid && back!.dataset.edge === 'above' ? pill.bottom - a.top + margin : 0);
  const bottom = Math.min((dock === undefined ? a.bottom : Math.min(a.bottom, dock)) - a.top - margin, solid && back!.dataset.edge === 'below' ? pill.top - a.top - margin : Infinity);
  const rowTop = b.top - a.top;
  const by = rowTop < top ? rowTop - top : rowTop + b.height > bottom ? Math.min(rowTop + b.height - bottom, rowTop - top) : 0;
  return Math.min(Math.max(box.scrollTop + by, 0), box.scrollHeight - box.clientHeight);
}, id);
/** Where the Graph must end for node `id`: its middle in the middle of the view, as far as the scroll range allows. */
const graphEnd = (page: Page, id: string) => page.getByTestId('graph-scroll').evaluate((box, key) => {
  const a = box.getBoundingClientRect(), b = box.querySelector(`[data-item-id="${key}"]`)!.getBoundingClientRect();
  const dock = document.querySelector('[aria-label="Answer dock"]')?.getBoundingClientRect().top;
  const shown = (dock === undefined ? a.bottom : Math.min(a.bottom, dock)) - a.top;
  const clamp = (value: number, room: number) => Math.min(Math.max(value, 0), Math.max(0, room));
  return { top: clamp(box.scrollTop + (b.top + Math.min(b.height, 120) / 2) - (a.top + shown / 2), box.scrollHeight - box.clientHeight),
    left: clamp(box.scrollLeft + (b.left + b.width / 2) - (a.left + a.width / 2), box.scrollWidth - box.clientWidth) };
}, id);
/**
 * The frames of a landing from `start` to `end`: several distinct positions between them, in one direction, no frame a big share of
 * the way and the last one small (no jump at the end), ending on `end`, which is also the end worked out from the geometry (`expected`).
 */
function eased(seen: readonly number[], start: number, end: number, expected = end) {
  const between = [...new Set(seen.filter(value => Math.abs(value - start) > 1 && Math.abs(value - end) > 1))];
  expect(between.length, `several frames between ${start} and ${end}: ${seen.join(', ')}`).toBeGreaterThanOrEqual(3);
  const sign = Math.sign(end - start), total = Math.abs(end - start);
  const steps = seen.map((value, index) => (value - (index ? seen[index - 1]! : start)) * sign);
  for (const step of steps) expect(step).toBeGreaterThanOrEqual(-0.5);
  expect(Math.max(...steps), `no frame moves more than a third of the way: ${seen.join(', ')}`).toBeLessThanOrEqual(0.35 * total + 1);
  const moving = steps.filter(step => step > 0.5);
  expect(moving.at(-1)!, `the last frame that moves is small: ${seen.join(', ')}`).toBeLessThanOrEqual(0.1 * total + 1);
  expect(Math.abs(seen.at(-1)! - end), `ends where the jump ends (${end}): ${seen.join(', ')}`).toBeLessThanOrEqual(1);
  expect(Math.abs(end - expected), `and where the rows' geometry puts it (${expected})`).toBeLessThanOrEqual(1);
}

test.describe('landing', () => {
  test('⌘[ moves the Map over several frames and ends where the jump ends; reduced motion jumps', async ({ page }) => serve(page, async open => {
    const end = await jumpEnd(page, open, 'still', '2', '18');
    await open('still', 'no-preference');
    // Under one screen away (a row above the window lands at the same place from anywhere below it): no part of the way is jumped.
    const screen = await scroller(page).evaluate(box => box.clientHeight);
    const start = await history(page, '2', '18', end + Math.round(0.8 * screen));
    expect(start - end).toBeGreaterThan(0.7 * screen);
    const expected = await mapEnd(page, '2');
    await back(page, '2');
    expect(await scrollTop(page), 'nothing moves before the first frame').toBe(start);
    eased(await frames(page, 30), start, end, expected);
  }));

  test('a long way jumps all but the last screen, then eases over it', async ({ page }) => serve(page, async open => {
    // The Map-still world with 2,000 one-line results after item 18.
    const end = await jumpEnd(page, open, 'still&many', '2', '2099');
    await open('still&many', 'no-preference');
    const start = await history(page, '2', '2099');
    const screen = await scroller(page).evaluate(box => box.clientHeight);
    expect(start - end).toBeGreaterThan(5 * screen);
    const expected = await mapEnd(page, '2');
    await back(page, '2');
    const jumped = await scrollTop(page);
    expect(Math.abs(jumped - end - screen)).toBeLessThanOrEqual(1);
    eased(await frames(page, 30), jumped, end, expected);
  }));

  test('n moves the Map over several frames and ends where its jump ends', async ({ page }) => serve(page, async open => {
    const landOnNext = async () => {
      await scroller(page).evaluate(box => { box.scrollTop = 0; }); await quiet(page);
      await row(page, '1').focus();
      const expected = await mapEnd(page, '11');
      await pause(page);
      await page.keyboard.press('n');
      await expect(row(page, '11')).toHaveAttribute('data-next-unseen', 'true');
      return expected;
    };
    await open('still', 'reduce');
    const expected = await landOnNext();
    const end = await scrollTop(page);
    expect(end).toBeGreaterThan(0);
    await open('still', 'no-preference');
    expect(Math.abs(await landOnNext() - expected)).toBeLessThanOrEqual(1);
    expect(await scrollTop(page)).toBe(0);
    eased(await frames(page, 30), 0, end, expected);
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
    await history(page, '2', '18');
    await back(page, '2');
    const jumped = await scrollTop(page);
    const before = await frames(page, 2);
    await scroller(page).evaluate(box => { box.dispatchEvent(new WheelEvent('wheel', { deltaX: -30, deltaY: 1, bubbles: true })); });
    eased([...before, ...await frames(page, 30)], jumped, end);
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
      expected = (await graphEnd(page, '2')).top;
      await pause(page);
      await page.keyboard.press('Meta+BracketLeft');
      await expect(node('2')).toHaveAttribute('aria-selected', 'true');
      return start;
    };
    let expected = 0;
    await setUp('reduce');
    const end = await position();
    expect(await frames(page, 3, position)).toEqual([end, end, end]);
    const start = await setUp('no-preference');
    expect(await position()).toBe(start);
    eased(await frames(page, 30, position), start, end, expected);
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

  test('the Graph lands through the trailing momentum of the swipe that began it, though the landing opens the room that wheel would scroll', async ({ page }) => serve(page, async open => {
    const graph = page.getByTestId('graph-scroll'), node = (id: string) => graph.locator(`[data-item-id="${id}"]`);
    const place = () => graph.evaluate(box => ({ top: box.scrollTop, left: box.scrollLeft }));
    // 23 is the deepest node, far to the right of 1; the Graph rests at its left edge, as a back swipe starts.
    const setUp = async (motion: Motion) => {
      await open('nav', motion);
      await page.getByRole('button', { name: 'Graph', exact: true }).click();
      await expect(graph).toBeVisible();
      await node('23').click(); await expect(node('23')).toHaveAttribute('aria-selected', 'true');
      await node('1').click(); await expect(node('1')).toHaveAttribute('aria-selected', 'true');
      await graph.evaluate(box => { box.scrollLeft = 0; }); await settle(page); await page.waitForTimeout(250);
      await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeEnabled();
      expect((await place()).left).toBe(0);
    };
    await setUp('reduce');
    await page.keyboard.press('Meta+BracketLeft');
    await expect(node('23')).toHaveAttribute('aria-selected', 'true');
    await settle(page);
    const end = await place();
    expect(end.left, 'the way back is sideways').toBeGreaterThan(100);
    await setUp('no-preference');
    const expected = await graphEnd(page, '23');
    // The swipe: three wheel events commit it (the page clock stands still, so the momentum below can be paced by frames); its
    // momentum goes on a wheel event per frame, the landing moving the Graph sideways under it, so that each of them would scroll it.
    await pause(page);
    const wheel = (deltaX: number, times = 1) => graph.evaluate(async (box, [by, count, settle]) => {
      for (let index = 0; index < count!; index++) box.dispatchEvent(new WheelEvent('wheel', { deltaX: by, deltaY: 0, bubbles: true, cancelable: true }));
      // The commit that follows the swipe starts the landing, which first jumps all but the last screen of a long way: after a task.
      if (settle) await new Promise<void>(done => { const channel = new MessageChannel(); channel.port1.onmessage = () => done(); channel.port2.postMessage(0); });
      return box.scrollLeft;
    }, [deltaX, times, times > 1]);
    const start = await wheel(-40, 3);
    const trace = await frames(page, 30, () => wheel(-20));
    await expect(node('23')).toHaveAttribute('aria-selected', 'true');
    // It keeps moving across several frames while the momentum comes in (stopped by it, the Graph stays where the first frame left it).
    eased(trace, start, end.left, expected.left);
    expect(Math.abs((await place()).top - end.top)).toBeLessThanOrEqual(1);
  }));

  /** A ⌘[ landing on its way to row 2 (the page clock paused, four frames in): the Map has moved and has not arrived. */
  async function underWay(page: Page, open: (query: string, motion: Motion) => Promise<void>) {
    const end = await jumpEnd(page, open, 'still', '2', '18');
    await open('still', 'no-preference');
    await history(page, '2', '18');
    await back(page, '2');
    await frames(page, 4);
    const at = await scrollTop(page);
    expect(Math.abs(at - end)).toBeGreaterThan(1);
    return { end, at };
  }
  /** Counts the writes to the Map scroller's scrollTop from now on. The element, and the count with it, outlive the Map leaving the page. */
  const watchWrites = (page: Page) => scroller(page).evaluate(box => {
    const writes = { count: 0 }, own = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!;
    Object.defineProperty(box, 'scrollTop', { configurable: true, get(this: Element) { return own.get!.call(this) as number; },
      set(this: Element, value: number) { ++writes.count; own.set!.call(this, value); } });
    (window as unknown as { writes: typeof writes }).writes = writes;
  });
  const writes = (page: Page) => page.evaluate(() => (window as unknown as { writes: { count: number } }).writes.count);
  /** Steps `count` frames with the clock paused (nothing is read). */
  const step = async (page: Page, count: number) => { for (let index = 0; index < count; index++) await page.clock.runFor(16); };
  const sessionsPage = async (page: Page) => {
    await page.locator('[data-popover-trigger="switcher"]').click();
    await page.getByRole('dialog', { name: 'Switch session or project' }).getByRole('button', { name: 'All sessions' }).click();
    await expect(page.locator('button[data-session-id]').first()).toBeEnabled();
  };

  test('Map to Graph and back during a landing: the Map left is not written again, the Map that returns stays where it is', async ({ page }) => serve(page, async open => {
    await underWay(page, open);
    await watchWrites(page);
    await page.getByRole('button', { name: 'Graph', exact: true }).click();
    await expect(page.getByTestId('graph-scroll')).toBeVisible();
    await step(page, 30);
    expect(await writes(page), 'the Map that left was not moved again').toBe(0);
    await page.getByRole('button', { name: 'Tree', exact: true }).click();
    await expect(scroller(page)).toBeVisible();
    await page.clock.resume(); await quiet(page);
    const returned = await scrollTop(page);
    await page.waitForTimeout(600);
    expect(await scrollTop(page), 'the Map that returned does not land').toBe(returned);
  }));

  test('the Map leaving the page during a landing is not written again, and comes back still', async ({ page }) => serve(page, async open => {
    await underWay(page, open);
    await watchWrites(page);
    await sessionsPage(page);
    await step(page, 30);
    expect(await writes(page), 'the Map that unmounted was not moved again').toBe(0);
    await page.locator('button[data-session-id]').first().click();
    await page.clock.resume();
    await expect(page.getByRole('region', { name: 'Session tree' })).toHaveAttribute('data-session-busy', 'false');
    await quiet(page);
    const returned = await scrollTop(page);
    await page.waitForTimeout(600);
    expect(await scrollTop(page), 'the Map that came back does not land').toBe(returned);
  }));

  test('a session switch during a landing leaves the other session\'s Map still', async ({ page }) => serve(page, async open => {
    await underWay(page, open);
    await sessionsPage(page);
    expect(await page.locator('button[data-session-id]').count(), 'a second session to switch to').toBeGreaterThan(1);
    await page.locator('button[data-session-id]').nth(1).click();
    await page.clock.resume();
    await expect(page.getByRole('region', { name: 'Session tree' })).toHaveAttribute('data-session-busy', 'false');
    await quiet(page);
    const opened = await scrollTop(page);
    await page.waitForTimeout(600);
    expect(await scrollTop(page), 'the other session\'s Map does not land').toBe(opened);
  }));

  test('the topic path\'s top during a landing puts the Map at the top and nothing pulls it away', async ({ page }) => serve(page, async open => {
    await underWay(page, open);
    await page.getByRole('navigation', { name: 'Item location' }).locator('button').first().click();
    await expect.poll(() => scrollTop(page)).toBe(0);
    expect(await frames(page, 30)).toEqual(Array(30).fill(0));
  }));

  test('Undo of a hide during a landing stops it where it is', async ({ page }) => serve(page, async open => {
    const end = await jumpEnd(page, open, 'still', '2', '18');
    await open('still', 'no-preference');
    await history(page, '2', '18');
    // An unrelated row goes (the Map stays still); ⌘[ then goes back to row 2 over the frames; Undo comes in the middle.
    const box = (await row(page, '16').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 12);
    const hide = row(page, '16').getByRole('button', { name: /^Hide/ });
    await expect(hide).toBeVisible();
    const place = (await hide.boundingBox())!;
    await page.mouse.click(place.x + place.width / 2, place.y + place.height / 2);
    await expect(row(page, '16')).toHaveCount(0);
    await page.mouse.move(1, 1);
    await quiet(page);
    await back(page, '2');
    await frames(page, 4);
    const moving = await scrollTop(page);
    expect(Math.abs(moving - end)).toBeGreaterThan(1);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(row(page, '16')).toHaveCount(1);
    const stopped = await scrollTop(page);
    expect(Math.abs(stopped - end)).toBeGreaterThan(1);
    expect(await frames(page, 30)).toEqual(Array(30).fill(stopped));
  }));

  test('a row above the target growing during a Map landing: it still ends on the row, and the row stays put afterwards', async ({ page }) => serve(page, async open => {
    await open('still', 'no-preference');
    const start = await history(page, '2', '18');
    const topIn = () => scroller(page).evaluate(box => document.querySelector('[role="treeitem"][data-item-id="2"]')!.getBoundingClientRect().top - box.getBoundingClientRect().top);
    const grow = (by: number) => row(page, '1').evaluate((element, extra) => { element.style.minHeight = `${element.getBoundingClientRect().height + extra}px`; }, by);
    // Row 2's place when the landing arrives, from the rows as they stand now: where it is now, less the way the Map has to go.
    const wanted = await topIn() - (await mapEnd(page, '2') - start);
    await back(page, '2');
    await frames(page, 4);
    await grow(90);
    const seen = await frames(page, 40);
    expect(Math.abs(await topIn() - wanted), `row 2 ends where it would without the resize (${wanted}): ${seen.join(', ')}`).toBeLessThanOrEqual(1);
    const arrived = await scrollTop(page);
    expect(await frames(page, 20), 'nothing moves after arrival').toEqual(Array(20).fill(arrived));
    // And the retained row keeps its place when a row above it grows again.
    await grow(60);
    await page.clock.resume(); await quiet(page);
    expect(Math.abs(await topIn() - wanted), 'the arrived row stays put').toBeLessThanOrEqual(1);
  }));

  test('the Graph window growing or shrinking during a landing: it still ends on the node, and stays', async ({ page }) => serve(page, async open => {
    const graph = page.getByTestId('graph-scroll'), node = (id: string) => graph.locator(`[data-item-id="${id}"]`);
    const position = () => graph.evaluate(box => box.scrollTop);
    await open('still', 'no-preference');
    await page.getByRole('button', { name: 'Graph', exact: true }).click();
    await expect(graph).toBeVisible();
    await node('2').click(); await expect(node('2')).toHaveAttribute('aria-selected', 'true');
    await graph.evaluate(box => { box.scrollTop = box.scrollHeight; }); await settle(page);
    await node('18').click(); await expect(node('18')).toHaveAttribute('aria-selected', 'true');
    await graph.evaluate(box => { box.scrollTop = box.scrollHeight; }); await settle(page); await page.waitForTimeout(250);
    await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeEnabled();
    await pause(page);
    await page.keyboard.press('Meta+BracketLeft');
    await expect(node('2')).toHaveAttribute('aria-selected', 'true');
    await frames(page, 4, position);
    await page.setViewportSize({ width: 1280, height: 560 });
    const seen = await frames(page, 40, position);
    const wanted = (await graphEnd(page, '2')).top;
    expect(Math.abs(seen.at(-1)! - wanted), `the node is centred in the window as it is now (${wanted}): ${seen.join(', ')}`).toBeLessThanOrEqual(1);
    expect(await frames(page, 20, position), 'nothing moves after arrival').toEqual(Array(20).fill(seen.at(-1)));
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

/**
 * Paint, not style (alpha.28): the computed ::before can be the dotted ring while a box slice of the row paints over it. So one
 * screenshot of the row before the key (the ground) and one after are read pixel for pixel on each edge of the box, in a band 3px
 * across the edge's centre line and 8px along it (a dotted 1.5px line at DPR 1 is antialiased round dots with gaps, and no pixel of it
 * is whole). The expected colour of a pixel is `mix` x the ink + (1 - mix) x that pixel's ground. A dotted edge shows when some pixel of
 * its band moved from its ground value toward that colour by a third of the way or more (the same fraction on every channel); an
 * opaque dashed edge (`full`) when some pixel moved to within 24 per channel of it.
 * The top edge is read left of the hover bar, which covers the row's top 5px around its centre once the row is focused.
 */
type Edge = 'left' | 'right' | 'top' | 'bottom';
interface EdgeReading { readonly edge: Edge; readonly hits: number; readonly of: number; readonly groundFar: boolean; readonly best: readonly number[]; readonly want: readonly number[]; readonly cover: number }
const shot = async (page: Page) => (await page.screenshot()).toString('base64');
const readEdges = (page: Page, args: { ground: string; after: string; id: string; part: '::before' | '::after'; ink: string; mix: number; full: boolean }) => page.evaluate(async ({ ground, after, id, part, ink, mix, full }) => {
  const element = document.querySelector(`[role="treeitem"][data-item-id="${id}"]`)!;
  const rect = element.getBoundingClientRect(), style = getComputedStyle(element, part);
  const left = rect.left + parseFloat(style.left), top = rect.top + parseFloat(style.top);
  const right = rect.right - parseFloat(style.right), bottom = rect.bottom - parseFloat(style.bottom);
  // The hover bar is the row's one child that carries a side (above, below or inside).
  const bar = element.querySelector('[data-side]')!.getBoundingClientRect();
  const colour = (css: string) => {
    const swatch = document.createElement('canvas'); swatch.width = swatch.height = 1;
    const context = swatch.getContext('2d')!; context.fillStyle = css; context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data];
  };
  let source = ink;
  if (ink === 'accent') { const swatch = document.createElement('span'); swatch.style.color = 'var(--color-accent)'; element.append(swatch); source = getComputedStyle(swatch).color; swatch.remove(); }
  const wanted = colour(source);
  const decode = async (base64: string) => {
    const image = new Image();
    await new Promise<void>((done, fail) => { image.onload = () => done(); image.onerror = fail; image.src = `data:image/png;base64,${base64}`; });
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    return context;
  };
  const [before, now] = [await decode(ground), await decode(after)];
  const pixel = (context: CanvasRenderingContext2D, x: number, y: number) => [...context.getImageData(x, y, 1, 1).data];
  // The run of the straight sides lies between the corner radii (7.5px).
  const runX = [left + 7.5, right - 7.5], runY = [top + 7.5, bottom - 7.5];
  const topEnd = Math.min(runX[0]! + (runX[1]! - runX[0]!) / 4, bar.left - 2);
  const bands: Record<Edge, { xs: number[]; ys: number[] }> = {
    left: { xs: [-1, 0, 1].map(step => Math.floor(left + 0.75) + step), ys: Array.from({ length: 8 }, (_, at) => Math.floor((runY[0]! + runY[1]!) / 2) - 4 + at) },
    right: { xs: [-1, 0, 1].map(step => Math.floor(right - 0.75) + step), ys: Array.from({ length: 8 }, (_, at) => Math.floor((runY[0]! + runY[1]!) / 2) - 4 + at) },
    top: { xs: Array.from({ length: 8 }, (_, at) => Math.floor((runX[0]! + topEnd) / 2) - 4 + at), ys: [-1, 0, 1].map(step => Math.floor(top + 0.75) + step) },
    bottom: { xs: Array.from({ length: 8 }, (_, at) => Math.floor((runX[0]! + runX[1]!) / 2) - 4 + at), ys: [-1, 0, 1].map(step => Math.floor(bottom - 0.75) + step) },
  };
  const readings: EdgeReading[] = [];
  for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
    let hits = 0, of = 0, groundFar = false, best: number[] = [], bestScore = -Infinity, bestWant: number[] = [], bestCover = 0;
    for (const x of bands[edge].xs) for (const y of bands[edge].ys) {
      const was = pixel(before, x, y), got = pixel(now, x, y);
      const expected = [0, 1, 2].map(channel => mix * wanted[channel]! + (1 - mix) * was[channel]!);
      const away = (value: number[]) => Math.max(...[0, 1, 2].map(channel => Math.abs(value[channel]! - expected[channel]!)));
      // How far the pixel moved from its ground toward the expected colour, per channel that has room to move (0 = still the ground, 1 = all the way).
      const covers = [0, 1, 2].filter(channel => Math.abs(was[channel]! - expected[channel]!) > 24).map(channel => (was[channel]! - got[channel]!) / (was[channel]! - expected[channel]!));
      const cover = covers.length ? covers.reduce((sum, value) => sum + value, 0) / covers.length : 0;
      const along = covers.length > 0 && Math.max(...covers) - Math.min(...covers) <= 0.15;
      of++;
      if (away(was) > 24) groundFar = true;
      // A full line (an opaque colour) is within 24 of the colour; a dotted 1.5px line is antialiased round dots, none of them whole pixels.
      const painted = full ? away(got) <= 24 && away(was) > 24 : along && cover >= 0.35 && cover <= 1.2;
      if (painted) hits++;
      const score = full ? -away(got) : along ? cover : -1;
      if (score > bestScore) { bestScore = score; best = got.slice(0, 3); bestWant = expected.map(Math.round); bestCover = cover; }
    }
    readings.push({ edge, hits, of, groundFar, best, want: bestWant, cover: Math.round(bestCover * 100) / 100 });
  }
  return readings;
}, args);
const describeEdges = (readings: readonly EdgeReading[]) => readings.map(read => `${read.edge}: ${read.hits}/${read.of} band pixels painted (best [${read.best}] = ${read.cover} of the way to [${read.want}])`).join('; ');
/** Every edge's band must differ meaningfully from its colour, or the check could not tell a painted edge from the ground. */
function showsAllEdges(readings: readonly EdgeReading[], what: string) {
  console.log(`${what}: ${describeEdges(readings)}`);
  for (const read of readings) expect.soft(read.groundFar, `${what}, ${read.edge}: the ground is not already the ring's colour`).toBe(true);
  for (const read of readings) expect.soft(read.hits, `${what}, ${read.edge} edge is painted (${describeEdges(readings)})`).toBeGreaterThan(0);
}

for (const theme of ['light', 'dark'] as const) for (const details of ['open', 'closed'] as const) {
  test(`the dotted focus box is painted on all four edges, not only styled (${theme}, Details ${details})`, async ({ page }) => serve(page, async open => {
    await open('still', 'reduce');
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await select(page, '9');
    if (details === 'closed') {
      await closeDetails(page, true);
      await expect(page.getByRole('button', { name: 'More actions', exact: true })).toHaveCount(0);
      await row(page, '9').focus();
    }
    await page.mouse.move(1, 1);
    await quiet(page);
    const was = await row(page, '10').boundingBox();
    const ground = await shot(page);
    await page.keyboard.press('ArrowDown');
    await expect(row(page, '10')).toBeFocused();
    await expect(page.getByRole('region', { name: 'Session tree' })).toHaveAttribute('data-kbd');
    await settle(page);
    expect(await row(page, '10').boundingBox(), 'the row stays where it was').toEqual(was);
    expect(await boxOf(page, '10', '::before'), 'the dotted box is the computed one').not.toBeNull();
    showsAllEdges(await readEdges(page, { ground, after: await shot(page), id: '10', part: '::before', ink: 'accent', mix: 0.7, full: false }), `focus box (${theme}, Details ${details})`);
  }));
}

for (const theme of ['light', 'dark'] as const) test(`the dashed n box is painted on all four edges, in the attention colour (${theme})`, async ({ page }) => serve(page, async open => {
  await open('still', 'reduce');
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  await select(page, '9');
  // The row is in clear view already, so the `n` landing leaves the Map where it is and the ground is the same pixels.
  await row(page, '11').evaluate(element => element.scrollIntoView({ block: 'center' }));
  await page.mouse.move(1, 1);
  await quiet(page);
  const was = await row(page, '11').boundingBox();
  const ground = await shot(page);
  await page.keyboard.press('n');
  await expect(row(page, '11')).toHaveAttribute('data-next-unseen', 'true');
  await expect(row(page, '11')).toBeFocused();
  await page.waitForTimeout(1100); await settle(page);
  expect(await row(page, '11').boundingBox(), 'the row stays where it was').toEqual(was);
  const attention = await row(page, '11').getByTestId('change-marker').evaluate(element => getComputedStyle(element).backgroundColor);
  showsAllEdges(await readEdges(page, { ground, after: await shot(page), id: '11', part: '::after', ink: attention, mix: 1, full: true }), `n box (${theme})`);
}));

/**
 * A focused, unselected ancestor of the selected item: the selection thread crosses its ring (accepted by design, alpha.28). The thread
 * and the elbow paint later at z-index 0 than the ring. The probes sit on their opaque halos (not on the accent stroke, which the ring's
 * accent would hide), where a ring painted on top would tint the halo.
 */
for (const theme of ['light', 'dark'] as const) test(`on a focused ancestor of the selected item the thread and the elbow still paint over the dotted box (${theme})`, async ({ page }) => serve(page, async open => {
  await open('still', 'reduce');
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  // 1.1 is item 1's child: the selection chain runs through item 1.
  if (await row(page, '1.1').count() === 0) await row(page, '1').getByRole('button', { name: 'Expand or collapse' }).click();
  await expect(row(page, '1.1')).toHaveCount(1);
  await select(page, '1.1');
  const parent = '1';
  for (let presses = 0; presses < 12 && !(await row(page, parent).evaluate(element => element === document.activeElement)); presses++) await page.keyboard.press('ArrowUp');
  await expect(row(page, parent)).toBeFocused();
  await expect(row(page, parent)).not.toHaveAttribute('aria-selected', 'true');
  expect(await boxOf(page, parent, '::before'), 'the dotted box is the computed one').not.toBeNull();
  await page.mouse.move(1, 1);
  await settle(page);
  const base64 = await shot(page);
  const probes = await row(page, parent).evaluate(async (element, png) => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element, '::before');
    const ring = { left: rect.left + parseFloat(style.left), bottom: rect.bottom - parseFloat(style.bottom) };
    const own = (name: string) => [...element.children].find(child => child.classList.contains(name))?.getBoundingClientRect();
    const elbow = own('tree-thread-elbow'), thread = own('tree-thread');
    // The bytes of a colour variable (the halo is an oklch colour): the 1x1 canvas converts it.
    const bytesOf = (variable: string) => {
      const swatch = document.createElement('span'); swatch.style.color = `var(${variable})`; element.append(swatch);
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const paint = canvas.getContext('2d')!; paint.fillStyle = getComputedStyle(swatch).color; paint.fillRect(0, 0, 1, 1); swatch.remove();
      return [...paint.getImageData(0, 0, 1, 1).data];
    };
    const halo = bytesOf('--tree-halo');
    const image = new Image();
    await new Promise<void>((done, fail) => { image.onload = () => done(); image.onerror = fail; image.src = `data:image/png;base64,${png}`; });
    const page = document.createElement('canvas'); page.width = image.width; page.height = image.height;
    const context = page.getContext('2d')!; context.drawImage(image, 0, 0);
    const read = (name: string, meets: boolean, x: number, y: number) => {
      const got = [...context.getImageData(x, y, 1, 1).data];
      return { name, meets, x, y, got: got.slice(0, 3), halo: halo.slice(0, 3), ok: [0, 1, 2].every(channel => Math.abs(got[channel]! - halo[channel]!) <= 3) };
    };
    // The ring is the accent at 70%, so over the 3px accent stroke it would still read accent. The halos are opaque and differ from the
    // ring: a halo pixel that crosses the ring reads the halo only if the line paints over the ring (the ring on top would tint it).
    return [
      // The elbow's 2px halo just below its stroke runs across the ring's left edge; the thread's left halo (2px, left of the stroke) across the ring's bottom edge.
      elbow && read('elbow halo over the ring\'s left edge', elbow.left < ring.left && ring.left < elbow.right && ring.left - elbow.left > 9, Math.floor(ring.left + 0.75), Math.ceil(elbow.bottom)),
      thread && read('thread halo over the ring\'s bottom edge', thread.top < ring.bottom - 1.5 && ring.bottom < thread.bottom, Math.floor(thread.left - 1), Math.floor(ring.bottom - 0.75)),
    ];
  }, base64);
  expect(probes.every(Boolean), 'the focused parent draws a thread and an elbow').toBe(true);
  for (const probe of probes) {
    expect(probe!.meets, `${probe!.name}: the line does cross the ring there`).toBe(true);
    expect.soft(probe!.ok, `${probe!.name} (${probe!.x},${probe!.y}) reads the halo [${probe!.halo}], got [${probe!.got}]`).toBe(true);
  }
}));

/** Presses `key` until a Map item has focus (the keys go to what is focused outside the Map first); returns its id. */
async function tabInto(page: Page, key: 'Tab' | 'Shift+Tab') {
  for (let presses = 0; presses < 40; presses++) {
    await page.keyboard.press(key);
    const id = await page.evaluate(() => document.activeElement?.matches('[role="treeitem"]') ? document.activeElement.getAttribute('data-item-id') : null);
    if (id) return id;
  }
  throw new Error(`${key} never reached a Map item`);
}

for (const theme of ['light', 'dark'] as const) test(`Tab and Shift+Tab into the Map from outside draw the dotted box on the item, with the column out of keyboard mode (${theme})`, async ({ page }) => serve(page, async open => {
  await open('still', 'reduce');
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  await select(page, '9');
  await page.keyboard.press('ArrowDown');
  await expect(row(page, '10')).toBeFocused();
  const column = page.getByRole('region', { name: 'Session tree' });
  await expect(column).toHaveAttribute('data-kbd');
  const dotted = async (id: string) => {
    await expect(row(page, id)).toBeFocused();
    await expect(row(page, id)).not.toHaveAttribute('aria-selected', 'true');
    const box = await boxOf(page, id, '::before');
    expect(box, `${id} draws the dotted box`).not.toBeNull();
    expect(box!.line).toMatch(/^dotted /);
    expect(await outlineOf(page, id)).toBe('none');
  };
  // A click on blank Map space (a press on the column itself) takes the column out of keyboard mode; focus then leaves to the top bar.
  await column.dispatchEvent('mousedown');
  await expect(column).not.toHaveAttribute('data-kbd');
  await page.locator('[data-popover-trigger="switcher"]').focus();
  // Whatever the Tab passes on its way through the column's own controls puts the column back in keyboard mode, and a press on blank
  // space takes it out again: the item holds focus-visible focus with the column out of keyboard mode (a Tab straight in does the same).
  const enters = async (key: 'Tab' | 'Shift+Tab') => {
    const id = await tabInto(page, key);
    await column.dispatchEvent('mousedown');
    await expect(column).not.toHaveAttribute('data-kbd');
    await dotted(id);
  };
  await enters('Tab');
  // And back in from Details, after the Map.
  await column.dispatchEvent('mousedown');
  await page.getByRole('button', { name: 'More actions', exact: true }).focus();
  await enters('Shift+Tab');
}));
