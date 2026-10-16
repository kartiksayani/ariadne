// Design fidelity harness: each handoff frame of Ariadne Mockups.dc.html beside
// the real DesktopApp in the same state. Writes coverage/design/<frame>-design.png,
// -app.png and -diff.png, a per-frame result that teardown.ts gathers into
// report.json, and fails a frame whose mismatch ratio exceeds thresholds.json.
import { test as base, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import { answerFrameIds, designNow, detailMask, detailMasked, dockFrameIds, frameNow, frameSpec, graphFrame, graphShift, toastFrameIds, variantIds, type FrameSpec } from './frames';
import { startDesignServer } from './server.mts';
import { handoffMembers, prefix, repo, sourceRoot } from './source.mts';
import thresholds from './thresholds.json' with { type: 'json' };
import { changeNames, interpretation, longDecided, ownerWords } from './changes-fixture';
import { captureFrame, type Region, type Shift } from './compare.mts';

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
    // Warmed before the first test, so no test pays the cold transform inside its render wait.
    const { server, origin } = await startDesignServer();
    try { await use(origin); } finally { await server.close(); }
  }, { scope: 'worker', timeout: 240_000 }],
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
    await expect(page.locator('.tree-path > .tree-selected-slot')).toHaveCount(1);
    await expect(page.locator('.tree-scroll .tree-selected-slot, .tree-scroll .tree-selected-edge')).toHaveCount(0);
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
    // Caught up leaves no box: a check in the brief's header line, with Undo beside it while it is offered.
    await expect(since).toHaveCount(0);
    await expect(brief.getByRole('img', { name: 'All caught up' })).toBeVisible();
    await changesFit(brief);
    await testInfo.attach(`changes-caught-up-undo-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
    await brief.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(since).toContainText('8 changes while you were away');
    await expect(brief.locator('.brief-list').nth(1).locator('.change-name')).toHaveText(['Recovery question']);
    await testInfo.attach(`changes-away-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
  });
}

/** Layout tests of the Map's topic cards, chevrons, filter row and rails (A16 owner reports). */
const mapSizes = [{ brief: 'map-brief-long', map: 'map-thread' }, { brief: 'map-brief-long-small', map: 'map-thread-small' }] as const;

for (const { brief: frame } of mapSizes) for (const theme of ['dark', 'light'] as const) {
  test(`Topic brief names flow across the width instead of one per line: ${frame} (${theme})`, async ({ page, origin }, testInfo) => {
    await openApp(page, origin, { ...frameSpec(frame), theme });
    const brief = page.getByRole('region', { name: 'Topic brief', exact: true });
    await page.locator('.tree-scroll').evaluate(element => { element.scrollTop = 0; });
    await brief.scrollIntoViewIfNeeded();
    const decided = brief.locator('.brief-list').nth(0);
    // Every name is there, in order.
    await expect(decided.locator('.change-name')).toHaveText(['Recovery policy', ...longDecided]);
    const layout = await decided.evaluate(list => {
      const names = list.querySelector('ul')!, box = names.getBoundingClientRect(), items = [...names.children].map(item => item.getBoundingClientRect());
      return { count: items.length, lines: new Set(items.map(rect => Math.round(rect.top))).size, width: box.width,
        reach: Math.max(...items.map(rect => rect.right)) - box.left, label: 0,
        dot: getComputedStyle(names.firstElementChild!, '::after').content, lastDot: getComputedStyle(names.lastElementChild!, '::after').content };
    });
    expect(layout.lines, 'names share lines').toBeLessThanOrEqual(Math.ceil(layout.count * 0.6));
    expect(layout.lines).toBeGreaterThan(1);
    expect(layout.reach, 'the names use the width').toBeGreaterThan(layout.width * 0.7);
    expect(layout.dot).toBe('"·"');
    expect(layout.lastDot).toBe('none');
    // The group labels stay a column on the left, and "Your turn" / "Replaced" do not wrap.
    const labels = await brief.locator('.brief-list > strong').evaluateAll(elements => elements.map(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      return { x: element.getBoundingClientRect().x, lines: new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size };
    }));
    expect(new Set(labels.map(label => label.x)).size).toBe(1);
    for (const label of labels) expect(label.lines, 'a group label stays on one line').toBe(1);
    // "old replaced by new" is one unit: the "replaced by" and the new name share a line.
    const pair = await brief.locator('.brief-list').nth(2).locator('li').first().evaluate(item => {
      const replacement = item.querySelector('.brief-replacement')!, button = replacement.querySelector('button')!;
      const middle = (rect: DOMRect) => rect.top + rect.height / 2;
      return { lead: middle(replacement.firstElementChild!.getBoundingClientRect()), name: middle(button.getBoundingClientRect()), rects: replacement.getClientRects().length };
    });
    expect(Math.abs(pair.lead - pair.name)).toBeLessThan(4);
    expect(pair.rects).toBe(1);
    await changesFit(brief);
    await testInfo.attach(`brief-wrap-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
  });
}

for (const { map: frame } of mapSizes) for (const theme of ['dark', 'light'] as const) {
  test(`Fold chevron is an opaque chip the rails end at: ${frame} (${theme})`, async ({ page, origin }, testInfo) => {
    await openApp(page, origin, { ...frameSpec(frame), theme });
    await page.locator('.tree-scroll').evaluate(element => { element.querySelector('.tree-item:has(.tree-chevron)')?.scrollIntoView({ block: 'center' }); });
    await settle(page);
    const chevrons = page.locator('.tree-chevron');
    expect(await chevrons.count()).toBeGreaterThan(1);
    const facts = await chevrons.evaluateAll(buttons => buttons.map(button => {
      const style = getComputedStyle(button), caret = getComputedStyle(button.querySelector('i')!), box = button.getBoundingClientRect();
      const paint = (color: string, base: string) => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d')!;
        context.fillStyle = base; context.fillRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data];
      };
      const light = (rgb: number[]) => { const [r, g, b] = rgb.map(value => { const unit = value / 255; return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const chip = paint(style.backgroundColor, 'rgb(0, 0, 0)'), over = paint(style.backgroundColor, 'rgb(255, 255, 255)');
      const ink = paint(style.color, style.backgroundColor);
      const [high, low] = [light(chip), light(ink)].sort((a, b) => b - a);
      const centre = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { opaque: chip.every((value, at) => value === over[at]), contrast: (high + 0.05) / (low + 0.05), caret: parseFloat(caret.fontSize),
        width: box.width, height: box.height, covers: !!centre?.closest('.tree-chevron'), hidden: box.bottom < 0 || box.top > innerHeight };
    }));
    for (const fact of facts.filter(value => !value.hidden)) {
      expect(fact.opaque, 'the chip hides the rail behind it').toBe(true);
      expect(fact.contrast, 'the caret reads against its chip').toBeGreaterThanOrEqual(4.5);
      expect(fact.caret).toBeGreaterThanOrEqual(14);
      expect(fact.width).toBe(16);
      expect(fact.covers, 'the chip paints over the rail').toBe(true);
    }
    // Hover keeps a visible state.
    const first = chevrons.nth(1), resting = await first.evaluate(element => getComputedStyle(element).backgroundColor);
    await first.hover();
    expect(await first.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(resting);
    await testInfo.attach(`chevron-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
  });
}

