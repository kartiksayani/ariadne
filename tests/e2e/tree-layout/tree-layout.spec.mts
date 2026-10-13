import { test, expect, type Page } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import type { Server } from 'node:http';

for (const theme of ['light', 'dark'] as const) test(`N wraps unread Map targets without opening them and clears sticky bars in ${theme}`, async ({ page }) => {
  const server = await createServer({ configFile: false, root: resolve('.'), publicDir: resolve('apps/desktop/public'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  try {
    await server.listen();
    const address = (server.httpServer as Server).address();
    if (!address || typeof address === 'string') throw new Error('Missing layout fixture server address');
    await openTree(page, `http://127.0.0.1:${address.port}`, '?changes');
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const child = page.locator('.tree-item[data-item-id="1.1"]');
    await expect(child).toHaveCount(0);
    await page.keyboard.press('n');
    await expect(child).toHaveAttribute('data-next-unseen', 'true');
    await expect(child.getByRole('img', { name: 'New to you' })).toHaveText('New');
    const markerColour = await child.locator('.tree-change-marker').evaluate(element => getComputedStyle(element).color);
    const attention = await child.locator('.tree-change-marker').evaluate(element => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d')!;
      const pixels = (colour: string) => {
        context.clearRect(0, 0, 1, 1); context.fillStyle = colour; context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
      };
      const luminance = (rgb: number[]) => rgb.map(value => value / 255)
        .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
        .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
      const style = getComputedStyle(element), text = pixels(style.color), background = pixels(style.backgroundColor);
      const [low, high] = [luminance(text), luminance(background)].sort((a, b) => a - b);
      const statuses = ['--st-progress', '--st-done', '--st-decided', '--a-danger'].map(token => {
        const probe = document.createElement('span'); probe.style.color = `var(${token})`; element.append(probe);
        const colour = pixels(getComputedStyle(probe).color); probe.remove(); return colour;
      });
      return { text, statuses, contrast: (high + .05) / (low + .05) };
    });
    expect(attention.contrast, 'small New text remains readable, including while the row pulses').toBeGreaterThanOrEqual(4.5);
    for (const status of attention.statuses) expect(attention.text).not.toEqual(status);
    await expect(child).toHaveCSS('outline-color', markerColour);
    await expect(child).toHaveCSS('outline-width', '2px');
    await expect(child).toHaveAttribute('aria-selected', 'false');
    await expect(child).not.toHaveAttribute('data-next-unseen-pulse', 'true', { timeout: 2000 });
    await expect(child).toHaveAttribute('data-next-unseen', 'true');
    await expect(child.getByRole('img', { name: 'New to you' })).toBeVisible();
    const changed = page.locator('.tree-item[data-item-id="2"]');
    await page.keyboard.press('n');
    await expect(changed).toHaveAttribute('data-next-unseen', 'true');
    await expect(child).not.toHaveAttribute('data-next-unseen', 'true');
    await expect(changed.getByRole('img', { name: 'Changed since you read it' })).toBeVisible();
    await expect(changed.locator('.tree-change-marker')).toHaveCSS('background-color', markerColour);
    const last = page.locator('.tree-item[data-item-id="18"]');
    await page.keyboard.press('n');
    await expect(last).toHaveAttribute('data-next-unseen', 'true');
    await expect(last).toBeInViewport({ ratio: 1 });
    await page.keyboard.press('n');
    await expect(child).toHaveAttribute('data-next-unseen', 'true');
    const bounds = (await child.boundingBox())!, scroller = (await page.locator('.tree-scroll').boundingBox())!;
    const header = (await child.locator('xpath=..').locator('.tree-topic').boundingBox())!;
    expect(bounds.y).toBeGreaterThanOrEqual(scroller.y + header.height + 7);
    await expect(page.locator('.tree-item[aria-selected="true"]')).toHaveCount(0);
    await expect(page.locator('.tree-item[data-item-id="3"] .tree-change-marker')).toHaveCount(0);
    // Opening remains an explicit action; its shared read then clears this tag.
    await page.keyboard.press('Enter');
    await expect(child).toHaveAttribute('aria-selected', 'true');
    await expect(child.getByRole('img', { name: 'New to you' })).toHaveCount(0);
    // Typing N in the search box leaves the last landed target alone.
    const search = page.getByRole('textbox', { name: 'Search questions and outcomes' });
    await search.focus(); await page.keyboard.press('n');
    await expect(child).toHaveAttribute('data-next-unseen', 'true');
  } finally { await server.close(); }
});

// Real-browser checks of the session tree's layout promises: a long preview folds to
// four lines, hovering a row never rewraps its text, and clicking a row never scrolls.
async function openTree(page: Page, origin: string, query = '') {
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(`${origin}/tests/e2e/tree-layout/fixture.html${query}`);
  await page.locator('[data-shell-tab="projects"]').click();
  await page.locator('.pw-project-open').first().click();
  const session = page.locator('button[data-session-id]').first();
  await expect(session).toBeEnabled(); await session.click();
  await expect(page.locator('.tree-session-bar').getByRole('button', { name: 'Session actions' })).toBeEnabled();
  await expect(page.getByRole('region', { name: 'Session tree' })).toHaveAttribute('data-session-status', 'ready');
  await expect(page.locator('.tree-session-bar')).toHaveAttribute('aria-busy', 'false');
}

test('folds a long preview to four lines, never rewraps on hover and never scrolls on a click', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const server = await createServer({ configFile: false, root: resolve('.'), publicDir: resolve('apps/desktop/public'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  try {
    await server.listen();
    const address = (server.httpServer as Server).address();
    if (!address || typeof address === 'string') throw new Error('Missing layout fixture server address');
    await openTree(page, `http://127.0.0.1:${address.port}`);

    // Separate four-line body clamp; titles stay readable.
    const first = page.locator('.tree-item[data-item-id="1"]');
    const text = first.locator('.tree-outcome .tree-clamp'), line = await text.evaluate(element => parseFloat(getComputedStyle(element).lineHeight));
    const folded = (await text.boundingBox())!.height;
    // Fractional line heights can round either way in browser layout.
    expect(folded).toBeLessThanOrEqual(line * 4 + 0.5); expect(folded).toBeGreaterThanOrEqual(line * 4 - 0.5);
    await expect(first.getByRole('button', { name: 'Show more' })).toBeVisible();
    const title = first.locator('.tree-question'), titleLine = await title.evaluate(element => parseFloat(getComputedStyle(element).lineHeight));
    const titleHeight = (await title.boundingBox())!.height;
    expect(titleHeight).toBeGreaterThan(titleLine * 2);
    await first.getByRole('button', { name: 'Show more' }).click();
    expect((await text.boundingBox())!.height).toBeGreaterThan(line * 15);
    expect((await title.boundingBox())!.height).toBe(titleHeight);
    await first.getByRole('button', { name: 'Show less' }).click();
    expect((await text.boundingBox())!.height).toBeLessThanOrEqual(line * 4 + 0.5);

    // Hovering a row keeps its text column and its line count exactly as they were.
    const wrapped = page.locator('.tree-item[data-item-id="5"]'), body = wrapped.locator('.tree-body'), outcome = wrapped.locator('.tree-outcome .tree-clamp');
    await page.mouse.move(0, 0);
    const width = (await body.boundingBox())!.width, height = (await outcome.boundingBox())!.height;
    await expect(wrapped.locator('.tree-actions')).toHaveCSS('opacity', '0');
    await wrapped.hover();
    await expect(wrapped.locator('.tree-actions')).toHaveCSS('opacity', '1');
    expect((await body.boundingBox())!.width).toBe(width); expect((await outcome.boundingBox())!.height).toBe(height);
    // A selected row is the same, with or without the pointer on it (selecting opens the detail, which narrows the tree).
    await wrapped.click(); await page.mouse.move(0, 0);
    await expect(wrapped).toHaveAttribute('aria-selected', 'true');
    await expect(wrapped.locator('.tree-actions')).toHaveCSS('opacity', '1');
    const selectedWidth = (await body.boundingBox())!.width, selectedHeight = (await outcome.boundingBox())!.height;
    await wrapped.hover();
    expect((await body.boundingBox())!.width).toBe(selectedWidth); expect((await outcome.boundingBox())!.height).toBe(selectedHeight);

    // A click on a row in view leaves the tree exactly where it was.
    const scroller = page.locator('.tree-scroll');
    const target = page.locator('.tree-item[data-item-id="3"]');
    await target.evaluate(element => element.scrollIntoView({ block: 'start' }));
    await scroller.evaluate(element => { element.scrollTop -= 120; });
    await expect(target).toBeInViewport({ ratio: 1 });
    const before = await scroller.evaluate(element => element.scrollTop);
    await target.click();
    await expect(target).toHaveAttribute('aria-selected', 'true');
    await page.waitForTimeout(400);
    expect(await scroller.evaluate(element => element.scrollTop)).toBe(before);
    // Real native CSS sticky containment: pinned within a topic, then pushed away by the next band.
    const groups = page.locator('.tree-topic-group'), header = groups.first().locator('.tree-topic');
    const nextHeader = groups.nth(1).locator('.tree-topic');
    const treeTop = (await scroller.boundingBox())!.y;
    await scroller.evaluate(element => { element.scrollTop = 180; });
    expect((await header.boundingBox())!.y).toBeCloseTo(treeTop, 0);
    const headerHeight = (await header.boundingBox())!.height;
    await nextHeader.evaluate(element => {
      const box = element.closest('.tree-scroll')!;
      box.scrollTop += element.getBoundingClientRect().top - box.getBoundingClientRect().top - 12;
    });
    const sectionBottom = (await groups.first().boundingBox())!;
    expect((await header.boundingBox())!.y).toBeCloseTo(sectionBottom.y + sectionBottom.height - headerHeight, 0);
    await scroller.evaluate(element => { element.scrollTop += 30; });
    expect((await nextHeader.boundingBox())!.y).toBeCloseTo(treeTop, 0);
    expect((await header.boundingBox())!.y + headerHeight).toBeLessThanOrEqual(treeTop);
    expect(await header.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    const rootPadding = await first.evaluate(element => parseFloat(getComputedStyle(element).paddingTop));
    const child = page.locator('.tree-item[data-item-id="1.1"]');
    expect(rootPadding).toBeGreaterThan(await child.evaluate(element => parseFloat(getComputedStyle(element).paddingTop)));
    await expect(first).toHaveCSS('border-bottom-width', '1px');
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});

test('gives the title and status at least 60% of the row with all actions and keeps hover width stable', async ({ page }) => {
  const server = await createServer({ configFile: false, root: resolve('.'), publicDir: resolve('apps/desktop/public'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  try {
    await server.listen();
    const address = (server.httpServer as Server).address();
    if (!address || typeof address === 'string') throw new Error('Missing layout fixture server address');
    const origin = `http://127.0.0.1:${address.port}`;
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
    await page.setViewportSize({ width: 1600, height: 960 });
    await page.goto(`${origin}/tests/e2e/tree-layout/fixture.html?grid`);
    await page.evaluate(async () => { await document.fonts.ready; });
    const row = page.locator('.tree-item[data-item-id="1"]'), title = row.locator('.tree-question');
    const bounds = (await row.boundingBox())!, text = (await title.boundingBox())!;
    expect((await row.locator('.tree-heading').boundingBox())!.width / bounds.width).toBeGreaterThanOrEqual(0.6);
    const actions = row.locator('.tree-action');
    await expect(actions).toHaveCount(8);
    await row.hover();
    expect((await title.boundingBox())!.width).toBe(text.width);
    expect((await title.boundingBox())!.height).toBe(text.height);
    const lines = new Set<number>();
    for (const action of await actions.all()) {
      await expect(action).toBeVisible();
      const box = (await action.boundingBox())!;
      expect(box.width).toBe(26); expect(box.height).toBe(24); lines.add(box.y);
      const name = (await action.getAttribute('aria-label'))!;
      await action.click(); await expect(page.getByLabel('Last action')).toHaveText(name);
    }
    expect(lines.size).toBe(2);
    await row.locator('.tree-question').click(); await page.mouse.move(0, 0);
    expect((await title.boundingBox())!.width).toBe(text.width);
    const noActions = page.locator('.tree-item[data-item-id="2"]');
    await expect(noActions.locator('.tree-action-grid')).toHaveCount(0);
    expect((await noActions.locator('.tree-end').boundingBox())!.width).toBeLessThan((await row.locator('.tree-end').boundingBox())!.width);
    await page.setViewportSize({ width: 320, height: 700 });
    for (const item of [row, noActions]) {
      expect(await item.evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(Math.ceil((await item.boundingBox())!.width));
    }
  } finally { await server.close(); }
});

test('keeps the session menu inside a narrow column with Restore and a long name', async ({ page }) => {
  const server = await createServer({ configFile: false, root: resolve('.'), publicDir: resolve('apps/desktop/public'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  try {
    await server.listen();
    const address = (server.httpServer as Server).address();
    if (!address || typeof address === 'string') throw new Error('Missing layout fixture server address');
    const origin = `http://127.0.0.1:${address.port}`;
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
    await page.setViewportSize({ width: 1600, height: 960 });
    await page.goto(`${origin}/tests/e2e/tree-layout/fixture.html?bar`);
    await page.evaluate(async () => { await document.fonts.ready; });
    const bar = page.locator('.tree-session-bar'), more = bar.getByRole('button', { name: 'Session actions' });
    await expect(bar.getByRole('button', { name: 'Restore session' })).toBeVisible();
    const bounds = (await bar.boundingBox())!, menu = (await more.boundingBox())!;
    expect(menu.x + menu.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    expect(await bar.evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(Math.ceil(bounds.width));
    await more.click();
    await expect(page.getByRole('menuitem', { name: 'Copy ID' })).toBeVisible();
  } finally { await server.close(); }
});


for (const theme of ['light', 'dark'] as const) test(`Map look: continuous rails, clamp threshold and solid selection markers in ${theme}`, async ({ page }) => {
  const server = await createServer({ configFile: false, root: resolve('.'), publicDir: resolve('apps/desktop/public'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  try {
    await server.listen();
    const address = (server.httpServer as Server).address();
    if (!address || typeof address === 'string') throw new Error('Missing layout fixture server address');
    await openTree(page, `http://127.0.0.1:${address.port}`);
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.evaluate(async () => { await document.fonts.ready; });
    const root = page.locator('.tree-item[data-item-id="1"]'), child = page.locator('.tree-item[data-item-id="1.1"]');
    await expect(page.locator('.tree-id')).toHaveCount(0);
    await expect(root.locator('.tree-top-colour')).toHaveCount(1);
    await expect(child.locator('.tree-top-colour')).toHaveCount(0);
    await expect(root.locator('.tree-heading .tree-row-status')).toContainText('Done');
    const accent = await page.locator('.tree-topic-name').first().evaluate(element => {
      const probe = document.createElement('span');
      probe.style.color = element.hasAttribute('data-earlier') ? 'color-mix(in srgb, var(--a-acc-text) 82%, transparent)' : 'var(--a-acc-text)';
      element.append(probe);
      const expected = getComputedStyle(probe).color, actual = getComputedStyle(element).color;
      probe.style.color = 'var(--a-acc-text)';
      const full = getComputedStyle(probe).color;
      probe.remove(); return { actual, expected, full };
    });
    expect(accent.actual).toBe(accent.expected);
    expect(await root.locator('.tree-more').evaluate(element => getComputedStyle(element).color)).toBe(accent.full);
    const stem = root.locator('.tree-guide[data-from-bullet][style*="left: 44px"]').first();
    const end = child.locator('.tree-guide[data-to-bullet][style*="left: 44px"]').first();
    const stemBox = (await stem.boundingBox())!, endBox = (await end.boundingBox())!;
    const bullet = (await root.locator('.tree-chevron').boundingBox())!, childBullet = (await child.locator('.tree-chevron-space').boundingBox())!;
    expect(stemBox.x).toBeCloseTo(bullet.x + bullet.width / 2, 0);
    expect(stemBox.y).toBeCloseTo(bullet.y + bullet.height / 2, 0);
    expect(stemBox.y + stemBox.height).toBeCloseTo(endBox.y, 0);
    expect(endBox.y + endBox.height).toBeCloseTo(childBullet.y + childBullet.height / 2, 0);
    await root.locator('.tree-question').click();
    await expect(root).toHaveAttribute('aria-selected', 'true');
    // The accent reaches the selection; the rails to unrelated siblings stay neutral.
    expect(await root.locator('.tree-elbow').last().evaluate(element => element.getAttribute('style'))).toContain('var(--color-accent)');
    const neutral = page.locator('.tree-item[data-item-id="3"] .tree-guide').first();
    expect(await neutral.getAttribute('style')).toContain('var(--a-guide)');

    for (const [id, lines] of [['9', 6], ['10', 7]] as const) {
      const row = page.locator(`.tree-item[data-item-id="${id}"]`);
      await row.evaluate(element => element.scrollIntoView({ block: 'center' }));
      const body = row.locator('.tree-clamp');
      const line = await body.evaluate(element => parseFloat(getComputedStyle(element).lineHeight));
      // Prove the fixture really contains six/seven body lines before testing the threshold.
      await expect(body.locator('br')).toHaveCount(lines - 1);
      expect((await body.textContent())!.split('\n')).toHaveLength(lines);
      await expect(body).toHaveCSS('white-space', 'normal');
      if (lines === 6) {
        await expect(row.getByRole('button', { name: 'Show more' })).toHaveCount(0);
        expect((await body.boundingBox())!.height).toBeCloseTo(line * 6, 0);
      } else {
        await expect(row.getByRole('button', { name: 'Show more' })).toBeVisible();
        expect((await body.boundingBox())!.height).toBeCloseTo(line * 4, 0);
        await row.getByRole('button', { name: 'Show more' }).click();
        expect((await body.boundingBox())!.height).toBeCloseTo(line * 7, 0);
        await row.getByRole('button', { name: 'Show less' }).click();
        // A closed preview tracks text scaling even before an observer can remeasure it.
        for (const scale of [0.8, 1, 1.2]) {
          await page.evaluate(scale => document.documentElement.style.setProperty('--text-scale', String(scale)), scale);
          const scaledLine = await body.evaluate(element => parseFloat(getComputedStyle(element).lineHeight));
          expect((await body.boundingBox())!.height).toBeCloseTo(scaledLine * 4, 0);
        }
        await page.evaluate(() => document.documentElement.style.setProperty('--text-scale', '1'));
      }
    }
    const scroller = page.locator('.tree-scroll');
    await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const marker = page.locator('.tree-selected-edge');
    await expect(marker).toContainText('↑ Selected: A long item title');
    const colour = await marker.evaluate(element => {
      const surface = getComputedStyle(element).backgroundColor;
      const probe = document.createElement('span');
      probe.style.backgroundColor = 'var(--a-card)';
      probe.style.position = 'absolute';
      element.append(probe);
      const expected = getComputedStyle(probe).backgroundColor;
      probe.remove();
      // Let the browser resolve its own colour syntax, including oklch and color().
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d')!;
      context.fillStyle = surface;
      context.fillRect(0, 0, 1, 1);
      return { surface, expected, alpha: context.getImageData(0, 0, 1, 1).data[3] };
    });
    const { surface } = colour;
    expect(surface).toBe(colour.expected);
    expect(colour.alpha).toBe(255);
    await expect(marker).toHaveCSS('opacity', '1');
    await marker.hover(); await expect(marker).toHaveCSS('background-color', surface);
    await expect(marker).toHaveCSS('opacity', '1');
    await marker.focus(); await expect(marker).toHaveCSS('background-color', surface);
    await expect(marker).toHaveCSS('opacity', '1');
    await page.mouse.down(); await expect(marker).toHaveCSS('background-color', surface);
    await expect(marker).toHaveCSS('opacity', '1'); await page.mouse.up();
    await expect(marker).toHaveCount(0);
    await expect(root.locator('.tree-question')).toBeInViewport();
    await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(marker).toBeVisible();
    // The shortcut works while the session's other panel has focus.
    await page.locator('.item-detail').getByRole('button', { name: 'Copy reference' }).focus();
    await page.keyboard.press('Meta+j');
    await expect(marker).toHaveCount(0);
    await expect(root.locator('.tree-question')).toBeInViewport();
    // A selection below the viewport uses the other edge and remains fully opaque.
    const last = page.locator('.tree-item[data-item-id="18"]');
    await last.locator('.tree-question').click();
    await expect(last).toHaveAttribute('aria-selected', 'true');
    await scroller.evaluate(element => { element.scrollTop = 0; });
    await expect(marker).toContainText('↓ Selected: Another item');
    await expect(marker).toHaveCSS('background-color', surface);
    await marker.click(); await expect(marker).toHaveCount(0);
  } finally { await server.close(); }
});
