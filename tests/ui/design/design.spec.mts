// Design fidelity harness: each handoff frame of Ariadne Mockups.dc.html beside
// the real DesktopApp in the same state. Writes coverage/design/<frame>-design.png,
// -app.png and -diff.png, a per-frame result that teardown.ts gathers into
// report.json, and fails a frame whose mismatch ratio exceeds thresholds.json.
import { test as base, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import { answerFrameIds, designNow, detailMask, detailMasked, dockFrameIds, frameNow, frameSpec, graphFrame, toastFrameIds, variantIds, type FrameSpec } from './frames';
import { handoffMembers, prefix, repo, sourceRoot } from './source.mts';
import thresholds from './thresholds.json' with { type: 'json' };
import { changeNames, interpretation, ownerWords } from './changes-fixture';

// Pixels whose channels differ by more than this count as mismatched.
const tolerance = 16;
const members = handoffMembers();
const served = resolve(sourceRoot, prefix);
const output = resolve(repo, 'coverage/design');
// Every frame that mounts the Ariadne component; ones without a fixture are skipped.
const designFrames = members['Ariadne Mockups.dc.html'].split('<div class="dv-opt" id="').slice(1)
  .filter(part => part.includes('<dc-import name="Ariadne"')).map(part => part.slice(0, part.indexOf('"')));
const requireRuntime = createRequire(resolve(repo, 'tests/ui/design/runtime/package.json'));
const runtimeFile = (name: string, file: string) => readFileSync(resolve(dirname(requireRuntime.resolve(`${name}/package.json`)), file));
const runtime: Record<string, Buffer> = {
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js': runtimeFile('react', 'umd/react.production.min.js'),
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js': runtimeFile('react-dom', 'umd/react-dom.production.min.js'),
  'https://unpkg.com/@babel/standalone@7.29.0/babel.min.js': runtimeFile('@babel/standalone', 'babel.min.js'),
};
const fontsCss = readFileSync(resolve(repo, 'apps/desktop/public/fonts/jetbrains-mono.css'), 'utf8');
const iconsCss = readFileSync(resolve(repo, 'apps/desktop/public/icons/phosphor.css'), 'utf8');
const phosphor = /^https:\/\/unpkg\.com\/@phosphor-icons\/web@2\.1\.1\/src\/(?:regular|fill)\/style\.css$/;
const contentTypes: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.md': 'text/markdown' };

const test = base.extend<Record<never, never>, { origin: string; designPage: Page }>({
  origin: [async ({ browserName }, use) => {
    expect(browserName).toBe('chromium');
    // support.js checks SRI on its CDN scripts; serve the same bytes offline.
    for (const [url, bytes] of Object.entries(runtime)) {
      const name = url.includes('react-dom') ? 'REACT_DOM' : url.includes('babel') ? 'BABEL' : 'REACT';
      const sri = members['support.js'].match(new RegExp(`var ${name}_SRI = "([^"]+)"`))?.[1];
      expect(`sha384-${createHash('sha384').update(bytes).digest('base64')}`, url).toBe(sri);
    }
    const server = await createServer({ configFile: false, root: repo, publicDir: resolve(repo, 'apps/desktop/public'), plugins: [react()], logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string') throw new Error('Missing design server address');
      await use(`http://127.0.0.1:${address.port}`);
    } finally { await server.close(); }
  }, { scope: 'worker' }],
  designPage: [async ({ browser, origin }, use) => {
    const context = await browser.newContext({ viewport: { width: 1700, height: 1000 }, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC',
      colorScheme: 'dark', reducedMotion: 'reduce' });
    const denied: string[] = [];
    await route(context, origin, denied);
    const page = await context.newPage();
    await page.clock.setFixedTime(designNow);
    await page.goto(`${origin}/source/${encodeURIComponent('Ariadne Mockups.dc.html')}`);
    await page.waitForFunction(() => {
      const cards = [...document.querySelectorAll('.dv-card')];
      return cards.length > 0 && cards.every(card => card.querySelector('.sc-host > *')) && !document.querySelector('.sc-placeholder, .sc-missing, .sc-logic-error, .sc-placeholder-error');
    }, null, { timeout: 180_000 });
    // Ariadne.dc.html:976 scrolls the selection at 400/1200/2500 ms after mount.
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => setTimeout(resolve, 2600)); });
    const inline = page.locator('[id="1c"] [data-inline-answer-ready]');
    await expect(inline).toHaveAttribute('data-inline-answer-ready', 'true');
    await expect(inline.locator('[data-item-id="2.1.1"]')).toHaveAttribute('aria-selected', 'true');
    await expect(inline.locator('[data-item-id="2.1.1"] textarea')).toHaveCount(1);
    expect(denied).toEqual([]);
    await use(page);
    await context.close();
  }, { scope: 'worker' }],
});

/** Serves the unzipped handoff at /source/, its CDN runtime, fonts and icons offline; blocks every other origin. */
async function route(context: BrowserContext, origin: string, denied: string[]) {
  await context.route('**/*', async request => {
    const url = request.request().url();
    if (runtime[url]) return request.fulfill({ body: runtime[url], contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' } });
    if (url.startsWith('https://fonts.googleapis.com/css2?family=JetBrains+Mono')) {
      return request.fulfill({ body: fontsCss.split('url("./').join(`url("${origin}/fonts/`), contentType: 'text/css' });
    }
    if (phosphor.test(url)) return request.fulfill({ body: iconsCss.split('url("./').join(`url("${origin}/icons/`), contentType: 'text/css' });
    const parsed = new URL(url);
    if (parsed.origin !== origin) { denied.push(url); return request.abort('blockedbyclient'); }
    if (parsed.pathname.startsWith('/source/')) {
      const file = resolve(served, decodeURIComponent(parsed.pathname.slice('/source/'.length)));
      if (!file.startsWith(served + sep) || !existsSync(file)) return request.fulfill({ status: 404, body: '' });
      return request.fulfill({ body: readFileSync(file), contentType: contentTypes[extname(file)] ?? 'application/octet-stream' });
    }
    return request.continue();
  });
}

async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(resolve => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), 300));
  });
}

