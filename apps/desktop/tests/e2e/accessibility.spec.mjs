import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { json } from '../../../../scripts/run-native-e2e.mjs';
import { openSession } from './session-button.mjs';

const wait = (condition, message) => browser.waitUntil(condition, { timeout: 60000, interval: 100, timeoutMsg: message });
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
    viewport, nativeWindow, minimum: { width: 1300, height: 760 } });
  assert.equal(nativeWindow.ok, true, nativeWindow.message);
  assert.ok(nativeWindow.logical.width >= 1300 && nativeWindow.logical.height >= 760,
    'Ordinary native window must reach minimum outer size 1300×760');
  const before = await readFile(configuration.demo.sessionPath);
  await openSession(configuration.demo.session_id);
  // An open item keeps its reply box docked in Details, so Reply focuses a text editor (a waiting item's Reply lands on its
  // answer cards). Item keys act on the selected item: select the row first, then press the key on it.
  const row = '[role="treeitem"][data-item-id="1.1"]';
  const select = async () => {
    const target = await browser.$(row); await target.waitForDisplayed(); await target.waitForEnabled(); await target.click();
    await wait(async () => await browser.$('.item-detail').getAttribute('data-detail-item-id') === '1.1', 'Selecting the row did not open its detail');
    await focus(row);
  };
  await select();
  const editor = '.item-detail .detail-dock [data-owner-input] textarea';
  // The key needs the session ready and idle and the detail's reply box mounted. Wait for those, then press once: a key the
  // app loses must fail this step, not be pressed again until it happens to land.
  const replyReady = () => wait(async () => await browser.$('.tree-column').getAttribute('data-session-status') === 'ready'
    && await browser.$('.tree-column').getAttribute('data-session-busy') === 'false' && await browser.$(editor).isExisting(),
  'Session and reply box were not ready for the Reply shortcut');
  await replyReady();
  await focus(row);
  await browser.keys('r');
  await wait(() => active(editor), 'Reply shortcut did not focus ordinary native editor');
  const draft = `Native keyboard retained draft ${process.env.ARIADNE_E2E_NONCE}`;
  await (await browser.$(editor)).setValue(draft);
  await browser.keys('g');
  assert.equal(await (await browser.$(editor)).getValue(), `${draft}g`);
  assert.equal(await active(editor), true, 'Editor typing must not switch workspace');
  // Esc in the answer returns focus to the row; Esc on the row closes detail.
  await browser.keys('Escape');
  await wait(() => active(row), 'Editor Escape did not return focus to the item row');
  await browser.keys('Escape');
  await wait(async () => !(await browser.$('.shell-detail').isExisting()), 'Row Escape did not close detail');
  // Draft saves patch preferences; navigation re-reads on change events and its
  // 2 s fallback poll. Let the saved file stay unchanged past one poll so Reply
  // is not issued with a stale preferences revision.
  const preferencesPath = join(process.env.ARIADNE_HOME, 'ui.json');
  let settledSince = Date.now(); let lastSaved = await readFile(preferencesPath, 'utf8');
  await browser.waitUntil(async () => {
    const saved = await readFile(preferencesPath, 'utf8');
    if (saved !== lastSaved) { lastSaved = saved; settledSince = Date.now(); }
    return Date.now() - settledSince >= 3000;
  }, { timeout: 30000, interval: 200, timeoutMsg: 'Saved preferences did not settle after the draft edit' });
  // Same readiness as the first press: selecting the row again re-renders the Details before the key can land.
  await select(); await replyReady(); await focus(row);
  await browser.keys('r'); await wait(() => active(editor), 'Repeated Reply did not refocus');
  assert.equal(await (await browser.$(editor)).getValue(), `${draft}g`);
  await browser.saveScreenshot(join(process.env.ARIADNE_E2E_EVIDENCE, 'native-keyboard-retained-editor.png'));
  // Close session on the top bar's connection card (opened from the connection button) opens its one confirmation.
  await wait(async () => await browser.$('.tree-column').getAttribute('data-session-status') === 'ready'
    && await browser.$('.tree-column').getAttribute('data-session-busy') === 'false', 'Session was not ready for Close session');
  const connection = '[data-popover-trigger="connection"]';
  const actions = await browser.$(connection);
  await actions.waitForEnabled(); await actions.click();
  const closeButton = await browser.$('.cc').$('button=Close session');
  await closeButton.waitForEnabled(); await closeButton.click();
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
  // The card closes as the review opens, so focus returns to the connection button the card came from.
  const opener = await browser.execute(() => ({ trigger: document.activeElement?.getAttribute('data-popover-trigger') ?? null, html: document.activeElement?.outerHTML.slice(0, 300) ?? null }));
  assert.equal(opener.trigger, 'connection', `Dialog restores opener; focus is on ${opener.html}`);
  await browser.saveScreenshot(join(process.env.ARIADNE_E2E_EVIDENCE, 'native-keyboard-dialog-return.png'));
  assert.deepEqual(await readFile(configuration.demo.sessionPath), before, 'Keyboard focus/draft/modal checks leave durable demo domain unchanged');
  await json(join(process.env.ARIADNE_E2E_EVIDENCE, 'keyboard-accessibility.json'), { ordinaryApp: true, actualCoreStore: true,
    realDriverKeys: true, replyFocused: true, editorShortcutSuppressed: true, draftRetained: true, dialogContained: true,
    dialogEscapePreservedDetail: true, openerRestored: true, demoDomainUnchanged: true });
}
