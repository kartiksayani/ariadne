// Help > Keys over its real styles (alpha.24 keys): every key row of every group is on the page, none is clipped or lies over another,
// and each can be scrolled into view under the sticky head at the smallest window (900 x 650). Design frame 16.1 compares only the
// panel's head and the first row of groups (the added rows sit below what the board draws), so this holds the rest.
import { test, expect, type Page } from '@playwright/test';
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

async function open(page: Page, origin: string, width: number, height: number) {
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  await page.setViewportSize({ width, height });
  await page.goto(`${origin}/tests/e2e/tree-layout/help-fixture.html`);
  await expect(page.getByRole('dialog', { name: 'Help: keys and markers' })).toBeVisible();
  await page.evaluate(async () => { await document.fonts.ready; });
}

const SIZES = [[900, 650], [1280, 800], [640, 480]] as const;

for (const [width, height] of SIZES) {
  test.describe(`${width} x ${height}`, () => {
    test('every key row of every group is rendered, in order, with its caps and words', async ({ page }) => {
      await serve(async origin => {
        await open(page, origin, width, height);
        const expected = await page.evaluate(() => (window as unknown as { helpKeyGroups: ReadonlyArray<{ label: string; keys: ReadonlyArray<readonly [readonly string[], string]> }> })
          .helpKeyGroups.map(group => ({ label: group.label, rows: group.keys.map(([keys, text]) => ({ caps: keys.join(''), text })) })));
        expect(expected.map(group => group.label)).toEqual(['Move around the Map', 'Answer and reply', 'On the selected item', 'Find and switch']);
        for (const group of expected) {
          const section = page.getByRole('region', { name: group.label });
          const rows = section.getByTestId('help-key');
          await expect(rows).toHaveCount(group.rows.length);
          const drawn = await rows.evaluateAll(items => items.map(item => ({ caps: item.children[0]!.textContent, text: item.children[1]!.textContent })));
          expect(drawn, group.label).toEqual(group.rows);
        }
        // The two rows alpha.24 added, which the board's frame does not draw.
        await expect(page.getByTestId('help-key').filter({ hasText: 'Scroll Details' })).toHaveCount(1);
        await expect(page.getByTestId('help-key').filter({ hasText: 'Choose and send' })).toHaveCount(1);
      });
    });

    test('no row is clipped sideways, no caps or words run into their neighbours, and no two rows overlap', async ({ page }) => {
      await serve(async origin => {
        await open(page, origin, width, height);
        const faults = await page.getByRole('dialog').evaluate(panel => {
          const found: string[] = [], frame = panel.getBoundingClientRect();
          const rows = [...panel.querySelectorAll<HTMLElement>('[data-testid="help-key"]')];
          const name = (row: Element) => row.children[1]?.textContent?.slice(0, 30) ?? '?';
          const meet = (one: DOMRect, two: DOMRect) => Math.min(one.right, two.right) - Math.max(one.left, two.left) > 0.5 && Math.min(one.bottom, two.bottom) - Math.max(one.top, two.top) > 0.5;
          if (panel.scrollWidth > panel.clientWidth + 1) found.push('the panel scrolls sideways');
          for (const row of rows) {
            const place = row.getBoundingClientRect(), caps = row.children[0] as HTMLElement, words = row.children[1] as HTMLElement;
            // The panel has 14px of padding each side: a row inside the panel's box is not cut by its edge.
            if (place.left < frame.left - 0.5 || place.right > frame.right + 0.5) found.push(`"${name(row)}" leaves the panel sideways`);
            if (row.scrollWidth > row.clientWidth + 1) found.push(`"${name(row)}" is wider than its row`);
            if (words.scrollWidth > words.clientWidth + 1) found.push(`"${name(row)}" words are cut sideways`);
            if (caps.scrollWidth > caps.clientWidth + 1) found.push(`"${name(row)}" caps are cut sideways`);
            for (const cap of caps.children) {
              const box = cap.getBoundingClientRect(), outer = caps.getBoundingClientRect();
              if (box.left < outer.left - 0.5 || box.right > outer.right + 0.5) found.push(`"${name(row)}" has a cap outside its column`);
            }
            if (meet(caps.getBoundingClientRect(), words.getBoundingClientRect())) found.push(`"${name(row)}" caps run into the words`);
            for (const part of [caps, words]) {
              const box = part.getBoundingClientRect();
              if (box.bottom > place.bottom + 0.5 || box.top < place.top - 0.5) found.push(`"${name(row)}" has a part outside its row`);
            }
          }
          rows.forEach((first, at) => rows.slice(at + 1).forEach(second => {
            if (meet(first.getBoundingClientRect(), second.getBoundingClientRect())) found.push(`"${name(first)}" overlaps "${name(second)}"`);
          }));
          return found;
        });
        expect(faults).toEqual([]);
      });
    });

    test('every row can be scrolled into view under the sticky head, inside the window, and the last note is reachable', async ({ page }) => {
      await serve(async origin => {
        await open(page, origin, width, height);
        const panel = page.getByRole('dialog');
        const box = await panel.boundingBox();
        expect(box!.y).toBeGreaterThanOrEqual(0);
        expect(box!.y + box!.height).toBeLessThanOrEqual(height);
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        expect(await panel.evaluate(element => getComputedStyle(element).overflowY)).toBe('auto');
        const rows = page.getByTestId('help-key');
        const count = await rows.count();
        expect(count).toBe(await page.evaluate(() => (window as unknown as { helpKeyGroups: ReadonlyArray<{ keys: readonly unknown[] }> }).helpKeyGroups.reduce((sum, group) => sum + group.keys.length, 0)));
        for (let index = 0; index < count; index++) {
          const row = rows.nth(index);
          await row.evaluate(element => element.scrollIntoView({ block: 'center' }));
          const seen = await row.evaluate(element => {
            const dialog = element.closest('[role="dialog"]')!, head = dialog.querySelector('[role="tablist"]')!.parentElement!;
            const place = element.getBoundingClientRect(), frame = dialog.getBoundingClientRect();
            return { under: place.top >= head.getBoundingClientRect().bottom - 0.5, above: place.bottom <= frame.bottom + 0.5, text: element.children[1]!.textContent };
          });
          expect(seen, `row ${index}`).toMatchObject({ under: true, above: true });
        }
        // The end of the panel: its scroll reaches the bottom, and the note under the groups is whole there.
        await panel.evaluate(element => { element.scrollTop = element.scrollHeight; });
        const note = page.getByText(/^Single-letter keys work when no text box has focus/);
        await expect(note).toBeVisible();
        expect(await note.evaluate(element => {
          const dialog = element.closest('[role="dialog"]')!, place = element.getBoundingClientRect(), frame = dialog.getBoundingClientRect();
          return place.bottom <= frame.bottom + 0.5 && place.top >= frame.top;
        })).toBe(true);
      });
    });
  });
}
