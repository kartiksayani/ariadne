import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, type Page, type TestInfo } from '@playwright/test';
import { ordinaryCases, type OrdinaryCase } from './cases';


const beforeHead = '9bfbc74ed1358e00e56848e8a35ab6e7f4aa08ef';
// Extract only tracked frontend source at the exact reviewed parent, into ignored
// evidence space. Reuse the same app transport, Vite and browser for before/after.
export async function prepareBeforeCapture(repo: string): Promise<string> {
  await mkdir(resolve(repo, 'target'), { recursive: true });
  const directory = await mkdtemp(resolve(repo, 'target/design-before-'));
  const archive = execFileSync('git', ['archive', beforeHead, 'apps/desktop/src'], { cwd: repo });
  execFileSync('tar', ['-x', '-C', directory], { input: archive });
  const entry = (await readFile(resolve(repo, 'tests/visual/ordinary-app.tsx'), 'utf8'))
    .split('../../apps/desktop/src/').join('./apps/desktop/src/')
    .split('../../apps/desktop/tests/').join('/apps/desktop/tests/')
    .replace("from './fixture'", "from '/tests/visual/fixture'");
  await writeFile(resolve(directory, 'ordinary-app.tsx'), entry);
  await writeFile(resolve(directory, 'ordinary-app.html'), '<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>Ariadne before fixes</title></head><body><div id="root"></div><script type="module" src="./ordinary-app.tsx"></script></body></html>');
  return directory.slice(repo.length);
}

