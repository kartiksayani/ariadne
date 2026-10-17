// App-only layout checks on the handoff fixtures (frames.ts): the Map, the Graph and the changes cards in the real DesktopApp, in
// the states the v2 handoff drew. The v2 board's own frames (whole-screen comparisons against Ariadne Mockups.dc.html) are retired:
// the final board (final.spec.mts, final-frames.ts) holds the redesigned screens to the new design instead.
import { test as base, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { dockFrameIds, frameNow, frameSpec, graphFrame, type FrameSpec } from './frames';
import { startDesignServer } from './server.mts';
import { prefix, sourceRoot } from './source.mts';
import { changeNames, interpretation, longDecided, ownerWords } from './changes-fixture';

const served = resolve(sourceRoot, prefix);
const contentTypes: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.md': 'text/markdown' };

const test = base.extend<Record<never, never>, { origin: string }>({
  origin: [async ({ browserName }, use) => {
    expect(browserName).toBe('chromium');
    // Warmed before the first test, so no test pays the cold transform inside its render wait.
    const { server, origin } = await startDesignServer();
    try { await use(origin); } finally { await server.close(); }
  }, { scope: 'worker', timeout: 240_000 }],
});

/** Serves the unzipped handoff at /source/ (the gallery reads its prototype data from it); blocks every other origin. */
async function route(context: BrowserContext, origin: string, denied: string[]) {
  await context.route('**/*', async request => {
    const url = request.request().url();
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
  const denied: string[] = [];
  await route(page.context(), origin, denied);
  await page.setViewportSize({ width: spec.width, height: spec.height });
  await page.clock.setFixedTime(frameNow(spec));
  const params = new URLSearchParams({ frame: spec.id, theme: spec.theme });
  await page.goto(`${origin}/tests/ui/design/gallery.html?${params}`);
  await page.waitForFunction(() => (window as { __designError?: string }).__designError
    || (document.getElementById('root')?.innerText.length ?? 0) > 40, null, { timeout: 60_000 });
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
  if (graphFrame(spec)) {
    await row(spec.selected).focus();
    if (spec.selected && !spec.detail) await page.keyboard.press('Escape');
    await page.keyboard.press('g');
  }
  await settle(page);
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
  // The Back-to pill (SPEC §5.8) floats over the Map in the scroller's shell, never inside the scroller, never in the Graph.
  if (graphFrame(spec)) {
    await expect(page.locator('.tree-back')).toHaveCount(0);
  } else if (await page.locator('.tree-scroll').count()) {
    await expect(page.locator('.tree-selected-slot')).toHaveCount(0);
    await expect(page.locator('.tree-scroll .tree-back')).toHaveCount(0);
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
      children: [...element.querySelectorAll('.change-name, .change-read-as, .brief-text, .change-comparison, .changes-seen')].map(child => {
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

/** The band's changes slot (W3) hosts ChangesOpener; until it is merged nothing opens What changed in the app. Flip this then. */
const BAND_HOST_LANDED = false;

/** Opens the band's What changed popover (D18) over the Map and returns it. */
async function openChanges(page: Page) {
  test.fixme(!BAND_HOST_LANDED, 'needs W3 band host');
  await page.getByRole('button', { name: /new|changed|changes since/ }).first().click();
  const popover = page.getByRole('dialog', { name: 'What changed', exact: true });
  await expect(popover).toBeVisible();
  return popover;
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
    await openChanges(page);
    const sinceCard = page.getByRole('dialog', { name: 'What changed', exact: true }).getByTestId('changes-row')
      .filter({ has: page.getByRole('button', { name: 'Retry schedule', exact: true }) });
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
    const brief = (await openChanges(page)).getByRole('region', { name: 'Topic brief', exact: true });
    await brief.getByRole('button', { name: /Brief/ }).click();
    await expect(brief).toContainText('by the agent · updated');
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

  test(`M2 a row marked Seen stays, dimmed, until the popover closes (${theme})`, async ({ page, origin }) => {
    await openApp(page, origin, { ...frameSpec('changes-typed'), theme });
    const popover = await openChanges(page);
    const card = popover.getByTestId('changes-row').filter({ has: page.getByRole('button', { name: 'Retry schedule', exact: true }) });
    await changesFit(card);
    await card.getByRole('button', { name: 'Mark Retry schedule seen', exact: true }).click();
    await expect(card.getByRole('button', { name: 'Retry schedule is seen', exact: true })).toBeDisabled();
    await expect(card.getByTestId('change-marker')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await expect(page.locator('[data-item-id="3.9"]')).toContainText('Recovery question');
    const again = await openChanges(page);
    await expect(again.getByRole('button', { name: 'Retry schedule', exact: true })).toHaveCount(0);
  });

  test(`M2 long absence leads with a calm summary, then the brief, and offers reversible catch-up (${theme})`, async ({ page, origin }, testInfo) => {
    await openApp(page, origin, { ...frameSpec('changes-away'), theme });
    const popover = await openChanges(page);
    const away = popover.getByRole('region', { name: 'While you were away', exact: true });
    const brief = popover.getByRole('region', { name: 'Topic brief', exact: true });
    await expect(away).toContainText('You were away since');
    const awayBox = await away.boundingBox(), briefBox = await brief.boundingBox();
    expect(awayBox).not.toBeNull(); expect(briefBox).not.toBeNull();
    expect(awayBox!.y + awayBox!.height).toBeLessThan(briefBox!.y);
    await changesFit(away);
    await away.getByRole('button', { name: 'Read the brief', exact: true }).click();
    await changesFit(brief);
    await away.getByRole('button', { name: 'Mark all caught up', exact: true }).click();
    // Caught up: the popover says so, and Undo is beside it and in the band while it is offered.
    await expect(popover.getByText(/All caught up\. The markers are cleared/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
    await testInfo.attach(`changes-caught-up-undo-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
    await popover.getByRole('button', { name: '↺ Undo', exact: true }).click();
    await expect(away).toContainText('You were away since');
    await expect(brief.locator('.brief-list').nth(1).locator('.change-name')).toHaveText(['Recovery question']);
    await testInfo.attach(`changes-away-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
  });
}

/** Layout tests of the Map's topic cards, chevrons, filter row and rails (A16 owner reports). */
const mapSizes = [{ brief: 'map-brief-long', map: 'map-thread' }, { brief: 'map-brief-long-small', map: 'map-thread-small' }] as const;

for (const { brief: frame } of mapSizes) for (const theme of ['dark', 'light'] as const) {
  test(`Topic brief names flow across the width instead of one per line: ${frame} (${theme})`, async ({ page, origin }, testInfo) => {
    await openApp(page, origin, { ...frameSpec(frame), theme });
    const brief = (await openChanges(page)).getByRole('region', { name: 'Topic brief', exact: true });
    await brief.getByRole('button', { name: /Brief/ }).click();
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
      // The answer dock floats over the foot of the Map: a chip under it is covered by the dock, not by the rail.
      const dockTop = document.querySelector('.answer-dock')?.getBoundingClientRect().top ?? innerHeight;
      return { opaque: chip.every((value, at) => value === over[at]), contrast: (high + 0.05) / (low + 0.05), caret: parseFloat(caret.fontSize),
        width: box.width, height: box.height, covers: !!centre?.closest('.tree-chevron'), hidden: box.bottom < 0 || box.bottom > dockTop };
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

for (const { map: frame } of mapSizes) test(`The Back-to pill floats inside the Map, clear of the path row and the ancestors: ${frame}`, async ({ page, origin }) => {
  await openApp(page, origin, frameSpec(frame));
  await page.locator('.tree-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await settle(page);
  const tag = page.locator('.tree-scroll-shell > .tree-back');
  await expect(tag).toBeVisible();
  const boxes = await page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const crumbs = [...document.querySelectorAll('.tree-breadcrumb button')].map(button => button.getBoundingClientRect());
    return { path: box('.tree-path'), crumbs: box('.tree-breadcrumb'), tag: box('.tree-back'), buttons: crumbs, scroller: box('.tree-scroll') };
  });
  // The pill sits over the rows, below the path row, inside the Map's width; the ancestors keep the whole path row.
  expect(boxes.tag.top).toBeGreaterThanOrEqual(boxes.path.bottom - 0.5);
  expect(boxes.tag.left).toBeGreaterThanOrEqual(boxes.scroller.left - 0.5);
  expect(boxes.tag.right).toBeLessThanOrEqual(boxes.scroller.right + 0.5);
  expect(boxes.path.height).toBeLessThanOrEqual(28.5);
  expect(boxes.path.bottom).toBeLessThanOrEqual(boxes.scroller.top + 0.5);
  for (const button of boxes.buttons) expect(button.right).toBeLessThanOrEqual(boxes.crumbs.right + 0.5);
});

/** The selected path and the plain guide must each run as one line from the topic band down to the first item. */
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
    const first = group.querySelector('[data-item-id]')?.getBoundingClientRect();
    return { off: runs(false), on: runs(true), topic: { top: topic.top, bottom: topic.bottom }, first: first ? { top: first.top, bottom: first.bottom } : null };
  });
}
for (const { map: frame } of mapSizes) for (const theme of ['dark', 'light'] as const) {
  test(`The thread is one unbroken line from the band to the first item: ${frame} (${theme})`, async ({ page, origin }, testInfo) => {
    await openApp(page, origin, { ...frameSpec(frame), theme });
    const runs = await railRuns(page);
    expect(runs.off, 'the plain guide is one line from the band to the last item').toHaveLength(1);
    expect(runs.on, 'the accent thread is one line from the band to the selected path').toHaveLength(1);
    for (const run of [runs.off[0]!, runs.on[0]!]) {
      expect(run[0], 'it starts inside the band').toBeLessThanOrEqual(runs.topic.bottom);
      expect(run[1], 'it reaches the first item').toBeGreaterThanOrEqual(runs.first!.top);
    }
    expect(runs.first!.top - runs.topic.bottom, 'no line of its own sits between the band and the first item').toBeLessThanOrEqual(12);
    await testInfo.attach(`thread-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
  });
}

for (const { map: frame } of mapSizes) test(`A folded topic draws no rail below its band: ${frame}`, async ({ page, origin }) => {
  await openApp(page, origin, frameSpec(frame));
  const group = page.locator('.tree-topic-group').first();
  await group.locator('.tree-topic .tree-chevron').dispatchEvent('click');
  await expect(group.locator('.tree-topic')).toHaveAttribute('aria-expanded', 'false');
  const below = await group.evaluate(element => {
    const band = element.querySelector('.tree-topic')!.getBoundingClientRect();
    return [...element.querySelectorAll('.tree-guide')].filter(line => line.getBoundingClientRect().height > 0 && line.getBoundingClientRect().bottom > band.bottom + 2).length;
  });
  expect(below).toBe(0);
});

for (const size of [{ width: 1280, height: 800 }, { width: 900, height: 650 }] as const) for (const theme of ['dark', 'light'] as const) {
  test(`The What changed popover fits the window, never holds the Map, and keeps Undo reachable: ${size.width}x${size.height} (${theme})`, async ({ page, origin }, testInfo) => {
    await openApp(page, origin, { ...frameSpec('changes-away'), ...size, theme });
    const rowTop = () => page.locator('[data-item-id]').first().evaluate(element => element.getBoundingClientRect().top);
    const before = await rowTop();
    const popover = await openChanges(page);
    expect(await rowTop(), 'opening it moves nothing in the Map').toBe(before);
    const box = (await popover.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(size.width);
    expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(size.height);
    await changesFit(popover.locator('.changes-body'));
    await testInfo.attach(`has-changes-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
    await popover.getByRole('button', { name: 'Mark all caught up', exact: true }).click();
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeVisible();
    await testInfo.attach(`caught-up-undo-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
    await popover.getByRole('button', { name: '↺ Undo', exact: true }).click();
    await expect(popover).toContainText('You were away since');
    expect(await rowTop(), 'catching up and undoing move nothing in the Map').toBe(before);
  });
}

/** Graph nodes never overlap one another. */
async function noOverlap(page: Page) {
  const overlaps = await page.locator('.graph-canvas').evaluateAll(canvases => canvases.flatMap(canvas => {
    const boxes = [...canvas.querySelectorAll('.graph-node')].map(element => ({ name: element.getAttribute('data-item-id'), rect: element.getBoundingClientRect() }));
    return boxes.flatMap((a, i) => boxes.slice(i + 1).filter(b => Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left) > 1
      && Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top) > 1).map(b => `${a.name} x ${b.name}`));
  }));
  expect(overlaps).toEqual([]);
}

for (const frame of ['graph-hidden', 'graph-hidden-small'] as const) for (const theme of ['dark', 'light'] as const) {
  test(`The Graph draws no hidden item but the selected route, with no stub and no overlap: ${frame} (${theme})`, async ({ page, origin }, testInfo) => {
    await openApp(page, origin, { ...frameSpec(frame), theme });
    await expect(page.locator('.graph-stub')).toHaveCount(0);
    const selected = (await page.locator('.graph-node[aria-selected="true"]').getAttribute('data-item-id'))!;
    const route = selected.split('.').map((_part, index, parts) => parts.slice(0, index + 1).join('.'));
    const hidden = await page.locator('.graph-node.is-hidden').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-item-id')!));
    for (const id of hidden) expect(route, `${id} is hidden and drawn only on the selected route`).toContain(id);
    await noOverlap(page);
    await testInfo.attach(`graph-hidden-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
  });
}

for (const frame of ['graph-hidden', 'graph-hidden-small'] as const) for (const theme of ['dark', 'light'] as const) {
  test(`A node reached by keys shows its whole selection ring: ${frame} (${theme})`, async ({ page, origin }, testInfo) => {
    await openApp(page, origin, { ...frameSpec(frame), theme });
    // The Graph's own keyboard moves (up and down in layout order) scroll the target into view themselves.
    await page.locator('.graph-node[aria-selected="true"]').focus();
    for (let step = 0; step < 6; step++) { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(40); }
    const target = page.locator('.graph-node[aria-selected="true"]');
    await expect(target).toBeFocused();
    await settle(page);
    const ring = await target.evaluate(element => {
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
    await page.screenshot({ path: testInfo.outputPath(`graph-node-focus-${frame}-${theme}.png`), animations: 'disabled' });
    const box = (await target.boundingBox())!;
    await page.screenshot({ path: testInfo.outputPath(`graph-node-focus-zoom-${frame}-${theme}.png`), animations: 'disabled',
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

/** Focus leaves from the sticky Unfocus copy when the focused row is not on screen: its topic folded. (A search no longer
 * takes a row off screen, SPEC §4, so it is no longer a way here; tests/ui/tree/component.test.tsx pins that the row stays.) */
for (const { map: frame } of mapSizes) for (const theme of ['dark', 'light'] as const) for (const state of ['folded'] as const) {
  test(`The sticky Unfocus is whole and clear of the path row when the focused row is under a ${state} topic: ${frame} (${theme})`, async ({ page, origin }, testInfo) => {
    await openApp(page, origin, { ...frameSpec(frame), theme });
    const roots = page.locator('.tree-item-root:has(.tree-chevron)'), first = roots.first();
    const topic = page.locator('.tree-topic-group').first().locator('.tree-topic');
    await first.getByRole('button', { name: /^Focus on / }).click();
    await expect(first.getByRole('button', { name: /^Unfocus / })).toBeVisible();
    await topic.locator('.tree-chevron').dispatchEvent('click');
    await settle(page);
    const copy = page.getByRole('navigation', { name: 'Map ancestors' }).getByRole('button', { name: /^Unfocus / });
    await expect(copy, 'the exit stays in the path row').toBeVisible();
    await expect(copy).toHaveText('Unfocus');
    const facts = await page.evaluate(() => {
      const box = (element: Element) => element.getBoundingClientRect();
      const copy = document.querySelector('.tree-path .tree-focus-action')!, path = document.querySelector('.tree-path')!, bar = document.querySelector('.tree-breadcrumb')!;
      const others = [...document.querySelectorAll('.tree-breadcrumb button:not(.tree-focus-action), .tree-back')].map(element => ({ name: element.textContent, rect: box(element) }));
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

test.describe.configure({ mode: 'parallel' });

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
  // The status is the end cluster's badge slot, level with the title's first line (alpha.20 C4).
  const title = root.locator('.tree-question'), status = root.locator('.tree-end > .tree-end-badge');
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
    const composer = dock.getByRole('textbox', { name: 'Reply message', exact: true });
    await expect(composer).toHaveValue('');
    await expect(composer).toBeInViewport();
    const lines = await composer.evaluate(element => {
      const style = getComputedStyle(element);
      return { height: element.getBoundingClientRect().height, minimum: parseFloat(style.minHeight), line: parseFloat(style.lineHeight),
        padding: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom), border: parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth) };
    });
    expect(lines.height, 'resting composer is one line').toBeLessThanOrEqual(Math.max(lines.minimum, Math.ceil(lines.line + lines.padding + lines.border)));
    await expect(dock.getByRole('button', { name: 'Ack → Decided', exact: true })).toBeInViewport();
    await expect(dock.getByRole('button', { name: 'Reply', exact: true })).toBeInViewport();
    await expect(dock.getByRole('button', { name: 'Later', exact: true })).toBeInViewport();
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
    expect(geometry.conversation, `visible resting Conversation at ${spec.width}×${spec.height}`).toBeGreaterThanOrEqual(0.70);
    expect(geometry.dock, 'dock uses at most 40% of the pane').toBeLessThanOrEqual(0.40);
    if (spec.dockState === 'pending') expect(geometry.dock, 'pending Open dock uses at most 25% of the portrait pane').toBeLessThanOrEqual(0.25);
    expect(geometry.bodyBottom).toBeLessThanOrEqual(geometry.dockTop + 1);
    expect(geometry.dockBottom).toBeLessThanOrEqual(geometry.paneBottom + 1);
    await testInfo.attach('dock geometry', { body: JSON.stringify({ viewport: { width: spec.width, height: spec.height }, ...geometry }, null, 2), contentType: 'application/json' });
    await page.screenshot({ path: testInfo.outputPath(`${id}.png`), animations: 'disabled' });
    expect(denied).toEqual([]);
  });
}