for (const frame of ['graph-hidden', 'graph-hidden-small'] as const) for (const theme of ['dark', 'light'] as const) {
  test(`Over the Graph the filter control shares the legend row with Reveal selected: ${frame} (${theme})`, async ({ page, origin }, testInfo) => {
    await openApp(page, origin, { ...frameSpec(frame), theme });
    const filters = page.getByRole('group', { name: 'Filter items' }), trigger = filters.getByRole('button', { name: /^Filter/ });
    await expect(trigger).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`graph-filter-${frame}-${theme}.png`), animations: 'disabled' });
    const rows = await page.evaluate(() => {
      const rect = (element: Element | null) => element!.getBoundingClientRect();
      const filter = document.querySelector('.tree-filters')!, reveal = document.querySelector('.graph-reveal'), legend = document.querySelector('.graph-legend')!;
      // Every row in the legend column that holds the filter button: the button's siblings in its row.
      const row = filter.closest('.graph-legend');
      const parts = [...legend.querySelectorAll(':scope > *, .graph-legend-actions > *')].filter(part => !part.classList.contains('graph-legend-actions'))
        .map(part => ({ name: part.className || part.tagName, rect: part.getBoundingClientRect() })).filter(part => part.rect.width > 0);
      return { standalone: !!document.querySelector('.tree-recent'), inLegend: !!row, filter: rect(filter), reveal: rect(reveal), legend: rect(legend),
        parts, scrollWidth: legend.scrollWidth, clientWidth: legend.clientWidth, column: rect(document.querySelector('.tree-column')) };
    });
    expect(rows.standalone, 'no row over the Graph holds only the filter button').toBe(false);
    expect(rows.inLegend, 'the filter control sits in the legend row').toBe(true);
    expect(Math.abs((rows.filter.top + rows.filter.height / 2) - (rows.reveal.top + rows.reveal.height / 2)), 'the funnel and Reveal selected share one row').toBeLessThan(4);
    expect(rows.filter.left, 'the funnel follows Reveal selected').toBeGreaterThanOrEqual(rows.reveal.right - 0.5);
    expect(rows.legend.height, 'the legend stays one row').toBeLessThanOrEqual(44);
    expect(rows.filter.height, 'the funnel does not make the legend row taller than Reveal selected').toBeLessThanOrEqual(rows.reveal.height + 0.5);
    expect(rows.filter.right).toBeLessThanOrEqual(rows.column.right + 0.5);
    expect(rows.scrollWidth, 'the legend does not clip').toBeLessThanOrEqual(rows.clientWidth);
    const ordered = [...rows.parts].sort((a, b) => a.rect.left - b.rect.left);
    for (let at = 1; at < ordered.length; at++) expect(ordered[at - 1]!.rect.right, `${ordered[at - 1]!.name} does not overlap ${ordered[at]!.name}`).toBeLessThanOrEqual(ordered[at]!.rect.left + 0.5);
    for (const part of ordered) {
      expect(part.rect.top).toBeGreaterThanOrEqual(rows.legend.top - 0.5);
      expect(part.rect.bottom).toBeLessThanOrEqual(rows.legend.bottom + 0.5);
    }
    // The menu opens inside the window and still filters.
    await trigger.click();
    const option = page.getByRole('menuitemcheckbox', { name: /^Open \d+$/ });
    await expect(option).toBeVisible();
    const menu = await page.getByRole('menu', { name: /^Filter/ }).boundingBox(), size = page.viewportSize()!;
    expect(menu!.x).toBeGreaterThanOrEqual(0); expect(menu!.x + menu!.width).toBeLessThanOrEqual(size.width);
    expect(menu!.y).toBeGreaterThanOrEqual(0); expect(menu!.y + menu!.height).toBeLessThanOrEqual(size.height);
    await option.click();
    await page.keyboard.press('Escape');
    await expect(filters.getByRole('button', { name: 'Filter: Open' })).toHaveAttribute('data-active', 'true');
    await expect(trigger).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`graph-filter-active-${frame}-${theme}.png`), animations: 'disabled' });
  });
}

for (const { map: frame } of mapSizes) for (const theme of ['dark', 'light'] as const) {
  test(`The filter control ends the Recent row and gives the Map the rest: ${frame} (${theme})`, async ({ page, origin }, testInfo) => {
    await openApp(page, origin, { ...frameSpec(frame), theme });
    const filters = page.getByRole('group', { name: 'Filter items' }), trigger = filters.getByRole('button', { name: /^Filter/ });
    await expect(trigger).toBeVisible();
    const geometry = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const recent = box('.tree-recent'), recentButton = box('.tree-recent > button'), filter = box('.tree-filters'), trail = box('.recent-trail');
      return { recent, recentButton, filter, trail, bar: box('.tree-session-bar'), scroller: box('.tree-scroll'), path: box('.tree-path'),
        inRow: !!document.querySelector('.tree-recent > .tree-filters'), column: box('.tree-column') };
    });
    expect(geometry.inRow, 'the filter control sits in the Recent row').toBe(true);
    expect(geometry.filter.left).toBeGreaterThanOrEqual(geometry.recentButton.right - 0.5);
    expect(geometry.filter.right).toBeLessThanOrEqual(geometry.column.right + 0.5);
    expect(Math.abs((geometry.filter.top + geometry.filter.height / 2) - (geometry.recentButton.top + geometry.recentButton.height / 2))).toBeLessThan(6);
    expect(geometry.trail.right, 'the trail does not run under Recent').toBeLessThanOrEqual(geometry.recentButton.left + 0.5);
    // Between the session bar and the rows: the Recent row (32) and the path row (28), no row of its own for the filter.
    expect(geometry.scroller.top - geometry.bar.bottom).toBeLessThanOrEqual(66);
    expect(geometry.path.top - geometry.recent.bottom, 'no stray row between Recent and the path').toBeLessThanOrEqual(1);
    // The menu opens inside the window, and an active filter says which statuses it keeps.
    await trigger.click();
    const option = page.getByRole('menuitemcheckbox', { name: /^Open \d+$/ });
    await expect(option).toBeVisible();
    const menu = (await option.boundingBox())!, size = page.viewportSize()!;
    expect(menu.x).toBeGreaterThanOrEqual(0); expect(menu.x + menu.width).toBeLessThanOrEqual(size.width);
    await option.click();
    await page.keyboard.press('Escape');
    await expect(filters.getByRole('button', { name: 'Filter: Open' })).toHaveAttribute('data-active', 'true');
    await expect(page.getByText(/^Showing \d+ of \d+ items.* in the statuses you picked/)).toBeVisible();
    await testInfo.attach(`filter-row-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
    // The shortcut for search still focuses the search field.
    await page.locator('.tree-scroll').focus();
    await page.keyboard.press('/');
    await expect(page.locator('[data-shell-search]')).toBeFocused();
  });
}

for (const { map: frame } of mapSizes) test(`The selection tag and the ancestors share the path row without overlap: ${frame}`, async ({ page, origin }) => {
  await openApp(page, origin, frameSpec(frame));
  await page.locator('.tree-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await settle(page);
  const tag = page.locator('.tree-path .tree-selected-edge');
  await expect(tag).toBeVisible();
  const boxes = await page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const crumbs = [...document.querySelectorAll('.tree-breadcrumb button')].map(button => button.getBoundingClientRect());
    return { path: box('.tree-path'), crumbs: box('.tree-breadcrumb'), tag: box('.tree-selected-edge'), buttons: crumbs, scroller: box('.tree-scroll') };
  });
  expect(boxes.crumbs.right).toBeLessThanOrEqual(boxes.tag.left + 0.5);
  expect(boxes.tag.right).toBeLessThanOrEqual(boxes.path.right + 0.5);
  expect(boxes.path.height).toBeLessThanOrEqual(28.5);
  expect(boxes.path.bottom).toBeLessThanOrEqual(boxes.scroller.top + 0.5);
  for (const button of boxes.buttons) expect(button.right).toBeLessThanOrEqual(boxes.crumbs.right + 0.5);
});

/** The selected path and the plain guide must each run as one line from the topic band through its cards to the items. */
async function railRuns(page: Page) {
  await page.locator('.tree-scroll').evaluate(element => { element.scrollTop = 0; });
  await settle(page);
  return page.locator('.tree-topic-group').first().evaluate(group => {
    const origin = group.getBoundingClientRect(), topic = group.querySelector('.tree-topic')!.getBoundingClientRect();
    const lines = [...group.querySelectorAll<HTMLElement>('.tree-guide')].map(line => ({ rect: line.getBoundingClientRect(), on: line.style.width === '1.5px' }))
      .filter(line => Math.abs(line.rect.left - origin.left - 20) < 1.5 && line.rect.height > 0);
    const runs = (on: boolean) => {
      const merged: number[][] = [];
      for (const [top, bottom] of lines.filter(line => line.on === on).map(line => [line.rect.top, line.rect.bottom]).sort((a, b) => a[0] - b[0])) {
        const last = merged.at(-1);
        if (last && top <= last[1] + 1.5) last[1] = Math.max(last[1], bottom); else merged.push([top, bottom]);
      }
      return merged;
    };
    const cards = group.querySelector('.topic-changes')?.getBoundingClientRect(), first = group.querySelector('[data-item-id]')?.getBoundingClientRect();
    return { off: runs(false), on: runs(true), topic: { top: topic.top, bottom: topic.bottom }, first: first ? { top: first.top, bottom: first.bottom } : null,
      cardsLeft: cards ? cards.left - origin.left : null, cardsHeight: cards?.height ?? 0 };
  });
}
for (const { name, frame, theme, act } of [
  { name: 'brief open, no since cards', frame: 'map-thread', theme: 'dark', act: async () => {} },
  { name: 'brief open, no since cards', frame: 'map-thread', theme: 'light', act: async () => {} },
  { name: 'brief open, no since cards at 900', frame: 'map-thread-small', theme: 'dark', act: async () => {} },
  { name: 'brief collapsed', frame: 'map-thread', theme: 'dark', act: async (page: Page) => { await page.getByRole('button', { name: 'Topic brief', exact: true }).first().click(); } },
  { name: 'long brief with since cards', frame: 'map-brief-long', theme: 'dark', act: async (page: Page) => { await page.getByRole('button', { name: /^Since you were here ·/ }).click(); } },
  { name: 'long brief with since cards', frame: 'map-brief-long', theme: 'light', act: async (page: Page) => { await page.getByRole('button', { name: /^Since you were here ·/ }).click(); } },
  { name: 'long brief collapsed at 900', frame: 'map-brief-long-small', theme: 'dark', act: async (page: Page) => { await page.getByRole('button', { name: 'Topic brief', exact: true }).click(); } },
] as const) test(`The thread is one unbroken line through the topic cards: ${name} (${frame}, ${theme})`, async ({ page, origin }, testInfo) => {
  await openApp(page, origin, { ...frameSpec(frame), theme });
  await act(page);
  const runs = await railRuns(page);
  expect(runs.off, 'the plain guide is one line from the band to the last item').toHaveLength(1);
  expect(runs.on, 'the accent thread is one line from the band to the selected path').toHaveLength(1);
  for (const run of [runs.off[0]!, runs.on[0]!]) {
    expect(run[0], 'it starts inside the band').toBeLessThanOrEqual(runs.topic.bottom);
    expect(run[1], 'it reaches the first item').toBeGreaterThanOrEqual(runs.first!.top);
  }
  expect(runs.cardsHeight).toBeGreaterThan(0);
  expect(runs.cardsLeft!, 'the cards sit clear of the rail').toBeGreaterThanOrEqual(24);
  await testInfo.attach(`thread-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
});

