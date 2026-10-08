import { test, expect } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import type { Server } from 'node:http';

test('scrolls full variable tree rows with the session bar, setup and filters accessible', async ({ page }, testInfo) => {
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
    await page.setViewportSize({ width: 1000, height: 668 });
    await page.goto(`${origin}/tests/e2e/owner-input/fixture.html?largeTree`);
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
    // The connect card sits directly under the project header, above the Active list.
    await expect(page.getByRole('region', { name: 'Session setup' }).getByRole('button', { name: 'Copy instruction' })).toBeVisible();
    expect(await page.evaluate(() => {
      const card = document.querySelector('[aria-label="Session setup"]');
      const active = [...document.querySelectorAll('h3')].find(heading => heading.textContent?.startsWith('Active sessions · '));
      return !!card && !!active && !!(card.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING);
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
    await page.locator('button[data-session-id]').first().click();
    const tree = page.getByRole('tree'), setup = page.getByRole('region', { name: 'Session setup' });
    await expect(tree.locator('.tree-item')).toHaveCount(2000);
    // The connect card belongs to the project page; the session view does not carry it.
    await expect(setup).toHaveCount(0);
    const geometry = () => page.evaluate(() => {
      const rows = document.querySelector<HTMLElement>('.tree-scroll')!, center = document.querySelector<HTMLElement>('.shell-center')!;
      return { rowsHeight: rows.clientHeight, rowsScrollHeight: rows.scrollHeight, rowsScrollTop: rows.scrollTop,
        centerScrollTop: center.scrollTop, centerHeight: center.clientHeight, centerScrollHeight: center.scrollHeight,
        // The toolbar's offset under the session bar. The body never scrolls sideways, so opening the detail
        // column narrows the centre and the session bar may wrap; the toolbar must still sit right under it.
        toolbarGap: document.querySelector('.tree-filters')!.getBoundingClientRect().top - document.querySelector('.tree-session-bar')!.getBoundingClientRect().bottom,
        headerTop: document.querySelector('.shell-header')!.getBoundingClientRect().top };
    });
    const before = await geometry();
    await testInfo.attach('initial-tree-geometry', { body: JSON.stringify(before), contentType: 'application/json' });
    // At least one full variable-height row (about 64px) stays visible.
    const usefulRows = 64;
    expect(before.rowsHeight).toBeGreaterThan(usefulRows);
    const row = tree.locator('[data-item-id="10.50"]');
    await row.evaluate(element => element.scrollIntoView({ block: 'start' }));
    await row.click();
    await expect(row).toHaveAttribute('aria-selected', 'true');
    const after = await geometry();
    await testInfo.attach('tree-scroll-geometry', { body: JSON.stringify({ before, after }), contentType: 'application/json' });
    expect(after.rowsScrollTop).toBeGreaterThan(0);
    expect(after.rowsHeight).toBeGreaterThan(usefulRows);
    expect(after.rowsScrollHeight).toBeGreaterThan(after.rowsHeight);
    expect(after.centerScrollTop).toBe(0);
    expect(after.centerScrollHeight).toBeLessThanOrEqual(after.centerHeight + 1);
    expect(after.toolbarGap).toBe(before.toolbarGap);
    expect(after.headerTop).toBe(before.headerTop);
    await expect(page.getByRole('group', { name: 'Filter items' }).getByRole('button', { name: /\bOpen \d+$/ })).toBeInViewport();
    for (const viewport of [{ width: 1000, height: 668 }, { width: 900, height: 650 }]) {
      await page.setViewportSize(viewport);
      // The bar keeps Close session and the sending chip (details, Pause); connect lives on the project page.
      const bar = page.locator('.tree-session-bar');
      await expect(bar.getByRole('button', { name: 'Close session' })).toBeInViewport();
      for (const action of await bar.getByRole('button').all()) {
        await action.scrollIntoViewIfNeeded();
        await expect(action).toBeInViewport();
        expect(await action.evaluate(element => {
          const bounds = element.getBoundingClientRect();
          return document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.closest('button') === element;
        })).toBe(true);
        // Pause and Resume write at once; Close session and the sending details open a dialog to dismiss.
        // Pause and Resume are icon buttons: their name is the aria-label.
        const label = ((await action.getAttribute('aria-label')) ?? (await action.innerText())).trim();
        if (/Pause|Resume|Try again/.test(label)) continue;
        // Copy ID acts immediately without a dialog. This layout harness grants no clipboard permissions.
        if (label === 'Copy ID') {
          await expect(page.getByRole('dialog')).toHaveCount(0);
          continue;
        }
        // Rename opens its fields in the bar, not a dialog; Esc closes them and focus returns to the button.
        if (label === 'Rename') {
          await action.click();
          const field = bar.getByLabel('Session name');
          await expect(field).toBeInViewport();
          await page.keyboard.press('Escape');
          await expect(field).toHaveCount(0);
          continue;
        }
        await action.click();
        const review = page.getByRole('dialog');
        await expect(review).toBeInViewport();
        await review.getByRole('button', { name: label === 'Close session' ? 'Cancel' : 'Done', exact: true }).click();
        await expect(review).toHaveCount(0);
        await expect(action).toBeFocused();
      }
      const current = await geometry();
      expect(current.rowsHeight).toBeGreaterThan(usefulRows);
      expect(current.centerScrollTop).toBe(0);
      expect(current.centerScrollHeight).toBeLessThanOrEqual(current.centerHeight + 1);
      await expect(page.getByRole('group', { name: 'Filter items' }).getByRole('button', { name: /\bOpen \d+$/ })).toBeInViewport();
      const controls = await page.locator('.tree-filters').evaluate(element => [...element.querySelectorAll('button, input, select')].map(control => {
        const bounds = control.getBoundingClientRect();
        return { label: control.textContent || control.closest('label')?.textContent,
          reachable: document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.closest('button, input, select') === control };
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
    // Graph renders in the tree column under the session bar and owns its
    // scrolling there. Catalogue routes retain the centre pane scroller,
    // including complete setup content below the catalogue.
    await page.getByRole('button', { name: 'Graph', exact: true }).click();
    await expect(page.getByRole('tree', { name: / graph$/ }).first()).toBeVisible();
    expect(await page.locator('.graph-scroll').evaluate(element => getComputedStyle(element).overflowY)).toBe('auto');
    expect(await page.locator('.shell-center').evaluate(element => getComputedStyle(element).overflowY)).toBe('hidden');
    const graphBox = (await page.locator('.graph-scroll').boundingBox())!, centerBox = (await page.locator('.shell-center').boundingBox())!;
    expect(graphBox.y + graphBox.height).toBeLessThanOrEqual(centerBox.y + centerBox.height + 1);
    // Nothing in the session column is clipped: banners and controls shrink and scroll themselves.
    expect(await page.locator('.nav-session-content').evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
    await page.getByRole('navigation', { name: 'Projects and sessions' }).getByRole('button', { name: 'Projects', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
    await expect(setup).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});

test('keeps a sent answer between the item question and its timeline in the ordinary App', async ({ page }, testInfo) => {
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
    // All sessions lists only sessions with an open tab; a fresh App opens the
    // session from its project page.
    await page.locator('[data-shell-tab="projects"]').click();
    await page.locator('.pw-project-open').first().click();
    const session = page.locator('button[data-session-id]').first();
    await expect(session).toBeEnabled(); await session.click();
    await expect(page.locator('.tree-session-bar').getByRole('button', { name: 'Close session' })).toBeEnabled();
    await page.locator('[data-item-id="2"]').click();
    // The reference (head, delivery receipt, timeline) scrolls on top; the composer is docked below it.
    const detail = page.locator('.shell-detail-scroll'), head = detail.locator('.item-detail .detail-head');
    await expect(head.getByRole('heading', { name: 'Which native delivery window should we use?', level: 2 })).toBeVisible();
    await detail.getByLabel('Reply in your own words').fill('Use the saved native delivery option.');
    await detail.getByRole('button', { name: 'Send reply', exact: true }).click();
    // A sent answer becomes the delivery stepper on top, the reply joins the timeline, and the
    // reply ends the conversation as the owner's pending message. The fixture's session already
    // has a message in flight, so its status line says what the reply waits behind instead of
    // echoing it; that line sits with the pending message.
    const receipt = detail.getByRole('region', { name: 'Conversation' }).getByRole('status').filter({ hasText: 'Queued behind your message' });
    const sent = detail.getByRole('region', { name: 'Timeline' }).getByText('Use the saved native delivery option.');
    await expect(detail.getByRole('region', { name: 'Your answer' })).toContainText('Sending');
    await expect(receipt).toBeVisible(); await expect(sent).toBeAttached();
    await expect(detail.getByLabel('Reply in your own words')).toHaveCount(0);
    // The sent reply also ends the conversation, as the owner's pending message, after the timeline.
    const pending = detail.getByRole('region', { name: 'Conversation' }).locator('li[data-pending]').last();
    await expect(pending).toContainText('Use the saved native delivery option.');
    expect(await detail.evaluate(element => {
      const timeline = element.querySelector('[aria-label="Timeline"]')!, chat = element.querySelector('[aria-label="Conversation"]')!;
      return !!(timeline.compareDocumentPosition(chat) & Node.DOCUMENT_POSITION_FOLLOWING);
    })).toBe(true);
    // Check actual rectangles at the reported size, the supported minimum and
    // the wide workspace, including a shorter window that requires scrolling.
    for (const viewport of [{ width: 900, height: 650 }, { width: 1000, height: 700 }, { width: 1600, height: 960 }, { width: 1000, height: 500 }]) {
      await page.setViewportSize(viewport);
      await page.locator('.shell-body').evaluate(element => { element.scrollLeft = element.scrollWidth; });
      await sent.scrollIntoViewIfNeeded();
      await expect(sent).toBeInViewport();
      const headBox = (await head.boundingBox())!, receiptBox = (await receipt.boundingBox())!, sentBox = (await sent.boundingBox())!;
      expect(receiptBox.y, `receipt below the question at ${viewport.width}×${viewport.height}`).toBeGreaterThanOrEqual(headBox.y + headBox.height);
      expect(receiptBox.y, `pending message after the timeline reply at ${viewport.width}×${viewport.height}`).toBeGreaterThanOrEqual(sentBox.y + sentBox.height);
      for (const content of await head.locator('h2, .detail-status').all()) {
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
    await page.locator('[data-shell-tab="projects"]').click();
    await page.locator('.pw-project-open').first().click();
    const session = page.locator('button[data-session-id]').first();
    await expect(session).toBeEnabled(); await session.click();
    await expect(page.locator('.tree-session-bar').getByRole('button', { name: 'Close session' })).toBeEnabled();
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
    await page.locator('[data-shell-tab="projects"]').click();
    await page.locator('.pw-project-open').first().click();
    const session = page.locator('button[data-session-id]').first();
    await expect(session).toBeEnabled(); await session.click();
    await expect(page.locator('.tree-session-bar').getByRole('button', { name: 'Close session' })).toBeEnabled();
    const pane = page.locator('.item-detail');

    // A waiting item: its quick replies sit above the composer, which is the last thing in the dock.
    await page.locator('[data-item-id="2"]').click();
    const composer = pane.getByLabel('Reply in your own words');
    await expect(composer).toBeVisible();
    const options = pane.locator('.detail-dock [data-answer-option]');
    await expect(options).toHaveCount(2);
    const composerBox = (await composer.boundingBox())!;
    for (const option of await options.all()) {
      const box = (await option.boundingBox())!;
      expect(box.y + box.height, 'quick reply above the composer').toBeLessThanOrEqual(composerBox.y);
    }

    // A closed item: its exchanges run oldest first, with no round headers, and no composer, only its revisit actions in the dock.
    await page.locator('[data-item-id="1"]').click();
    const turns = pane.locator('.detail-chat-list li[data-round]');
    await expect(turns).toHaveCount(3);
    expect(await turns.evaluateAll(list => list.map(turn => turn.getAttribute('data-round')))).toEqual(['1', '2', '3']);
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
