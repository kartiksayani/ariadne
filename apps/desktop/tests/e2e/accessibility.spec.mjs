import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { json } from '../../../../scripts/run-native-e2e.mjs';

const wait = (condition, message) => browser.waitUntil(condition, { timeout: 20000, interval: 100, timeoutMsg: message });
const focus = selector => browser.execute(selector => document.querySelector(selector).focus(), selector);
const active = selector => browser.execute(selector => document.activeElement === document.querySelector(selector), selector);
// Real embedded-WebDriver key input, actual DesktopApp/core/store. This helper
// writes only a retained preference draft; it never submits demo owner work.
export async function runAccessibilityAcceptance(configuration) {
  const viewport = await browser.execute(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const nativeWindow = await browser.execute(async () => {
    try {
      const physical = await window.__TAURI_INTERNALS__.invoke('plugin:window|outer_size', { label: 'main' });
      const scaleFactor = await window.__TAURI_INTERNALS__.invoke('plugin:window|scale_factor', { label: 'main' });
      return { ok: true, physical, scaleFactor, logical: { width: physical.width / scaleFactor, height: physical.height / scaleFactor } };
    } catch (error) { return { ok: false, message: String(error) }; }
  });
  await json(join(process.env.ARIADNE_E2E_EVIDENCE, 'native-minimum-window.json'), { actualWebView: true,
    viewport, nativeWindow, minimum: { width: 1000, height: 700 } });
  assert.equal(nativeWindow.ok, true, nativeWindow.message);
  assert.ok(nativeWindow.logical.width >= 1000 && nativeWindow.logical.height >= 700,
    'Ordinary native window must reach minimum outer size 1000×700');
  const before = await readFile(configuration.demo.sessionPath);
  const catalogue = await browser.$('button[data-shell-tab="all_sessions"]'); await catalogue.waitForEnabled(); await catalogue.click();
  const session = await browser.$(`[data-session-id="${configuration.demo.session_id}"]`);
  await session.waitForDisplayed(); await session.waitForEnabled(); await session.click();
  const row = '[role="treeitem"][data-item-id="2"]';
  await (await browser.$(row)).waitForDisplayed(); await focus(row);
  await browser.keys('r');
  const editor = '.shell-detail-scroll .owner-input textarea';
  await wait(() => active(editor), 'Reply shortcut did not focus ordinary native editor');
  const draft = `Native keyboard retained draft ${process.env.ARIADNE_E2E_NONCE}`;
  await (await browser.$(editor)).setValue(draft);
  await browser.keys('g');
  assert.equal(await (await browser.$(editor)).getValue(), `${draft}g`);
  assert.equal(await active(editor), true, 'Editor typing must not switch workspace');
  await browser.keys('Escape');
  await wait(async () => !(await browser.$('.shell-detail').isExisting()), 'Editor Escape did not close detail');
  // Draft saves patch preferences; the navigation store re-reads them only every
  // 2 s. Let the saved file stay unchanged past one refresh so Reply is not
  // issued with a stale preferences revision.
  const preferencesPath = join(process.env.ARIADNE_HOME, 'ui.json');
  let settledSince = Date.now(); let lastSaved = await readFile(preferencesPath, 'utf8');
  await browser.waitUntil(async () => {
    const saved = await readFile(preferencesPath, 'utf8');
    if (saved !== lastSaved) { lastSaved = saved; settledSince = Date.now(); }
    return Date.now() - settledSince >= 3000;
  }, { timeout: 30000, interval: 200, timeoutMsg: 'Saved preferences did not settle after the draft edit' });
  await focus(row); await browser.keys('r'); await wait(() => active(editor), 'Repeated Reply did not refocus');
  assert.equal(await (await browser.$(editor)).getValue(), `${draft}g`);
  await browser.saveScreenshot(join(process.env.ARIADNE_E2E_EVIDENCE, 'native-keyboard-retained-editor.png'));
  const lifecycle = await browser.$('[aria-label="Binding lifecycle"]');
  const pauseButton = await lifecycle.$('button=Pause dispatch'); await pauseButton.waitForEnabled(); await pauseButton.click();
  await (await browser.$('[role="dialog"]')).waitForDisplayed();
  await focus('[role="dialog"] button');
  await browser.keys(['Shift', 'Tab']);
  assert.equal(await browser.execute(() => document.activeElement?.closest('[role="dialog"]') !== null), true);
  await browser.keys('Tab');
  assert.equal(await browser.execute(() => document.activeElement?.closest('[role="dialog"]') !== null), true);
  await browser.keys('g'); assert.equal(await (await browser.$('[role="tree"]')).isExisting(), true);
  await browser.keys('Escape');
  await wait(async () => !(await browser.$('[role="dialog"]').isExisting()), 'Dialog Escape did not close overlay');
  assert.equal(await (await browser.$('.shell-detail')).isExisting(), true, 'Dialog Escape must preserve selected detail');
  assert.equal(await browser.execute(() => document.activeElement?.textContent === 'Pause dispatch'), true, 'Dialog restores opener');
  await browser.saveScreenshot(join(process.env.ARIADNE_E2E_EVIDENCE, 'native-keyboard-dialog-return.png'));
  assert.deepEqual(await readFile(configuration.demo.sessionPath), before, 'Keyboard focus/draft/modal checks leave durable demo domain unchanged');
  await json(join(process.env.ARIADNE_E2E_EVIDENCE, 'keyboard-accessibility.json'), { ordinaryApp: true, actualCoreStore: true,
    realDriverKeys: true, replyFocused: true, editorShortcutSuppressed: true, draftRetained: true, dialogContained: true,
    dialogEscapePreservedDetail: true, openerRestored: true, demoDomainUnchanged: true });
}
