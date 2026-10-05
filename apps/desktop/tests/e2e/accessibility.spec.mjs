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
  await json(join(process.env.ARIADNE_E2E_EVIDENCE, 'native-minimum-window.json'), { actualWebView: true,
    viewport, minimum: { width: 1000, height: 700 } });
  assert.ok(viewport.width >= 1000 && viewport.height >= 700,
    `Ordinary native WebView must reach minimum 1000×700; observed ${viewport.width}×${viewport.height}`);
  const before = await readFile(configuration.demo.sessionPath);
  await (await browser.$('button*=All sessions')).click();
  await (await browser.$(`[data-session-id="${configuration.demo.session_id}"]`)).click();
  const row = '[role="treeitem"][data-item-id="2"]';
  await (await browser.$(row)).waitForDisplayed(); await focus(row);
  await browser.keys('r');
  const editor = '.ref-detail-scroll .owner-input textarea';
  await wait(() => active(editor), 'Reply shortcut did not focus ordinary native editor');
  const draft = `Native keyboard retained draft ${process.env.ARIADNE_E2E_NONCE}`;
  await (await browser.$(editor)).setValue(draft);
  await browser.keys('g');
  assert.equal(await (await browser.$(editor)).getValue(), `${draft}g`);
  assert.equal(await active(editor), true, 'Editor typing must not switch workspace');
  await browser.keys('Escape');
  await wait(async () => !(await browser.$('.ref-detail')).isExisting(), 'Editor Escape did not close detail');
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
  await wait(async () => !(await browser.$('[role="dialog"]')).isExisting(), 'Dialog Escape did not close overlay');
  assert.equal(await (await browser.$('.ref-detail')).isExisting(), true, 'Dialog Escape must preserve selected detail');
  assert.equal(await browser.execute(() => document.activeElement?.textContent === 'Pause dispatch'), true, 'Dialog restores opener');
  await browser.saveScreenshot(join(process.env.ARIADNE_E2E_EVIDENCE, 'native-keyboard-dialog-return.png'));
  assert.deepEqual(await readFile(configuration.demo.sessionPath), before, 'Keyboard focus/draft/modal checks leave durable demo domain unchanged');
  await json(join(process.env.ARIADNE_E2E_EVIDENCE, 'keyboard-accessibility.json'), { ordinaryApp: true, actualCoreStore: true,
    realDriverKeys: true, replyFocused: true, editorShortcutSuppressed: true, draftRetained: true, dialogContained: true,
    dialogEscapePreservedDetail: true, openerRestored: true, demoDomainUnchanged: true });
}