/** Opens the frame in the app and puts it in the frame's state. */
async function openApp(page: Page, origin: string, spec: FrameSpec) {
  // Every app-only frame uses the same offline source harness as reference captures.
  // In particular M2 does not request designPage, which has its own routed context.
  const denied: string[] = [];
  await route(page.context(), origin, denied);
  await page.setViewportSize({ width: spec.width, height: spec.height });
  await page.clock.setFixedTime(frameNow(spec));
  const params = new URLSearchParams({ frame: spec.id, theme: spec.theme });
  await page.goto(`${origin}/tests/ui/design/gallery.html?${params}`);
  await page.waitForFunction(() => (window as { __designError?: string }).__designError
    || /\d+ items/.test(document.querySelector('.shell-summary')?.textContent ?? ''), null, { timeout: 60_000 });
  expect(await page.evaluate(() => (window as { __designError?: string }).__designError)).toBeUndefined();
  await expect(page.locator('html')).toHaveAttribute('data-theme', spec.theme);
  if (spec.state !== 'loading') await expect(page.getByText(/^(Loading|Opening)\b/)).toHaveCount(0, { timeout: 30_000 });
  else await expect(page.getByText(/^Reading the session…/).first()).toBeVisible();
  const row = (id?: string) => id ? page.locator(`[data-item-id="${id}"]`) : page.locator('[data-item-id]').first();
  // The prototype folds these topics on load (Ariadne.dc.html:940); the app keeps topic folds local.
  for (const name of spec.collapseTopics ?? []) {
    const topic = page.locator(`[role="treeitem"][aria-label="${name}"]`);
    // Hovering a band shows its actions, which re-wrap narrow bands; a dispatched click leaves no hover behind.
    await topic.locator('.tree-chevron').dispatchEvent('click');
    await expect(topic).toHaveAttribute('aria-expanded', 'false');
  }
  // The reveal scenario (Ariadne.dc.html:938): an item route, as a notification opens one, lands outside the Waiting filter.
  if (spec.scenario === 'reveal') {
    await page.evaluate(itemId => {
      const fixture = (window as unknown as { __designFixture: { route: object; transport: { emit: (event: string, hint: object) => void } } }).__designFixture;
      fixture.transport.emit('ariadne://route', { ...fixture.route, item_id: itemId });
    }, spec.selected!);
    await expect(page.getByText('Showing an item outside your current filters.')).toBeVisible();
  }
  let answerTop: number | null = null;
  if (spec.answering) {
    await settle(page);
    await row(spec.answering).focus();
    answerTop = await row(spec.answering).evaluate(element => element.getBoundingClientRect().top);
    if (!spec.detail) await page.keyboard.press('Escape');
    await page.keyboard.press('a');
    await expect(page.locator(`[data-item-id="${spec.answering}"] .answer`)).toBeVisible();
  }
  // open-mode opens the reply or follow-up box; r opens either (Ariadne.dc.html:1490). The frame draws it unfocused.
  if (spec.openMode) {
    await row(spec.selected).first().focus(); await page.keyboard.press('r');
    await page.locator('.detail-box textarea').waitFor();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  }
  if (graphFrame(spec)) {
    await row(spec.selected).focus();
    if (spec.selected && !spec.detail) await page.keyboard.press('Escape');
    await page.keyboard.press('g');
  }
  await settle(page);
  if (spec.answering) {
    const selected = row(spec.answering);
    await expect(selected).toHaveAttribute('aria-selected', 'true');
    if (!spec.detail) await expect(page.locator('.shell-detail')).toHaveCount(0);
    // Closing detail and opening the inline answer keep the owner's reading position: the answered row
    // stays where it was on screen. scrollTop may change, since rows above re-wrap when the Map widens.
    expect(await selected.evaluate(element => element.getBoundingClientRect().top)).toBe(answerTop);
  }
  const sessionBar = page.locator('.tree-session-bar');
  if (await sessionBar.count()) {
    await expect(sessionBar.getByRole('button', { name: 'Session actions' })).toBeVisible();
    await expect(sessionBar.getByRole('button', { name: 'Close session' })).toHaveCount(0);
    await expect(sessionBar.locator('.tree-session-meta')).toHaveText(/^\d+ topics?$/);
  }
  const filters = page.getByRole('group', { name: 'Filter items' });
  if (await filters.count()) {
    await expect(filters.getByRole('button', { name: /^Filter/ })).toBeVisible();
    await expect(filters.getByRole('combobox')).toHaveCount(0);
  }
  if (graphFrame(spec)) {
    await expect(page.locator('.tree-selected-edge')).toHaveCount(0);
  } else if (await page.locator('.tree-scroll').count()) {
    await expect(page.locator('.tree-filters > .tree-selected-slot')).toHaveCount(1);
    await expect(page.locator('.tree-scroll-shell .tree-selected-slot, .tree-scroll-shell .tree-selected-edge')).toHaveCount(0);
  }
  await expect(page.locator('.pw-rail')).toHaveCount(0);
  await expect(page.locator('.session-activity')).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Session activity', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Messages (m)', exact: true })).toHaveCount(0);
  expect(denied).toEqual([]);
}

/** Check actual wrapped boxes; text assertions alone cannot detect clipped change cards. */
async function changesFit(surface: Locator) {
  await expect(surface).toBeVisible();
  const layout = await surface.evaluate(element => {
    const card = element.getBoundingClientRect();
    return { overflow: element.scrollWidth - element.clientWidth,
      children: [...element.querySelectorAll('.change-name, .change-read-as, .brief-text, .change-comparison, .since-seen')].map(child => {
        const rect = child.getBoundingClientRect();
        return { text: child.textContent, left: rect.left - card.left, right: rect.right - card.right,
          overflow: child.scrollWidth - child.clientWidth };
      }) };
  });
  expect(layout.overflow, 'change surface does not scroll horizontally').toBeLessThanOrEqual(1);
  for (const child of layout.children) {
    expect(child.left, `${child.text} starts inside its card`).toBeGreaterThanOrEqual(-1);
    expect(child.right, `${child.text} ends inside its card`).toBeLessThanOrEqual(1);
    expect(child.overflow, `${child.text} wraps instead of clipping`).toBeLessThanOrEqual(1);
  }
}

async function compactCompare(surface: Locator) {
  const control = surface.getByRole('button', { name: 'Show before and after', exact: true }).first();
  await control.scrollIntoViewIfNeeded();
  await expect(control).toHaveAttribute('title', 'Show before and after');
  await expect(control).toHaveAttribute('aria-expanded', 'false');
  // The bundled Phosphor subset has no compare glyph, so the control draws one inline SVG icon.
  await expect(control.locator('svg')).toHaveCount(1);
  await expect(control).toHaveText('');
  const measure = () => control.evaluate(element => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return { width: rect.width, height: rect.height, color: style.color, background: style.backgroundColor };
  });
  const closed = await measure();
  expect(closed.width).toBeGreaterThanOrEqual(24); expect(closed.width).toBeLessThanOrEqual(32);
  expect(closed.height).toBeGreaterThanOrEqual(24); expect(closed.height).toBeLessThanOrEqual(32);
  await control.click();
  await expect(control).toHaveAttribute('aria-expanded', 'true');
  const comparison = surface.page().locator(`[id="${await control.getAttribute('aria-controls')}"]`);
  await expect(comparison).toBeVisible();
  await expect(comparison.locator('del').first()).toBeVisible();
  await expect(comparison.locator('mark').first()).toBeVisible();
  const opened = await measure();
  expect(opened.width).toBe(closed.width); expect(opened.height).toBe(closed.height);
  expect(opened.color).not.toBe(closed.color); expect(opened.background).not.toBe(closed.background);
  await changesFit(surface);
  return opened;
}

