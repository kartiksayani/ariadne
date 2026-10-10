// Design fidelity harness: each handoff frame of Ariadne Mockups.dc.html beside
// the real DesktopApp in the same state. Writes coverage/design/<frame>-design.png,
// -app.png and -diff.png, a per-frame result that teardown.ts gathers into
// report.json, and fails a frame whose mismatch ratio exceeds thresholds.json.
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import { answerFrameIds, designNow, detailMask, detailMasked, frameNow, frameSpec, graphFrame, variantIds, type FrameSpec } from './frames';
import { handoffMembers, prefix, repo, sourceRoot } from './source.mts';
import thresholds from './thresholds.json' with { type: 'json' };

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
  await page.setViewportSize({ width: spec.width, height: spec.height });
  await page.clock.setFixedTime(frameNow(spec));
  await page.goto(`${origin}/tests/ui/design/gallery.html?frame=${spec.id}`);
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
  if (spec.answering) {
    await row(spec.answering).focus();
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
  // hover-msg (1a): the rail message is hovered, so the items it touched are highlighted. A dispatched
  // mouseover is React's mouseenter and leaves the rail's scroll position and the pointer alone.
  if (spec.hoverMsg) await railMessage(page, spec.hoverMsg).dispatchEvent('mouseover');
  await settle(page);
}

const railMessage = (page: Page, number: number) => page.locator('.pw-rail-list [data-message-id]').filter({
  has: page.locator('.pw-excerpt-number', { hasText: new RegExp(`^#${number}$`) }) });

/**
 * Puts the app's rail where the design's rail sits. The prototype scrolls its rail to the bottom 60 ms after
 * mount (Ariadne.dc.html:988), before its fonts settle; in some frames the reflow leaves it above the bottom,
 * showing "Follow latest" (Ariadne.dc.html:2196). The app's rail is scrolled to the same message and offset.
 */
async function matchRail(page: Page, designPage: Page, id: string) {
  const aside = designPage.locator(`[id="${id}"] .dv-card aside[aria-label="Messages"]`);
  if (!await aside.count()) return;
  const position = await aside.evaluate(element => {
    const list = element.children[1] as HTMLElement;
    if (list.scrollHeight - list.scrollTop - list.clientHeight < 24) return null;
    const top = list.getBoundingClientRect().top;
    for (const card of list.children) {
      const rect = card.getBoundingClientRect(), number = /^\s*#(\d+)/.exec(card.textContent ?? '')?.[1];
      if (number && rect.bottom > top) return { number: Number(number), offset: rect.top - top };
    }
    return null;
  });
  if (!position) return;
  const card = railMessage(page, position.number);
  await card.evaluate((element, offset) => {
    const list = element.closest<HTMLElement>('.pw-rail-list')!;
    list.scrollTop += element.getBoundingClientRect().top - list.getBoundingClientRect().top - offset;
  }, position.offset);
  await expect(page.locator('.pw-rail-follow')).toHaveText('Follow latest');
  await settle(page);
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
/** The tree row of item `itemId` in a board card: the Item Row whose id label reads it (Item Row.dc.html). */
const designRow = (designPage: Page, card: string, itemId: string) => designPage.locator(`[id="${card}"] .dv-card [role="treeitem"]`)
  .filter({ has: designPage.locator('span', { hasText: new RegExp(`^${itemId.replace(/\./g, '\\.')}$`) }) }).first();

for (const id of [...designFrames, ...variantIds]) {
  test(`frame ${id}`, async ({ page, origin, designPage }) => {
    let spec: FrameSpec;
    try { spec = frameSpec(id); } catch (error) { test.skip(true, (error as Error).message); return; }
    const card = spec.design ?? id;
    const denied: string[] = [];
    await route(page.context(), origin, denied);
    await openApp(page, origin, spec);
    if (spec.rail) await matchRail(page, designPage, card);
    // The pointer rests on a row in both: the prototype's hoverItem and the app's :hover. Moved off again after the capture.
    if (spec.hoverItem) {
      await designRow(designPage, card, spec.hoverItem).hover();
      await page.locator(`.tree-item[data-item-id="${spec.hoverItem}"]`).hover();
      await settle(page); await settle(designPage);
    }
    try { await capture(page, designPage, spec, id, card, denied); } finally { if (spec.hoverItem) await designPage.mouse.move(0, 0); }
  });
}

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
      await expect(notice).toContainText(spec.hiddenItems.includes(spec.selected!) ? 'Hidden — this item is hidden from the list.' : 'Hidden with its parent “Review the shared examples”');
      await expect(notice).toBeInViewport();
      await expect(detail.getByRole('button', { name: 'Unhide item', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(detail.getByRole('button', { name: 'Unhide item', exact: true })).toHaveAttribute('title', 'Unhide');
    }
    await composer.fill('Keep the captions with the examples.');
    const space = async () => {
      const paneBox = (await pane.boundingBox())!, bodyBox = (await pane.locator('.detail-body').boundingBox())!, dockBox = (await dock.boundingBox())!;
      expect(bodyBox.height / paneBox.height, 'conversation scroll region keeps most of the pane').toBeGreaterThanOrEqual(0.55);
      expect(dockBox.height / paneBox.height, 'answer area uses at most 40% of the pane').toBeLessThanOrEqual(0.405);
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

async function capture(page: Page, designPage: Page, spec: FrameSpec, id: string, card: string, denied: readonly string[]) {
  {
    const shell = await page.evaluate(() => {
      const height = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().height ?? null;
      const columns = [...document.querySelector('.shell-body')!.children].map(child => ({
        name: ['waiting', 'center', 'detail'].find(name => child.classList.contains(`shell-${name}`)) ?? 'rail',
        x: child.getBoundingClientRect().x, width: child.getBoundingClientRect().width }));
      return { header: height('.shell-header'), tabs: height('.shell-tabs'), footer: height('.shell-footer'), columns };
    });
    expect(shell.header).toBe(48); expect(shell.tabs).toBe(38); expect(shell.footer).toBe(30);
    const fixed: Record<string, number> = { waiting: 300, detail: 400, rail: 240 };
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
      return { name: ['waiting', 'center', 'detail'].find(name => child.classList.contains(`shell-${name}`)) ?? 'rail',
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