for (const { map: frame } of mapSizes) test(`A folded topic draws no rail below its band: ${frame}`, async ({ page, origin }) => {
  await openApp(page, origin, frameSpec(frame));
  const group = page.locator('.tree-topic-group').first();
  await group.locator('.tree-topic .tree-chevron').dispatchEvent('click');
  await expect(group.locator('.tree-topic')).toHaveAttribute('aria-expanded', 'false');
  await expect(group.locator('.tree-topic-cards')).toHaveCount(0);
  const below = await group.evaluate(element => {
    const band = element.querySelector('.tree-topic')!.getBoundingClientRect();
    return [...element.querySelectorAll('.tree-guide')].filter(line => line.getBoundingClientRect().height > 0 && line.getBoundingClientRect().bottom > band.bottom + 2).length;
  });
  expect(below).toBe(0);
});

for (const frame of ['map-thread', 'map-thread-small'] as const) for (const theme of ['dark', 'light'] as const) {
  test(`Nothing to catch up on is a check in the brief header, not a box: ${frame} (${theme})`, async ({ page, origin }, testInfo) => {
    await openApp(page, origin, { ...frameSpec(frame), theme });
    await page.locator('.tree-scroll').evaluate(element => { element.scrollTop = 0; });
    await expect(page.getByRole('region', { name: 'Since you were here', exact: true })).toHaveCount(0);
    const brief = page.getByRole('region', { name: 'Topic brief', exact: true }).first();
    const icon = brief.getByRole('img', { name: 'All caught up' });
    await expect(icon).toBeVisible();
    await expect(icon).toHaveAttribute('title', 'All caught up');
    const line = await brief.evaluate(element => {
      const toggle = element.querySelector('button')!.getBoundingClientRect(), mark = element.querySelector('[aria-label="All caught up"]')!.getBoundingClientRect();
      return { sameLine: Math.abs((toggle.top + toggle.height / 2) - (mark.top + mark.height / 2)) < 8, after: mark.left >= toggle.right - 0.5 };
    });
    expect(line).toEqual({ sameLine: true, after: true });
    await testInfo.attach(`caught-up-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
  });
}

for (const size of [{ width: 1280, height: 800 }, { width: 900, height: 650 }] as const) for (const theme of ['dark', 'light'] as const) {
  test(`Caught up keeps Undo beside the check, and changes keep their box: ${size.width}x${size.height} (${theme})`, async ({ page, origin }, testInfo) => {
    await openApp(page, origin, { ...frameSpec('changes-away'), ...size, theme });
    const brief = page.getByRole('region', { name: 'Topic brief', exact: true });
    const since = page.getByRole('region', { name: 'Since you were here', exact: true });
    // While there are changes the box is today's, unchanged.
    await expect(since).toContainText('8 changes while you were away');
    await expect(brief.getByRole('img', { name: 'All caught up' })).toHaveCount(0);
    await testInfo.attach(`has-changes-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
    await since.getByRole('button', { name: 'Mark all seen', exact: true }).click();
    await expect(since).toHaveCount(0);
    const check = brief.getByRole('img', { name: 'All caught up' }), undo = brief.getByRole('button', { name: 'Undo', exact: true });
    await expect(check).toBeVisible(); await expect(undo).toBeVisible();
    const line = await brief.evaluate(element => {
      const toggle = element.querySelector('button')!.getBoundingClientRect(), mark = element.querySelector('[aria-label="All caught up"]')!.getBoundingClientRect();
      const undo = [...element.querySelectorAll('button')].find(button => button.textContent === 'Undo')!.getBoundingClientRect();
      const middle = (rect: DOMRect) => rect.top + rect.height / 2;
      return { oneLine: Math.abs(middle(toggle) - middle(mark)) < 8 && Math.abs(middle(toggle) - middle(undo)) < 8, ordered: toggle.right <= mark.left + 0.5 && mark.right <= undo.left + 0.5 };
    });
    expect(line).toEqual({ oneLine: true, ordered: true });
    await changesFit(brief);
    await testInfo.attach(`caught-up-undo-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
    await undo.click();
    await expect(since).toContainText('8 changes while you were away');
  });
}

/** Graph cards and stubs never overlap one another. */
async function noOverlap(page: Page) {
  const overlaps = await page.locator('.graph-canvas').evaluateAll(canvases => canvases.flatMap(canvas => {
    const boxes = [...canvas.querySelectorAll('.graph-node, .graph-stub')].map(element => ({ name: element.getAttribute('data-item-id') ?? element.getAttribute('data-stub'), rect: element.getBoundingClientRect() }));
    return boxes.flatMap((a, i) => boxes.slice(i + 1).filter(b => Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left) > 1
      && Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top) > 1).map(b => `${a.name} x ${b.name}`));
  }));
  expect(overlaps).toEqual([]);
}

for (const frame of ['graph-hidden', 'graph-hidden-small'] as const) for (const theme of ['dark', 'light'] as const) {
  test(`The Graph folds hidden items into one small stub that opens and folds: ${frame} (${theme})`, async ({ page, origin }, testInfo) => {
    await openApp(page, origin, { ...frameSpec(frame), theme });
    const stubs = page.locator('.graph-stub');
    expect(await stubs.count()).toBeGreaterThan(0);
    await expect(page.locator('.graph-node.is-hidden'), 'hidden items are not drawn as cards').toHaveCount(0);
    const size = await stubs.first().evaluate(stub => {
      const rect = stub.getBoundingClientRect(), card = document.querySelector('.graph-node')!.getBoundingClientRect();
      return { stubWidth: rect.width, stubHeight: rect.height, cardWidth: card.width, cardHeight: card.height };
    });
    expect(size.stubHeight, 'much smaller than a card').toBeLessThan(size.cardHeight / 2);
    expect(size.stubWidth).toBeLessThan(size.cardWidth * 0.75);
    await noOverlap(page);
    const folded = await page.locator('.graph-node').count();
    await stubs.first().scrollIntoViewIfNeeded();
    await expect(stubs.first()).toHaveAttribute('aria-expanded', 'false');
    await stubs.first().click();
    await expect(stubs.first()).toHaveAttribute('aria-expanded', 'true');
    expect(await page.locator('.graph-node').count()).toBeGreaterThan(folded);
    expect(await page.locator('.graph-node.is-hidden').count()).toBeGreaterThan(0);
    await noOverlap(page);
    await testInfo.attach(`graph-stub-open-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
    // The stub is a button: Enter folds again.
    await stubs.first().focus(); await page.keyboard.press('Enter');
    await expect(stubs.first()).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.graph-node.is-hidden')).toHaveCount(0);
    expect(await page.locator('.graph-node').count()).toBe(folded);
    await testInfo.attach(`graph-stub-folded-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
  });
}

for (const { map: frame } of mapSizes) for (const theme of ['dark', 'light'] as const) {
  test(`Focus is left from the focused item's own button, and from its sticky copy once that scrolls away: ${frame} (${theme})`, async ({ page, origin }, testInfo) => {
    await openApp(page, origin, { ...frameSpec(frame), theme });
    const root = page.locator('.tree-item-root:has(.tree-chevron)').first();
    const place = () => root.evaluate(element => {
      const button = element.querySelector('.tree-focus-action')!.getBoundingClientRect(), row = element.getBoundingClientRect();
      return { x: Math.round(button.left - row.left), y: Math.round(button.top - row.top), width: Math.round(button.width), height: Math.round(button.height) };
    });
    const before = await place();
    await root.getByRole('button', { name: /^Focus on / }).click();
    const unfocus = root.getByRole('button', { name: /^Unfocus / });
    await expect(unfocus).toHaveText('Unfocus');
    await expect(page.getByText(/^Focused:/), 'there is no banner').toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Leave Focus' })).toHaveCount(0);
    const after = await place();
    // Same spot, same height and look; only the word is longer.
    expect({ x: after.x, y: after.y, height: after.height }).toEqual({ x: before.x, y: before.y, height: before.height });
    await expect(unfocus).toHaveClass(/tree-focus-action/);
    await expect(page.locator('.tree-item-root')).toHaveCount(1);
    // Scrolled so its own button is under the sticky band, the copy beside the ancestors takes over.
    await page.locator('.tree-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
    const copy = page.getByRole('navigation', { name: 'Map ancestors' }).getByRole('button', { name: /^Unfocus / });
    await expect(copy).toBeVisible();
    const box = (await copy.boundingBox())!, crumbs = (await page.getByRole('navigation', { name: 'Map ancestors' }).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(crumbs.x); expect(box.x + box.width).toBeLessThanOrEqual(crumbs.x + crumbs.width + 0.5);
    expect(box.y).toBeGreaterThanOrEqual(crumbs.y - 0.5); expect(box.y + box.height).toBeLessThanOrEqual(crumbs.y + crumbs.height + 0.5);
    await testInfo.attach(`focus-scrolled-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
    await copy.click();
    await expect(page.locator('.tree-item-root')).not.toHaveCount(1);
    await expect(copy).toHaveCount(0);
    await page.locator('.tree-scroll').evaluate(element => { element.scrollTop = 0; });
    await expect(root.getByRole('button', { name: /^Focus on / })).toHaveText('Focus');
  });
}

for (const frame of ['graph-hidden', 'graph-hidden-small'] as const) for (const theme of ['dark', 'light'] as const) {
  test(`The hidden-items stub shows a whole focus ring under keyboard focus: ${frame} (${theme})`, async ({ page, origin }, testInfo) => {
    await openApp(page, origin, { ...frameSpec(frame), theme });
    const stub = page.locator('.graph-stub').first();
    // The Graph's own keyboard moves (up and down in layout order) reach the stub and scroll it into view themselves.
    await page.locator('.graph-node[aria-selected="true"]').focus();
    const reached = () => stub.evaluate(element => element === document.activeElement);
    for (const key of ['ArrowDown', 'ArrowUp'] as const) for (let step = 0; step < 40 && !(await reached()); step++) { await page.keyboard.press(key); await page.waitForTimeout(40); }
    await expect(stub).toBeFocused();
    expect(await stub.evaluate(element => element.matches(':focus-visible')), 'keyboard focus shows the ring').toBe(true);
    await settle(page);
    const ring = await stub.evaluate(element => {
      const style = getComputedStyle(element), rect = element.getBoundingClientRect();
      const width = parseFloat(style.outlineWidth) || 0, offset = parseFloat(style.outlineOffset) || 0;
      const grow = style.outlineStyle === 'none' ? 0 : width + Math.max(offset, 0);
      const drawn = { left: rect.left - grow, top: rect.top - grow, right: rect.right + grow, bottom: rect.bottom + grow };
      // Every ancestor that clips must still contain the ring.
      const clips: { name: string; left: number; top: number; right: number; bottom: number }[] = [];
      for (let node = element.parentElement; node; node = node.parentElement) {
        const overflow = getComputedStyle(node);
        if (overflow.overflowX === 'visible' && overflow.overflowY === 'visible') continue;
        const box = node.getBoundingClientRect();
        clips.push({ name: node.className || node.tagName, left: box.left, top: box.top, right: box.right, bottom: box.bottom });
      }
      return { style: style.outlineStyle, width, shadow: style.boxShadow, drawn, clips, view: { width: innerWidth, height: innerHeight } };
    });
    await page.screenshot({ path: testInfo.outputPath(`fix1-graph-stub-focus-${frame}-${theme}.png`), animations: 'disabled' });
    const box = (await stub.boundingBox())!;
    await page.screenshot({ path: testInfo.outputPath(`fix1-graph-stub-focus-zoom-${frame}-${theme}.png`), animations: 'disabled',
      clip: { x: Math.max(0, box.x - 40), y: Math.max(0, box.y - 30), width: Math.min(box.width + 80, page.viewportSize()!.width), height: box.height + 60 } });
    expect(ring.style === 'none' ? ring.shadow : ring.style, 'a focus indicator is drawn').not.toBe('none');
    for (const clip of ring.clips) {
      expect(ring.drawn.left, `${clip.name} does not cut the ring on the left`).toBeGreaterThanOrEqual(clip.left - 0.5);
      expect(ring.drawn.right, `${clip.name} does not cut the ring on the right`).toBeLessThanOrEqual(clip.right + 0.5);
      expect(ring.drawn.top, `${clip.name} does not cut the ring at the top`).toBeGreaterThanOrEqual(clip.top - 0.5);
      expect(ring.drawn.bottom, `${clip.name} does not cut the ring at the bottom`).toBeLessThanOrEqual(clip.bottom + 0.5);
    }
  });
}

/** Focus leaves from the sticky Unfocus copy when the focused row is not on screen: filtered out by search, or its topic folded. */
for (const { map: frame } of mapSizes) for (const theme of ['dark', 'light'] as const) for (const state of ['search', 'folded'] as const) {
  test(`The sticky Unfocus is whole and clear of the path row when the focused row is ${state === 'search' ? 'filtered out by search' : 'under a folded topic'}: ${frame} (${theme})`, async ({ page, origin }, testInfo) => {
    await openApp(page, origin, { ...frameSpec(frame), theme });
    const roots = page.locator('.tree-item-root:has(.tree-chevron)'), first = roots.first();
    const topic = page.locator('.tree-topic-group').first().locator('.tree-topic');
    // Something that matches another topic's item only, so the search leaves rows on screen but not the focused one.
    const other = ((await roots.last().locator('.tree-question').textContent()) ?? '').trim().slice(0, 14);
    await first.getByRole('button', { name: /^Focus on / }).click();
    await expect(first.getByRole('button', { name: /^Unfocus / })).toBeVisible();
    if (state === 'search') await page.locator('[data-shell-search]').fill(other);
    else await topic.locator('.tree-chevron').dispatchEvent('click');
    await settle(page);
    const copy = page.getByRole('navigation', { name: 'Map ancestors' }).getByRole('button', { name: /^Unfocus / });
    await expect(copy, 'the exit stays in the path row').toBeVisible();
    await expect(copy).toHaveText('Unfocus');
    const facts = await page.evaluate(() => {
      const box = (element: Element) => element.getBoundingClientRect();
      const copy = document.querySelector('.tree-path .tree-focus-action')!, path = document.querySelector('.tree-path')!, bar = document.querySelector('.tree-breadcrumb')!;
      const others = [...document.querySelectorAll('.tree-breadcrumb button:not(.tree-focus-action), .tree-selected-edge')].map(element => ({ name: element.textContent, rect: box(element) }));
      const centre = document.elementFromPoint(box(copy).left + box(copy).width / 2, box(copy).top + box(copy).height / 2);
      return { copy: box(copy), path: box(path), bar: box(bar), others, covers: !!centre?.closest('.tree-focus-action'), width: innerWidth, height: innerHeight,
        clipped: copy.scrollWidth > copy.clientWidth };
    });
    expect(facts.copy.left).toBeGreaterThanOrEqual(facts.bar.left - 0.5); expect(facts.copy.right).toBeLessThanOrEqual(facts.bar.right + 0.5);
    expect(facts.copy.top).toBeGreaterThanOrEqual(facts.path.top - 0.5); expect(facts.copy.bottom).toBeLessThanOrEqual(facts.path.bottom + 0.5);
    expect(facts.copy.right).toBeLessThanOrEqual(facts.width); expect(facts.copy.bottom).toBeLessThanOrEqual(facts.height);
    expect(facts.clipped, 'the word is not cut off').toBe(false);
    expect(facts.covers, 'nothing paints over it').toBe(true);
    for (const other of facts.others) {
      const apart = other.rect.right <= facts.copy.left + 0.5 || other.rect.left >= facts.copy.right - 0.5 || other.rect.bottom <= facts.copy.top || other.rect.top >= facts.copy.bottom;
      expect(apart, `${other.name} does not overlap Unfocus`).toBe(true);
    }
    await page.screenshot({ path: testInfo.outputPath(`fix1-unfocus-${state}-${frame}-${theme}.png`), animations: 'disabled' });
    await copy.click();
    await expect(copy).toHaveCount(0);
  });
}

/**
 * Graph frames (frames.ts graphShift): where the legend and the Graph body sit in the design against the app.
 * Returns the shifted bands and the strips with no counterpart, in app pixels. Nothing outside the centre column moves.
 */
async function graphBands(page: Page, designPage: Page, card: string, columns: readonly Region[]) {
  const center = columns.find(column => column.name === 'center')!;
  const app = await page.evaluate(() => {
    const legend = document.querySelector('.graph-legend')!, thread = legend.querySelector('[aria-label="Thread to the selected item"]')!;
    const node = document.querySelector('.graph-node[aria-selected="true"]') ?? document.querySelector('.graph-node');
    return { legendTop: legend.getBoundingClientRect().top, legendBottom: legend.getBoundingClientRect().bottom, thread: thread.getBoundingClientRect().top,
      row: node?.getAttribute('data-row') ?? null, node: node?.getBoundingClientRect().top ?? null };
  });
  expect(app.row, 'the Graph has a card to align on').not.toBeNull();
  const design = await designPage.evaluate(({ card, row }) => {
    const root = document.querySelector(`[id="${card}"] .dv-card`)!;
    const filterRow = root.querySelector('[aria-label="Filter"]')!.parentElement!;
    // The card sits at a fractional page offset and the capture clips at the rounded one: measure from that origin.
    const origin = Math.round(root.getBoundingClientRect().y + window.scrollY) - window.scrollY;
    return { thread: root.querySelector('[aria-label="Thread to the selected item"]')!.getBoundingClientRect().top - origin,
      node: root.querySelector(`[data-row="${row}"]`)!.getBoundingClientRect().top - origin,
      filterRowHeight: filterRow.getBoundingClientRect().height };
  }, { card, row: app.row });
  const legend = Math.round(design.thread - app.thread), body = Math.round(design.node - app.node!);
  expect(design.filterRowHeight, 'the handoff filter row has measurable height').toBeGreaterThan(0);
  expect(Math.abs(design.thread - app.thread - design.filterRowHeight), 'the legend moves up by the handoff filter row height').toBeLessThanOrEqual(1);
  expect(body, 'the Graph body moves up by no more than the legend').toBeGreaterThanOrEqual(0); expect(body).toBeLessThanOrEqual(legend);
  const top = Math.round(app.legendTop), under = Math.round(app.legendBottom), foot = center.y + center.height;
  const strip = (name: string, y: number, height: number): Region => ({ name, x: center.x, y, width: center.width, height });
  const band = (name: string, y: number, height: number, dy: number): Shift => ({ ...strip(name, y, height), dy });
  return {
    // The Graph below the legend: app rows from where the design's Graph starts under its legend, up to the last row that has a design row.
    shifts: [band('legend', top, under - top, legend), band('graph', under + legend - body, foot - under - legend, body)],
    masks: [strip('graph newly in view under the legend', under, legend - body), strip('graph newly in view above the footer', foot - body, body)].filter(mask => mask.height > 0),
    legend, body,
  };
}

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
  // The focused item's own button now says Unfocus; there is no banner to leave from.
  await expect(root.getByRole('button', { name: /^Unfocus / })).toBeVisible();
  await expect(page.getByText(/^Focused:/)).toHaveCount(0);
  expect(await page.locator('[data-waiting-item]').count()).toBe(waiting);
  await expect(page.locator(`.tree-item-root:not([data-item-id="${sourceId}"])`)).toHaveCount(0);
  await root.getByRole('button', { name: /^Unfocus / }).click();
  await expect(root.getByRole('button', { name: /^Focus on / })).toBeVisible();
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
    await openApp(page, origin, { ...frameSpec('conversation-four-options'), ...viewport, theme });
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
    const heading = pin.getByRole('heading', { name: /^Your turn ·/ }), question = pin.locator('.conversation-question');
    await expect(conversation.locator('.conversation-header .status-badge')).toHaveText('Waiting on me');
    await expect(page.locator('[data-waiting-item="4.1"]')).toBeVisible();
    if (viewport.width === 1280) for (let index = 0; index < 3; index++) await expect(turns.nth(index), 'at least three messages share the initial chat viewport').toBeInViewport();
    const ownWords = dock.getByRole('textbox', { name: 'Reply in your own words', exact: true });
    const replySend = dock.getByRole('button', { name: 'Send as a reply only', exact: true });
    const fullyVisible = async (control: Locator) => {
      await expect(control).toBeVisible();
      // Sub-pixel scroll positions can leave a fraction of a pixel outside; the clip check below allows 1 px too.
      await expect(control).toBeInViewport({ ratio: 0.98 });
      // A box can be inside the footer while being clipped by a nested scroller.
      const clipped = await control.evaluate(element => {
        const rect = element.getBoundingClientRect(), failures: string[] = [];
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
          const left = bounds.left + parent.clientLeft, top = bounds.top + parent.clientTop;
          if (/auto|scroll|hidden|clip/.test(style.overflowX) && (rect.left < left - 1 || rect.right > left + parent.clientWidth + 1)) failures.push(`${parent.className}: horizontal`);
          if (/auto|scroll|hidden|clip/.test(style.overflowY) && (rect.top < top - 1 || rect.bottom > top + parent.clientHeight + 1)) failures.push(`${parent.className}: vertical`);
        }
        return failures;
      });
      expect(clipped, `${await control.getAttribute('class')} is fully inside every clipping ancestor`).toEqual([]);
    };
    const firstOption = dock.locator('[data-answer-option]').first();
    const choiceSend = dock.getByRole('button', { name: /^Send / }).filter({ hasNotText: 'Send as a reply only' });
    const controls = [heading, question, firstOption, choiceSend, ownWords];
    const assertControls = async (option = firstOption) => {
      const visible = [heading, question, option, choiceSend, ownWords];
      if (await replySend.count()) visible.push(replySend);
      for (const control of visible) await fullyVisible(control);
      const boxes = await Promise.all(visible.map(control => control.boundingBox()));
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!, b = boxes[j]!;
        const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        expect(width > 0.5 && height > 0.5, `pinned controls ${i} and ${j} never paint over one another`).toBe(false);
      }
    };
    await expect(dock.locator('[data-answer-option]')).toHaveCount(4);
    await expect(replySend, 'the reply-only action appears once there are words to send').toHaveCount(0);
    const optionsRegion = dock.locator('.answer-choices');
    expect(await optionsRegion.evaluate(element => element.scrollTop), 'the first option starts at rest without an initial scroll').toBe(0);
    const optionsRoom = await optionsRegion.evaluate(element => {
      const style = getComputedStyle(element);
      return element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    });
    expect(optionsRoom, 'the options viewport fits a complete first choice, including its padding').toBeGreaterThanOrEqual((await firstOption.boundingBox())!.height);
    await assertControls();
    await firstOption.click();
    await assertControls();
    const questionGeometry = await question.locator('.conversation-question-text').evaluate(element => ({ height: element.getBoundingClientRect().height, line: parseFloat(getComputedStyle(element).lineHeight), scroll: element.scrollHeight, client: element.clientHeight }));
    expect(questionGeometry.scroll, 'the fixture actually needs the full-question action').toBeGreaterThan(questionGeometry.client);
    expect(questionGeometry.height, 'the current question initially takes at most two lines').toBeLessThanOrEqual(questionGeometry.line * 2 + 1);
    const scrollers = await dock.evaluate(element => [...element.querySelectorAll<HTMLElement>('*')].filter(child => child.tagName !== 'TEXTAREA' && /auto|scroll/.test(getComputedStyle(child).overflowY)).map(child => child.className));
    expect(scrollers, 'only options own a footer scroller').toEqual(['answer-choices']);
    const optionsStyle = await optionsRegion.evaluate(element => ({ overflow: getComputedStyle(element).overflowY, sticky: [...element.querySelectorAll('*')].some(child => ['sticky', 'fixed'].includes(getComputedStyle(child).position)) }));
    expect(optionsStyle.overflow).toBe('auto'); expect(optionsStyle.sticky).toBe(false);
    const assertWordsRoom = async () => {
      const words = (await ownWords.boundingBox())!, row = (await dock.locator('.answer-conversation-row').boundingBox())!;
      expect(words.width, 'own words always get at least half the composer row').toBeGreaterThanOrEqual(row.width / 2);
    };
    await assertWordsRoom();
    const optionsOverflow = await optionsRegion.evaluate(element => element.scrollHeight > element.clientHeight + 1);
    if (optionsOverflow) {
      await expect(optionsRegion).toHaveAttribute('data-more-below', 'true');
      await expect(optionsRegion).not.toHaveCSS('box-shadow', 'none');
      await optionsRegion.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await expect(optionsRegion).not.toHaveAttribute('data-more-below');
      await expect(optionsRegion).toHaveCSS('box-shadow', 'none');
      await optionsRegion.evaluate(element => { element.scrollTop = 0; });
      await expect(optionsRegion).toHaveAttribute('data-more-below', 'true');
      await assertControls();
    } else {
      await expect(optionsRegion).not.toHaveAttribute('data-more-below');
    }
    if (viewport.height < 700) await expect(dock.locator('.answer-fixed-controls > .answer-hint')).toBeHidden();
    else await expect(dock.locator('.answer-fixed-controls > .answer-hint')).toBeVisible();
    const wordsBox = (await ownWords.boundingBox())!, sendBox = (await choiceSend.boundingBox())!;
    expect(sendBox.y + sendBox.height, 'choice Send shares the own-words row when the width allows').toBeCloseTo(wordsBox.y + wordsBox.height, 0);
    const fixedBeforeQuestion = await Promise.all(controls.map(control => control.boundingBox()));
    await pin.getByRole('button', { name: 'Expand question', exact: true }).click();
    const fullQuestion = page.getByRole('dialog', { name: 'Current question', exact: true });
    await expect(fullQuestion).toBeVisible();
    await expect(fullQuestion.locator('.dialog-body')).not.toBeEmpty();
    expect(await Promise.all(controls.map(control => control.boundingBox())), 'reading the full question cannot move the pinned controls').toEqual(fixedBeforeQuestion);
    await fullQuestion.getByRole('button', { name: 'Close question', exact: true }).click();
    await assertControls();
    const title = conversation.locator('.conversation-title');
    const titleGeometry = await title.evaluate(element => ({ height: element.getBoundingClientRect().height, line: parseFloat(getComputedStyle(element).lineHeight), scroll: element.scrollHeight, client: element.clientHeight }));
    expect(titleGeometry.height, 'the full title initially takes at most two lines').toBeLessThanOrEqual(titleGeometry.line * 2 + 1);
    expect(titleGeometry.scroll, 'the fixture actually needs the full-title action').toBeGreaterThan(titleGeometry.client);
    await settle(page);
    const geometry = await pane.evaluate(element => {
      const pane = element.getBoundingClientRect(), body = element.querySelector('.detail-body')!.getBoundingClientRect();
      const dock = element.querySelector('.detail-dock')!.getBoundingClientRect();
      return { body: body.height / pane.height, dock: dock.height / pane.height,
        bodyBottom: body.bottom, dockTop: dock.top, dockBottom: dock.bottom, paneBottom: pane.bottom };
    });
    // Short windows reserve up to half for the question and fixed controls.
    const footerCap = viewport.height < 700 ? 0.5 : viewport.width <= 1000 ? 0.4 : 0.3;
    expect(geometry.body, 'the transcript keeps most of the conversation pane').toBeGreaterThanOrEqual(1 - footerCap - 0.001);
    expect(geometry.dock, 'the answer footer stays within its responsive cap').toBeLessThanOrEqual(footerCap + 0.001);
    expect(geometry.bodyBottom).toBeLessThanOrEqual(geometry.dockTop + 1);
    expect(geometry.dockBottom).toBeCloseTo(geometry.paneBottom, 0);
    const overlayBox = (await conversation.boundingBox())!, waitingBox = (await page.locator('.shell-waiting').boundingBox())!;
    const tabs = (await page.locator('.shell-tabs').boundingBox())!, footer = (await page.locator('.shell-footer').boundingBox())!;
    expect(overlayBox.x, 'Waiting stays beside the bigger conversation').toBeGreaterThanOrEqual(waitingBox.x + waitingBox.width - 1);
    expect(overlayBox.y).toBeGreaterThanOrEqual(tabs.y + tabs.height - 1);
    expect(overlayBox.x + overlayBox.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(overlayBox.y + overlayBox.height).toBeLessThanOrEqual(footer.y + 1);
    expect(await page.locator('.shell-footer .shell-key').allTextContents()).toEqual([
      'escBack to Map', '↑↓messages', 'aack / answer', 'rreply', '1–9select', '⌥1–9send choice + note', '⌥0focus own words', '⌘↵send', 'b d oitem actions', 'Spacepeek',
    ]);
    await page.screenshot({ path: testInfo.outputPath(`${id}.png`), animations: 'disabled' });
    await ownWords.fill('My note about the retry window');
    await expect(replySend).toBeVisible();
    await assertWordsRoom();
    await assertControls();
    const typedWords = (await ownWords.boundingBox())!;
    if (viewport.width === 900) {
      for (const send of [choiceSend, replySend]) expect((await send.boundingBox())!.y, 'both Send buttons move below the typing box at narrow widths').toBeGreaterThanOrEqual(typedWords.y + typedWords.height);
    }
    expect(await body.evaluate(element => element.scrollHeight > element.clientHeight), 'the long transcript scrolls').toBe(true);
    const footerBefore = await dock.boundingBox(), pinBefore = await pin.boundingBox();
    await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await settle(page);
    expect(await dock.boundingBox(), 'scrolling messages keeps the answer footer pinned').toEqual(footerBefore);
    expect(await pin.boundingBox(), 'the waiting question stays with its answer controls').toEqual(pinBefore);
    // Only the options move: heading, question and both Send actions remain fixed.
    const chatScroll = await body.evaluate(element => element.scrollTop);
    const fixed = [...controls.filter(control => control !== firstOption), replySend];
    const fixedBefore = await Promise.all(fixed.map(control => control.boundingBox()));
    for (const option of await dock.locator('[data-answer-option]').all()) {
      await option.scrollIntoViewIfNeeded(); await assertControls(option);
      expect(await Promise.all(fixed.map(control => control.boundingBox()))).toEqual(fixedBefore);
    }
    expect(await dock.evaluate(element => element.scrollTop)).toBe(0);
    expect(await body.evaluate(element => element.scrollTop)).toBe(chatScroll);
    const fullTitle = await title.textContent();
    await title.click(); await expect(title).toHaveAttribute('aria-expanded', 'true');
    await expect(title).toHaveText(fullTitle!);
    const expandedTitle = await title.evaluate(element => ({ height: element.getBoundingClientRect().height, scroll: element.scrollHeight, client: element.clientHeight }));
    expect(expandedTitle.height).toBeGreaterThan(titleGeometry.height);
    expect(expandedTitle.scroll, 'one click reveals the complete title without clipping').toBeLessThanOrEqual(expandedTitle.client + 1);
  });
}

/** A control is inside the viewport and inside every clipping ancestor (sub-pixel scroll rounding allowed). */
async function fullyVisible(control: Locator) {
  await expect(control).toBeVisible();
  await expect(control).toBeInViewport({ ratio: 0.98 });
  const clipped = await control.evaluate(element => {
    const rect = element.getBoundingClientRect(), failures: string[] = [];
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
      const left = bounds.left + parent.clientLeft, top = bounds.top + parent.clientTop;
      if (/auto|scroll|hidden|clip/.test(style.overflowX) && (rect.left < left - 1 || rect.right > left + parent.clientWidth + 1)) failures.push(`${parent.className}: horizontal`);
      if (/auto|scroll|hidden|clip/.test(style.overflowY) && (rect.top < top - 1 || rect.bottom > top + parent.clientHeight + 1)) failures.push(`${parent.className}: vertical`);
    }
    return failures;
  });
  expect(clipped, `${await control.evaluate(element => element.className || element.tagName)} is fully inside every clipping ancestor`).toEqual([]);
}

interface FooterState {
  readonly name: string;
  /** Recovery rows win over the chat's half of the view at the small size. */
  readonly recovery?: boolean;
  readonly frame?: string;
  readonly prepare?: (page: Page, dock: Locator) => Promise<void>;
  /** The state's own controls and text, fully visible beside the standing controls. */
  readonly shows?: (dock: Locator) => Locator[];
}
const typed = 'My note about the retry window';
/** The frame's fake transport as the page sees it; these callbacks run in the page, so each reads it from `window`. */
interface PageTransport {
  failNext: string | null;
  invoke: (name: string, args: { request: { command?: { command: string } } }) => Promise<unknown>;
  sessions: Map<string, { revision: number; id: string; active_binding_id: string; bindings: Record<string, { owner_paused: boolean; dispatch_state: string; connection_state: string }> }>;
  emit: (event: string, hint: object) => void;
}
type PageWindow = { __designFixture: { transport: PageTransport } };
const pause = (page: Page) => page.evaluate(() => {
  const transport = (window as unknown as PageWindow).__designFixture.transport, session = [...transport.sessions.values()].find(value => value.active_binding_id)!;
  const binding = session.bindings[session.active_binding_id]!;
  binding.owner_paused = true; binding.dispatch_state = 'paused'; ++session.revision;
  transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision });
});
const sendChoice = (dock: Locator) => dock.getByRole('button', { name: /^Send “/ });
const holdSaving = (page: Page) => page.evaluate(() => {
  const transport = (window as unknown as PageWindow).__designFixture.transport, original = transport.invoke.bind(transport);
  transport.invoke = (name, args) => args.request.command?.command === 'input_submit' ? new Promise(() => {}) : original(name, args);
});
/** Loses the response to the first draft save only; background patches such as the seen dwell pass through untouched. */
const failDraftSave = (page: Page) => page.evaluate(() => {
  const transport = (window as unknown as PageWindow).__designFixture.transport, original = transport.invoke.bind(transport);
  let armed = true;
  transport.invoke = (name, args) => {
    const command = args.request.command as { command: string; params?: { entries?: { kind: string }[] } } | undefined;
    if (armed && command?.command === 'preferences_patch' && command.params?.entries?.some(entry => entry.kind === 'upsert_draft')) {
      armed = false;
      return Promise.reject(new Error('Lost response'));
    }
    return original(name, args);
  };
});
const footerStates: readonly FooterState[] = [
  { name: 'clean four options' },
  { name: 'option selected', prepare: async (_page, dock) => { await dock.locator('[data-answer-option]').nth(1).click(); await expect(sendChoice(dock)).toContainText('Use a shorter window'); } },
  { name: 'own words typed', prepare: async (_page, dock) => {
    await dock.getByRole('textbox', { name: 'Reply in your own words', exact: true }).fill(typed);
    await expect(dock.getByRole('button', { name: 'Send as a reply only', exact: true })).toBeVisible();
  }, shows: dock => [dock.getByRole('button', { name: 'Send as a reply only', exact: true })] },
  { name: 'saving', recovery: true, prepare: async (page, dock) => {
    await holdSaving(page);
    await sendChoice(dock).click();
    await expect(dock.locator('.detail-delivery')).toContainText('Sending');
  }, shows: dock => [dock.locator('.detail-delivery'), dock.getByText(/isn’t sure this reply was saved/)] },
  { name: 'uncertain answer', recovery: true, prepare: async (page, dock) => {
    await page.evaluate(() => { (window as unknown as PageWindow).__designFixture.transport.failNext = 'input_submit'; });
    await sendChoice(dock).click();
    await expect(dock.getByText(/isn’t sure this reply was saved/)).toBeVisible();
  }, shows: dock => [dock.getByText(/isn’t sure this reply was saved/), dock.getByRole('button', { name: 'Try sending again', exact: true })] },
  { name: 'error and draft retry', recovery: true, prepare: async (page, dock) => {
    await failDraftSave(page);
    await dock.getByRole('textbox', { name: 'Reply in your own words', exact: true }).fill(typed);
    await expect(dock.getByRole('button', { name: 'Try saving your draft again', exact: true })).toBeVisible();
  }, shows: dock => [dock.getByRole('alert').first(), dock.getByRole('button', { name: 'Try saving your draft again', exact: true })] },
  { name: 'shortcut status alert', recovery: true, frame: 'conversation-reconnecting', prepare: async (page, dock) => {
    await expect(dock.locator('.answer-blocked')).toBeVisible();
    // Workspace keys listen on the view itself, not inside a text field. A blocked session turns the send key into a status line.
    await page.getByRole('region', { name: 'Item conversation', exact: true }).focus();
    await page.keyboard.press('Alt+Digit1');
    await expect(dock.locator('.detail-answer-slot > p[role="alert"]')).toBeVisible();
  }, shows: dock => [dock.locator('.detail-answer-slot > p[role="alert"]'), dock.locator('.answer-blocked')] },
  { name: 'paused', recovery: true, prepare: async (page, dock) => {
    await pause(page);
    await expect(dock.locator('.dispatch-note')).toBeVisible();
  }, shows: dock => [dock.locator('.dispatch-note'), dock.locator('.dispatch-note').getByRole('button', { name: 'Resume' })] },
  { name: 'paused and uncertain answer', recovery: true, prepare: async (page, dock) => {
    await page.evaluate(() => { (window as unknown as PageWindow).__designFixture.transport.failNext = 'input_submit'; });
    await sendChoice(dock).click();
    await expect(dock.getByText(/isn’t sure this reply was saved/)).toBeVisible();
    await pause(page);
    await expect(dock.locator('.dispatch-note')).toBeVisible();
  }, shows: dock => [dock.locator('.dispatch-note'), dock.locator('.dispatch-note').getByRole('button', { name: 'Resume' }), dock.getByText(/isn’t sure this reply was saved/),
    dock.getByRole('button', { name: 'Try sending again', exact: true })] },
  { name: 'actionable notice', prepare: async page => {
    await page.evaluate(() => {
      (window as unknown as { __designNotices: { push: (notice: object) => void } }).__designNotices.push({ id: 'design-unsent', icon: 'ph ph-warning-circle', tone: 'problem', dismissible: true,
        text: 'Your reply was not sent because the conversation moved on. Put it back in the reply box to edit it, or leave it here.',
        actions: [{ label: 'Put back in reply box', run: () => {} }] });
    });
    await expect(page.locator('.pw-notices .pw-note')).toBeVisible();
  } },
  { name: 'one option', frame: 'conversation-one-option' },
  { name: 'short question', frame: 'conversation-short' },
];

for (const viewport of conversationSizes) for (const state of footerStates) {
  const id = `${state.name.replace(/ /g, '-')}-${viewport.width}x${viewport.height}`;
  test(`conversation footer: ${state.name} at ${viewport.width}x${viewport.height}`, async ({ page, origin }, testInfo) => {
    await openApp(page, origin, { ...frameSpec(state.frame ?? 'conversation-four-options'), ...viewport });
    const unfold = page.getByRole('button', { name: /^Show Waiting on me/ });
    if (await unfold.count()) await unfold.click();
    await page.getByRole('button', { name: 'Open the conversation in a bigger view', exact: true }).click();
    const conversation = page.getByRole('region', { name: 'Item conversation', exact: true });
    await expect(conversation).toBeVisible();
    const pane = conversation.locator('.item-detail.item-conversation'), dock = pane.locator('.detail-dock');
    await settle(page);
    await state.prepare?.(page, dock);
    await settle(page);
    // The standing controls, plus whatever the state adds.
    const heading = dock.getByRole('heading', { name: /^Your turn ·/ }), question = dock.locator('.conversation-question');
    const ownWords = dock.getByRole('textbox', { name: 'Reply in your own words', exact: true });
    // Only a recovery state may fold the options away; everywhere else the first option is complete.
    const squeezed = await dock.getAttribute('data-squeezed') !== null;
    if (squeezed) expect(state.recovery, 'the options fold away only for recovery rows').toBe(true);
    const standing = [heading, question, ...squeezed ? [] : [dock.locator('[data-answer-option]').first()], ownWords, dock.getByRole('button', { name: /^Send / }).first()];
    for (const control of [...standing, ...(state.shows?.(dock) ?? [])]) await fullyVisible(control);
    // Every row of the footer: inside it, never under another row, never under a notice, and the footer itself never scrolls.
    const geometry = await pane.evaluate((element, recovery) => {
      const dock = element.querySelector<HTMLElement>('.detail-dock')!, dockBox = dock.getBoundingClientRect();
      const rows = [...dock.querySelectorAll<HTMLElement>('.detail-delivery, .dispatch-note, [role="alert"], .answer-warn, .conversation-pin, .answer-choices, .answer-fixed-controls, .detail-answer-retry, .detail-error, .answer-blocked, .detail-answer-slot > button, .detail-answer-slot > p')]
        .filter(row => row.getClientRects().length > 0 && !(row.matches('.answer-choices') && row.clientHeight === 0));
      const boxes = rows.map(row => { const box = row.getBoundingClientRect(); return { name: row.className || row.tagName, top: box.top, bottom: box.bottom, left: box.left, right: box.right }; });
      const overlaps: string[] = [];
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!, b = boxes[j]!;
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5) overlaps.push(`${a.name} / ${b.name}`);
      }
      const outside = boxes.filter(box => box.top < dockBox.top - 1 || box.bottom > dockBox.bottom + 1 || box.left < dockBox.left - 1 || box.right > dockBox.right + 1).map(box => box.name);
      const controls = [...element.closest('.conversation-view')!.querySelectorAll<HTMLElement>('.conversation-header .btn, .detail-dock button, .detail-dock textarea, .detail-dock .answer-choices, .detail-dock p, .detail-dock h3')]
        .filter(control => control.getClientRects().length > 0).map(control => ({ name: control.className || control.tagName, box: control.getBoundingClientRect() }));
      const notices = [...document.querySelectorAll('.pw-notices .pw-note')].map(note => note.getBoundingClientRect());
      const covered = notices.flatMap(note => controls.filter(({ box }) => Math.min(box.right, note.right) - Math.max(box.left, note.left) > 0.5
        && Math.min(box.bottom, note.bottom) - Math.max(box.top, note.top) > 0.5).map(control => control.name));
      const pane = element.getBoundingClientRect(), chat = element.querySelector('.detail-body')!.getBoundingClientRect();
      const scrollers = [...dock.querySelectorAll<HTMLElement>('*')].filter(child => child.tagName !== 'TEXTAREA' && /auto|scroll/.test(getComputedStyle(child).overflowY)).map(child => child.className);
      return { overlaps, outside, covered, notices: notices.length, scrollers, dockScrolls: dock.scrollHeight - dock.clientHeight > 1,
        chat: chat.height / pane.height, dock: dockBox.height / pane.height, recovery, firstRow: dock.querySelector<HTMLElement>('.answer-card')?.getBoundingClientRect().height ?? 0 };
    }, state.recovery ?? false);
    expect(geometry.overlaps, 'no footer row paints over another').toEqual([]);
    expect(geometry.outside, 'every footer row is inside the footer').toEqual([]);
    expect(geometry.covered, 'no notice covers a footer control or Back to Map').toEqual([]);
    if (state.name === 'actionable notice') expect(geometry.notices).toBeGreaterThan(0);
    expect(geometry.scrollers.filter(name => name !== 'answer-choices'), 'only the options region scrolls').toEqual([]);
    expect(geometry.dockScrolls, 'the footer is not itself a scroller').toBe(false);
    // The chat keeps about half the view; recovery rows may take more of the small view.
    expect(geometry.chat, 'the chat keeps its room').toBeGreaterThanOrEqual(state.recovery && viewport.width === 900 ? 0.3 : 0.5 - 0.02);
    const regions = await pane.evaluate(element => { const region = element.querySelector<HTMLElement>('.detail-dock .answer-choices'); return region && { client: region.clientHeight, scroll: region.scrollHeight }; });
    if (state.name === 'one option') {
      expect(regions, 'one option needs no scrolling').toMatchObject({});
      expect(regions!.scroll, 'the footer shrinks to its content: the options region holds exactly the one option').toBeLessThanOrEqual(regions!.client + 1);
      expect(regions!.client, 'no slack under the single option').toBeLessThanOrEqual(geometry.firstRow + 8);
    }
    if (state.name === 'short question') {
      await expect(dock.locator('.conversation-question-toggle'), 'a question that fits has no expand control').toHaveCount(0);
      await expect(conversation.getByRole('button', { name: /^(Expand|Collapse) title/ }), 'a title that fits has no expand control').toHaveCount(0);
    } else if (!state.frame) {
      await expect(dock.locator('.conversation-question-toggle')).toHaveCount(1);
      await expect(conversation.getByRole('button', { name: /^Expand title/ })).toHaveCount(1);
    }
    await page.screenshot({ path: testInfo.outputPath(`footer-${id}.png`), animations: 'disabled' });
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
  await conversation.focus();
  for (const shortcut of ['Meta+j', 'Meta+e', 'x', 'z', 'Backspace', 'g', 'e', 'r', 'a', 'ArrowDown', 'ArrowUp']) {
    await page.keyboard.press(shortcut);
    await unchanged();
    // Leave any answer control's roving focus before the next workspace key.
    await conversation.focus();
  }
  await expect(page.getByRole('dialog', { name: /Recent/ })).toHaveCount(0);
  await conversation.getByRole('button', { name: 'Back to Map', exact: true }).click();
  await expect(conversation).toHaveCount(0);
  await expect(page.locator('.shell-center')).not.toHaveAttribute('inert', '');
  await expect(page.locator('.shell-detail .item-detail')).toHaveAttribute('data-detail-item-id', '3.1');
  await unchanged();
  await page.getByRole('button', { name: 'Open the conversation in a bigger view', exact: true }).click();
  await waiting.locator('.waiting-question').click();
  await unchanged();
  await conversation.focus(); await page.keyboard.press('Escape');
  await expect(conversation).toHaveCount(0);
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
    // Graph frames compare the legend and the Graph with the intended move applied (frames.ts graphShift); the rest as is.
    const graph = graphFrame(spec) ? await graphBands(page, designPage, card, columns) : null;
    try {
      await captureFrame(canvas, { id, design, app, directory: output, threshold: (thresholds as Record<string, number>)[id] ?? 0,
        regions: columns, masks: [...(mask ? [mask] : []), ...(graph?.masks ?? [])], shifts: graph?.shifts ?? [],
        report: result => ({ masked: mask ? { region: mask, reason: detailMask.reason } : null,
          shifted: graph ? { reason: graphShift.reason, legend: graph.legend, graph: graph.body, bands: graph.shifts, masks: graph.masks } : null,
          columns: Object.fromEntries(columns.map((column, at) => [column.name, Number(result.regions[at].toFixed(4))])),
          size: { width: result.width, height: result.height }, viewport: { width: spec.width, height: spec.height }, shell }),
        // Written into the frame's JSON, then asserted empty after the capture: a blocked request still leaves the frame, its diff and its JSON as evidence.
        denied });
    } finally { await canvas.close(); }
  }
}
