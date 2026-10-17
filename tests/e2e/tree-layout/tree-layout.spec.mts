import { test, expect, type Locator, type Page } from '@playwright/test';
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
    await expect(child).toHaveCSS('outline-width', '2px');
    await expect(child).toHaveCSS('outline-color', markerColour);
    await expect(page.locator('.shell-detail')).toHaveCount(0);
    const changed = page.locator('.tree-item[data-item-id="2"]');
    await page.keyboard.press('n');
    await expect(changed).toHaveAttribute('data-next-unseen', 'true');
    // N's ancestry expansion is temporary; leaving this child restores the saved fold.
    await expect(child).toHaveCount(0);
    await expect(page.locator('.tree-item[data-next-unseen="true"]')).toHaveCount(1);
    await expect(changed.getByRole('img', { name: 'Changed since you read it' })).toBeVisible();
    await expect(changed.locator('.tree-change-marker')).toHaveCSS('background-color', markerColour);
    const last = page.locator('.tree-item[data-item-id="18"]');
    await page.keyboard.press('n');
    await expect(last).toHaveAttribute('data-next-unseen', 'true');
    await expectRevealedRow(last);
    await expect(last).not.toHaveAttribute('data-next-unseen-pulse', 'true', { timeout: 2000 });
    await expect(last).toHaveCSS('outline-width', '2px');
    await expect(last).toHaveCSS('outline-color', markerColour);
    await expect(page.locator('.shell-detail')).toHaveCount(0);
    await page.keyboard.press('n');
    await expect(child).toHaveAttribute('data-next-unseen', 'true');
    await expect(last).not.toHaveAttribute('data-next-unseen', 'true');
    await expect(child.getByRole('img', { name: 'New to you' })).toBeVisible();
    await expectRevealedRow(child);
    await expect(page.locator('.shell-detail')).toHaveCount(0);
    await expect(page.locator('.tree-item[aria-selected="true"]')).toHaveCount(0);
    await expect(page.locator('.tree-item[data-item-id="3"] .tree-change-marker')).toHaveCount(0);
    // Opening remains an explicit action; its shared read then clears this tag.
    await page.keyboard.press('Enter');
    await expect(child).toHaveAttribute('aria-selected', 'true');
    await expect(child.getByRole('img', { name: 'New to you' })).toHaveCount(0);
    // Typing N in the search box leaves the last landed target alone.
    await page.getByRole('button', { name: 'Search the Map' }).click();
    const search = page.getByRole('textbox', { name: 'Search the Map' });
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
  // No tabs: the switcher's All sessions lists the session (as tests/ui/app/open.ts `goToSession`).
  await page.locator('[data-popover-trigger="switcher"]').click();
  await page.getByRole('dialog', { name: 'Switch session or project' }).getByRole('button', { name: 'All sessions' }).click();
  const session = page.locator('button[data-session-id]').first();
  await expect(session).toBeEnabled(); await session.click();
  await expect(page.locator('[data-popover-trigger="connection"]')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Session tree' })).toHaveAttribute('data-session-status', 'ready');
  await expect(page.getByRole('region', { name: 'Session tree' })).toHaveAttribute('data-session-busy', 'false');
}

