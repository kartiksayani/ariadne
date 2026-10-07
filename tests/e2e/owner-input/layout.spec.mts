import { test, expect } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import type { Server } from 'node:http';

test('scrolls full variable sentence rows with history actions, setup and toolbar accessible', async ({ page }, testInfo) => {
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
    await page.locator('button[data-session-id]').first().click();
    const tree = page.getByRole('tree'), setup = page.getByRole('region', { name: 'Session setup' });
    await expect(tree.getByRole('treeitem')).toHaveCount(2000);
    await expect(setup.getByRole('heading', { name: 'Session connected' })).toBeVisible();
    const geometry = () => page.evaluate(() => {
      const rows = document.querySelector<HTMLElement>('.sentence-rows')!, center = document.querySelector<HTMLElement>('.shell-center')!;
      return { rowsHeight: rows.clientHeight, rowsScrollHeight: rows.scrollHeight, rowsScrollTop: rows.scrollTop,
        centerScrollTop: center.scrollTop, centerHeight: center.clientHeight, centerScrollHeight: center.scrollHeight,
        toolbarTop: document.querySelector('.sentence-filters')!.getBoundingClientRect().top,
        headerTop: document.querySelector('.shell-header')!.getBoundingClientRect().top };
    });
    const before = await geometry();
    await testInfo.attach('initial-tree-geometry', { body: JSON.stringify(before), contentType: 'application/json' });
    // At least one full variable-height row (about 64px) stays visible. JetBrains
    // Mono wraps the old status filters onto a third line at these widths (106px
    // of rows under the old proportional font at 1000x668, 87px now) until WP1's
    // filter chips land.
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
    expect(after.toolbarTop).toBe(before.toolbarTop);
    expect(after.headerTop).toBe(before.headerTop);
    await expect(page.getByRole('button', { name: 'Open', exact: true })).toBeInViewport();
    await expect(setup.getByRole('heading', { name: 'Session connected' })).toBeInViewport();
    for (const viewport of [{ width: 1000, height: 668 }, { width: 900, height: 650 }]) {
      await page.setViewportSize(viewport);
      const binding = page.locator('.lifecycle-binding');
      await binding.getByRole('button', { name: 'Pause dispatch', exact: true }).scrollIntoViewIfNeeded();
      await expect(binding.getByRole('button', { name: 'Pause dispatch', exact: true })).toBeInViewport();
      const history = page.getByRole('region', { name: 'History actions' });
      for (const action of [...await binding.getByRole('button').all(), ...await history.getByRole('button').all()]) {
        await action.scrollIntoViewIfNeeded();
        await expect(action).toBeInViewport();
        expect(await action.evaluate(element => {
          const bounds = element.getBoundingClientRect();
          return document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.closest('button') === element;
        })).toBe(true);
        await action.click();
        const review = page.getByRole('dialog');
        await expect(review).toBeInViewport();
        await review.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(review).toHaveCount(0);
        await expect(action).toBeFocused();
      }
      // A rectangle for the whole pre cannot prove the last instruction is
      // readable. Scroll its actual text range into this notice's viewport.
      const instruction = await setup.evaluate(element => {
        const node = element.querySelector('pre')!.firstChild!, range = document.createRange();
        range.setStart(node, node.textContent!.lastIndexOf('Setup step 30:'));
        range.setEnd(node, node.textContent!.length);
        element.scrollTop += range.getBoundingClientRect().top - element.getBoundingClientRect().top - element.clientHeight / 2;
        const line = range.getBoundingClientRect(), bounds = element.getBoundingClientRect();
        return { lineTop: line.top, lineBottom: line.bottom, top: bounds.top, bottom: bounds.bottom };
      });
      expect(instruction.lineTop).toBeGreaterThanOrEqual(instruction.top);
      expect(instruction.lineBottom).toBeLessThanOrEqual(instruction.bottom);
      const current = await geometry();
      expect(current.rowsHeight).toBeGreaterThan(usefulRows);
      expect(current.centerScrollTop).toBe(0);
      expect(current.centerScrollHeight).toBeLessThanOrEqual(current.centerHeight + 1);
      await expect(page.getByRole('button', { name: 'Open', exact: true })).toBeInViewport();
      const controls = await page.locator('.sentence-filters').evaluate(element => [...element.querySelectorAll('button, input, select')].map(control => {
        const bounds = control.getBoundingClientRect();
        return { label: control.textContent || control.closest('label')?.textContent,
          reachable: document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.closest('button, input, select') === control };
      }));
      expect(controls.filter(control => !control.reachable)).toEqual([]);
      const ordinary = tree.locator('[data-item-id="10.49"]');
      await ordinary.evaluate(element => element.scrollIntoView({ block: 'start' }));
      const completeRow = await ordinary.evaluate(element => {
        const bounds = element.getBoundingClientRect(), viewport = element.closest('.sentence-rows')!.getBoundingClientRect();
        return { height: bounds.height, top: bounds.top, bottom: bounds.bottom, viewportTop: viewport.top, viewportBottom: viewport.bottom };
      });
      expect(completeRow.height).toBeGreaterThan(40);
      expect(completeRow.top).toBeGreaterThanOrEqual(completeRow.viewportTop);
      expect(completeRow.bottom).toBeLessThanOrEqual(completeRow.viewportBottom);
    }
    // Session sizing ends with Tree mode. Other routes retain the centre pane
    // scroller, including complete setup content below the graph/catalogue.
    await page.getByRole('button', { name: 'Graph', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Topic graph' }).first()).toBeVisible();
    expect(await page.locator('.shell-center').evaluate(element => getComputedStyle(element).overflowY)).toBe('auto');
    await page.getByRole('navigation', { name: 'Projects and sessions' }).getByRole('button', { name: 'Projects', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
    await setup.evaluate(element => element.scrollIntoView({ block: 'end' }));
    expect(await page.locator('.shell-center').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});

test('keeps saved owner controls below complete history in the ordinary App', async ({ page }, testInfo) => {
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
    await expect(page.getByRole('button', { name: 'Pause dispatch' })).toBeEnabled();
    await page.locator('[data-item-id="2"]').click();
    const detail = page.locator('.shell-detail-scroll'), history = detail.locator('.item-history');
    await expect(history.getByRole('heading', { name: 'Which native delivery window should we use?', level: 3 })).toBeVisible();
    await detail.getByLabel('Reply in your own words').fill('Use the saved native delivery option.');
    await detail.getByRole('button', { name: 'Send answer', exact: true }).click();
    const receipt = detail.getByRole('status').filter({ hasText: 'Saved · Queue position' });
    const another = detail.getByRole('button', { name: 'Write another input' });
    await expect(receipt).toBeVisible(); await expect(another).toBeEnabled();
    // Check actual rectangles at the reported size, the supported minimum and
    // the wide workspace, including a shorter window that requires scrolling.
    for (const viewport of [{ width: 900, height: 650 }, { width: 1000, height: 700 }, { width: 1600, height: 960 }, { width: 1000, height: 500 }]) {
      await page.setViewportSize(viewport);
      await page.locator('.shell-body').evaluate(element => { element.scrollLeft = element.scrollWidth; });
      await another.scrollIntoViewIfNeeded();
      const historyBox = (await history.boundingBox())!, receiptBox = (await receipt.boundingBox())!, buttonBox = (await another.boundingBox())!;
      expect(receiptBox.y, `receipt below history at ${viewport.width}×${viewport.height}`).toBeGreaterThanOrEqual(historyBox.y + historyBox.height);
      expect(buttonBox.y, `button below receipt at ${viewport.width}×${viewport.height}`).toBeGreaterThanOrEqual(receiptBox.y + receiptBox.height);
      for (const content of await history.locator('h2, h3, .history-body, .history-options').all()) {
        const box = (await content.boundingBox())!;
        expect(box.y + box.height, `history content above receipt at ${viewport.width}×${viewport.height}`).toBeLessThanOrEqual(receiptBox.y);
      }
      if (viewport.width === 1000 && viewport.height === 700) await page.screenshot({ path: testInfo.outputPath('saved-answer.png') });
    }
    await another.click();
    await expect(detail.getByLabel('Reply in your own words')).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});