for (const theme of ['dark', 'light'] as const) {
  test(`M2 typed answer names and uniform compact comparisons (${theme})`, async ({ page, origin }, testInfo) => {
    await openApp(page, origin, { ...frameSpec('changes-typed'), theme });
    const answer = page.getByRole('region', { name: 'What your answer changed', exact: true });
    await answer.scrollIntoViewIfNeeded();
    await expect(answer.locator('.change-owner-words')).toHaveText(ownerWords);
    await expect(answer.locator('.change-read-as')).toHaveText(interpretation);
    const words = await answer.locator('.change-owner-words').boundingBox(), read = await answer.locator('.change-read-as').boundingBox();
    expect(words).not.toBeNull(); expect(read).not.toBeNull();
    expect(words!.y + words!.height).toBeLessThanOrEqual(read!.y);
    expect(await answer.locator('.change-owner-words').evaluate(element => getComputedStyle(element).whiteSpace)).toBe('pre-wrap');
    await expect(answer.locator('.change-name')).toHaveText(changeNames.slice(0, 5));
    await expect(answer.getByRole('heading', { name: 'New', exact: true })).toHaveCount(0);
    await answer.getByRole('button', { name: 'and 3 more: 3 new', exact: true }).click();
    await expect(answer.locator('.change-name')).toHaveText(changeNames);
    await expect(answer.getByRole('heading', { name: 'New', exact: true })).toBeVisible();
    await changesFit(answer);
    const answerControl = await compactCompare(answer);
    const current = page.getByRole('region', { name: 'What changed', exact: true });
    const currentControl = await compactCompare(current);
    await page.locator('.change-history > summary').click();
    const older = page.locator('.change-history-entry').first();
    await expect(older).toContainText('Rewording');
    const historyControl = await compactCompare(older);
    const since = page.getByRole('region', { name: 'Since you were here', exact: true });
    await since.getByRole('button', { name: /^Since you were here ·/ }).click();
    const sinceCard = since.locator('.since-card').filter({ has: page.getByRole('button', { name: 'Retry schedule', exact: true }) });
    const sinceControl = await compactCompare(sinceCard);
    expect([currentControl, historyControl, sinceControl]).toEqual([answerControl, answerControl, answerControl]);
    await testInfo.attach(`changes-comparisons-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
  });

  test(`M2 chosen answer and attributed topic lists (${theme})`, async ({ page, origin }, testInfo) => {
    await openApp(page, origin, { ...frameSpec('changes-choice'), theme });
    const answer = page.getByRole('region', { name: 'What your answer changed', exact: true });
    await answer.scrollIntoViewIfNeeded();
    await expect(answer).toContainText('Because you chose Keep retries quiet:');
    await expect(answer.locator('.change-owner-words, .change-read-as')).toHaveCount(0);
    await changesFit(answer);
    const brief = page.getByRole('region', { name: 'Topic brief', exact: true });
    await brief.scrollIntoViewIfNeeded();
    await expect(brief.locator('.brief-attribution')).toContainText('By the agent · as of');
    await expect(brief.locator('time')).toHaveAttribute('datetime', '2026-10-07T15:02:00.000Z');
    await expect(brief.locator('.brief-list').nth(0).locator('.change-name')).toHaveText(['Recovery policy']);
    await expect(brief.locator('.brief-list').nth(1).locator('.change-name')).toHaveText(['Recovery question']);
    const replaced = brief.locator('.brief-list').nth(2);
    await expect(replaced.locator('del')).toHaveText('Old retry policy');
    await expect(replaced).toContainText('replaced by Recovery policy');
    expect(await replaced.locator('del').evaluate(element => getComputedStyle(element).textDecorationLine)).toContain('line-through');
    const columns = await brief.locator('.brief-list').evaluateAll(elements => elements.map(element => ({
      label: element.querySelector('strong')!.getBoundingClientRect().x, links: element.querySelector('ul')!.getBoundingClientRect().x,
    })));
    expect(new Set(columns.map(column => column.label)).size).toBe(1);
    expect(new Set(columns.map(column => column.links)).size).toBe(1);
    await changesFit(brief);
    await testInfo.attach(`changes-brief-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
  });

  test(`M2 Since cards acknowledge Seen before leaving (${theme})`, async ({ page, origin }) => {
    await openApp(page, origin, { ...frameSpec('changes-typed'), theme });
    const since = page.getByRole('region', { name: 'Since you were here', exact: true });
    await since.getByRole('button', { name: /^Since you were here ·/ }).click();
    const card = since.locator('.since-card').filter({ has: page.getByRole('button', { name: 'Retry schedule', exact: true }) });
    await changesFit(card);
    await card.getByRole('button', { name: 'Seen', exact: true }).click();
    await expect(card.getByRole('button', { name: '✓ Seen', exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: '✓ Seen', exact: true })).toBeDisabled();
    await expect(card).toHaveCount(0, { timeout: 6000 });
    await expect(page.locator('[data-item-id="3.9"]')).toContainText('Recovery question');
  });

  test(`M2 long absence puts the brief first and offers reversible catch-up (${theme})`, async ({ page, origin }, testInfo) => {
    await openApp(page, origin, { ...frameSpec('changes-away'), theme });
    const brief = page.getByRole('region', { name: 'Topic brief', exact: true });
    const since = page.getByRole('region', { name: 'Since you were here', exact: true });
    await expect(since).toContainText('8 changes while you were away');
    await expect(since.locator('.since-card')).toHaveCount(0);
    const briefBox = await brief.boundingBox(), sinceBox = await since.boundingBox();
    expect(briefBox).not.toBeNull(); expect(sinceBox).not.toBeNull();
    expect(briefBox!.y + briefBox!.height).toBeLessThan(sinceBox!.y);
    await changesFit(brief); await changesFit(since);
    await since.getByRole('button', { name: 'Mark all seen', exact: true }).click();
    await expect(since).toContainText('All caught up');
    await since.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(since).toContainText('8 changes while you were away');
    await expect(brief.locator('.brief-list').nth(1).locator('.change-name')).toHaveText(['Recovery question']);
    await testInfo.attach(`changes-away-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
  });
}

/** Pixel diff in the browser canvas: mismatch ratio and a diff image (mismatches red over the dimmed app). */
async function compare(page: Page, design: Buffer, app: Buffer, regions: readonly Region[] = [], mask: Region | null = null) {
  return page.evaluate(async ({ design, app, tolerance, regions, mask }) => {
    const load = (base64: string) => new Promise<HTMLImageElement>((done, fail) => {
      const image = new Image(); image.onload = () => done(image); image.onerror = fail; image.src = `data:image/png;base64,${base64}`;
    });
    const [left, right] = await Promise.all([load(design), load(app)]);
    const width = Math.max(left.width, right.width), height = Math.max(left.height, right.height);
    const pixels = (image: HTMLImageElement) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0); return context.getImageData(0, 0, width, height).data;
    };
    const a = pixels(left), b = pixels(right), canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d')!, out = context.createImageData(width, height);
    let mismatched = 0;
    const inRegion = regions.map(() => 0);
    for (let index = 0; index < a.length; index += 4) {
      const x = (index / 4) % width, y = Math.floor(index / 4 / width);
      // A masked region is left out of the ratio (the frame's full area still divides it) and shown tinted blue in the diff.
      if (mask && x >= mask.x && x < mask.x + mask.width && y >= mask.y && y < mask.y + mask.height) {
        out.data.set([b[index] * 0.3, b[index + 1] * 0.3 + 24, b[index + 2] * 0.3 + 64, 255], index);
        continue;
      }
      const differs = [0, 1, 2, 3].some(channel => Math.abs(a[index + channel] - b[index + channel]) > tolerance);
      if (differs) {
        mismatched++;
        regions.forEach((region, at) => { if (x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height) inRegion[at]++; });
        out.data.set([255, 0, 64, 255], index);
      } else out.data.set([b[index] * 0.3, b[index + 1] * 0.3, b[index + 2] * 0.3, 255], index);
    }
    context.putImageData(out, 0, 0);
    return { ratio: mismatched / (width * height), regions: regions.map((region, at) => inRegion[at] / Math.max(1, region.width * region.height)), width, height,
      png: canvas.toDataURL('image/png').split(',')[1] };
  }, { design: design.toString('base64'), app: app.toString('base64'), tolerance, regions, mask });
}
interface Region { readonly name: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number }

test.describe.configure({ mode: 'parallel' });
/** Stable identity works even though reference rows no longer print their item numbers. */
const designRow = (designPage: Page, card: string, itemId: string) => designPage.locator(`[id="${card}"] .dv-card [role="treeitem"][data-item-id="${itemId}"]`).first();

for (const id of [...designFrames, ...variantIds]) {
  test(`frame ${id}`, async ({ page, origin, designPage }) => {
    let spec: FrameSpec;
    try { spec = frameSpec(id); } catch (error) { test.skip(true, (error as Error).message); return; }
    const card = spec.design ?? id;
    const denied: string[] = [];
    await route(page.context(), origin, denied);
    await openApp(page, origin, spec);
    await expect(designPage.locator(`[id="${card}"] aside[aria-label="Messages"]`)).toHaveCount(0);
    // The pointer rests on a row in both: the prototype's hoverItem and the app's :hover. Moved off again after the capture.
    if (spec.hoverItem) {
      await designRow(designPage, card, spec.hoverItem).hover();
      await page.locator(`.tree-item[data-item-id="${spec.hoverItem}"]`).hover();
      await settle(page); await settle(designPage);
    }
    try { await capture(page, designPage, spec, id, card, denied); } finally { if (spec.hoverItem) await designPage.mouse.move(0, 0); }
  });
}

for (const width of [1920, 1600, 1280]) for (const acceptedFailure of [false, true]) {
  test(`${acceptedFailure ? 'delivered-stopped' : 'failed-delivery'} layout at ${width}px`, async ({ page, origin }) => {
    const denied: string[] = [];
    await route(page.context(), origin, denied);
    await openApp(page, origin, { ...frameSpec(acceptedFailure ? 'delivery-stopped' : '1m'), width });
    for (const selector of ['.tree-item[data-item-id="3.1"]', '.shell-detail-scroll']) {
      const note = page.locator(`${selector} .stuck-note[data-stuck="${acceptedFailure ? 'stopped' : 'decision'}"]`).first();
      await expect(note).toBeVisible();
      await expect(note.locator(':scope > [role="status"]')).toContainText(acceptedFailure ? 'got your message but stopped before answering' : 'Couldn’t deliver');
      await expect(note.getByRole('button', { name: acceptedFailure ? 'Send again' : 'Retry', exact: true })).toBeVisible();
      const layout = await note.evaluate(element => {
        const status = element.querySelector<HTMLElement>(':scope > [role="status"]')!;
        const actions = element.querySelector<HTMLElement>(':scope > .stuck-actions')!;
        const words: { word: string; lines: number }[] = [];
        const textNodes = document.createTreeWalker(status, NodeFilter.SHOW_TEXT);
        for (let text = textNodes.nextNode(); text; text = textNodes.nextNode()) {
          for (const word of text.textContent!.matchAll(/\S+/g)) {
            const range = document.createRange();
            range.setStart(text, word.index); range.setEnd(text, word.index + word[0].length);
            words.push({ word: word[0], lines: range.getClientRects().length });
          }
        }
        const box = (node: Element) => {
          const { x, y, width, right, bottom } = node.getBoundingClientRect();
          return { x, y, width, right, bottom };
        };
        return { note: box(element), status: box(status), actions: box(actions), words, nestedText: status.childElementCount,
          buttons: [...actions.querySelectorAll('button')].map(box) };
      });
      // Enough room for ordinary words: recovery controls must never squeeze the reason to a sliver.
      expect(layout.status.width, `${selector} status width`).toBeGreaterThanOrEqual(190);
      expect(layout.nestedText, 'the complete explanation is plain sentence text').toBe(0);
      if (selector.startsWith('.tree-item')) expect(layout.status.x, 'reason uses the existing body column').toBe(layout.note.x);
      expect(layout.words.map(word => word.word)).toEqual((await note.locator(':scope > [role="status"]').textContent())!.match(/\S+/g));
      for (const word of layout.words) expect(word.lines, `${selector}: ${word.word}`).toBe(1);
      // Controls can sit beside the reason when they fit, or wrap completely below it.
      const beside = layout.actions.x >= layout.status.right;
      if (!acceptedFailure && width === 1920 && selector.startsWith('.tree-item')) expect(beside).toBe(true);
      if (beside) {
        expect(layout.actions.y).toBeLessThan(layout.status.bottom);
        expect(layout.actions.bottom).toBeGreaterThan(layout.status.y);
      } else expect(layout.actions.y).toBeGreaterThanOrEqual(layout.status.bottom);
      for (const button of layout.buttons) {
        expect(button.x).toBeGreaterThanOrEqual(layout.note.x - 0.5);
        expect(button.right).toBeLessThanOrEqual(layout.note.right + 0.5);
      }
    }
    expect(denied).toEqual([]);
  });
}

for (const theme of ['light', 'dark'] as const) test(`Map names and top-line status keep their layout on hover in ${theme}`, async ({ page, origin }) => {
  const denied: string[] = [];
  await route(page.context(), origin, denied);
  await openApp(page, origin, { ...frameSpec('1a'), theme });
  const root = page.locator('.tree-item.tree-item-root').first(), child = page.locator('.tree-item.tree-item-child').first();
  await expect(page.locator('.tree-id')).toHaveCount(0);
  await expect(root.locator('.tree-top-colour')).toHaveCount(1);
  await expect(child.locator('.tree-top-colour')).toHaveCount(0);
  const heading = root.locator('.tree-heading'), title = root.locator('.tree-question'), status = heading.locator('.tree-row-status');
  await expect(status).toBeVisible();
  const titleBefore = await title.boundingBox(), statusBefore = await status.boundingBox();
  expect(statusBefore!.y).toBeLessThan(titleBefore!.y + titleBefore!.height);
  const topicColour = await page.locator('.tree-topic-name').first().evaluate(element => {
    const probe = document.createElement('span');
    probe.style.color = element.hasAttribute('data-earlier') ? 'color-mix(in srgb, var(--a-acc-text) 82%, transparent)' : 'var(--a-acc-text)';
    element.append(probe);
    const expected = getComputedStyle(probe).color, actual = getComputedStyle(element).color;
    probe.remove(); return { actual, expected };
  });
  expect(topicColour.actual).toBe(topicColour.expected);
  await root.hover();
  expect(await title.boundingBox()).toEqual(titleBefore);
  expect(await status.boundingBox()).toEqual(statusBefore);
  expect(denied).toEqual([]);
});

for (const theme of ['light', 'dark'] as const) test(`Getting around preserves the Map while peeking and focusing in ${theme}`, async ({ page, origin }) => {
  const denied: string[] = [];
  await route(page.context(), origin, denied);
  await openApp(page, origin, { ...frameSpec('1a'), theme });
  const root = page.locator('.tree-item.tree-item-root').first(), scroller = page.locator('.tree-scroll');
  const sourceId = await root.getAttribute('data-item-id');
  await root.click();
  const detail = page.locator('.item-detail');
  await expect(detail).toHaveAttribute('data-detail-item-id', sourceId!);
  const fullTitle = await detail.locator('.detail-question').getAttribute('title');
  const before = await scroller.evaluate(element => element.scrollTop);
  await root.focus();
  await page.keyboard.press('Space');
  const peek = page.getByRole('dialog', { name: /^Peek:/ });
  await expect(peek).toBeVisible();
  const heading = peek.getByRole('heading', { level: 2 });
  await expect(heading).toHaveText(fullTitle!);
  await expect(heading).toHaveCSS('white-space', 'pre-wrap');
  expect(await heading.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(peek.getByRole('button', { name: 'Copy reference' })).toBeVisible();
  await expect(peek.getByRole('button', { name: 'Go to' })).toBeVisible();
  const box = (await peek.boundingBox())!, chrome = (await page.locator('.shell-header').boundingBox())!, viewport = page.viewportSize()!;
  expect(box.y).toBeGreaterThanOrEqual(chrome.y + chrome.height);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  await page.keyboard.press('Escape');
  await expect(root).toBeFocused();
  expect(await scroller.evaluate(element => element.scrollTop)).toBe(before);
  const waiting = await page.locator('[data-waiting-item]').count();
  await root.getByRole('button', { name: /^Focus on / }).click();
  await expect(page.getByText(/^Focused:/)).toBeVisible();
  expect(await page.locator('[data-waiting-item]').count()).toBe(waiting);
  await expect(page.locator(`.tree-item-root:not([data-item-id="${sourceId}"])`)).toHaveCount(0);
  await page.getByRole('button', { name: 'Leave Focus' }).click();
  await page.keyboard.press('Meta+e');
  const recent = page.getByRole('dialog', { name: 'Recent items' });
  await expect(recent).toBeVisible();
  await recent.getByRole('button', { name: 'Changed only' }).click();
  await expect(recent.getByRole('button', { name: 'Changed only' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  const crumbs = (await page.getByRole('navigation', { name: 'Map ancestors' }).boundingBox())!, rows = (await scroller.boundingBox())!;
  expect(crumbs.y + crumbs.height).toBeLessThanOrEqual(rows.y + 1);
  expect(denied).toEqual([]);
});

test('a long waiting conversation opens at its latest ask and keeps the question visible', async ({ page, origin }) => {
  const denied: string[] = [];
  await route(page.context(), origin, denied);
  await openApp(page, origin, { ...frameSpec('1u'), width: 1400, height: 830 });
  const pane = page.locator('.item-detail'), body = pane.locator('.detail-body'), head = body.locator('.detail-head');
  await expect(body.locator('.detail-turn-now .detail-waiting-tag')).toBeInViewport();
  await expect(head.locator('.detail-question')).toBeInViewport();
  await expect(head.locator('.detail-badge')).toBeInViewport();
  await expect(head.locator('.detail-question')).toHaveAttribute('title', /\S+/);
  expect(await body.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(head.locator('.detail-question')).toBeInViewport();
  await expect(head.locator('.detail-badge')).toBeInViewport();
  await head.getByRole('button', { name: 'Expand title', exact: true }).click();
  await expect(head.getByRole('button', { name: 'Collapse title', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(head.locator('.detail-meta')).toBeVisible();
  expect(denied).toEqual([]);
});

const conversationSizes = [{ width: 1280, height: 800 }, { width: 900, height: 650 }] as const;

for (const theme of ['dark', 'light'] as const) for (const viewport of conversationSizes) {
  const id = `conversation-${theme}-${viewport.width}x${viewport.height}`;
  test(`frame ${id}`, async ({ page, origin }, testInfo) => {
    await openApp(page, origin, { ...frameSpec('1u'), ...viewport, theme });
    const unfold = page.getByRole('button', { name: /^Show Waiting on me/ });
    if (await unfold.count()) await unfold.click();
    await page.getByRole('button', { name: 'Open the conversation in a bigger view', exact: true }).click();
    const conversation = page.getByRole('region', { name: 'Item conversation', exact: true });
    await expect(conversation).toBeVisible();
    await expect(conversation.getByRole('button', { name: 'Back to Map', exact: true })).toBeInViewport();
    const pane = conversation.locator('.item-detail.item-conversation'), body = pane.locator('.detail-body'), dock = pane.locator('.detail-dock');
    await expect(page.locator('.item-detail')).toHaveCount(1);
    await expect(page.locator('.shell-detail .detail-body')).toHaveCount(0);
    await expect(page.locator('.shell-center')).toHaveAttribute('inert', '');
    await expect(page.locator('.shell-detail')).toHaveAttribute('inert', '');
    const turns = pane.locator('.detail-chat-list > li[data-message-id]');
    const messages = await turns.evaluateAll(elements => elements.map(element => element.getAttribute('data-message-id')!));
    expect(messages.length, 'the fixture contains several conversation turns').toBeGreaterThan(3);
    expect(new Set(messages).size, 'each message appears once').toBe(messages.length);
    // The fixture's zero-padded message IDs encode their original message numbers.
    expect(messages, 'messages read oldest first').toEqual([...messages].sort());
    await expect(turns.first()).toBeInViewport();
    const pin = dock.locator('.conversation-pin');
    await expect(pin.getByRole('heading', { name: /^Your turn ·/ })).toBeInViewport();
    await expect(pin.locator('p').first()).toBeInViewport();
    await expect(dock.getByRole('textbox', { name: 'Reply in your own words', exact: true })).toBeAttached();
    await expect(dock.locator('[data-answer-option]')).not.toHaveCount(0);
    await settle(page);
    const geometry = await pane.evaluate(element => {
      const pane = element.getBoundingClientRect(), body = element.querySelector('.detail-body')!.getBoundingClientRect();
      const dock = element.querySelector('.detail-dock')!.getBoundingClientRect();
      return { body: body.height / pane.height, dock: dock.height / pane.height,
        bodyBottom: body.bottom, dockTop: dock.top, dockBottom: dock.bottom, paneBottom: pane.bottom };
    });
    expect(geometry.body, 'the transcript keeps most of the conversation pane').toBeGreaterThanOrEqual(0.55);
    expect(geometry.dock, 'the answer footer uses at most 40% of the pane').toBeLessThanOrEqual(0.40);
    expect(geometry.bodyBottom).toBeLessThanOrEqual(geometry.dockTop + 1);
    expect(geometry.dockBottom).toBeCloseTo(geometry.paneBottom, 0);
    const overlayBox = (await conversation.boundingBox())!, waitingBox = (await page.locator('.shell-waiting').boundingBox())!;
    const tabs = (await page.locator('.shell-tabs').boundingBox())!, footer = (await page.locator('.shell-footer').boundingBox())!;
    expect(overlayBox.x, 'Waiting stays beside the bigger conversation').toBeGreaterThanOrEqual(waitingBox.x + waitingBox.width - 1);
    expect(overlayBox.y).toBeGreaterThanOrEqual(tabs.y + tabs.height - 1);
    expect(overlayBox.x + overlayBox.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(overlayBox.y + overlayBox.height).toBeLessThanOrEqual(footer.y + 1);
    await page.screenshot({ path: testInfo.outputPath(`${id}.png`), animations: 'disabled' });
    expect(await body.evaluate(element => element.scrollHeight > element.clientHeight), 'the long transcript scrolls').toBe(true);
    const footerBefore = await dock.boundingBox(), pinBefore = await pin.boundingBox();
    await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await settle(page);
    expect(await dock.boundingBox(), 'scrolling messages keeps the answer footer pinned').toEqual(footerBefore);
    expect(await pin.boundingBox(), 'the waiting question stays with its answer controls').toEqual(pinBefore);
    // A capped footer scrolls internally: every answer remains reachable without moving the chat.
    const chatScroll = await body.evaluate(element => element.scrollTop);
    for (const option of await dock.locator('[data-answer-option]').all()) {
      await option.scrollIntoViewIfNeeded(); await expect(option).toBeInViewport();
    }
    const ownWords = dock.getByRole('textbox', { name: 'Reply in your own words', exact: true });
    await ownWords.scrollIntoViewIfNeeded(); await expect(ownWords).toBeInViewport();
    expect(await body.evaluate(element => element.scrollTop)).toBe(chatScroll);
  });
}

for (const viewport of conversationSizes) test(`owner input keeps the Map reading position through conversation and Waiting at ${viewport.width}x${viewport.height}`, async ({ page, origin }) => {
  await openApp(page, origin, { ...frameSpec('1b'), ...viewport });
  const unfold = page.getByRole('button', { name: /^Show Waiting on me/ });
  if (await unfold.count()) await unfold.click();
  const scroller = page.locator('.tree-scroll'), reading = page.locator('[data-item-id="3.1"]');
  await reading.click();
  await expect(reading).toHaveAttribute('aria-selected', 'true');
  await reading.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await settle(page);
  const mapNode = await scroller.elementHandle(), rowNode = await reading.elementHandle();
  const position = async () => ({ top: await reading.evaluate(element => element.getBoundingClientRect().top),
    scroll: await scroller.evaluate(element => element.scrollTop),
    selected: await page.locator('.tree-item[aria-selected="true"]').getAttribute('data-item-id') });
  const before = await position();
  expect(before.scroll, 'the owner starts partway through the Map').toBeGreaterThan(0);
  await expect(reading).toBeInViewport();
  const unchanged = async () => {
    await settle(page);
    expect(await position()).toEqual(before);
    expect(await scroller.evaluate((element, original) => element === original, mapNode), 'the same Map stays mounted').toBe(true);
    expect(await reading.evaluate((element, original) => element === original, rowNode), 'the reading row stays mounted').toBe(true);
  };
  await page.getByRole('button', { name: 'Open the conversation in a bigger view', exact: true }).click();
  const conversation = page.getByRole('region', { name: 'Item conversation', exact: true });
  await expect(conversation.locator('.item-conversation')).toHaveAttribute('data-detail-item-id', '3.1');
  await unchanged();
  await expect(page.locator('.shell-center')).toHaveAttribute('inert', '');
  await expect(page.locator('.shell-detail .item-detail')).toHaveCount(0);
  const waiting = page.locator('[data-waiting-item="2.1.1"]');
  await expect(waiting).toBeVisible();
  await waiting.locator('.waiting-question').click();
  await expect(conversation.locator('.item-conversation')).toHaveAttribute('data-detail-item-id', '2.1.1');
  await unchanged();
  await conversation.getByRole('button', { name: 'Back to Map', exact: true }).click();
  await expect(conversation).toHaveCount(0);
  await expect(page.locator('.shell-center')).not.toHaveAttribute('inert', '');
  await expect(page.locator('.shell-detail .item-detail')).toHaveAttribute('data-detail-item-id', '3.1');
  await unchanged();
});

for (const id of answerFrameIds) {
  test(`frame ${id}`, async ({ page, origin }, testInfo) => {
    const spec = frameSpec(id), denied: string[] = [];
    await route(page.context(), origin, denied);
    await openApp(page, origin, spec);
    const pane = page.locator('.item-detail'), dock = pane.locator('.detail-dock'), options = dock.locator('[data-answer-option]');
    const composer = dock.getByRole('textbox', { name: 'Reply in your own words' });
    await expect(options).toHaveCount(spec.answerOptions!);
    const detail = page.getByRole('complementary', { name: 'Item detail', exact: true });
    const notice = detail.locator('.shell-detail-hidden-notice');
    if (spec.hiddenItems) {
      const inherited = spec.hiddenItems.includes('2.1');
      const alsoHidden = spec.hiddenItems.includes(spec.selected!);
      await expect(notice).toContainText(inherited ? `${alsoHidden ? 'Hidden, along with' : 'Hidden with'} its parent “Review the shared examples”${alsoHidden ? '.' : ''}` : 'Hidden — this item is hidden from the list.');
      await expect(notice).toBeInViewport();
      await expect(detail.getByRole('button', { name: 'Unhide item', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(detail.getByRole('button', { name: 'Unhide item', exact: true })).toHaveAttribute('title', inherited ? 'Unhide this item and its hidden parents' : 'Unhide');
    }
    await composer.fill('Keep the captions with the examples.');
    const space = async () => {
      const paneBox = (await pane.boundingBox())!, bodyBox = (await pane.locator('.detail-body').boundingBox())!, dockBox = (await dock.boundingBox())!;
      expect(bodyBox.height / paneBox.height, 'conversation scroll region keeps most of the pane').toBeGreaterThanOrEqual(0.55);
      expect(dockBox.height / paneBox.height, 'answer area uses at most 40% of the pane').toBeLessThanOrEqual(0.40);
      expect(bodyBox.y + bodyBox.height).toBeLessThanOrEqual(dockBox.y + 1);
      expect(dockBox.y + dockBox.height).toBeLessThanOrEqual(paneBox.y + paneBox.height + 1);
      if (page.viewportSize()!.height === 830) {
        const chatBox = (await pane.getByRole('region', { name: 'Conversation', exact: true }).boundingBox())!;
        const visibleChat = Math.min(chatBox.y + chatBox.height, bodyBox.y + bodyBox.height) - Math.max(chatBox.y, bodyBox.y);
        expect(visibleChat / paneBox.height, 'visible conversation at 1400×830').toBeGreaterThanOrEqual(0.55);
      }
    };
    await space();
    if (spec.answerOptions) {
      await expect(dock.locator('.answer-choices')).toBeVisible();
      const description = dock.locator('.answer-description').first(), more = dock.locator('.answer-more').first();
      const fullText = await description.textContent();
      const clamped = await description.evaluate(element => ({ height: element.getBoundingClientRect().height, line: parseFloat(getComputedStyle(element).lineHeight), scroll: element.scrollHeight }));
      expect(clamped.height).toBeLessThanOrEqual(clamped.line * 2 + 1);
      expect(clamped.scroll).toBeGreaterThan(clamped.height);
      await expect(dock.locator('.answer-recommended').first()).toBeVisible();
      await more.click();
      await expect(more).toHaveAttribute('aria-expanded', 'true');
      expect((await description.boundingBox())!.height).toBeGreaterThan(clamped.height);
      expect(await description.textContent()).toBe(fullText);
      const ending = await description.evaluate(element => {
        const dock = element.closest<HTMLElement>('.detail-dock')!, range = document.createRange(), text = element.firstChild!;
        range.setStart(text, text.textContent!.lastIndexOf('The final paragraph'));
        range.setEnd(text, text.textContent!.length);
        dock.scrollTop += range.getBoundingClientRect().bottom - dock.getBoundingClientRect().bottom + 8;
        const line = range.getBoundingClientRect(), bounds = dock.getBoundingClientRect();
        return { top: line.top, bottom: line.bottom, dockTop: bounds.top, dockBottom: bounds.bottom };
      });
      expect(ending.top).toBeGreaterThanOrEqual(ending.dockTop);
      expect(ending.bottom).toBeLessThanOrEqual(ending.dockBottom);
      await expect(options.first()).toHaveAttribute('aria-pressed', 'true');
      await expect(composer).toHaveValue('Keep the captions with the examples.');
      await space();
      await more.focus(); await page.keyboard.press('Enter');
      await expect(more).toHaveAttribute('aria-expanded', 'false');
      await expect(composer).toHaveValue('Keep the captions with the examples.');
      if (spec.expandedAnswer !== undefined) await dock.locator('.answer-more').nth(spec.expandedAnswer).click();
      const send = dock.locator('.answer-send');
      await send.scrollIntoViewIfNeeded(); await expect(send).toBeInViewport();
    }
    await composer.scrollIntoViewIfNeeded(); await expect(composer).toBeInViewport();
    await expect(dock.getByRole('button', { name: 'Send as a reply only', exact: true })).toBeInViewport();
    await space();
    await page.screenshot({ path: testInfo.outputPath(`${id}.png`), animations: 'disabled' });
    if (spec.hiddenItems) {
      const before = await pane.boundingBox(), scrollTop = await pane.locator('.detail-body').evaluate(element => element.scrollTop);
      await notice.getByRole('button', { name: 'Unhide', exact: true }).click();
      await expect(notice).toHaveCount(0);
      expect(await pane.boundingBox(), 'Unhide does not move or resize the detail body').toEqual(before);
      expect(await pane.locator('.detail-body').evaluate(element => element.scrollTop)).toBe(scrollTop);
      await expect(composer).toHaveValue('Keep the captions with the examples.');
      await expect(detail.getByRole('button', { name: 'Hide item', exact: true })).toHaveAttribute('aria-pressed', 'false');
      await space();
    }
    // A resize and an expansion never remount the owner's input or change the saved choice.
    await page.setViewportSize({ width: 1400, height: 500 });
    await composer.scrollIntoViewIfNeeded(); await expect(composer).toBeInViewport();
    await expect(composer).toHaveValue('Keep the captions with the examples.');
    if (spec.answerOptions) {
      await expect(options.first()).toHaveAttribute('aria-pressed', 'true');
      await dock.locator('.answer-send').scrollIntoViewIfNeeded(); await expect(dock.locator('.answer-send')).toBeInViewport();
    }
    await space();
    expect(denied).toEqual([]);
  });
}

for (const id of toastFrameIds) {
  test(`frame ${id}`, async ({ page, origin }, testInfo) => {
    const spec = frameSpec(id), denied: string[] = [];
    await route(page.context(), origin, denied);
    await openApp(page, origin, spec);
    if (spec.detailWidth !== undefined) {
      const separator = page.getByRole('separator', { name: 'Resize detail panel' });
      await expect(separator).toHaveAttribute('aria-valuenow', '400');
      await separator.focus();
      for (let width = 400; width < spec.detailWidth; width += 16) await page.keyboard.press('ArrowLeft');
      await expect(separator).toHaveAttribute('aria-valuenow', String(spec.detailWidth));
      await separator.evaluate(element => (element as HTMLElement).blur());
      await settle(page);
    }
    if (spec.peekWaiting) {
      await page.getByRole('button', { name: /^Show Waiting on me/ }).click();
      await settle(page);
    }
    const bar = page.locator('.tree-session-bar'), title = bar.locator('.tree-session-title');
    const overlay = page.locator('.pw-notices'), toast = overlay.locator('.pw-note');
    await expect(bar).toBeVisible();
    await expect(title).toBeVisible();
    await expect(toast).toHaveCount(0);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const emptyOverlay = await overlay.boundingBox();
    const geometry = async () => ({ bar: await bar.boundingBox(), title: await title.boundingBox(),
      center: await page.locator('.shell-center').boundingBox(), waiting: await page.locator('.shell-waiting').boundingBox(),
      detail: await page.locator('.shell-detail').count() ? await page.locator('.shell-detail').boundingBox() : null,
      dock: await page.locator('.detail-dock').count() ? await page.locator('.detail-dock').boundingBox() : null,
      tabs: await page.locator('.shell-tabs').boundingBox(), footer: await page.locator('.shell-footer').boundingBox() });
    const before = await geometry();
    if (spec.detail) {
      expect(before.detail!.width, 'fixture uses the requested actual detail-pane width').toBe(spec.detailWidth ?? 400);
      if (spec.detailWidth !== undefined) expect(before.detail!.width, 'wide detail pane is wider than the 400px default').toBeGreaterThan(400);
    }
    const monitor = await page.evaluateHandle(() => {
      type Shift = PerformanceEntry & { value: number };
      const shifts: number[] = [];
      const record = (entries: PerformanceEntry[]) => {
        for (const entry of entries) shifts.push((entry as Shift).value);
      };
      if (!PerformanceObserver.supportedEntryTypes.includes('layout-shift')) throw new Error('Layout shift observation is unavailable');
      const observer = new PerformanceObserver(list => record(list.getEntries()));
      observer.observe({ type: 'layout-shift' });
      return { finish: () => { record(observer.takeRecords()); observer.disconnect(); return shifts; } };
    });
    await page.evaluate(() => window.__designToast!.show());
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('Reference copied.');
    await expect(overlay).toHaveCSS('position', 'absolute');
    await settle(page);
    const visible = await geometry();
    expect(visible, 'toast appearance moves the session bar and title by 0px').toEqual(before);
    const toastBox = (await toast.boundingBox())!, overlayBox = (await overlay.boundingBox())!, centerBox = before.center!;
    expect(overlayBox, 'the persistent overlay keeps its bounds when a toast appears').toEqual(emptyOverlay);
    expect(toastBox.x, 'toast stays inside the centre left edge').toBeGreaterThanOrEqual(centerBox.x + 16);
    expect(toastBox.x + toastBox.width, 'toast stays inside the centre right edge').toBeLessThanOrEqual(centerBox.x + centerBox.width - 16);
    expect(toastBox.width, 'toast is bounded by the centre width and 480px').toBeLessThanOrEqual(Math.min(480, centerBox.width - 32));
    for (const [name, box] of Object.entries({ waiting: before.waiting, detail: before.detail, dock: before.dock, footer: before.footer })) {
      if (!box) continue;
      const intersects = toastBox.x < box.x + box.width && toastBox.x + toastBox.width > box.x
        && toastBox.y < box.y + box.height && toastBox.y + toastBox.height > box.y;
      expect(intersects, `toast does not intersect ${name}`).toBe(false);
    }
    if (spec.peekWaiting) {
      expect(centerBox.width, 'fixture exercises the narrow-centre fallback').toBeLessThanOrEqual(400);
      expect(overlayBox.y, 'narrow toast starts just below the tab bar').toBe(before.tabs!.y + before.tabs!.height + 8);
    } else {
      expect(centerBox.width, 'fixture exercises the bottom anchor').toBeGreaterThan(400);
      expect(overlayBox.y + overlayBox.height, 'toast overlay ends 16px above the footer').toBe(before.footer!.y - 16);
      expect(toastBox.y + toastBox.height, 'the toast itself ends at the bottom anchor').toBe(overlayBox.y + overlayBox.height);
      expect(toastBox.y, 'toast stays below the session header').toBeGreaterThanOrEqual(before.bar!.y + before.bar!.height);
    }
    await page.screenshot({ path: testInfo.outputPath(`${id}.png`), animations: 'disabled' });
    await page.evaluate(() => window.__designToast!.show('Reference saved. The complete conversation is included, along with the earlier questions, replies and decisions. You can paste it into your notes and return to this conversation whenever you need it.'));
    await expect(toast).toContainText('Reference saved. The complete conversation is included');
    await settle(page);
    expect((await toast.boundingBox())!.height, 'the update exercises a taller toast').toBeGreaterThan(toastBox.height);
    expect(await geometry(), 'updating a toast leaves the surrounding panes in place').toEqual(before);
    expect(await overlay.boundingBox(), 'updating a toast keeps the overlay bounds').toEqual(emptyOverlay);
    await page.evaluate(() => window.__designToast!.clear());
    await expect(toast).toHaveCount(0);
    await settle(page);
    const cleared = await geometry();
    expect(cleared, 'toast clearance moves the session bar and title by 0px').toEqual(before);
    expect(await overlay.boundingBox(), 'the empty overlay keeps its bounds after dismissal').toEqual(emptyOverlay);
    const shifts = await monitor.evaluate(value => value.finish());
    await monitor.dispose();
    expect(shifts.reduce((sum, value) => sum + value, 0), 'toast appearance, update and clearance cause 0 layout shift, including the overlay').toBe(0);
    await testInfo.attach('session toast geometry', { body: JSON.stringify({ before, visible, cleared, layoutShifts: shifts }, null, 2), contentType: 'application/json' });
    expect(denied).toEqual([]);
  });
}

test('catalogue scrolling keeps the toast anchored above the footer', async ({ page, origin }) => {
  const denied: string[] = [];
  await route(page.context(), origin, denied);
  await openApp(page, origin, frameSpec('session-toast-light'));
  await page.getByRole('navigation', { name: 'Projects and sessions' }).getByRole('button', { name: 'Projects', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 300 });
  await settle(page);
  const scroll = page.locator('.shell-center-content'), overlay = page.locator('.pw-notices');
  const range = await scroll.evaluate(element => element.scrollHeight - element.clientHeight);
  expect(range, 'catalogue fixture has scrollable content').toBeGreaterThan(0);
  await page.evaluate(() => window.__designToast!.show());
  await expect(overlay.locator('.pw-note')).toBeVisible();
  await settle(page);
  const before = await overlay.boundingBox();
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await settle(page);
  expect(await scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await overlay.boundingBox(), 'scrolling the catalogue moves the toast by 0px').toEqual(before);
  const footer = (await page.locator('.shell-footer').boundingBox())!;
  expect(before!.y + before!.height).toBe(footer.y - 16);
  await page.evaluate(() => window.__designToast!.clear());
  expect(denied).toEqual([]);
});

for (const id of dockFrameIds) {
  test(`frame ${id}`, async ({ page, origin }, testInfo) => {
    const spec = frameSpec(id), denied: string[] = [];
    await route(page.context(), origin, denied);
    await openApp(page, origin, spec);
    const pane = page.locator('.item-detail'), dock = pane.locator('.detail-dock');
    const detail = page.getByRole('complementary', { name: 'Item detail', exact: true });
    const detailBox = (await detail.boundingBox())!, headerAction = (await detail.getByRole('button', { name: 'Hide item', exact: true }).boundingBox())!;
    expect(headerAction.y).toBeGreaterThanOrEqual(detailBox.y);
    expect(headerAction.y - detailBox.y, 'detail header action starts within 5px of the pane top').toBeLessThanOrEqual(5);
    const composer = dock.getByRole('textbox', { name: spec.dockState === 'question' ? 'Reply in your own words' : 'Reply message', exact: true });
    await expect(composer).toHaveValue('');
    await expect(composer).toBeInViewport();
    const lines = await composer.evaluate(element => {
      const style = getComputedStyle(element);
      return { height: element.getBoundingClientRect().height, minimum: parseFloat(style.minHeight), line: parseFloat(style.lineHeight),
        padding: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom), border: parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth) };
    });
    expect(lines.height, 'resting composer is one line').toBeLessThanOrEqual(Math.max(lines.minimum, Math.ceil(lines.line + lines.padding + lines.border)));
    if (spec.dockState === 'question') {
      const choices = dock.locator('.answer-choices');
      await expect(choices).toBeVisible();
      await expect(dock.locator('[data-answer-option]')).toHaveCount(2);
      for (const option of await dock.locator('[data-answer-option]').all()) await expect(option).toBeInViewport();
    } else {
      await expect(dock.getByRole('button', { name: 'Ack → Decided', exact: true })).toBeInViewport();
      await expect(dock.getByRole('button', { name: 'Reply', exact: true })).toBeInViewport();
      await expect(dock.getByRole('button', { name: 'Later', exact: true })).toBeInViewport();
    }
    if (spec.dockState === 'pending') {
      const pending = pane.getByRole('region', { name: 'Conversation', exact: true }).locator('li[data-pending]');
      await expect(pending).toContainText('Keep the captions with the examples.');
      await expect(pending).toContainText('On its way');
      await expect(pending).toBeInViewport();
      await expect(dock.locator('.detail-delivery-hint')).toHaveText('Your reply was received · waiting for the agent');
      await expect(dock.getByRole('button', { name: 'Bring it up', exact: true })).toHaveCount(0);
      await expect(dock.getByRole('button', { name: 'Drop', exact: true })).toHaveCount(0);
    }
    const geometry = await pane.evaluate(element => {
      const pane = element.getBoundingClientRect(), body = element.querySelector('.detail-body')!.getBoundingClientRect();
      const dock = element.querySelector('.detail-dock')!.getBoundingClientRect(), chat = element.querySelector('[aria-label="Conversation"]')!.getBoundingClientRect();
      // Intersect the actual Conversation with its scroll clip, the pane and the viewport.
      const top = Math.max(chat.top, body.top, pane.top, 0), bottom = Math.min(chat.bottom, body.bottom, pane.bottom, window.innerHeight);
      return { conversation: Math.max(0, bottom - top) / pane.height, dock: dock.height / pane.height,
        bodyBottom: body.bottom, dockTop: dock.top, dockBottom: dock.bottom, paneBottom: pane.bottom };
    });
    expect(geometry.conversation, `visible resting Conversation at ${spec.width}×${spec.height}`).toBeGreaterThanOrEqual(spec.dockState === 'question' ? 0.55 : 0.70);
    expect(geometry.dock, 'dock uses at most 40% of the pane').toBeLessThanOrEqual(0.40);
    if (spec.dockState === 'pending') expect(geometry.dock, 'pending Open dock uses at most 25% of the portrait pane').toBeLessThanOrEqual(0.25);
    expect(geometry.bodyBottom).toBeLessThanOrEqual(geometry.dockTop + 1);
    expect(geometry.dockBottom).toBeLessThanOrEqual(geometry.paneBottom + 1);
    await testInfo.attach('dock geometry', { body: JSON.stringify({ viewport: { width: spec.width, height: spec.height }, ...geometry }, null, 2), contentType: 'application/json' });
    await page.screenshot({ path: testInfo.outputPath(`${id}.png`), animations: 'disabled' });
    expect(denied).toEqual([]);
  });
}

async function capture(page: Page, designPage: Page, spec: FrameSpec, id: string, card: string, denied: readonly string[]) {
  {
    const shell = await page.evaluate(() => {
      const height = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().height ?? null;
      const columns = [...document.querySelector('.shell-body')!.children].map(child => ({
        name: ['waiting', 'center', 'detail'].find(name => child.classList.contains(`shell-${name}`)) ?? 'unknown',
        x: child.getBoundingClientRect().x, width: child.getBoundingClientRect().width }));
      return { header: height('.shell-header'), tabs: height('.shell-tabs'), footer: height('.shell-footer'), columns };
    });
    expect(shell.header).toBe(48); expect(shell.tabs).toBe(38); expect(shell.footer).toBe(30);
    const fixed: Record<string, number> = { waiting: 300, detail: 400 };
    for (const column of shell.columns) {
      if (column.name === 'center') expect(column.width, 'centre column').toBeGreaterThanOrEqual(560);
      else expect(column.width, `${column.name} column`).toBe(fixed[column.name]);
    }
    const app = await page.screenshot({ animations: 'disabled' });
    // The card sits at a fractional page offset; clip the frame's exact size at the rounded origin.
    const box = await designPage.locator(`[id="${card}"] .dv-card`).evaluate(node => {
      const rect = node.getBoundingClientRect(); return { x: rect.x + window.scrollX, y: rect.y + window.scrollY };
    });
    const design = await designPage.screenshot({ animations: 'disabled', fullPage: true,
      clip: { x: Math.round(box.x), y: Math.round(box.y), width: spec.width, height: spec.height } });
    // Each body column's own ratio, so a view can be followed apart from the columns around it.
    const columns = await page.evaluate(() => [...document.querySelector('.shell-body')!.children].map(child => {
      const rect = child.getBoundingClientRect();
      return { name: ['waiting', 'center', 'detail'].find(name => child.classList.contains(`shell-${name}`)) ?? 'unknown',
        x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    }));
    const canvas = await page.context().newPage();
    // The chat-style detail pane's scrolling body is masked out (frames.ts detailMask); its header strip is still compared.
    const mask = detailMasked(spec) ? await page.locator(detailMask.selector).evaluate(element => {
      const rect = element.getBoundingClientRect(); return { name: 'detail body', x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    }) : null;
    const result = await compare(canvas, design, app, columns, mask);
    await canvas.close();
    writeFileSync(resolve(output, `${id}-design.png`), design);
    writeFileSync(resolve(output, `${id}-app.png`), app);
    writeFileSync(resolve(output, `${id}-diff.png`), Buffer.from(result.png, 'base64'));
    const threshold = (thresholds as Record<string, number>)[id] ?? 0;
    writeFileSync(resolve(output, 'frames', `${id}.json`), `${JSON.stringify({ ratio: Number(result.ratio.toFixed(4)), threshold, tolerance,
      masked: mask ? { region: mask, reason: detailMask.reason } : null,
      columns: Object.fromEntries(columns.map((column, at) => [column.name, Number(result.regions[at].toFixed(4))])),
      size: { width: result.width, height: result.height }, viewport: { width: spec.width, height: spec.height }, shell }, null, 2)}\n`);
    expect(denied).toEqual([]);
    expect(result.ratio, `${id} mismatch ratio`).toBeLessThanOrEqual(threshold);
  }
}