export async function captureOrdinaryFrames(page: Page, origin: string, testInfo: TestInfo, batch: number) {
  const theme = testInfo.project.name.startsWith('light') ? 'light' : 'dark';
  const cases: readonly OrdinaryCase[] = ordinaryCases.filter((_value, index) => index % 2 === batch);
  for (const scenario of cases) {
    await page.goto(`${origin}/tests/visual/ordinary-app.html?frame=${scenario.id}&theme=${theme}`);
    await expect(page.locator('.product-app')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.evaluate(() => document.fonts.ready);
    if (scenario.navigation) await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    else if (scenario.loading) await expect(page.getByText('Loading session…', { exact: true })).toBeVisible();
    else {
      await expect(page.getByRole('button', { name: 'Pause dispatch', exact: true })).toBeEnabled();
      await expect(page.getByRole('tree', { name: 'Sentences' })).toBeVisible();
      if (scenario.item) await expect(page.locator('.ref-detail-scroll .owner-input')).toBeVisible();
    }
    if (scenario.id === '1p') {
      await page.getByRole('button', { name: 'Discover host sessions', exact: true }).click();
      await expect(page.getByText('Discovered existing conversation', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Register this project', exact: true })).toBeVisible();
    }
    if (scenario.filtered) {
      await page.evaluate(() => window.__ordinaryCapture.transport.emit('ariadne://route', { ...window.__ordinaryCapture.route, item_id: '2' }));
      await expect(page.getByText('Item 2 is outside the current filters.', { exact: false })).toBeVisible();
    }
    if (scenario.graph) {
      await page.getByRole('button', { name: 'Graph', exact: true }).click();
      await expect(page.getByRole('region', { name: /Topic graph/ }).first()).toBeVisible();
    }
    if (scenario.action === 'answer') {
      const detail = page.locator('.ref-detail-scroll');
      await detail.getByRole('button', { name: /Afternoon delivery/ }).click();
      await expect(detail.getByRole('button', { name: /Afternoon delivery/, pressed: true })).toBeVisible();
    } else if (scenario.action === 'reply' || scenario.action === 'followup') {
      const detail = page.locator('.ref-detail-scroll');
      await detail.getByRole('button', { name: scenario.action === 'reply' ? 'Reply' : 'Follow up', exact: true }).click();
      await detail.getByRole('textbox').fill('Keep the complete owner draft across views.');
    } else if (scenario.action === 'continue') {
      await page.getByRole('button', { name: 'Continue Delivery decisions', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Separate session', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveAccessibleName('Continue topic');
      await expect(page.getByRole('dialog').getByRole('button', { name: 'Send to Separate session' })).toBeEnabled();
    }
    if (scenario.answered) {
      await expect(page.locator('.ref-sent-card').filter({ hasText: 'Please use the afternoon delivery.' })).toBeVisible();
      await expect(page.locator('.ref-waiting-card').filter({ hasText: 'Which delivery window?' })).toHaveCount(0);
    }
    if (scenario.clear) await expect(page.getByText('Nothing waiting on you', { exact: true })).toBeVisible();
    if (scenario.empty) await expect(page.getByText('No items yet', { exact: false })).toBeVisible();
    if (scenario.disconnected && scenario.item) await expect(page.locator('.ref-detail-scroll textarea')).toHaveValue('Keep the afternoon choice and this draft.');
    if (scenario.id === '1u') { await expect(page.locator('.history-round')).toHaveCount(3); await expect(page.locator('.history-fork')).toHaveCount(2); }
    if (scenario.archived) await expect(page.getByRole('button', { name: 'Restore Continued context' })).toBeVisible();
    const dimensions = await page.evaluate(() => {
      const box = (selector: string) => { const node = document.querySelector(selector)!; const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; };
      const scroll = document.querySelector<HTMLElement>('.ref-workspace-scroll')!;
      return { header: box('.ref-header'), tabs: box('.ref-tabs'), footer: box('.ref-footer'), waiting: box('.ref-waiting'),
        center: box('.ref-center'), horizontalOverflow: scroll.scrollWidth > scroll.clientWidth };
    });
    expect(dimensions.header.height).toBe(48); expect(dimensions.tabs.height).toBe(38); expect(dimensions.footer.height).toBe(30);
    expect(dimensions.waiting.width).toBe(300); expect(dimensions.center.width).toBeGreaterThanOrEqual(560);
    if (page.viewportSize()!.width === 1000 && (scenario.item || scenario.rail)) expect(dimensions.horizontalOverflow).toBe(true);
    await page.locator('.ref-workspace-scroll').evaluate(node => { node.scrollLeft = 400; });
    expect((await page.locator('.ref-waiting').boundingBox())?.x).toBe(dimensions.waiting.x);
    await page.locator('.ref-workspace-scroll').evaluate(node => { node.scrollLeft = 0; });
    for (const control of await page.locator('.ref-header button, .ref-header input, .ref-detail-close').all()) {
      await expect(control).toHaveAccessibleName(/.+/);
      await control.scrollIntoViewIfNeeded();
      const box = await control.boundingBox();
      expect(box!.height).toBeGreaterThan(0); expect(box!.width).toBeGreaterThan(0);
      expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
      expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
    }
    await page.locator('.ref-workspace-scroll').evaluate(node => { node.scrollLeft = 0; });
    await testInfo.attach(`${scenario.id}-ordinary-${theme}`, { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
    await testInfo.attach(`${scenario.id}-ordinary-state`, { body: JSON.stringify({ scenario, theme, viewport: page.viewportSize(), dimensions,
      entry: 'DesktopApp', fixture: 'canonical demo + AppTransport/HistoryTransport', suppliedFrameTextParity: false,
      status: await page.locator('.ref-header-context').innerText(), snapshot: await page.evaluate(() => window.__ordinaryCapture.snapshot) }), contentType: 'application/json' });
  }
}


async function contrastEvidence(page: Page) {
  return page.locator('.product-app').evaluate(root => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!;
    const rgba = (color: string) => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data].map(value => value / 255); };
    const blend = (foreground: number[], background: number[]) => foreground.slice(0, 3).map((channel, index) => channel * foreground[3] + background[index] * (1 - foreground[3]));
    const luminance = (color: number[]) => color.slice(0, 3).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
      .reduce((value, channel, index) => value + channel * [0.2126, 0.7152, 0.0722][index], 0);
    return [...root.querySelectorAll<HTMLElement>('.ref-tree-question,.owner-editor-label,.ref-status,.ref-header-context > span')].map(node => {
      const ancestors: HTMLElement[] = [];
      for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement) ancestors.unshift(parent);
      let background = [1, 1, 1];
      for (const ancestor of ancestors) background = blend(rgba(getComputedStyle(ancestor).backgroundColor), background);
      const style = getComputedStyle(node), foreground = blend(rgba(style.color), background);
      const a = luminance(foreground), b = luminance(background);
      return { text: node.textContent?.trim(), selector: node.className, color: style.color, background, contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
    });
  });
}

export async function checkOrdinaryKeyboard(page: Page, origin: string, testInfo: TestInfo, beforePath: string) {
  const theme = testInfo.project.name.startsWith('light') ? 'light' : 'dark';
  await page.goto(`${origin}${beforePath}/ordinary-app.html?frame=1e&theme=${theme}`);
  const beforeRow = page.locator('[role="treeitem"][data-item-id="2"]'); await expect(beforeRow).toBeVisible(); await expect(page.locator('.ref-detail-scroll .owner-input textarea')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause dispatch', exact: true })).toBeEnabled(); await beforeRow.focus();
  await page.keyboard.press('r'); await expect(beforeRow).toBeFocused();
  await testInfo.attach('before-reply-shortcut-missing', { body: await page.screenshot(), contentType: 'image/png' });
  await page.getByRole('button', { name: 'Pause dispatch', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible(); await page.keyboard.press('Escape');
  await expect(page.locator('.ref-detail')).toHaveCount(0);
  await testInfo.attach('before-dialog-escape-loses-detail', { body: await page.screenshot(), contentType: 'image/png' });
  await testInfo.attach('before-contrast', { body: JSON.stringify(await contrastEvidence(page)), contentType: 'application/json' });
  await testInfo.attach('before-source', { body: JSON.stringify({ head: beforeHead, source: 'tracked apps/desktop/src', transport: 'same AppTransport/HistoryTransport as after' }), contentType: 'application/json' });
  await page.goto(`${origin}/tests/visual/ordinary-app.html?frame=1e&theme=${theme}`);
  const row = page.getByRole('treeitem').filter({ has: page.locator('[aria-label="Waiting on me"]') }).first();
  await expect(row).toBeVisible(); await row.focus();
  await page.keyboard.press('r');
  const editor = page.locator('.ref-detail-scroll').getByLabel('Reply message'); await expect(editor).toBeFocused();
  await testInfo.attach('after-reply-shortcut-focus', { body: await page.screenshot(), contentType: 'image/png' });
  await editor.fill('Ordinary keyboard draft'); await page.keyboard.press('g'); await expect(editor).toHaveValue('Ordinary keyboard draftg');
  await page.keyboard.press('Escape'); await expect(page.locator('.ref-detail')).toHaveCount(0);
  await row.focus(); await page.keyboard.press('r'); await expect(editor).toBeFocused(); await expect(editor).toHaveValue('Ordinary keyboard draftg');
  const opener = page.getByRole('button', { name: 'Pause dispatch', exact: true }); await opener.click();
  const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
  const first = dialog.getByRole('button', { name: 'Cancel', exact: true }); await first.focus();
  await page.keyboard.press('Shift+Tab'); await expect(dialog.getByRole('button', { name: 'Confirm pause', exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(first).toBeFocused();
  await page.keyboard.press('g'); await expect(page.getByRole('tree')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused(); await expect(page.locator('.ref-detail')).toBeVisible();
  await testInfo.attach('after-dialog-escape-return', { body: await page.screenshot(), contentType: 'image/png' });
  const contrast = await contrastEvidence(page);
  await testInfo.attach('after-contrast', { body: JSON.stringify(contrast), contentType: 'application/json' });
  for (const sample of contrast) expect.soft(sample.contrast, `${theme} ${sample.selector}: ${sample.text}`).toBeGreaterThanOrEqual(4.5);
  await expect(opener).toHaveCSS('outline-width', '2px'); await expect(opener).toHaveCSS('outline-style', 'solid');
  const moving = await page.locator('.product-app').evaluate(root => [...root.querySelectorAll('*')].filter(node => {
    const style = getComputedStyle(node); return style.animationName !== 'none' || style.transitionDuration.split(',').some(value => parseFloat(value) > 0);
  }).map(node => node.className));
  expect(moving).toEqual([]);
}
