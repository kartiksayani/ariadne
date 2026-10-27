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

// What design frames 14.1 and 14.4 no longer compare (they are narrowed to the chrome and header bands, the board artwork cannot be
// updated): the session rows, the footer and the menus. Layout assertions on the real styles stand in for the pixels.
for (const width of [1000, 640, 380]) {
  test(`no text in a card runs past its box without an ellipsis: session rows, names, paths, footers, tags (${width}px)`, async ({ page }) => {
    await serve(async origin => {
      await open(page, origin, width);
      const offenders = await page.getByTestId('project-card').evaluateAll(cards => cards.flatMap(item => {
        const found: string[] = [], name = item.querySelector('button')?.textContent ?? '?';
        // Every box in the card that holds text: if the text is wider than the box, it must be clipped with an ellipsis. (The "…" button's
        // 4px negative margin makes its wrappers 4px wider than themselves on purpose; they hold no text.)
        for (const part of item.querySelectorAll<HTMLElement>('*')) {
          if (![...part.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())) continue;
          if (part.scrollWidth <= part.clientWidth + 1) continue;
          const style = getComputedStyle(part);
          if (style.textOverflow !== 'ellipsis' || style.overflowX !== 'hidden') found.push(`${name}: <${part.tagName}> "${part.textContent?.slice(0, 30)}" overflows (${part.scrollWidth} > ${part.clientWidth}) with no ellipsis`);
        }
        // An ellipsis only helps when the box is inside the card: no part may stick out of its row, nor the row out of its list.
        for (const row of item.querySelectorAll<HTMLElement>('[data-testid="project-session"]')) {
          const frame = row.getBoundingClientRect(), list = row.parentElement!.getBoundingClientRect();
          if (frame.right > list.right + 0.5 || frame.left < list.left - 0.5) found.push(`${name}: a session row leaves its list`);
          for (const part of row.children) {
            const place = part.getBoundingClientRect();
            if (place.right > frame.right + 0.5 || place.left < frame.left - 0.5) found.push(`${name}: "${part.textContent}" leaves its session row`);
          }
        }
        return found;
      }));
      expect(offenders).toEqual([]);
    });
  });

  test(`no two parts of a card overlap, and the footer and every part sit inside the card (${width}px)`, async ({ page }) => {
    await serve(async origin => {
      await open(page, origin, width);
      const problems = await page.getByTestId('project-card').evaluateAll(cards => cards.flatMap(item => {
        const found: string[] = [], name = item.querySelector('button')?.textContent ?? '?', box = item.getBoundingClientRect();
        const part = (id: string) => item.querySelector(`[data-testid="${id}"]`)!;
        const rows = [...item.querySelectorAll('[data-testid="project-session"]')];
        const meet = (first: Element, second: Element) => {
          const one = first.getBoundingClientRect(), two = second.getBoundingClientRect();
          return Math.min(one.right, two.right) - Math.max(one.left, two.left) > 0.5 && Math.min(one.bottom, two.bottom) - Math.max(one.top, two.top) > 0.5;
        };
        const label = (element: Element) => element.getAttribute('data-testid') ?? element.getAttribute('aria-label') ?? (element.textContent?.slice(0, 20) || element.tagName);
        const check = (parts: readonly Element[], where: string) => parts.forEach((first, at) => parts.slice(at + 1).forEach(second => {
          if (meet(first, second)) found.push(`${name}: ${label(first)} overlaps ${label(second)} (${where})`);
        }));
        // The header's parts, then the three blocks of the card, then each session row's parts and the rows among themselves.
        check([...part('project-header').children], 'header');
        check([...part('project-id').children], 'name and path');
        check([part('project-header'), part('project-sessions'), part('project-footer')], 'blocks');
        check(rows, 'rows');
        for (const row of rows) check([...row.children], 'a session row');
        for (const block of [part('project-header'), part('project-sessions'), part('project-footer')]) {
          const place = block.getBoundingClientRect();
          if (place.left < box.left - 0.5 || place.right > box.right + 0.5 || place.top < box.top - 0.5 || place.bottom > box.bottom + 0.5) found.push(`${name}: ${label(block)} is outside the card`);
        }
        const foot = part('project-footer').getBoundingClientRect();
        if (!(foot.height > 0 && foot.bottom <= box.bottom - 1)) found.push(`${name}: the footer touches or leaves the card's bottom edge`);
        return found;
      }));
      expect(problems).toEqual([]);
    });
  });

  test(`a card's menu and the page's menu render fully: every row's text fits, the menu is inside the page and nothing covers it (${width}px)`, async ({ page }) => {
    await serve(async origin => {
      await open(page, origin, width);
      const triggers = [page.getByRole('button', { name: 'Register a project, discover sessions' })];
      for (const name of ['notes-empty', 'notes-twelve']) triggers.push(page.getByRole('button', { name: `More for ${name}: remove project` }));
      triggers.push(page.getByRole('button', { name: /^More for a-project-with-a-name.*: remove project$/ }));
      for (const trigger of triggers) {
        await trigger.scrollIntoViewIfNeeded();
        await trigger.click();
        const menu = page.getByRole('menu');
        await expect(menu).toBeVisible();
        await menu.scrollIntoViewIfNeeded();
        const faults = await menu.evaluate(element => {
          const found: string[] = [], frame = element.getBoundingClientRect(), view = element.closest('[role="region"]')!.getBoundingClientRect();
          if (frame.left < view.left - 0.5 || frame.right > view.right + 0.5 || frame.top < view.top - 0.5 || frame.bottom > view.bottom + 0.5) found.push('the menu is not inside the page');
          if (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1) found.push('the menu clips its own content');
          for (const row of element.querySelectorAll<HTMLElement>('[role="menuitem"]')) {
            const rowBox = row.getBoundingClientRect();
            if (row.scrollWidth > row.clientWidth + 1 || row.scrollHeight > row.clientHeight + 1) found.push(`"${row.textContent}" overflows its row`);
            for (const part of row.querySelectorAll<HTMLElement>('*')) {
              const place = part.getBoundingClientRect();
              if (part.scrollWidth > part.clientWidth + 1 && part.tagName !== 'I') found.push(`"${part.textContent}" runs past its box`);
              if (place.left < rowBox.left - 0.5 || place.right > rowBox.right + 0.5 || place.top < rowBox.top - 0.5 || place.bottom > rowBox.bottom + 0.5) found.push(`"${part.textContent || part.className}" leaves its row`);
              // Nothing else (the next card, a sticky head) paints over the text.
              const hit = document.elementFromPoint(place.left + place.width / 2, place.top + place.height / 2);
              if (!hit || !element.contains(hit)) found.push(`"${part.textContent || part.className}" is covered by ${hit?.className || hit?.tagName}`);
            }
          }
          return found;
        });
        expect(faults, `menu opened from ${await trigger.getAttribute('aria-label')}`).toEqual([]);
        await page.keyboard.press('Escape');
        await expect(menu).toHaveCount(0);
      }
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
