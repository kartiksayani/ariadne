import { test, expect, type Page, type Locator } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import type { Server } from 'node:http';

async function ready(page: Page) {
  await expect(page.getByRole('region', { name: 'Session tree' })).toHaveAttribute('data-session-status', 'ready');
  await expect(page.getByRole('region', { name: 'Session tree' })).toHaveAttribute('data-session-busy', 'false');
}

/** Opens one of the pages (Projects, All sessions, Archive) from the switcher's footer links, as tests/ui/app/open.ts `goToPage`. There are no tabs. */
async function goToPage(page: Page, name: 'Projects' | 'All sessions' | 'Archive') {
  await page.locator('[data-popover-trigger="switcher"]').click();
  await page.getByRole('dialog', { name: 'Switch session or project' }).getByRole('button', { name, exact: true }).click();
}

/** The filter row is closed until the top bar's Filter button opens it (SPEC 2.1, `f`). */
async function showFilters(page: Page) {
  const group = page.getByRole('group', { name: 'Filter items' });
  if (!await group.count()) await page.getByRole('button', { name: /^Filter by status/ }).click();
  await expect(group).toBeVisible();
}

async function reachable(control: Locator) {
  await expect(control).toBeInViewport();
  expect(await control.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.closest('button') === element;
  })).toBe(true);
}

async function checkFilters(page: Page) {
  const trigger = page.getByRole('group', { name: 'Filter items' }).getByRole('button', { name: /^Filter/ });
  await reachable(trigger);
  await trigger.click();
  const option = page.getByRole('menuitemcheckbox', { name: /^Open \d+$/ });
  await reachable(option);
  await expect(option).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(option).toHaveCount(0);
}

const usefulRows = 64;
type Viewport = { width: number; height: number };