async function expectRevealedRow(row: Locator) {
  await expect.poll(() => row.evaluate(element => {
    const box = element.closest('.tree-scroll')!.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    const header = element.closest('.tree-topic-group')!.querySelector('.tree-topic')!.getBoundingClientRect();
    const viewportBottom = Math.min(box.bottom, window.innerHeight);
    const usableTop = Math.max(box.top, header.bottom);
    return {
      clearsHeader: bounds.top >= usableTop - 0.5,
      // A row that cannot keep the reveal's 8px margin at both ends lines up its top instead (scroll.ts nearestDelta).
      fits: bounds.height > viewportBottom - usableTop - 16 || bounds.bottom <= viewportBottom + 0.5,
    };
  })).toEqual({ clearsHeader: true, fits: true });
  // The row can clear the header while the reveal is still correcting its position (the held row is put back after
  // each reflow). A scroll the test makes by hand in that window is undone by the correction, so wait until the
  // scroller has been still for three animation frames before the caller goes on.
  await row.evaluate(element => new Promise<void>(resolve => {
    const scroller = element.closest('.tree-scroll')!;
    let last = scroller.scrollTop, still = 0;
    const frame = () => {
      if (scroller.scrollTop !== last) { last = scroller.scrollTop; still = 0; } else if (++still >= 3) { resolve(); return; }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }));
}

async function expectSolidMarker(marker: Locator) {
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
  expect(colour.surface).toBe(colour.expected);
  expect(colour.alpha).toBe(255);
  await expect(marker).toHaveCSS('opacity', '1');
}

for (const theme of ['light', 'dark']) test(`Getting around keeps breadcrumbs and peeks clear of rows and chrome (${theme})`, async ({ page }) => {
  const server = await createServer({ configFile: false, root: resolve('.'), publicDir: resolve('apps/desktop/public'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  try {
    await server.listen();
    const address = (server.httpServer as Server).address();
    if (!address || typeof address === 'string') throw new Error('Missing layout fixture server address');
    await openTree(page, `http://127.0.0.1:${address.port}`, '?nav');
    await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
    const scroller = page.locator('.tree-scroll'), crumbs = page.getByRole('navigation', { name: 'Map ancestors' });
    const before = await scroller.boundingBox();
    const deep = page.locator('.tree-item[data-item-id="23"]');
    await deep.evaluate(element => element.scrollIntoView({ block: 'start' }));
    // Check the actual settled reference row, including sticky clearance: scrollIntoView
    // may leave a fractional strip of its predecessor visible under the topic band.
    await expect.poll(() => deep.evaluate(element => {
      const box = element.closest('.tree-scroll')!, viewport = box.getBoundingClientRect();
      const header = element.closest('.tree-topic-group')!.querySelector('.tree-topic')!.getBoundingClientRect();
      const top = Math.max(viewport.top, header.bottom), bottom = Math.min(viewport.bottom, window.innerHeight);
      return [...box.querySelectorAll<HTMLElement>('.tree-item')].find(row => {
        const bounds = row.getBoundingClientRect();
        return bounds.top >= top && bounds.bottom <= bottom;
      })?.dataset.itemId;
    })).toBe('23');
    await expect(crumbs.getByRole('button')).toHaveText(['Rehearsal notes', 'Evidence check', 'Owner handoff']);
    expect(await scroller.boundingBox()).toEqual(before);
    const breadcrumbBox = (await crumbs.boundingBox())!, viewport = (await scroller.boundingBox())!;
    expect(breadcrumbBox.y + breadcrumbBox.height).toBeLessThanOrEqual(viewport.y + 0.5);
    await crumbs.getByRole('button', { name: 'Owner handoff' }).click();
    await expectRevealedRow(page.locator('.tree-item[data-item-id="22"]'));

    // Focus restricts Map rows while Waiting remains complete.
    const root = page.locator('.tree-item[data-item-id="1"]');
    const waitingCount = await page.locator('.waiting-card').count();
    await root.getByRole('button', { name: /^Focus on / }).click();
    await expect(root.getByRole('button', { name: /^Unfocus / })).toBeVisible();
    await expect(page.getByText(/^Focused:/)).toHaveCount(0);
    await expect(page.locator('.tree-item[data-item-id="8"]')).toHaveCount(0);
    expect(await page.locator('.waiting-card').count()).toBe(waitingCount);
    await root.getByRole('button', { name: /^Unfocus / }).click();
    await expect(page.locator('.tree-item[data-item-id="8"]')).toHaveCount(1);
    // The click left keyboard focus on the row's own button; the peek below restores focus to the row.
    await root.focus();

    // A press on the row's button opened no card. Off the row and back, a resting pointer previews it; the Map does not move.
    const scrollBeforeHover = await scroller.evaluate(element => element.scrollTop);
    await expect(page.getByRole('dialog', { name: /^Peek:/ })).toHaveCount(0);
    await page.mouse.move(0, 0); await root.hover();
    const peek = page.getByRole('dialog', { name: /^Peek:/ });
    await expect(peek).toBeVisible();
    expect(await scroller.evaluate(element => element.scrollTop)).toBe(scrollBeforeHover);
    const peekBox = (await peek.boundingBox())!, topBar = (await page.locator('.shell-top').boundingBox())!;
    expect(peekBox.y).toBeGreaterThanOrEqual(topBar.y + topBar.height);
    expect(peekBox.x).toBeGreaterThanOrEqual(0);
    expect(peekBox.x + peekBox.width).toBeLessThanOrEqual(1000);
    expect(peekBox.y + peekBox.height).toBeLessThanOrEqual(700);
    const scrollBeforeEscape = await scroller.evaluate(element => element.scrollTop);
    await page.keyboard.press('Escape');
    await expect(peek).toHaveCount(0); await expect(root).toBeFocused();
    expect(await scroller.evaluate(element => element.scrollTop)).toBe(scrollBeforeEscape);
    await page.keyboard.press('Space'); await expect(peek).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Meta+e');
    await expect(page.getByRole('dialog', { name: 'Recent items' })).toBeVisible();
    await page.getByRole('button', { name: 'Changed only' }).click();
    await expect(page.getByRole('button', { name: 'Changed only' })).toHaveAttribute('aria-pressed', 'true');
  } finally { await server.close(); }
});

test('folds a long preview to three lines, never rewraps on hover and never scrolls on a click', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const server = await createServer({ configFile: false, root: resolve('.'), publicDir: resolve('apps/desktop/public'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  try {
    await server.listen();
    const address = (server.httpServer as Server).address();
    if (!address || typeof address === 'string') throw new Error('Missing layout fixture server address');
    await openTree(page, `http://127.0.0.1:${address.port}`);

    // Separate three-line body clamp; titles stay readable.
    const first = page.locator('.tree-item[data-item-id="1"]');
    const text = first.locator('.tree-outcome .tree-clamp'), line = await text.evaluate(element => parseFloat(getComputedStyle(element).lineHeight));
    const folded = (await text.boundingBox())!.height;
    // Fractional line heights can round either way in browser layout.
    expect(folded).toBeLessThanOrEqual(line * 3 + 0.5); expect(folded).toBeGreaterThanOrEqual(line * 3 - 0.5);
    await expect(first.getByRole('button', { name: 'Show more' })).toBeVisible();
    const title = first.locator('.tree-question'), titleLine = await title.evaluate(element => parseFloat(getComputedStyle(element).lineHeight));
    const titleHeight = (await title.boundingBox())!.height;
    expect(titleHeight).toBeGreaterThan(titleLine * 2);
    await first.getByRole('button', { name: 'Show more' }).click();
    expect((await text.boundingBox())!.height).toBeGreaterThan(line * 15);
    expect((await title.boundingBox())!.height).toBe(titleHeight);
    await first.getByRole('button', { name: 'Show less' }).click();
    expect((await text.boundingBox())!.height).toBeLessThanOrEqual(line * 3 + 0.5);

    // Hovering a row keeps its text column and its line count exactly as they were.
    const wrapped = page.locator('.tree-item[data-item-id="5"]'), body = wrapped.locator('.tree-body'), outcome = wrapped.locator('.tree-outcome .tree-clamp');
    await page.mouse.move(0, 0);
    const width = (await body.boundingBox())!.width, height = (await outcome.boundingBox())!.height;
    await expect(wrapped.locator('.tree-actions')).toHaveCSS('opacity', '0');
    await wrapped.hover();
    await expect(wrapped.locator('.tree-actions')).toHaveCSS('opacity', '1');
    expect((await body.boundingBox())!.width).toBe(width); expect((await outcome.boundingBox())!.height).toBe(height);
    // A selected row is the same, with or without the pointer on it (selecting opens the detail, which narrows the tree).
    // The floating bar shows only under the pointer or keyboard focus: on a selected row at rest it would cover the text.
    await wrapped.click(); await page.mouse.move(0, 0);
    await expect(wrapped).toHaveAttribute('aria-selected', 'true');
    await expect(wrapped.locator('.tree-actions')).toHaveCSS('opacity', '0');
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
    // A row's box is a slice behind it (D1), so a row carries no border of its own.
    await expect(first).toHaveCSS('border-bottom-width', '0px');
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});

test('gives the title the row beside a fixed end cluster with all actions and keeps hover width stable', async ({ page }) => {
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
    // The end cluster's slots are fixed (alpha.20 C4), so the title takes the rest: about half the 560px minimum column,
    // and never any of the cluster's room.
    const heading = (await row.locator('.tree-heading').boundingBox())!, end = (await row.locator('.tree-end').boundingBox())!;
    expect(heading.width / bounds.width).toBeGreaterThanOrEqual(0.45);
    expect(heading.x + heading.width).toBeLessThanOrEqual(end.x);
    const actions = row.locator('.tree-action');
    // Six hover slots (D4) and Ack in its own.
    await expect(actions).toHaveCount(7);
    await row.hover();
    expect((await title.boundingBox())!.width).toBe(text.width);
    expect((await title.boundingBox())!.height).toBe(text.height);
    const lines = new Set<number>();
    for (const action of await actions.all()) {
      await expect(action).toBeVisible();
      const box = (await action.boundingBox())!;
      expect(box.width).toBe(26); expect(box.height).toBe(24);
      if (await action.evaluate(element => !!element.closest('.tree-actions'))) lines.add(box.y);
      const name = (await action.getAttribute('aria-label'))!;
      await action.click(); await expect(page.getByLabel('Last action')).toHaveText(name);
    }
    // The hover bar is one floating line of six slots, left of the cluster; Ack keeps its own slot in the cluster.
    expect(lines.size).toBe(1);
    await expect(row.locator('.tree-actions .tree-action')).toHaveCount(6);
    const bar = (await row.locator('.tree-actions').boundingBox())!;
    expect(bar.x + bar.width).toBeLessThanOrEqual(end.x);
    await row.locator('.tree-icon').click(); await page.mouse.move(0, 0);
    expect((await title.boundingBox())!.width).toBe(text.width);
    const noActions = page.locator('.tree-item[data-item-id="2"]');
    await expect(noActions.locator('.tree-actions')).toHaveCount(0);
    // Every slot keeps its width filled or empty: a row without actions or Ack has the same cluster.
    expect((await noActions.locator('.tree-end').boundingBox())!.width).toBe((await row.locator('.tree-end').boundingBox())!.width);
    await page.setViewportSize({ width: 320, height: 700 });
    for (const item of [row, noActions]) {
      expect(await item.evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(Math.ceil((await item.boundingBox())!.width));
    }
  } finally { await server.close(); }
});

test('holds the reading anchor when a row click opens detail and when the window narrows', async ({ page }) => {
  const server = await createServer({ configFile: false, root: resolve('.'), publicDir: resolve('apps/desktop/public'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  try {
    await server.listen();
    const address = (server.httpServer as Server).address();
    if (!address || typeof address === 'string') throw new Error('Missing layout fixture server address');
    await openTree(page, `http://127.0.0.1:${address.port}`);
    await page.evaluate(async () => { await document.fonts.ready; });
    const close = page.getByRole('button', { name: 'Close detail' });
    if (await close.count()) await close.click();
    const scroller = page.locator('.tree-scroll'), anchored = page.locator('.tree-item[data-item-id="7"]');
    await anchored.evaluate(element => {
      const box = element.closest('.tree-scroll')!;
      const header = element.closest('.tree-topic-group')!.querySelector('.tree-topic')!;
      box.scrollTop += element.getBoundingClientRect().top - box.getBoundingClientRect().top - header.getBoundingClientRect().height;
    });
    // Let the scroll event record the reading anchor before the layout-changing click.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(anchored).toBeInViewport();
    const position = () => anchored.evaluate(element => element.getBoundingClientRect().top - element.closest('.tree-scroll')!.getBoundingClientRect().top);
    const before = await position(), width = (await scroller.boundingBox())!.width;
    await anchored.locator('.tree-question').click();
    await expect(page.locator('.item-detail')).toBeVisible();
    await expect.poll(async () => (await scroller.boundingBox())!.width).toBeLessThan(width);
    await expect.poll(async () => Math.abs(await position() - before)).toBeLessThanOrEqual(3);
    // Widen first so the following window resize demonstrably changes the tree's text width.
    await page.setViewportSize({ width: 1500, height: 700 });
    await expect.poll(async () => Math.abs(await position() - before)).toBeLessThanOrEqual(3);
    const wide = (await scroller.boundingBox())!.width;
    await page.setViewportSize({ width: 1100, height: 700 });
    await expect.poll(async () => (await scroller.boundingBox())!.width).toBeLessThan(wide);
    await expect.poll(async () => Math.abs(await position() - before)).toBeLessThanOrEqual(3);
  } finally { await server.close(); }
});

test('counts paragraph, list and code text lines exactly, and unfolds links only for keyboard focus', async ({ page }) => {
  const server = await createServer({ configFile: false, root: resolve('.'), publicDir: resolve('apps/desktop/public'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  try {
    await server.listen();
    const address = (server.httpServer as Server).address();
    if (!address || typeof address === 'string') throw new Error('Missing layout fixture server address');
    await openTree(page, `http://127.0.0.1:${address.port}`);
    await page.evaluate(async () => { await document.fonts.ready; });
    for (const scale of ['1', '1.5']) {
      await page.evaluate(value => document.documentElement.style.setProperty('--text-scale', value), scale);
      // Three lines stay open; at four the clamp (three lines) would hide one, so it folds.
      for (const [id, count, kind] of [[11, 3, 'paragraph'], [12, 4, 'paragraph'], [13, 3, 'list'], [14, 4, 'list'], [15, 3, 'code'], [16, 4, 'code'], [17, 4, 'mixed']] as const) {
        const row = page.locator(`.tree-item[data-item-id="${id}"]`), excerpt = row.locator('.tree-clamp');
        await expect(row.getByRole('button', { name: 'Show more' })).toHaveCount(count === 4 ? 1 : 0);
        // Markdown's inline mode renders the single mixed paragraph as a span;
        // multi-paragraph bodies, lists and fenced code retain their block elements.
        await expect(excerpt.locator(kind === 'mixed' ? 'span.tree-clamp-content' : kind === 'paragraph' ? 'p' : kind === 'list' ? 'li' : 'pre')).toHaveCount(kind === 'code' || kind === 'mixed' ? 1 : count);
        await expect.poll(() => excerpt.evaluate(element => {
          const box = element.getBoundingClientRect(), rectangles: DOMRect[] = [];
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), range = document.createRange();
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.textContent?.trim()) continue;
            range.selectNodeContents(node);
            rectangles.push(...[...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0));
          }
          rectangles.sort((a, b) => a.top - b.top);
          const lines: { top: number; bottom: number }[] = [];
          for (const rectangle of rectangles) {
            const line = lines.at(-1);
            if (line && Math.min(line.bottom, rectangle.bottom) - Math.max(line.top, rectangle.top) > 1) {
              line.top = Math.min(line.top, rectangle.top); line.bottom = Math.max(line.bottom, rectangle.bottom);
            } else lines.push({ top: rectangle.top, bottom: rectangle.bottom });
          }
          return {
            lines: lines.length,
            visible: lines.filter(rect => rect.bottom <= box.bottom + 0.5).length,
            cutLines: rectangles.filter(rect => rect.top < box.bottom - 0.5 && rect.bottom > box.bottom + 0.5).length,
          };
        })).toEqual({ lines: count, visible: 3, cutLines: 0 });
      }
    }
    await page.evaluate(() => document.documentElement.style.setProperty('--text-scale', '1'));
    const row = page.locator('.tree-item[data-item-id="17"]'), link = row.getByRole('link', { name: 'Read the evidence' });
    await row.evaluate(element => {
      const box = element.closest('.tree-scroll')!;
      const header = element.closest('.tree-topic-group')!.querySelector('.tree-topic')!;
      box.scrollTop += element.getBoundingClientRect().top - box.getBoundingClientRect().top - header.getBoundingClientRect().height - 16;
    });
    await link.click();
    await expect(row.getByRole('button', { name: 'Show more' })).toBeVisible();
    await row.evaluate(element => (element as HTMLElement).focus({ preventScroll: true }));
    await page.keyboard.press('Tab');
    await expect(link).toBeFocused();
    await expect(row.getByRole('button', { name: 'Show less' })).toBeVisible();
  } finally { await server.close(); }
});

test('keeps the connection card inside a narrow window with Restore and a long name', async ({ page }) => {
  const server = await createServer({ configFile: false, root: resolve('.'), publicDir: resolve('apps/desktop/public'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  try {
    await server.listen();
    const address = (server.httpServer as Server).address();
    if (!address || typeof address === 'string') throw new Error('Missing layout fixture server address');
    // 900px is the narrow top bar (below 1100); the archived session's long name must give way, not push the controls out.
    // An archived session is not listed on All sessions, so the fixture starts on it (the saved selection), as the vitest card tests do.
    const origin = `http://127.0.0.1:${address.port}`;
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
    await page.setViewportSize({ width: 900, height: 700 });
    await page.goto(`${origin}/tests/e2e/tree-layout/fixture.html?card`);
    await expect(page.getByRole('region', { name: 'Session tree' })).toHaveAttribute('data-session-status', 'ready');
    await page.evaluate(async () => { await document.fonts.ready; });
    const bar = page.locator('.shell-top'), dot = page.locator('[data-popover-trigger="connection"]');
    const bounds = (await bar.boundingBox())!, control = (await dot.boundingBox())!;
    expect(control.x).toBeGreaterThanOrEqual(bounds.x);
    expect(control.x + control.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    expect(await bar.evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(Math.ceil(bounds.width));
    await dot.click();
    const card = page.locator('.cc');
    await expect(card.getByRole('button', { name: 'Restore session' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Copy session ID' })).toBeVisible();
    const box = (await card.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(900);
  } finally { await server.close(); }
});


for (const theme of ['light', 'dark'] as const) test(`Map look: boxes, thread, clamp threshold, floating Back-to pills and clear reveals in ${theme}`, async ({ page }) => {
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
    // A branch has one hue, from its top item (D3); the top item opens one tinted box and its child a second (D1).
    await expect(root).toHaveAttribute('data-branch', /^[0-4]$/);
    expect(await child.getAttribute('data-branch')).toBe(await root.getAttribute('data-branch'));
    await expect(root.locator('.tree-box')).toHaveCount(1);
    await expect(child.locator('.tree-box')).toHaveCount(2);
    await expect(root.locator('.tree-end > .tree-end-badge')).toContainText('Done');
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
    // Nothing is drawn until a row is selected: the thread is the Map's only line.
    await expect(page.locator('.tree-thread, .tree-thread-elbow')).toHaveCount(0);
    await child.locator('.tree-question').click();
    await expect(child).toHaveAttribute('aria-selected', 'true');
    // The accent thread runs down the root's column, turns into the selected child's bullet with an elbow, and no other row has one.
    const childBullet = (await child.locator('.tree-chevron-space').boundingBox())!, elbow = (await child.locator('.tree-thread-elbow').boundingBox())!;
    expect(elbow.y + elbow.height - 1.5).toBeCloseTo(childBullet.y + childBullet.height / 2, 0);
    expect(await root.locator('.tree-thread').count()).toBeGreaterThan(0);
    await expect(page.locator('.tree-item[data-item-id="3"]').locator('.tree-thread, .tree-thread-elbow')).toHaveCount(0);
    await root.locator('.tree-question').click();
    await expect(root).toHaveAttribute('aria-selected', 'true');

    for (const [id, lines] of [['9', 3], ['10', 4]] as const) {
      const row = page.locator(`.tree-item[data-item-id="${id}"]`);
      await row.evaluate(element => element.scrollIntoView({ block: 'center' }));
      const body = row.locator('.tree-clamp');
      const line = await body.evaluate(element => parseFloat(getComputedStyle(element).lineHeight));
      // Prove the fixture really contains three/four body lines before testing the threshold.
      await expect(body.locator('br')).toHaveCount(lines - 1);
      expect((await body.textContent())!.split('\n')).toHaveLength(lines);
      await expect(body).toHaveCSS('white-space', 'normal');
      if (lines === 3) {
        await expect(row.getByRole('button', { name: 'Show more' })).toHaveCount(0);
        expect((await body.boundingBox())!.height).toBeCloseTo(line * 3, 0);
      } else {
        await expect(row.getByRole('button', { name: 'Show more' })).toBeVisible();
        expect((await body.boundingBox())!.height).toBeCloseTo(line * 3, 0);
        await row.getByRole('button', { name: 'Show more' }).click();
        expect((await body.boundingBox())!.height).toBeCloseTo(line * 4, 0);
        await row.getByRole('button', { name: 'Show less' }).click();
        // A closed preview tracks text scaling through its natural-content observer.
        for (const scale of [0.8, 1, 1.2]) {
          await page.evaluate(scale => document.documentElement.style.setProperty('--text-scale', String(scale)), scale);
          const scaledLine = await body.evaluate(element => parseFloat(getComputedStyle(element).lineHeight));
          // Text rectangles and line boxes round independently at scaled font sizes.
          // Allow at most one CSS pixel for that rounding, while separately proving
          // three complete text lines are visible and no glyph rectangle is clipped.
          await expect.poll(async () => Math.abs((await body.boundingBox())!.height - scaledLine * 3)).toBeLessThanOrEqual(1);
          await expect.poll(() => body.evaluate(element => {
            const bottom = element.getBoundingClientRect().bottom, rectangles: DOMRect[] = [];
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), range = document.createRange();
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              if (!node.textContent?.trim()) continue;
              range.selectNodeContents(node);
              rectangles.push(...[...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0));
            }
            return {
              visible: rectangles.filter(rect => rect.bottom <= bottom + 0.5).length,
              cutLines: rectangles.filter(rect => rect.top < bottom - 0.5 && rect.bottom > bottom + 0.5).length,
            };
          })).toEqual({ visible: 3, cutLines: 0 });
        }
        await page.evaluate(() => document.documentElement.style.setProperty('--text-scale', '1'));
      }
    }
    const scroller = page.locator('.tree-scroll'), filters = page.locator('.tree-path');
    // The Back-to pill (SPEC §5.8) floats over the Map in the scroller's shell; it is never a row of its own.
    const marker = page.locator('.tree-scroll-shell > .tree-back');
    const last = page.locator('.tree-item[data-item-id="18"]');
    await scroller.evaluate(element => { element.scrollTop = 0; });
    await expect(marker).toHaveCount(0);
    await expect(page.locator('.tree-scroll .tree-back, .tree-selected-slot')).toHaveCount(0);
    // The pill covers rows rather than taking room, so the path row, the scroller and the rows all keep their boxes.
    const geometry = async () => ({
      scroller: await scroller.boundingBox(), filters: await filters.boundingBox(),
      scroll: await scroller.evaluate(element => ({ width: element.clientWidth, height: element.clientHeight, contentHeight: element.scrollHeight })),
      rows: await Promise.all([root, child, last].map(row => row.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height };
      }))),
    });
    const hiddenGeometry = await geometry();
    const expectFloatingMarker = async (edge: 'above' | 'below', label: string) => {
      await expect(marker).toHaveAttribute('data-edge', edge);
      await expect(marker.locator('.tree-back-arrow')).toHaveText(edge === 'above' ? '↑' : '↓');
      await expect(marker.locator('.tree-back-label')).toContainText(`Back to “${label}`);
      const tag = (await marker.boundingBox())!, area = (await scroller.boundingBox())!;
      // Centred over the Map and inside it; above, clear of the sticky topic band it would otherwise cover.
      expect(Math.abs(tag.x + tag.width / 2 - (area.x + area.width / 2))).toBeLessThanOrEqual(1);
      expect(tag.y).toBeGreaterThanOrEqual(area.y);
      expect(tag.y + tag.height).toBeLessThanOrEqual(area.y + area.height);
      if (edge === 'above') {
        const band = await scroller.evaluate(box => {
          const top = box.getBoundingClientRect().top;
          return Math.max(top, ...[...box.querySelectorAll('.tree-topic')].map(header => header.getBoundingClientRect())
            .filter(rect => rect.top <= top + 1 && rect.bottom > top).map(rect => rect.bottom));
        });
        expect(tag.y).toBeGreaterThanOrEqual(band);
      }
      expect(await geometry()).toEqual(hiddenGeometry);
      await expectSolidMarker(marker);
      await marker.hover(); await expectSolidMarker(marker);
      await marker.focus(); await expectSolidMarker(marker);
      await page.mouse.down();
      await expect.poll(() => marker.evaluate(element => element.matches(':active'))).toBe(true);
      await expectSolidMarker(marker);
      expect(await geometry()).toEqual(hiddenGeometry);
      await page.mouse.up();
      await expect(marker).toHaveCount(0);
      expect(await geometry()).toEqual(hiddenGeometry);
    };

    await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(marker.locator('.tree-back-label')).toContainText('Back to “A long item title');
    const longLabel = marker.locator('.tree-back-label');
    await expect(longLabel).toHaveCSS('text-overflow', 'ellipsis');
    await expect(longLabel).toHaveCSS('overflow', 'hidden');
    await expect(longLabel).toHaveCSS('white-space', 'nowrap');
    // The pill names the item by its short name and never grows past 70% of the Map, however long the name.
    expect((await marker.boundingBox())!.width).toBeLessThanOrEqual((await scroller.boundingBox())!.width * 0.7 + 0.5);
    await expectFloatingMarker('above', 'A long item title');
    await expectRevealedRow(root);
    await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(marker).toBeVisible();
    // The shortcut (`.`, SPEC 6.1; ⌘J is gone) works while the session's other panel has focus.
    await page.locator('.item-detail').getByRole('button', { name: 'Copy reference' }).focus();
    await page.keyboard.press('.');
    await expect(marker).toHaveCount(0);
    await expectRevealedRow(root);
    // Nearest keyboard reveal also clears the actual sticky header, without centering the row.
    await root.evaluate(element => (element as HTMLElement).focus({ preventScroll: true }));
    await child.evaluate(element => {
      const box = element.closest('.tree-scroll')!;
      const header = element.closest('.tree-topic-group')!.querySelector('.tree-topic')!;
      box.scrollTop += element.getBoundingClientRect().top - box.getBoundingClientRect().top - header.getBoundingClientRect().height / 2;
    });
    expect(await child.evaluate(element => element.getBoundingClientRect().top < element.closest('.tree-topic-group')!.querySelector('.tree-topic')!.getBoundingClientRect().bottom)).toBe(true);
    await page.keyboard.press('ArrowDown');
    await expect(child).toBeFocused();
    await expectRevealedRow(child);
    // A selection below the viewport uses the other edge and remains fully opaque.
    await last.locator('.tree-question').click();
    await expect(last).toHaveAttribute('aria-selected', 'true');
    await scroller.evaluate(element => { element.scrollTop = 0; });
    await expectFloatingMarker('below', 'Another item');
    await expectRevealedRow(last);
  } finally { await server.close(); }
});

/** Opens the tree with Details beside it and one row scrolled to the reading edge; returns how to read where rows sit. */
async function readingSetup(page: Page, origin: string) {
  await openTree(page, origin);
  await page.evaluate(async () => { await document.fonts.ready; });
  const close = page.getByRole('button', { name: 'Close detail' });
  if (await close.count()) await close.click();
  const scroller = page.locator('.tree-scroll'), anchored = page.locator('.tree-item[data-item-id="7"]');
  await anchored.evaluate(element => {
    const box = element.closest('.tree-scroll')!;
    const header = element.closest('.tree-topic-group')!.querySelector('.tree-topic')!;
    box.scrollTop += element.getBoundingClientRect().top - box.getBoundingClientRect().top - header.getBoundingClientRect().height;
  });
  const settle = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await settle();
  await anchored.locator('.tree-question').click();
  await expect(page.locator('.item-detail')).toBeVisible();
  await settle();
  await expect(anchored).toBeInViewport();
  // Where a row sits below the sticky topic bar, which may wrap to another line when the Map narrows. The row the owner is
  // reading is the first one that reaches below the bar, as the Tree itself keeps it (or the one named).
  const reading = (id?: string) => scroller.evaluate((box, wanted) => {
    const edge = box.getBoundingClientRect().top;
    let bar = 0;
    for (const header of box.querySelectorAll('.tree-topic')) {
      const rect = header.getBoundingClientRect();
      if (rect.top <= edge && rect.bottom > edge) bar = Math.max(bar, rect.bottom - edge);
    }
    const rows = [...box.querySelectorAll<HTMLElement>('.tree-item')];
    const row = wanted ? rows.find(element => element.dataset.itemId === wanted)! : rows.find(element => element.getBoundingClientRect().bottom > edge + bar + 1)!;
    return { id: row.dataset.itemId!, top: row.getBoundingClientRect().top - edge - bar };
  }, id);
  /** Runs a change to the column; the Map's width changes, and the row the owner was reading stays where it was. */
  const holds = async (change: () => Promise<void>) => {
    const width = (await scroller.boundingBox())!.width, before = await reading();
    await change();
    await settle();
    await expect.poll(async () => (await scroller.boundingBox())!.width).not.toBe(width);
    await expect.poll(async () => Math.abs((await reading(before.id)).top - before.top)).toBeLessThanOrEqual(3);
    // The body never scrolls sideways.
    expect(await page.locator('.shell-body').evaluate(element => element.scrollLeft + element.scrollWidth - element.clientWidth)).toBe(0);
    return (await scroller.boundingBox())!.width;
  };
  return { holds, edge: page.getByRole('separator', { name: 'Resize detail panel' }) };
}

test('keeps the Map still while Details folds, unfolds and narrows the Map by its edge', async ({ page }) => {
  const server = await createServer({ configFile: false, root: resolve('.'), publicDir: resolve('apps/desktop/public'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  try {
    await server.listen();
    const address = (server.httpServer as Server).address();
    if (!address || typeof address === 'string') throw new Error('Missing layout fixture server address');
    const { holds, edge } = await readingSetup(page, `http://127.0.0.1:${address.port}`);
    const widths = [await holds(() => page.getByRole('button', { name: 'Fold Details' }).click())];
    widths.push(await holds(() => page.getByRole('button', { name: 'Show Details' }).click()));
    await edge.focus();
    const handle = (await edge.boundingBox())!, x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
    widths.push(await holds(async () => { await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x - 90, y, { steps: 5 }); await page.mouse.up(); }));
    await edge.focus();
    widths.push(await holds(() => page.keyboard.press('End')));
    expect(new Set(widths).size).toBe(widths.length);
  } finally { await server.close(); }
});

// Widening the Map back (End, then Home) reflows the rows so that another topic's sticky bar, wrapped to a different height,
// sits at the reading edge until the row is back; the Tree's hold (ui/tree/TreeView.tsx `holding`) settles against the bar
// the row ends under.
test('keeps the Map still while Details widens the Map back across the topic bar unwrapping', async ({ page }) => {
  const server = await createServer({ configFile: false, root: resolve('.'), publicDir: resolve('apps/desktop/public'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  try {
    await server.listen();
    const address = (server.httpServer as Server).address();
    if (!address || typeof address === 'string') throw new Error('Missing layout fixture server address');
    const { holds, edge } = await readingSetup(page, `http://127.0.0.1:${address.port}`);
    await edge.focus();
    await holds(() => page.keyboard.press('End'));
    await holds(() => page.keyboard.press('Home'));
  } finally { await server.close(); }
});

// The Map never moves on its own (alpha.19 Details decision): every way the Map's width changes, in both directions, leaves
// the row the owner was reading where it was below the sticky topic bar, and the body never scrolls sideways. One row per
// trigger; `before` brings the column to where the trigger starts (not measured).
const widthTriggers: ReadonlyArray<readonly [name: string, before: (page: Page, edge: Locator) => Promise<void>, change: (page: Page, edge: Locator) => Promise<void>]> = [
  ['fold widens the Map', async () => {}, page => page.getByRole('button', { name: 'Fold Details' }).click()],
  ['unfold narrows the Map', page => page.getByRole('button', { name: 'Fold Details' }).click(), page => page.getByRole('button', { name: 'Show Details' }).click()],
  ['dragging the edge left narrows the Map', async () => {}, (page, edge) => dragEdge(page, edge, -90)],
  ['dragging the edge right widens the Map', async (page, edge) => { await edge.focus(); await page.keyboard.press('End'); }, (page, edge) => dragEdge(page, edge, 120)],
  ['End narrows the Map to its least', async () => {}, async (page, edge) => { await edge.focus(); await page.keyboard.press('End'); }],
  ['Home widens the Map back, unwrapping the topic bar', async (page, edge) => { await edge.focus(); await page.keyboard.press('End'); },
    async (page, edge) => { await edge.focus(); await page.keyboard.press('Home'); }],
  ['a narrower window narrows the Map', async () => {}, page => page.setViewportSize({ width: 900, height: 700 })],
  ['a wider window widens the Map, across the Details breakpoint', async () => {}, page => page.setViewportSize({ width: 1280, height: 700 })],
];
async function dragEdge(page: Page, edge: Locator, dx: number) {
  const handle = (await edge.boundingBox())!, x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y, { steps: 5 }); await page.mouse.up();
}
for (const [name, before, change] of widthTriggers) test(`keeps the reading row still when ${name}`, async ({ page }) => {
  const server = await createServer({ configFile: false, root: resolve('.'), publicDir: resolve('apps/desktop/public'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  try {
    await server.listen();
    const address = (server.httpServer as Server).address();
    if (!address || typeof address === 'string') throw new Error('Missing layout fixture server address');
    const { holds, edge } = await readingSetup(page, `http://127.0.0.1:${address.port}`);
    await before(page, edge);
    // Let the column's own change land before the measured one starts.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await holds(() => change(page, edge));
  } finally { await server.close(); }
});
