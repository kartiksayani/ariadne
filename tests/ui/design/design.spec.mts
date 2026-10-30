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

/**
 * The chip row (SPEC 6.10), where the frame shows it: toggle buttons named "<status> <count>" (alpha.24: "<status> 0, N more hidden"
 * when items hide behind the chip), no menu button and no combobox. Only a frame whose fixture is empty or all hidden may have no
 * chip, and then the strip says "Nothing to filter" instead of drawing an empty strip; a populated frame with no chip fails.
 */
async function chipStrip(page: Page, spec: FrameSpec) {
  const filters = page.getByRole('group', { name: 'Filter items' });
  if (!await filters.count()) return;
  const chips = filters.getByRole('button', { name: /\d( more hidden)?$/ });
  if (spec.state === 'empty' || spec.allHidden) {
    if (await chips.count()) await expect(chips.first()).toBeVisible();
    else await expect(filters).toContainText('Nothing to filter');
  } else await expect(chips.first()).toBeVisible();
  await expect(filters.getByRole('button', { name: /^Filter/ })).toHaveCount(0);
  await expect(filters.getByRole('combobox')).toHaveCount(0);
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
  await chipStrip(page, spec);
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
      children: [...element.querySelectorAll('.change-name, .because-read, .brief-line, .change-comparison, .changes-seen')].map(child => {
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

/**
 * Whether a strike really draws on `target`. A strike that a <del> passes down to a nested list item, link or chip is not in the
 * descendant's computed style, so this compares the target's pixels with and without the decoration of `struck` (the element that holds it).
 */
async function strikeDrawn(target: Locator, struck: Locator, expected: boolean) {
  await target.scrollIntoViewIfNeeded();
  const withStrike = await target.screenshot({ animations: 'disabled' });
  await struck.evaluate(element => element.style.setProperty('text-decoration', 'none', 'important'));
  const without = await target.screenshot({ animations: 'disabled' });
  await struck.evaluate(element => element.style.removeProperty('text-decoration'));
  expect(withStrike.equals(without), expected ? 'the strike draws on it' : 'nothing is struck on it').toBe(!expected);
}

/** Opens the band's What changed popover (D18) over the Map and returns it. */
async function openChanges(page: Page) {
  await page.getByRole('button', { name: /new|changed|\d+ changes/ }).first().click();
  const popover = page.getByRole('dialog', { name: 'What changed', exact: true });
  await expect(popover).toBeVisible();
  return popover;
}

/** The Details change box starts collapsed (alpha.27): open it to read its rows. Clicks only while it is closed. */
async function openChangeBox(box: Locator) {
  const toggle = box.getByRole('button', { name: /^Changed (at|since you looked)/ });
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  return box;
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
    // The Because card (SPEC 6.8): "You wrote" above "Read as", then the effects as a ruled list, five of them before "and N more".
    await expect(answer.locator('.because-words')).toHaveText(ownerWords);
    await expect(answer.locator('.because-read')).toHaveText(interpretation.replace(/^Read as:\s*/, ''));
    const words = await answer.locator('.because-words').boundingBox(), read = await answer.locator('.because-read').boundingBox();
    expect(words).not.toBeNull(); expect(read).not.toBeNull();
    expect(words!.y + words!.height).toBeLessThanOrEqual(read!.y);
    expect(await answer.locator('.because-words').evaluate(element => getComputedStyle(element).whiteSpace)).toBe('pre-wrap');
    await expect(answer.locator('.because-effect')).toHaveCount(5);
    await answer.getByRole('button', { name: 'and 3 more', exact: true }).click();
    await expect(answer.locator('.because-effect')).toHaveCount(8);
    expect(await answer.locator('.change-name').allTextContents()).toEqual(expect.arrayContaining(changeNames));
    await changesFit(answer);
    const answerControl = await compactCompare(answer);
    // The change box on the item itself draws before → after inline, and its older history is a timeline behind one toggle.
    const current = page.getByTestId('change-box');
    await current.scrollIntoViewIfNeeded();
    await openChangeBox(current);
    await expect(current.locator('.change-row del').first()).toBeVisible();
    await changesFit(current);
    await current.getByRole('button', { name: /^Older history/ }).click();
    const older = current.locator('.change-event').first();
    await expect(older).toContainText('not counted as a change');
    const timelineLink = older.getByRole('button', { name: 'Before → after', exact: true });
    await expect(timelineLink).toBeVisible();
    const linkSize = (link: Locator) => link.evaluate(element => { const rect = element.getBoundingClientRect(); return { width: rect.width, height: rect.height }; });
    const timelineSize = await linkSize(timelineLink);
    await openChanges(page);
    const sinceCard = page.getByRole('dialog', { name: 'What changed', exact: true }).getByTestId('changes-row')
      .filter({ has: page.getByRole('button', { name: 'Retry schedule', exact: true }) });
    // The popover's rows use the board's "› Before → after" line instead of the compact icon (SPEC 5.3).
    const sinceLink = sinceCard.getByRole('button', { name: 'Before → after', exact: true });
    await expect(sinceLink).toHaveAttribute('aria-expanded', 'false');
    // One control, one size: the timeline's "Before → after" is the popover's, and the answer card's compact control keeps its own 24-32 px target.
    expect(await linkSize(sinceLink)).toEqual(timelineSize);
    const sinceComparison = page.locator(`[id="${await sinceLink.getAttribute('aria-controls')}"]`);
    await sinceLink.click();
    await expect(sinceComparison.locator('del').first()).toBeVisible();
    await expect(sinceComparison.locator('mark').first()).toBeVisible();
    await expect(sinceCard.getByRole('button', { name: 'Hide before → after', exact: true })).toBeVisible();
    await changesFit(sinceCard);
    expect(answerControl.width).toBeGreaterThanOrEqual(24);
    await testInfo.attach(`changes-comparisons-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
  });

  /**
   * Alpha.27: the change box starts collapsed to one head line, "› Changed at 20:51 · Notes" (the same text unseen and seen) with Mark seen at the right.
   * jsdom has no layout, so the pixels are checked here: one line (the head's 26px), the summary giving way before the title when the
   * box is narrow, Mark seen beside the toggle and never over it, and the head the same height unseen and seen.
   */
  test(`The collapsed change box is one line: caret, title, field names, Mark seen at the right (${theme})`, async ({ page, origin }, testInfo) => {
    await openApp(page, origin, { ...frameSpec('changes-notes'), theme });
    const box = page.getByTestId('change-box');
    await box.scrollIntoViewIfNeeded();
    const toggle = box.getByRole('button', { name: /^Changed (at|since you looked)/ });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(box.getByTestId('change-row-value')).toHaveCount(0);
    const head = async () => box.evaluate(element => {
      const rect = (target: Element | null) => target?.getBoundingClientRect() ?? null;
      const button = element.querySelector('.change-box-toggle')!, title = element.querySelector('.change-box-title-text')!, summary = element.querySelector('.change-box-summary')!;
      const mark = element.querySelector('.change-box-mark'), headBox = element.querySelector('.change-box-head')!;
      const overflowing = (target: Element) => target.scrollWidth > target.clientWidth;
      return { state: element.getAttribute('data-state'), head: rect(headBox)!.height, toggle: rect(button)!.height, toggleRight: rect(button)!.right,
        boxRight: rect(element)!.right, markLeft: rect(mark)?.left ?? null, markRight: rect(mark)?.right ?? null, caret: button.firstElementChild!.className,
        text: button.textContent, summaryWidth: rect(summary)!.width, boxWidth: rect(element)!.width, spare: rect(button)!.width - (rect(summary)!.right - rect(button.firstElementChild)!.left),summaryTop: rect(summary)!.top, titleTop: rect(title)!.top, summaryCut: overflowing(summary), titleCut: overflowing(title),
        overflow: element.scrollWidth - element.clientWidth };
    });
    const measure = (state: string, size: Awaited<ReturnType<typeof head>>) => {
      expect(size.state).toBe(state);
      expect(size.toggle, 'one line: the toggle is at most the head\'s 26px').toBeLessThanOrEqual(26.5);
      expect(size.head).toBeLessThanOrEqual(26.5);
      expect(size.caret).toContain('ph-caret-right');
      expect(size.text).toMatch(/ · Notes$/);
      expect(Math.abs(size.summaryTop - size.titleTop), 'the summary is on the title\'s line').toBeLessThanOrEqual(2);
      expect(size.overflow, 'the box does not scroll sideways').toBeLessThanOrEqual(1);
    };
    // Unseen: Mark seen sits at the right of the toggle, not over it, inside the box.
    const unseen = await head();
    measure('unseen', unseen);
    expect(unseen.markLeft).not.toBeNull();
    expect(unseen.markLeft!).toBeGreaterThanOrEqual(unseen.toggleRight - 0.5);
    expect(unseen.markRight!).toBeLessThanOrEqual(unseen.boxRight);
    // At the real width the unseen head shows the full time and a visible summary: "Changed at 15:02 · Notes", no ellipsis on the title.
    expect(unseen.text).toMatch(/^Changed at \d{2}:\d{2} · Notes$/);
    expect(unseen.titleCut, 'the unseen title shows its full time, no ellipsis').toBe(false);
    expect(unseen.summaryWidth, 'the unseen head has room for the field names').toBeGreaterThan(0);
    expect(unseen.summaryCut, 'the field names are not cut at the real width').toBe(false);
    await testInfo.attach(`change-box-collapsed-unseen-${theme}`, { body: await box.screenshot(), contentType: 'image/png' });
    // Seen: the head's text does not change, Mark seen goes, the head keeps its height, and the field names show after the title.
    await box.getByRole('button', { name: 'Mark seen', exact: true }).click();
    await expect(box).toHaveAttribute('data-state', 'seen');
    const seen = await head();
    measure('seen', seen);
    expect(seen.markLeft).toBeNull();
    expect(seen.head).toBe(unseen.head);
    expect(seen.text).toBe(unseen.text);
    expect(seen.summaryWidth, 'the field names are drawn once the head has room').toBeGreaterThan(0);
    expect(seen.summaryCut).toBe(false);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await testInfo.attach(`change-box-collapsed-seen-${theme}`, { body: await box.screenshot(), contentType: 'image/png' });
    // A narrower box (the head's spare room and half of the field names' width lost): the field names are cut with an ellipsis first, and the title keeps its words.
    await box.evaluate((element, width) => { element.style.width = `${width}px`; }, seen.boxWidth - seen.spare - seen.summaryWidth / 2);
    const narrow = await head();
    measure('seen', narrow);
    expect(narrow.summaryCut, 'the field names give way first').toBe(true);
    expect(narrow.titleCut, 'the title keeps its words while the field names are cut').toBe(false);
    await testInfo.attach(`change-box-collapsed-narrow-${theme}`, { body: await box.screenshot(), contentType: 'image/png' });
  });

  /**
   * Alpha.25: an item's `note` is its body and the change comparisons draw prose as Markdown. jsdom has no stylesheets, so the
   * pixels are checked here: Notes above Why, block label, full text colour, list markers kept, no doubled breaks, the before struck
   * and muted in the box and not struck in the popover, the timeline's rule on its own list only.
   */
  test(`Item notes and changed notes read as Markdown: Details, the change box, its timeline, the popover and the dock (${theme})`, async ({ page, origin }, testInfo) => {
    await openApp(page, origin, { ...frameSpec('changes-notes'), theme });
    // Details: a "Notes" section for an open item, a block label over block Markdown, right above Why.
    const notes = page.getByRole('region', { name: 'Notes', exact: true });
    await notes.scrollIntoViewIfNeeded();
    await expect(notes.getByRole('listitem')).toHaveCount(4);
    await expect(notes.getByRole('link', { name: 'the ticket' })).toBeVisible();
    await expect(notes).not.toContainText('**');
    const look = await notes.evaluate(element => {
      const label = element.querySelector('.detail-notes-label')!, text = element.querySelector('.detail-notes-text')!;
      const probe = document.createElement('i'); probe.style.color = 'var(--color-text)'; document.body.append(probe);
      const full = getComputedStyle(probe).color; probe.remove();
      const paragraph = text.querySelector('p')!, line = parseFloat(getComputedStyle(paragraph).lineHeight);
      return { labelBottom: label.getBoundingClientRect().bottom, textTop: text.getBoundingClientRect().top, labelDisplay: getComputedStyle(label).display,
        color: getComputedStyle(text).color, full, bullets: getComputedStyle(text.querySelector('ul')!).listStyleType,
        numbers: getComputedStyle(text.querySelector('ol')!).listStyleType, breakLines: paragraph.getBoundingClientRect().height / line,
        next: element.nextElementSibling?.querySelector('.detail-label')?.textContent ?? null };
    });
    expect(look.labelDisplay).toBe('block');
    expect(look.labelBottom).toBeLessThanOrEqual(look.textTop);
    expect(look.color).toBe(look.full);
    expect(look.bullets).toBe('disc'); expect(look.numbers).toBe('decimal');
    expect(look.breakLines, 'a soft break is one line break').toBeCloseTo(2, 0);
    expect(look.next).toBe('Why');
    await testInfo.attach(`item-notes-${theme}`, { body: await notes.screenshot(), contentType: 'image/png' });

    // The change box: the Notes row stacks the struck before, the arrow and the after.
    const box = page.getByTestId('change-box');
    await box.scrollIntoViewIfNeeded();
    await openChangeBox(box);
    const value = box.getByTestId('change-row-value').first();
    await expect(value.locator('del a')).toBeVisible();
    const stack = await value.evaluate(element => {
      const before = element.querySelector('del')!, arrow = element.querySelector('.change-arrow')!, after = element.lastElementChild!;
      const rect = (target: Element) => target.getBoundingClientRect();
      const paragraph = before.querySelector('p')!, line = parseFloat(getComputedStyle(paragraph).lineHeight);
      return { beforeBottom: rect(before).bottom, arrowTop: rect(arrow).top, arrowBottom: rect(arrow).bottom, afterTop: rect(after).top,
        strike: getComputedStyle(before).textDecorationLine, afterStrike: getComputedStyle(after).textDecorationLine,
        beforeColor: getComputedStyle(before).color, linkColor: getComputedStyle(before.querySelector('a')!).color,
        afterLinkColor: getComputedStyle(after.querySelector('a')!).color, breakLines: rect(paragraph).height / line,
        rootSpace: getComputedStyle(before.firstElementChild!).whiteSpace };
    });
    expect(stack.beforeBottom).toBeLessThanOrEqual(stack.arrowTop + 1);
    expect(stack.arrowBottom).toBeLessThanOrEqual(stack.afterTop + 1);
    expect(stack.strike).toContain('line-through'); expect(stack.afterStrike).toBe('none');
    expect(stack.linkColor, 'a struck link stays muted').toBe(stack.beforeColor);
    expect(stack.afterLinkColor).not.toBe(stack.beforeColor);
    expect(stack.breakLines, 'no doubled break').toBeCloseTo(2, 0);
    expect(stack.rootSpace).toBe('normal');
    // The strike reaches what is nested in the before: a list item, a link and an item chip (Details has the peek, so the chip is a button).
    const struckBefore = value.locator('del.change-before'), chip = struckBefore.locator('button.name-chip');
    await expect(chip).toHaveCount(1);
    await page.mouse.move(0, 0);
    await strikeDrawn(struckBefore.locator('li').first(), struckBefore, true);
    await strikeDrawn(struckBefore.locator('a').first(), struckBefore, true);
    await strikeDrawn(chip, struckBefore, true);
    await strikeDrawn(value.locator('.change-after li').first(), struckBefore, false);
    const chips = await value.evaluate(element => {
      const before = element.querySelector('del.change-before')!, after = element.querySelector('.change-after')!;
      return { beforeColor: getComputedStyle(before).color, chipColor: getComputedStyle(before.querySelector('.name-chip')!).color,
        afterChipColor: getComputedStyle(after.querySelector('.name-chip')!).color };
    });
    expect(chips.chipColor, 'a struck chip stays muted').toBe(chips.beforeColor);
    expect(chips.afterChipColor, 'the after chip keeps the accent').not.toBe(chips.beforeColor);
    // A ~~struck~~ word inside a value is Markdown's own strike: it draws, and keeps normal white space.
    const wordBefore = struckBefore.locator('.md del'), wordAfter = value.locator('.change-after del');
    await strikeDrawn(wordBefore, wordBefore, true);
    await strikeDrawn(wordAfter, wordAfter, true);
    expect(await wordBefore.evaluate(element => getComputedStyle(element).whiteSpace)).toBe('normal');
    await changesFit(box);
    await testInfo.attach(`item-notes-box-${theme}`, { body: await box.screenshot(), contentType: 'image/png' });

    // Its timeline: the rule sits on the timeline's own list; a Markdown numbered list inside keeps its numbers and has no rule.
    await box.getByRole('button', { name: /^Older history/ }).click();
    const timeline = box.getByTestId('change-timeline');
    await timeline.getByRole('button', { name: 'Before → after', exact: true }).click();
    const rule = await timeline.evaluate(element => {
      const own = element.querySelector(':scope > ol')!, inner = element.querySelector('.change-comparison ol')!;
      return { own: getComputedStyle(own).borderLeftWidth, inner: getComputedStyle(inner).borderLeftWidth, numbers: getComputedStyle(inner).listStyleType,
        innerStrike: getComputedStyle(element.querySelector('.change-comparison del')!).textDecorationLine };
    });
    expect(rule.own).toBe('2px'); expect(rule.inner).toBe('0px'); expect(rule.numbers).toBe('decimal');
    expect(rule.innerStrike).toContain('line-through');
    // The comparison's before is struck down to its nested list item, link and chip; its multi-line After keeps its tint (a block <mark>).
    const comparisonBefore = timeline.locator('.change-comparison > .change-field > span > del');
    await page.mouse.move(0, 0);
    await strikeDrawn(comparisonBefore.locator('li').first(), comparisonBefore, true);
    await strikeDrawn(comparisonBefore.locator('a').first(), comparisonBefore, true);
    await strikeDrawn(comparisonBefore.locator('button.name-chip'), comparisonBefore, true);
    const timelineChips = await timeline.locator('.change-comparison').evaluate(element => ({
      before: getComputedStyle(element.querySelector('del')!).color, chip: getComputedStyle(element.querySelector('del .name-chip')!).color,
      link: getComputedStyle(element.querySelector('del a')!).color }));
    expect(timelineChips.chip, 'a chip in the comparison’s before stays muted').toBe(timelineChips.before);
    expect(timelineChips.link, 'a link in the comparison’s before stays muted').toBe(timelineChips.before);
    const tint = await timeline.locator('.change-comparison mark').first().evaluate(mark => {
      const root = mark.firstElementChild!, own = mark.getBoundingClientRect(), inner = root.getBoundingClientRect();
      return { background: getComputedStyle(mark).backgroundColor, display: getComputedStyle(mark).display, root: root.tagName,
        coversHeight: own.height >= inner.height - 1, coversWidth: own.width > 0 };
    });
    expect(tint.root).toBe('DIV');
    expect(tint.display).not.toBe('inline');
    expect(tint.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(tint.coversHeight, 'the tint paints behind the whole block value').toBe(true); expect(tint.coversWidth).toBe(true);
    await changesFit(box);

    // The popover keeps its look: the before is not struck there, and nothing breaks twice.
    const popover = await openChanges(page);
    const card = popover.getByTestId('changes-row').filter({ has: page.getByRole('button', { name: 'Saved receipt', exact: true }) });
    await card.getByRole('button', { name: 'Before → after', exact: true }).click();
    const comparison = card.getByTestId('change-comparison');
    await expect(comparison.locator('del a')).toBeVisible();
    const pop = await comparison.evaluate(element => {
      const before = element.querySelector('del')!, after = element.querySelector('mark')!, paragraph = before.querySelector('p')!;
      return { strike: getComputedStyle(before).textDecorationLine, rootSpace: getComputedStyle(before.firstElementChild!).whiteSpace,
        breakLines: paragraph.getBoundingClientRect().height / parseFloat(getComputedStyle(paragraph).lineHeight),
        numbers: getComputedStyle(after.querySelector('ol')!).listStyleType, label: element.querySelector('strong')!.textContent };
    });
    expect(pop.strike).toBe('none'); expect(pop.rootSpace).toBe('normal');
    expect(pop.breakLines, 'no doubled break').toBeCloseTo(2, 0);
    expect(pop.numbers).toBe('decimal'); expect(pop.label).toBe('Notes');
    // Its own before stays unstruck, but a ~~struck~~ word inside a value draws its strike with normal white space, and the popover has no tint.
    const ownBefore = comparison.locator(':scope > .change-field > span > del'), word = comparison.locator('.md del');
    await expect(word).toHaveCount(2);
    await page.mouse.move(0, 0);
    await strikeDrawn(ownBefore.locator('li').first(), ownBefore, false);
    await strikeDrawn(word.first(), word.first(), true);
    await strikeDrawn(word.last(), word.last(), true);
    const words = await word.evaluateAll(nodes => nodes.map(node => ({ line: getComputedStyle(node).textDecorationLine, space: getComputedStyle(node).whiteSpace })));
    for (const entry of words) { expect(entry.line).toContain('line-through'); expect(entry.space).toBe('normal'); }
    expect(await comparison.locator('mark').first().evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    await changesFit(card);
    await testInfo.attach(`item-notes-popover-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();

    // The answer dock: a waiting item's note is Markdown too.
    const dock = page.getByRole('region', { name: 'Answer dock' });
    await dock.getByRole('button', { name: /waiting$/ }).click();
    await expect(dock.getByRole('link', { name: 'the ticket' })).toBeVisible();
    await expect(dock.getByRole('listitem')).toHaveCount(4);
    await expect(dock).not.toContainText('**');
    const bullets = await dock.locator('ul').first().evaluate(element => getComputedStyle(element).listStyleType);
    expect(bullets).toBe('disc');
    await testInfo.attach(`item-notes-dock-${theme}`, { body: await dock.screenshot(), contentType: 'image/png' });
  });

  test(`M2 chosen answer and attributed topic lists (${theme})`, async ({ page, origin }, testInfo) => {
    await openApp(page, origin, { ...frameSpec('changes-choice'), theme });
    const answer = page.getByRole('region', { name: 'What your answer changed', exact: true });
    await answer.scrollIntoViewIfNeeded();
    await expect(answer).toContainText('Because you chose “Keep retries quiet”');
    await expect(answer.locator('.because-words, .because-read')).toHaveCount(0);
    await changesFit(answer);
    const brief = (await openChanges(page)).getByRole('region', { name: 'Topic brief', exact: true });
    await brief.getByRole('button', { name: /Brief/ }).click();
    await expect(brief).toContainText('by the agent · updated');
    await expect(brief.locator('time')).toHaveAttribute('datetime', '2026-10-07T15:02:00.000Z');
    const groups = brief.locator('.brief-group');
    await expect(groups.nth(0).locator('.change-name')).toHaveText(['Recovery policy']);
    await expect(groups.nth(0).locator('.brief-line')).toHaveText(['Keep retries quiet and resume saved changes once.']);
    await expect(groups.nth(1).locator('.change-name')).toHaveText(['Recovery question']);
    await expect(groups.nth(1).locator('.brief-line')).toHaveText(['Should recovery wait until you reconnect?']);
    const replaced = groups.nth(2);
    await expect(replaced.locator('.change-name')).toHaveText(['Old retry policy', 'Recovery policy']);
    await expect(replaced.getByRole('img', { name: 'replaced by' })).toBeVisible();
    // The names are the board's underlined, peekable names, and each group lists them in one column under its label.
    expect(await replaced.locator('.change-name').first().evaluate(element => getComputedStyle(element).textDecorationLine)).toContain('underline');
    const columns = await groups.evaluateAll(elements => elements.map(element => ({
      label: element.querySelector('h3')!.getBoundingClientRect().x, links: element.querySelector('ul')!.getBoundingClientRect().x,
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

  // SPEC 5.5 / 5.3: the structure of the What changed popover, held here because its text is the fixture's own data (final-frames.ts).
  test(`What changed popover structure: the away summary and its three 28px actions (${theme})`, async ({ page, origin }) => {
    await openApp(page, origin, { ...frameSpec('changes-away'), theme });
    const away = (await openChanges(page)).getByRole('region', { name: 'While you were away', exact: true });
    const lines = away.getByRole('listitem');
    expect(await lines.count()).toBeGreaterThan(0);
    for (const line of await lines.all()) {
      await expect(line.locator('i').first()).toBeVisible();
      // The count is bold and right-aligned in its own column; the label follows it.
      const count = line.locator('span').first();
      expect(await count.evaluate(element => getComputedStyle(element).fontWeight)).toBe('500');
      expect(await count.evaluate(element => getComputedStyle(element).textAlign)).toBe('right');
    }
    const look = (name: string) => away.getByRole('button', { name, exact: true }).evaluate(element => {
      const style = getComputedStyle(element);
      return { height: element.getBoundingClientRect().height, filled: style.backgroundColor !== 'rgba(0, 0, 0, 0)', ring: style.boxShadow !== 'none' };
    });
    expect(await look('Start with what’s waiting')).toEqual({ height: 28, filled: true, ring: false });
    expect(await look('Read the brief')).toEqual({ height: 28, filled: false, ring: true });
    expect(await look('Mark all caught up')).toEqual({ height: 28, filled: false, ring: false });
  });

  test(`What changed popover structure: a change is a card with time and check at the right (${theme})`, async ({ page, origin }) => {
    await openApp(page, origin, { ...frameSpec('changes-typed'), theme });
    const popover = await openChanges(page);
    await page.evaluate(() => document.fonts.ready);
    const card = popover.getByTestId('changes-row').filter({ has: page.getByRole('button', { name: 'Retry schedule', exact: true }) });
    const box = (locator: Locator) => locator.evaluate(element => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; });
    const check = await box(card.getByRole('button', { name: 'Mark Retry schedule seen', exact: true }));
    expect([check.width, check.height]).toEqual([24, 22]);
    const name = await box(card.getByRole('button', { name: 'Retry schedule', exact: true })), time = await box(card.locator('time')), whole = await box(card);
    expect(time.x).toBeGreaterThan(name.x + name.width);
    expect(check.x).toBeGreaterThan(time.x + time.width);
    expect(check.x + check.width).toBeLessThanOrEqual(whole.x + whole.width);
    // "› Before → after" sits under the name column; opening it tints the card and draws a Before / After grid.
    const toggle = card.getByRole('button', { name: 'Before → after', exact: true });
    // Measured in one call: the popover can still settle between two separate reads on a slow runner.
    const stacked = await card.evaluate(element => {
      const nameRect = [...element.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Retry schedule')!.getBoundingClientRect();
      const toggleRect = [...element.querySelectorAll('button')].find(button => button.textContent?.includes('Before → after'))!.getBoundingClientRect();
      return { nameBottom: nameRect.bottom, toggleTop: toggleRect.top };
    });
    expect(stacked.toggleTop).toBeGreaterThanOrEqual(stacked.nameBottom - 1);
    await expect(card).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await toggle.click();
    await expect(card).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const comparison = page.locator(`[id="${await card.getByRole('button', { name: 'Hide before → after', exact: true }).getAttribute('aria-controls')}"]`);
    await expect(comparison.locator('del').first()).toBeVisible();
    // One call again, so the opening panel cannot move between the label read and the value read.
    const { label, value } = await comparison.evaluate(element => {
      const rect = (node: Element) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width }; };
      const before = [...element.querySelectorAll('*')].find(node => node.children.length === 0 && node.textContent?.trim() === 'Before')!;
      return { label: rect(before), value: rect(element.querySelector('del')!) };
    });
    expect(value.x).toBeGreaterThan(label.x + label.width - 1);
    expect(Math.abs(value.y - label.y)).toBeLessThan(6);
    // Seen: the whole row dims to half, the open Before → after panel with it (the board dims the row, not its parts).
    await card.getByRole('button', { name: 'Mark Retry schedule seen', exact: true }).click();
    await expect(card.locator('time')).toHaveCSS('opacity', '0.5');
    await expect(comparison).toHaveCSS('opacity', '0.5');
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
    await expect(brief.locator('.brief-group').nth(1).locator('.change-name')).toHaveText(['Recovery question']);
    await testInfo.attach(`changes-away-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
  });
}

/** Layout tests of the Map's topic cards, chevrons, filter row and rails (A16 owner reports). */
const mapSizes = [{ brief: 'map-brief-long', map: 'map-thread' }, { brief: 'map-brief-long-small', map: 'map-thread-small' }] as const;

for (const { brief: frame } of mapSizes) for (const theme of ['dark', 'light'] as const) {
  test(`Topic brief groups each name with its one-line text, one row per name: ${frame} (${theme})`, async ({ page, origin }, testInfo) => {
    await openApp(page, origin, { ...frameSpec(frame), theme });
    const brief = (await openChanges(page)).getByRole('region', { name: 'Topic brief', exact: true });
    await brief.getByRole('button', { name: /Brief/ }).click();
    const decided = brief.locator('.brief-group').nth(0);
    // Every name is there, in order, each on its own row with its text.
    await expect(decided.locator('.change-name')).toHaveText(['Recovery policy', ...longDecided]);
    await expect(decided.locator('li')).toHaveCount(longDecided.length + 1);
    const rows = await decided.locator('li').evaluateAll(items => items.map(item => ({ top: item.getBoundingClientRect().top,
      name: item.querySelector('.change-name')!.getBoundingClientRect().left, line: item.querySelector('.brief-line')?.textContent ?? '' })));
    expect(new Set(rows.map(row => Math.round(row.top))).size, 'one row per name').toBe(rows.length);
    expect(new Set(rows.map(row => Math.round(row.name))).size, 'the names share a column').toBe(1);
    for (const row of rows) expect(row.line, 'each name has its one-line text').not.toBe('');
    // The group labels stay a column on the left, and "Your turn" / "Replaced" do not wrap.
    const labels = await brief.locator('.brief-group > h3').evaluateAll(elements => elements.map(element => {
      const range = document.createRange(); range.selectNodeContents(element.lastChild!);
      return { x: element.getBoundingClientRect().x, lines: new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size };
    }));
    expect(new Set(labels.map(label => label.x)).size).toBe(1);
    for (const label of labels) expect(label.lines, 'a group label stays on one line').toBe(1);
    // "old → new" reads as one unit: the arrow and both names share a line.
    const pair = await brief.locator('.brief-group').nth(2).locator('li').first().evaluate(item => {
      const names = item.querySelector('.brief-names')!, middle = (rect: DOMRect) => rect.top + rect.height / 2;
      const buttons = [...names.querySelectorAll('button')].map(button => middle(button.getBoundingClientRect()));
      return { spread: Math.max(...buttons) - Math.min(...buttons), rects: names.getClientRects().length };
    });
    expect(pair.spread).toBeLessThan(4);
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
      return { opaque: chip.every((value, at) => value === over[at]), contrast: (high + 0.05) / (low + 0.05), caret: parseFloat(caret.fontSize), topic: !!button.closest('.tree-topic'),
        width: box.width, height: box.height, covers: !!centre?.closest('.tree-chevron'), hidden: box.bottom < 0 || box.bottom > dockTop };
    }));
    for (const fact of facts.filter(value => !value.hidden)) {
      expect(fact.opaque, 'the chip hides the rail behind it').toBe(true);
      expect(fact.contrast, 'the caret reads against its chip').toBeGreaterThanOrEqual(4.5);
      // The topic band's chevron is the board's: an 18px chip with a 12px caret (SPEC 2.2); the rows' are 16px chips with a 14px one.
      expect(fact.caret).toBeGreaterThanOrEqual(fact.topic ? 12 : 14);
      expect(fact.width).toBe(fact.topic ? 18 : 16);
      expect(fact.covers, 'the chip paints over the rail').toBe(true);
    }
    // Hover keeps a visible state.
    const first = chevrons.nth(1), resting = await first.evaluate(element => getComputedStyle(element).backgroundColor);
    await first.hover();
    expect(await first.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(resting);
    await testInfo.attach(`chevron-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
  });
}

for (const { map: frame } of mapSizes) test(`The Back-to pill floats inside the Map, clear of the topic band, with no path row above the Map: ${frame}`, async ({ page, origin }) => {
  await openApp(page, origin, frameSpec(frame));
  await page.locator('.tree-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await settle(page);
  const tag = page.locator('.tree-scroll-shell > .tree-back');
  await expect(tag).toBeVisible();
  // The sticky band and the thread show the path (SPEC 2.2): nothing sits between the chips and the Map.
  await expect(page.getByRole('navigation', { name: 'Map ancestors' })).toHaveCount(0);
  const boxes = await page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    return { band: box('.tree-topic'), tag: box('.tree-back'), shell: box('.tree-scroll-shell'), scroller: box('.tree-scroll') };
  });
  // The scroller starts at the shell's top, and the pill sits over the rows, below the band, inside the Map's width.
  expect(boxes.scroller.top).toBeCloseTo(boxes.shell.top, 0);
  expect(boxes.tag.top).toBeGreaterThanOrEqual(boxes.band.bottom - 0.5);
  expect(boxes.tag.left).toBeGreaterThanOrEqual(boxes.scroller.left - 0.5);
  expect(boxes.tag.right).toBeLessThanOrEqual(boxes.scroller.right + 0.5);
});

/** The accent thread (the only line the Map draws) runs as one line from the topic band down to the selected item's row. */
async function threadRuns(page: Page) {
  await page.locator('.tree-scroll').evaluate(element => { element.scrollTop = 0; });
  await settle(page);
  return page.locator('.tree-topic-group').first().evaluate(group => {
    const origin = group.getBoundingClientRect(), topic = group.querySelector('.tree-topic')!.getBoundingClientRect();
    const everyLine = [...group.querySelectorAll<HTMLElement>('.tree-thread, .tree-thread-elbow')].map(line => line.getBoundingClientRect()).filter(rect => rect.height > 0);
    const lines = everyLine.filter(rect => Math.abs(rect.left + 1.5 - origin.left - 20) < 1.5);
    // The thread leaves the band's column at the ancestor where the selected path branches off, so a deep selection is reached
    // along deeper columns: `reach` is the lowest point of the thread on any column.
    const reach = Math.max(...everyLine.map(rect => rect.bottom));
    const merged: number[][] = [];
    for (const [top, bottom] of lines.map(rect => [rect.top, rect.bottom]).sort((a, b) => a[0] - b[0])) {
      const last = merged.at(-1);
      if (last && top <= last[1] + 1.5) last[1] = Math.max(last[1], bottom); else merged.push([top, bottom]);
    }
    const selected = group.querySelector('[aria-selected="true"]')?.getBoundingClientRect();
    return { runs: merged, reach, topic: { top: topic.top, bottom: topic.bottom }, selected: selected ? { top: selected.top, bottom: selected.bottom } : null };
  });
}
/** The topic's changes live in the band's popover now, so no card sits between the band and the first item. */
for (const { map: frame } of mapSizes) for (const theme of ['dark', 'light'] as const) {
  test(`The thread is one unbroken line from the band to the selected item: ${frame} (${theme})`, async ({ page, origin }, testInfo) => {
    await openApp(page, origin, { ...frameSpec(frame), theme });
    const { runs, reach, topic, selected } = await threadRuns(page);
    expect(selected, 'a row is selected').not.toBeNull();
    expect(runs, 'one accent line from the band').toHaveLength(1);
    expect(runs[0]![0], 'it starts inside the band').toBeLessThanOrEqual(topic.bottom);
    expect(runs[0]![1], 'it runs on below the band, into the branch of the selected row').toBeGreaterThan(topic.bottom + 10);
    expect(reach, 'it reaches the selected row').toBeGreaterThanOrEqual(selected!.top);
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
    return [...element.querySelectorAll('.tree-thread, .tree-thread-elbow')].filter(line => line.getBoundingClientRect().height > 0 && line.getBoundingClientRect().bottom > band.bottom + 2).length;
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

// The chip strip with every item hidden (the alpha.23 bug: no status buttons, only "Pick a status"), and with no items at all.
for (const theme of ['dark', 'light'] as const) {
  test(`The chip strip counts hidden items behind each status, fits its width, and offers Show them (filter-all-hidden, ${theme})`, async ({ page, origin }, testInfo) => {
    await openApp(page, origin, { ...frameSpec('filter-all-hidden'), theme });
    await page.getByRole('button', { name: /^Filter by status/ }).click();
    const strip = page.getByRole('group', { name: 'Filter items' });
    await expect(strip).toBeVisible();
    await chipStrip(page, { ...frameSpec('filter-all-hidden'), theme });
    const chips = strip.getByRole('button', { name: /more hidden$/ });
    expect(await chips.count(), 'a chip for each status the hidden items hold').toBeGreaterThan(2);
    await expect(strip.getByRole('button', { name: /^(Open|Done|In progress) 0, \d+ more hidden$/ }).first()).toBeVisible();
    const height = (await strip.boundingBox())!.height;
    await strip.getByRole('button', { name: /^Open 0, \d+ more hidden$/ }).click();
    await expect(strip.getByRole('button', { name: 'Show them' })).toBeVisible();
    await expect(strip).toContainText(/\+\d+ hidden match/);
    await settle(page);
    await testInfo.attach(`filter-all-hidden-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
    const before = await page.locator('[data-item-id]').count();
    await strip.getByRole('button', { name: 'Show them' }).click();
    await expect(strip.getByRole('button', { name: 'Hide them' })).toBeVisible();
    expect(await page.locator('[data-item-id]').count(), 'Show them draws the hidden matches').toBeGreaterThan(before);
    await expect(page.locator('.tree-item-hidden').first()).toBeVisible();
    await settle(page);
    // The strip wraps its chips rather than clipping or scrolling: nothing runs past its edge, and the note's actions stay inside it.
    const fit = await strip.evaluate(element => {
      const box = element.getBoundingClientRect();
      return { overflow: element.scrollWidth - element.clientWidth, outside: [...element.querySelectorAll('button, .tree-filter-summary')]
        .filter(child => { const rect = child.getBoundingClientRect(); return rect.left < box.left - 1 || rect.right > box.right + 1; }).map(child => child.textContent) };
    });
    expect(fit.overflow, 'the strip does not scroll sideways').toBeLessThanOrEqual(1);
    expect(fit.outside, 'every chip and action stays inside the strip').toEqual([]);
    expect((await strip.boundingBox())!.height, 'the strip is at most two lines of chips').toBeLessThanOrEqual(height * 2);
    await testInfo.attach(`filter-all-hidden-shown-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
    await strip.getByRole('button', { name: 'Hide them' }).click();
    await expect(page.locator('.tree-item-hidden')).toHaveCount(0);
  });

  test(`An empty session's chip strip says "Nothing to filter" and draws no chip (filter-empty, ${theme})`, async ({ page, origin }, testInfo) => {
    await openApp(page, origin, { ...frameSpec('filter-empty'), theme });
    await page.getByRole('button', { name: /^Filter by status/ }).click();
    const strip = page.getByRole('group', { name: 'Filter items' });
    await chipStrip(page, { ...frameSpec('filter-empty'), theme });
    await expect(strip).toContainText('Nothing to filter');
    await expect(strip.getByRole('button')).toHaveCount(0);
    await expect(strip).not.toContainText('Pick a status');
    await testInfo.attach(`filter-empty-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
  });

  // A populated frame must draw a chip: "Nothing to filter" is no fallback for it.
  test(`A populated frame's chip strip draws a status chip (map-thread, ${theme})`, async ({ page, origin }) => {
    await openApp(page, origin, { ...frameSpec('map-thread'), theme });
    await page.getByRole('button', { name: /^Filter by status/ }).click();
    await expect(page.getByRole('group', { name: 'Filter items' })).toBeVisible();
    await chipStrip(page, { ...frameSpec('map-thread'), theme });
    await expect(page.getByRole('group', { name: 'Filter items' })).not.toContainText('Nothing to filter');
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

/* The sticky Unfocus copy in the path row is gone (D9): Focus and Unfocus are one band button, kept in reach by
 * tests/e2e/tree-layout/tree-layout.spec.mts (the 92px swap and the 560/480px Map at the largest text). */

test.describe.configure({ mode: 'parallel' });

for (const width of [1920, 1600, 1280]) for (const acceptedFailure of [false, true]) {
  test(`${acceptedFailure ? 'delivered-stopped' : 'failed-delivery'} layout at ${width}px`, async ({ page, origin }) => {
    const denied: string[] = [];
    await route(page.context(), origin, denied);
    await openApp(page, origin, { ...frameSpec(acceptedFailure ? 'delivery-stopped' : '1m'), width });
    // Only Details carries the note now (alpha.21 E17); a never-received delivery has its Retry in the bubble's "Not sent" line above it.
    for (const selector of ['.shell-detail-scroll']) {
      const note = page.locator(`${selector} .stuck-note[data-stuck="${acceptedFailure ? 'stopped' : 'decision'}"]`).first();
      await expect(note).toBeVisible();
      await expect(note.locator(':scope > [role="status"]')).toContainText(acceptedFailure ? 'got your message but stopped before answering' : 'Couldn’t deliver');
      await expect((acceptedFailure ? note : note.locator('xpath=ancestor::li[1]')).getByRole('button', { name: acceptedFailure ? 'Send again' : 'Retry', exact: true })).toBeVisible();
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
  // A top item opens one box of its own; a child sits inside its top item's box and opens a second one. No stripe.
  await expect(root.locator('.tree-box')).toHaveCount(1);
  await expect(child.locator('.tree-box')).toHaveCount(2);
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

// Alpha.26: a search that matches notes adds an "In notes" tag to rows that do not draw their note. The tag widens the end cluster, so
// it can rewrap a question; the Map's held-row correction must keep the selected row, and the rows at both ends of the scroll, in place.
// The frame's items 3.2, 3.3 and 3.9 carry the same note (changes-fixture.ts `notesAfter`, "Owner: the platform team").
for (const theme of ['light', 'dark'] as const) for (const [size, width, height] of [['wide', 1280, 1100], ['narrow', 900, 650], ['tight', 760, 650]] as const) {
  test(`A note search adds "In notes" tags and moves no row the owner is looking at: ${size} (${theme})`, async ({ page, origin }, testInfo) => {
    const denied: string[] = [];
    await route(page.context(), origin, denied);
    await openApp(page, origin, { ...frameSpec('changes-notes'), theme, width, height });
    const scroller = page.locator('.tree-scroll'), rows = page.locator('.tree-scroll [role="treeitem"][data-item-id]');
    const tops = () => rows.evaluateAll(elements => elements.flatMap(element => {
      const rect = element.getBoundingClientRect();
      return [[element.getAttribute('data-item-id')!, Math.round(rect.top * 10) / 10, Math.round(rect.bottom * 10) / 10] as const];
    }));
    const selected = page.locator('[role="treeitem"][data-item-id="3.2"]');
    await expect(selected).toHaveAttribute('aria-selected', 'true');
    const visibleIn = (box: { top: number; bottom: number }, row: readonly [string, number, number]) => row[2] > box.top && row[1] < box.bottom;
    // The reading row is the first row that starts inside the Map: the one the view holds still while a row above it rewraps.
    const reading = (box: { top: number; bottom: number }, rows: readonly (readonly [string, number, number])[]) => rows.find(row => row[1] >= box.top && row[1] < box.bottom)!;
    const type = async (text: string) => {
      if (!await page.locator('.tb-search-input').count()) await page.getByRole('button', { name: 'Search the Map' }).click();
      await page.locator('.tb-search-input').fill(text);
      await settle(page);
    };
    // (a) and (b): at the top of the scroll, the selected row and the first row stay where they are.
    await scroller.evaluate(element => { element.scrollTop = 0; });
    await selected.scrollIntoViewIfNeeded();
    await settle(page);
    const topBox = await scroller.evaluate(element => { const rect = element.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom }; });
    const before = await tops(), selectedBefore = before.find(row => row[0] === '3.2')!;
    await type('platform team');
    await expect(page.locator('.tree-note-hit').first()).toBeVisible();
    // The selected row is open, so it draws no note: its note match is named by the tag.
    await expect(selected.locator('.tree-note-hit')).toHaveText('In notes');
    const after = await tops();
    expect(after.find(row => row[0] === '3.2')![1], 'the selected row keeps its y').toBe(selectedBefore[1]);
    const firstSeen = reading(topBox, before);
    expect(after.find(row => row[0] === firstSeen[0])![1], 'the first visible row keeps its y').toBe(firstSeen[1]);
    // The tag is drawn in the hit tint, and the current match's tag has the strong ring.
    const look = await page.locator('.tree-note-hit').evaluateAll(tags => tags.map(tag => ({ current: tag.hasAttribute('data-current'), shadow: getComputedStyle(tag).boxShadow,
      background: getComputedStyle(tag).backgroundColor, height: tag.getBoundingClientRect().height })));
    expect(look.some(tag => tag.current)).toBe(true);
    for (const tag of look) {
      expect(tag.background).not.toBe('rgba(0, 0, 0, 0)');
      expect(tag.height).toBe(18);
      expect(tag.shadow === 'none').toBe(!tag.current);
    }
    await testInfo.attach(`in-notes-${size}-${theme}`, { body: await page.locator('.tree-scroll').screenshot(), contentType: 'image/png' });
    // Clearing the search takes the tags away and moves nothing either.
    await type('');
    await expect(page.locator('.tree-note-hit')).toHaveCount(0);
    expect((await tops()).find(row => row[0] === '3.2')![1], 'the selected row keeps its y when the search clears').toBe(selectedBefore[1]);
    // (c): at the bottom of the scroll, the last row stays where it is (a Map that does not scroll has its bottom at its end).
    await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await settle(page);
    const bottomBox = await scroller.evaluate(element => { const rect = element.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom }; });
    const atBottom = await tops(), last = atBottom.filter(row => visibleIn(bottomBox, row)).at(-1)!;
    await type('platform team');
    await expect(page.locator('.tree-note-hit').first()).toBeVisible();
    // A matched row above the reading row rewraps upward and one below it grows downward; the reading row itself stays.
    const afterBottom = await tops(), held = reading(bottomBox, atBottom);
    expect(afterBottom.find(row => row[0] === held[0])![1], 'the first visible row keeps its y at the bottom of the scroll').toBe(held[1]);
    for (const row of atBottom.slice(atBottom.indexOf(held), atBottom.indexOf(last))) expect(afterBottom.find(other => other[0] === row[0])![1], `row ${row[0]} between the reading row and the last keeps its y`).toBe(row[1]);
    // (d) The tight Map wraps a matched row to three lines or more once its tag is drawn; the selected row still held its y above.
    if (size === 'tight') {
      const lines = await page.locator('[role="treeitem"]:has(.tree-note-hit) .tree-question').evaluateAll(elements => elements.map(element => {
        const style = getComputedStyle(element);
        return Math.round(element.getBoundingClientRect().height / parseFloat(style.lineHeight));
      }));
      expect(Math.max(...lines), 'a matched row wraps to three lines').toBeGreaterThanOrEqual(3);
    }
    expect(denied).toEqual([]);
  });
}

test('a long waiting conversation opens at its latest ask and keeps the question visible', async ({ page, origin }) => {
  const denied: string[] = [];
  await route(page.context(), origin, denied);
  await openApp(page, origin, { ...frameSpec('1u'), width: 1400, height: 830 });
  const pane = page.locator('.item-detail'), body = pane.locator('.detail-body'), head = body.locator('.detail-head');
  await expect(body.locator('.detail-turn-now .detail-waiting-tag')).toBeInViewport();
  await expect(head.locator('.detail-question')).toHaveAttribute('title', /\S+/);
  expect(await body.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  // The badge row and title scroll with the body (SPEC 5.3): only the composer is pinned, so the ask stays in view at the end.
  await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(body.locator('.detail-turn-now .detail-waiting-tag')).toBeInViewport();
  await body.evaluate(element => { element.scrollTop = 0; });
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
    const detailBox = (await detail.boundingBox())!, headerAction = (await detail.getByRole('button', { name: 'More actions', exact: true }).boundingBox())!;
    expect(headerAction.y).toBeGreaterThanOrEqual(detailBox.y);
    // The board's head controls sit 8px under the pane's top edge (shell.css `.shell-detail-head`, measured on 3.2).
    expect(headerAction.y - detailBox.y, 'detail header action starts within 10px of the pane top').toBeLessThanOrEqual(10);
    const composer = dock.getByRole('textbox', { name: 'Reply message', exact: true });
    await expect(composer).toHaveValue('');
    await expect(composer).toBeInViewport();
    const lines = await composer.evaluate(element => {
      const style = getComputedStyle(element);
      return { height: element.getBoundingClientRect().height, minimum: parseFloat(style.minHeight), line: parseFloat(style.lineHeight),
        padding: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom), border: parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth) };
    });
    expect(lines.height, 'resting composer is two rows (alpha.21 E15)').toBeLessThanOrEqual(Math.max(lines.minimum, Math.ceil(lines.line * 2 + lines.padding + lines.border)));
    // The actions sit in the body, in one row under the outcome (SPEC 5.3 item 5): they scroll with it and the pinned dock holds only the
    // composer. Details opens 140px above the New divider or at the latest message (E13), so on a long conversation the row has scrolled
    // up out of view at rest, by design: it is drawn, and scrolling the body to its top brings it into the viewport.
    const actions = pane.getByRole('group', { name: 'Item actions', exact: true });
    const actionButtons = [actions.getByRole('button', { name: 'Ack → Decided', exact: true }), actions.getByRole('button', { name: 'Reply', exact: true }),
      actions.getByRole('button', { name: 'Later', exact: true })];
    for (const button of actionButtons) await expect(button).toBeVisible();
    const resting = await pane.locator('.detail-body').evaluate(element => { const place = element.scrollTop; element.scrollTop = 0; return place; });
    for (const button of actionButtons) await expect(button).toBeInViewport();
    await pane.locator('.detail-body').evaluate((element, place) => { element.scrollTop = place; }, resting);
    if (spec.dockState === 'pending') {
      const pending = pane.getByRole('region', { name: 'Conversation', exact: true }).locator('li[data-pending]');
      await expect(pending).toContainText('Keep the captions with the examples.');
      await expect(pending).toContainText(/✓ (Sent at|Picked up)/u);
      await expect(pending).toBeInViewport();
      await expect(pane.locator('.detail-delivery-hint')).toHaveText('Your reply was received · waiting for the agent');
      // While a message is on its way the row keeps Bring it up and Drop, greyed, so the row never changes shape under the pointer.
      await expect(actions.getByRole('button', { name: 'Bring it up', exact: true })).toBeDisabled();
      await expect(actions.getByRole('button', { name: 'Drop', exact: true })).toBeDisabled();
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