async function withLayoutFixture(page: Page, viewport: Viewport, query: string, run: () => Promise<void>) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const server = await createServer({ configFile: false, root: resolve('.'), publicDir: resolve('apps/desktop/public'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  try {
    await server.listen();
    const address = (server.httpServer as Server).address();
    if (!address || typeof address === 'string') throw new Error('Missing layout fixture server address');
    const origin = `http://127.0.0.1:${address.port}`;
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
    await page.setViewportSize(viewport);
    await page.goto(`${origin}/tests/e2e/owner-input/fixture.html${query}`);
    await run();
    expect(errors).toEqual([]);
  } finally { await server.close(); }
}

/** Every registered session is listed on All sessions, so the session opens from there whichever page the App started on. */
async function openLayoutSession(page: Page) {
  await goToPage(page, 'All sessions');
  const session = page.locator('button[data-session-id]').first();
  await expect(session).toBeEnabled(); await session.click();
  await ready(page);
}

/** From the Projects page: the project's own page, then its first session. */
async function openProjectPage(page: Page) {
  await goToPage(page, 'Projects');
  await page.locator('.pj-name').first().click();
}

function geometry(page: Page) {
  return page.evaluate(() => {
    const rows = document.querySelector<HTMLElement>('.tree-scroll')!, center = document.querySelector<HTMLElement>('.shell-center-content')!;
    return { rowsHeight: rows.clientHeight, rowsScrollHeight: rows.scrollHeight, rowsScrollTop: rows.scrollTop,
      centerScrollTop: center.scrollTop, centerHeight: center.clientHeight, centerScrollHeight: center.scrollHeight,
      // The toolbar's offset under the top bar. The body never scrolls sideways, so opening the detail
      // column narrows the centre; the toolbar must still sit right under the bar.
      toolbarGap: document.querySelector('[role="group"][aria-label="Filter items"]')!.getBoundingClientRect().top - document.querySelector('.shell-top')!.getBoundingClientRect().bottom,
      headerTop: document.querySelector('.shell-top')!.getBoundingClientRect().top };
  });
}

async function checkConnectionCard(page: Page, viewport: Viewport) {
  const tree = page.getByRole('tree');
  const selected = tree.locator('[data-item-id="10.50"]');
  await selected.click();
  await expect(selected).toHaveAttribute('aria-selected', 'true');
  expect((await geometry(page)).rowsScrollTop).toBeGreaterThan(0);
  await ready(page);
  // The session bar is gone (SPEC 7): its actions (Close, Copy ID, Sending) are the connection card's, opened from the dot.
  const dot = page.locator('[data-popover-trigger="connection"]');
  await reachable(dot);
  // Every session action stays reachable through the card with the tree scrolled.
  for (const label of ['Sending…', 'Close session', 'Copy session ID']) {
    await dot.click();
    const card = page.locator('.cc');
    const cardBox = (await card.boundingBox())!;
    expect(cardBox.x).toBeGreaterThanOrEqual(0);
    expect(cardBox.y).toBeGreaterThanOrEqual(0);
    expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(viewport.width);
    expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(viewport.height);
    const action = card.getByRole('button', { name: label, exact: true });
    await reachable(action);
    if (label === 'Copy session ID') {
      // This harness grants no clipboard permissions; check reachability without writing.
      await page.keyboard.press('Escape');
    } else {
      await action.click();
      const review = page.getByRole('dialog');
      await expect(review).toBeInViewport();
      await review.getByRole('button', { name: label === 'Sending…' ? 'Done' : 'Cancel', exact: true }).click();
      await expect(review).toHaveCount(0);
    }
    await expect(dot).toBeFocused();
  }
  // Every control that stayed in the top bar (the old bar's direct controls) is still reachable at this size.
  for (const control of await page.locator('.shell-top button:visible').all()) await reachable(control);
  const current = await geometry(page);
  expect(current.rowsHeight).toBeGreaterThan(usefulRows);
  expect(current.centerScrollTop).toBe(0);
  expect(current.centerScrollHeight).toBeLessThanOrEqual(current.centerHeight + 1);
  await checkFilters(page);
  const controls = await page.getByRole('group', { name: 'Filter items' }).evaluate(element => [...element.querySelectorAll('button')].map(control => {
    const bounds = control.getBoundingClientRect();
    return { label: control.textContent || control.closest('label')?.textContent,
      reachable: document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.closest('button') === control };
  }));
  expect(controls.filter(control => !control.reachable)).toEqual([]);
  const ordinary = tree.locator('[data-item-id="10.49"]');
  await ordinary.evaluate(element => element.scrollIntoView({ block: 'start' }));
  const completeRow = await ordinary.evaluate(element => {
    const bounds = element.getBoundingClientRect(), viewport = element.closest('.tree-scroll')!.getBoundingClientRect();
    return { height: bounds.height, top: bounds.top, bottom: bounds.bottom, viewportTop: viewport.top, viewportBottom: viewport.bottom };
  });
  expect(completeRow.height).toBeGreaterThan(40);
  expect(completeRow.top).toBeGreaterThanOrEqual(completeRow.viewportTop);
  expect(completeRow.bottom).toBeLessThanOrEqual(completeRow.viewportBottom);
}

test('keeps the connect card and scrolling instruction accessible', async ({ page }) => {
  await withLayoutFixture(page, { width: 1000, height: 668 }, '', async () => {
    await openProjectPage(page);
    await page.getByRole('button', { name: 'Connect existing session', exact: true }).click();
    const dialog = page.getByRole('dialog');
    // Only the Codex notice renders the pasted instruction; the Claude Mod has nothing to paste.
    await dialog.getByLabel('Adapter').selectOption('codex');
    await dialog.getByLabel('External session ID').fill('layout-host');
    await dialog.getByLabel('Socket path').fill('/tmp/layout-host.sock');
    await dialog.getByLabel('Attach to an existing Ariadne session').check();
    await dialog.getByLabel('Registered Ariadne session').selectOption('00000000-0000-4000-8000-000000000002');
    await dialog.getByRole('button', { name: 'Connect existing session', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    // The connect card sits directly under the page head, above the project's session list (the old "Active" list; SPEC 14.2).
    await expect(page.getByRole('region', { name: 'Session setup' }).getByRole('button', { name: 'Copy instruction' })).toBeVisible();
    expect(await page.evaluate(() => {
      const card = document.querySelector('[aria-label="Session setup"]');
      const list = document.querySelector('.sl-group');
      return !!card && !!list && !!(card.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING);
    })).toBe(true);
    // The instruction starts collapsed; opened, it scrolls inside its own frame and its last line is readable there.
    const card = page.getByRole('region', { name: 'Session setup' });
    await expect(card.locator('pre')).toBeHidden();
    await card.getByText('Show instruction').click();
    const instruction = await card.locator('pre').evaluate(element => {
      const node = element.firstChild!, range = document.createRange();
      range.setStart(node, node.textContent!.lastIndexOf('Setup step 30:'));
      range.setEnd(node, node.textContent!.length);
      element.scrollTop += range.getBoundingClientRect().top - element.getBoundingClientRect().top - element.clientHeight / 2;
      const line = range.getBoundingClientRect(), bounds = element.getBoundingClientRect();
      return { lineTop: line.top, lineBottom: line.bottom, top: bounds.top, bottom: bounds.bottom, scrolls: element.scrollHeight > element.clientHeight };
    });
    expect(instruction.scrolls).toBe(true);
    expect(instruction.lineTop).toBeGreaterThanOrEqual(instruction.top);
    expect(instruction.lineBottom).toBeLessThanOrEqual(instruction.bottom);
    await openLayoutSession(page);
    // The connect card belongs to the project page; the session view does not carry it.
    await expect(card).toHaveCount(0);
    await goToPage(page, 'Projects');
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
    await expect(card).toHaveCount(0);
  });
});

test('scrolls and selects full variable rows in a 2000-item tree with accessible filters', async ({ page }, testInfo) => {
  // Keep the CI allowance only for the required 2,000-row render, scroll and detail layout.
  test.setTimeout(900_000);
  await withLayoutFixture(page, { width: 1000, height: 668 }, '?largeTree', async () => {
    await openLayoutSession(page);
    await showFilters(page);
    const tree = page.getByRole('tree');
    await expect(tree.locator('.tree-item')).toHaveCount(2000);
    const before = await geometry(page);
    await testInfo.attach('initial-tree-geometry', { body: JSON.stringify(before), contentType: 'application/json' });
    // At least one full variable-height row (about 64px) stays visible.
    expect(before.rowsHeight).toBeGreaterThan(usefulRows);
    const row = tree.locator('[data-item-id="10.50"]');
    // Clicking scrolls the row into view before selecting it.
    await row.click();
    await expect(row).toHaveAttribute('aria-selected', 'true');
    const after = await geometry(page);
    await testInfo.attach('tree-scroll-geometry', { body: JSON.stringify({ before, after }), contentType: 'application/json' });
    expect(after.rowsScrollTop).toBeGreaterThan(0);
    expect(after.rowsHeight).toBeGreaterThan(usefulRows);
    expect(after.rowsScrollHeight).toBeGreaterThan(after.rowsHeight);
    expect(after.centerScrollTop).toBe(0);
    expect(after.centerScrollHeight).toBeLessThanOrEqual(after.centerHeight + 1);
    expect(after.toolbarGap).toBe(before.toolbarGap);
    expect(after.headerTop).toBe(before.headerTop);
    await checkFilters(page);
  });
});

test('keeps connection-card actions accessible over a scrolled tree at 1000x668 and after resizing to 900x650', async ({ page }) => {
  const viewport = { width: 1000, height: 668 };
  await withLayoutFixture(page, viewport, '?scrollTree', async () => {
    await openLayoutSession(page);
    await showFilters(page);
    await checkConnectionCard(page, viewport);
    await page.setViewportSize({ width: 900, height: 650 });
    await ready(page);
    await reachable(page.locator('[data-popover-trigger="connection"]'));
    await expect(page.getByRole('tree').locator('[data-item-id="10.50"]')).toHaveAttribute('aria-selected', 'true');
    const resized = await geometry(page);
    expect(resized.rowsHeight).toBeGreaterThan(usefulRows);
    expect(resized.centerScrollTop).toBe(0);
    expect(resized.centerScrollHeight).toBeLessThanOrEqual(resized.centerHeight + 1);
    await checkFilters(page);
    // Rename left the session bar for the All sessions page's rows (SPEC 5.14): its dialog fits the narrow window too.
    await goToPage(page, 'All sessions');
    await page.getByRole('button', { name: /^Rename /, }).first().click();
    const rename = page.getByRole('dialog', { name: 'Name this session' });
    await expect(rename).toBeInViewport();
    await page.keyboard.press('Escape');
    await expect(rename).toHaveCount(0);
  });
});

test('keeps connection-card actions and graph scrolling accessible at 900x650', async ({ page }) => {
  const viewport = { width: 900, height: 650 };
  await withLayoutFixture(page, viewport, '?scrollTree', async () => {
    await openLayoutSession(page);
    await showFilters(page);
    await checkConnectionCard(page, viewport);
    // Graph renders in the tree column under the top bar and owns its
    // scrolling there. Catalogue routes retain the centre pane scroller,
    // including complete setup content below the catalogue.
    await page.getByRole('button', { name: 'Graph', exact: true }).click();
    await expect(page.getByRole('tree', { name: / graph$/ }).first()).toBeVisible();
    expect(await page.locator('.graph-scroll').evaluate(element => getComputedStyle(element).overflowY)).toBe('auto');
    expect(await page.locator('.shell-center-content').evaluate(element => getComputedStyle(element).overflowY)).toBe('auto');
    const graphBox = (await page.locator('.graph-scroll').boundingBox())!, centerBox = (await page.locator('.shell-center-content').boundingBox())!;
    expect(graphBox.y + graphBox.height).toBeLessThanOrEqual(centerBox.y + centerBox.height + 1);
    // Nothing in the session column is clipped: banners and controls shrink and scroll themselves.
    expect(await page.locator('.nav-session-content').evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
    await goToPage(page, 'Projects');
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  });
});

test('keeps one sent answer with its delivery controls in the ordinary App', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const server = await createServer({ configFile: false, root: resolve('.'), publicDir: resolve('apps/desktop/public'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  try {
    await server.listen();
    const address = (server.httpServer as Server).address();
    if (!address || typeof address === 'string') throw new Error('Missing layout fixture server address');
    const origin = `http://127.0.0.1:${address.port}`;
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
    await page.goto(`${origin}/tests/e2e/owner-input/fixture.html`);
    // There are no tabs: a fresh App opens the session from All sessions.
    await openLayoutSession(page);
    await page.locator('[data-item-id="2"]').click();
    // The item and chat scroll on top; the composer is docked below it.
    const detail = page.locator('.shell-detail-scroll'), head = detail.locator('.item-detail .detail-head');
    await expect(head.getByRole('heading', { name: 'Which native delivery window should we use?', level: 2 })).toBeVisible();
    await detail.getByLabel('Reply in your own words').fill('Use the saved native delivery option.');
    // One Send in Details' answer bar; the old "Send as a reply only" menu entry is gone (SPEC 5.3).
    await detail.getByRole('region', { name: 'Your answer' }).getByRole('button', { name: 'Send', exact: true }).click();
    // A sent answer becomes the delivery stepper on top and one pending bubble in the chat.
    // The fixture's session already
    // has a message in flight, so its status line says what the reply waits behind instead of
    // echoing it; that line sits with the pending message.
    const receipt = detail.getByRole('region', { name: 'Conversation' }).getByRole('status').filter({ hasText: 'Queued behind your message' });
    const sent = detail.getByRole('region', { name: 'Conversation' }).getByText('Use the saved native delivery option.');
    await expect(sent).toHaveCount(1);
    await expect(detail.getByRole('region', { name: 'Timeline' })).toHaveCount(0);
    await expect(detail.getByRole('region', { name: 'Your answer' })).toContainText('Sending');
    await expect(receipt).toBeVisible(); await expect(sent).toBeAttached();
    await expect(detail.getByLabel('Reply in your own words')).toHaveCount(0);
    // Delivery controls stay with the one pending owner message.
    const pending = detail.getByRole('region', { name: 'Conversation' }).locator('li[data-pending]').last();
    await expect(pending).toContainText('Use the saved native delivery option.');
    await expect(pending.getByRole('status').filter({ hasText: 'Queued behind your message' })).toBeVisible();
    // Check actual rectangles at the reported size, the supported minimum and
    // the wide workspace, including a shorter window that requires scrolling.
    for (const viewport of [{ width: 900, height: 650 }, { width: 1000, height: 700 }, { width: 1600, height: 960 }, { width: 1000, height: 500 }]) {
      await page.setViewportSize(viewport);
      await page.locator('.shell-body').evaluate(element => { element.scrollLeft = element.scrollWidth; });
      await sent.scrollIntoViewIfNeeded();
      await expect(sent).toBeInViewport();
      const headBox = (await head.boundingBox())!, receiptBox = (await receipt.boundingBox())!, sentBox = (await sent.boundingBox())!;
      expect(receiptBox.y, `receipt below the question at ${viewport.width}×${viewport.height}`).toBeGreaterThanOrEqual(headBox.y + headBox.height);
      expect(receiptBox.y, `delivery controls below their reply at ${viewport.width}×${viewport.height}`).toBeGreaterThanOrEqual(sentBox.y + sentBox.height);
      for (const content of await head.locator('h2, .detail-badge').all()) {
        await expect(content).toBeVisible();
        const box = (await content.boundingBox())!;
        expect(box.y + box.height, `question head above receipt at ${viewport.width}×${viewport.height}`).toBeLessThanOrEqual(receiptBox.y);
      }
      if (viewport.width === 1000 && viewport.height === 700) await page.screenshot({ path: testInfo.outputPath('saved-answer.png') });
    }
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});

test('docks the composer under a scrolling detail body that grows it to a third of the pane', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const server = await createServer({ configFile: false, root: resolve('.'), publicDir: resolve('apps/desktop/public'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  try {
    await server.listen();
    const address = (server.httpServer as Server).address();
    if (!address || typeof address === 'string') throw new Error('Missing layout fixture server address');
    const origin = `http://127.0.0.1:${address.port}`;
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
    await page.goto(`${origin}/tests/e2e/owner-input/fixture.html`);
    await openLayoutSession(page);
    await page.locator('[data-item-id="2"]').click();
    const pane = page.locator('.item-detail'), body = pane.locator('.detail-body'), dock = pane.locator('.detail-dock');
    const composer = pane.getByLabel('Reply in your own words');
    await expect(composer).toBeVisible();
    for (const viewport of [{ width: 1000, height: 700 }, { width: 1000, height: 500 }]) {
      await page.setViewportSize(viewport);
      // The body scrolls; the pane and its shell host do not, so the dock never leaves the view.
      const geometry = await page.evaluate(() => {
        const detail = document.querySelector<HTMLElement>('.item-detail')!, host = document.querySelector<HTMLElement>('.shell-detail-scroll')!;
        const bodyBox = detail.querySelector('.detail-body')!.getBoundingClientRect(), dockBox = detail.querySelector('.detail-dock')!.getBoundingClientRect();
        return { hostOverflow: host.scrollHeight - host.clientHeight, bodyBottom: bodyBox.bottom, dockTop: dockBox.top, dockBottom: dockBox.bottom, paneBottom: detail.getBoundingClientRect().bottom };
      });
      expect(geometry.hostOverflow, `detail host does not scroll at ${viewport.width}×${viewport.height}`).toBeLessThanOrEqual(1);
      expect(geometry.bodyBottom, `body ends where the dock starts at ${viewport.width}×${viewport.height}`).toBeLessThanOrEqual(geometry.dockTop + 1);
      expect(geometry.dockBottom).toBeLessThanOrEqual(geometry.paneBottom + 1);
      await body.evaluate(element => { element.scrollTop = 0; });
      await expect(composer).toBeInViewport();
      await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await expect(composer).toBeInViewport();
      // Quick replies sit above the composer inside the dock.
      if (await dock.locator('[data-answer-option]').count()) {
        const choices = dock.locator('.answer-choices');
        await expect(choices).toBeVisible();
        await expect(dock.locator('[data-answer-option]').first()).toBeVisible();
        const options = (await dock.locator('[data-answer-option]').first().boundingBox())!, box = (await composer.boundingBox())!;
        expect(options.y + options.height).toBeLessThanOrEqual(box.y);
      }
    }
    // One line when empty; grows with its text to about a third of the pane, then scrolls inside itself.
    const empty = (await composer.boundingBox())!.height;
    await composer.fill(Array.from({ length: 40 }, (_, index) => `Line ${index + 1} of a long reply`).join('\n'));
    const grown = await composer.evaluate(element => ({ height: element.getBoundingClientRect().height, scrolls: element.scrollHeight > element.clientHeight,
      pane: element.closest('.item-detail')!.getBoundingClientRect().height }));
    expect(grown.height).toBeGreaterThan(empty);
    expect(grown.height).toBeLessThanOrEqual(grown.pane / 3 + 2);
    expect(grown.scrolls).toBe(true);
    await expect(composer).toBeInViewport();
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});

test('reads as a chat: oldest exchange first with no round headers, quick replies above the composer, no composer when closed', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const server = await createServer({ configFile: false, root: resolve('.'), publicDir: resolve('apps/desktop/public'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  try {
    await server.listen();
    const address = (server.httpServer as Server).address();
    if (!address || typeof address === 'string') throw new Error('Missing layout fixture server address');
    const origin = `http://127.0.0.1:${address.port}`;
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
    await page.goto(`${origin}/tests/e2e/owner-input/fixture.html?chat`);
    await openLayoutSession(page);
    const pane = page.locator('.item-detail');

    // A waiting item shows every quick reply as an option card immediately; "Write my own answer" opens the composer
    // below them (SPEC 5.3: the cards replace the old always-open composer with quick replies above it).
    await page.locator('[data-item-id="2"]').click();
    const options = pane.locator('[data-answer-option]');
    await expect(options).toHaveCount(2);
    const choices = pane.locator('.answer-options');
    await expect(choices).toBeVisible();
    await pane.locator('[data-answer-own]').click();
    const composer = pane.getByLabel('Reply in your own words');
    await expect(composer).toBeVisible();
    const composerBox = (await composer.boundingBox())!;
    for (const option of await options.all()) {
      await expect(option).toBeInViewport();
      const box = (await option.boundingBox())!;
      expect(box.y + box.height, 'quick reply above the composer').toBeLessThanOrEqual(composerBox.y);
    }

    // A closed item: its exchanges run oldest first, with no round headers, and no composer, only its revisit actions in the dock.
    await page.locator('[data-item-id="1"]').click();
    const turns = pane.locator('.detail-chat-list li[data-message-id]');
    await expect(turns).not.toHaveCount(0);
    const ids = await turns.evaluateAll(list => list.map(turn => turn.getAttribute('data-message-id')));
    expect(new Set(ids).size).toBe(ids.length);
    const chatText = await pane.getByRole('region', { name: 'Conversation' }).innerText();
    expect(chatText.indexOf('Second reply of the chat')).toBeLessThan(chatText.indexOf('Third reply of the chat'));
    const tops = await turns.evaluateAll(list => list.map(turn => turn.getBoundingClientRect().top));
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
    await expect(pane.getByRole('region', { name: 'Conversation' })).toContainText('Second reply of the chat');
    expect(await pane.innerText()).not.toMatch(/Round \d|Back and forth/);
    await expect(pane.getByRole('textbox')).toHaveCount(0);
    await expect(pane.locator('.answer')).toHaveCount(0);
    const dock = pane.locator('.detail-dock');
    await expect(dock.getByRole('region', { name: 'Revisit' })).toBeVisible();
    const [dockBox, paneBox] = [(await dock.boundingBox())!, (await pane.boundingBox())!];
    expect(dockBox.y + dockBox.height, 'revisit actions docked at the pane bottom').toBeGreaterThan(paneBox.y + paneBox.height - 2);
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});
