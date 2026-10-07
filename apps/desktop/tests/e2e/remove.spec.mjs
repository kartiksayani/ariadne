import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { admissions, snapshot } from './scripted-provider.mjs';
import { json } from '../../../../scripts/run-native-e2e.mjs';
import { openSessionButton } from './session-button.mjs';

const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const exists = async path => { try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const wait = (condition, message, timeout = 20000) => browser.waitUntil(condition, { timeout, interval: 100, timeoutMsg: message });
const dialog = () => browser.$('[role="alertdialog"]');
const notices = () => browser.$('.pw-notices');
const topicBand = name => browser.$(`.tree-rows [role="treeitem"][aria-label="${name}"]`);
async function click(control) { await control.waitForDisplayed(); await control.waitForEnabled(); await control.click(); }
async function confirm(label) {
  await click(await dialog().$(`button=${label}`));
  await wait(async () => !(await dialog().isExisting()), `${label} confirmation did not close`);
}
async function projectPage(projectId) {
  await click(await browser.$('button[data-shell-tab="projects"]'));
  await click(await browser.$(`.pw-project-card[data-project-id="${projectId}"] .pw-project-open`));
  await (await browser.$('.pw-session-lists')).waitForDisplayed();
}

// Runs last in the delivery phase, on the discovery target that
// history-actions left behind. It removes an item, a topic, the session and
// the project through ordinary App controls (ADR-0083). The removed topic has
// no continuation family, so the canonical demo and the main FIFO stay as they were.
export async function runRemoveAcceptance(configuration) {
  const evidence = process.env.ARIADNE_E2E_EVIDENCE, home = process.env.ARIADNE_HOME;
  const discovered = await readJson(join(evidence, 'discovery-acceptance.json'));
  const projectId = discovered.connected.project_id, sessionId = discovered.connected.id;
  const store = join(home, 'projects', projectId), sessionPath = join(store, 'sessions', `${sessionId}.json`);
  const demoBytes = await readFile(configuration.demo.sessionPath);
  const mainBefore = await snapshot(configuration), queuedBefore = await admissions(configuration);
  const before = await readJson(sessionPath);
  const topicName = `Guarded native terminal history ${process.env.ARIADNE_E2E_NONCE}`;
  const topic = Object.values(before.topics).find(value => value.name === topicName);
  assert.ok(topic, 'history-actions must leave its guarded terminal topic');
  assert.ok(!Object.values(before.topics).some(value => value.id !== topic.id && value.origin?.entity_id === topic.id), 'The guarded topic must have no continuation copies');
  const item = Object.values(before.items).find(value => value.topic_id === topic.id && value.parent === null);
  assert.ok(item, 'The guarded topic must hold its seeded item');

  // Item: ⌫ on the row asks first, the row goes at once, and the command waits out the Undo window.
  await click(await browser.$('button[data-shell-tab="all_sessions"]'));
  await click(await openSessionButton(sessionId));
  const row = `.tree-rows [role="treeitem"][data-item-id="${item.id}"]`;
  await (await browser.$(row)).waitForDisplayed();
  await browser.execute(selector => document.querySelector(selector).focus(), row);
  await browser.keys('Backspace');
  await confirm('Remove item');
  await wait(async () => !(await browser.$(row).isExisting()), 'The removed row stayed in the tree');
  assert.ok((await notices().getText()).includes('unless you undo'), 'Item remove did not offer Undo');
  assert.ok((await readJson(sessionPath)).items[item.id], 'Item remove ran before the Undo window ended');
  await wait(async () => !(await readJson(sessionPath)).items[item.id], 'Item remove did not run after the Undo window', 30000);
  const afterItem = await readJson(sessionPath);
  assert.ok(Object.values(afterItem.inputs).some(input => input.kind === 'removed'), 'Item remove did not queue the agent notice');

  // Topic: the band's Remove action, same deferred command.
  const band = await topicBand(topicName); await band.waitForDisplayed();
  await browser.execute(element => element.focus(), band);
  await click(await band.$('button=Remove'));
  await confirm('Remove topic');
  await wait(async () => !(await topicBand(topicName).isExisting()), 'The removed topic stayed in the tree');
  await wait(async () => !(await readJson(sessionPath)).topics[topic.id], 'Topic remove did not run after the Undo window', 30000);

  // Session: the project page card; Ariadne only, so the command runs on Dismiss.
  await projectPage(projectId);
  const card = `[data-session-card="${sessionId}"]`;
  await click(await browser.$(card).$('button=Remove'));
  await confirm('Remove session');
  await wait(async () => !(await browser.$(card).isExisting()), 'The removed session card stayed listed');
  assert.ok(await exists(sessionPath), 'Session remove ran before Dismiss');
  await click(await notices().$('button[aria-label="Dismiss"]'));
  await wait(async () => !(await exists(sessionPath)), 'Session remove did not delete the session file after Dismiss');

  // Project: the Projects page card trash.
  await click(await browser.$('button[data-shell-tab="projects"]'));
  const projectCard = `.pw-project-card[data-project-id="${projectId}"]`;
  await click(await browser.$(projectCard).$('button[aria-label="Remove project"]'));
  await confirm('Remove project');
  await wait(async () => !(await browser.$(projectCard).isExisting()), 'The removed project card stayed listed');
  assert.ok(await exists(store), 'Project remove ran before Dismiss');
  await click(await notices().$('button[aria-label="Dismiss"]'));
  await wait(async () => !(await exists(store)), 'Project remove did not delete the project store after Dismiss');

  assert.deepEqual(await readFile(configuration.demo.sessionPath), demoBytes, 'Remove changed the canonical demo');
  assert.deepEqual(await snapshot(configuration), mainBefore, 'Remove changed the main journey');
  assert.deepEqual(await admissions(configuration), queuedBefore, 'Remove signalled the main host');
  await browser.saveScreenshot(join(evidence, 'remove.png'));
  await json(join(evidence, 'remove.json'), { projectId, sessionId, itemId: item.id, topicId: topic.id, itemDeferred: true,
    agentNoticeQueued: true, topicDeferred: true, sessionOnDismiss: true, projectOnDismiss: true, demoUnchanged: true, mainJourneyUnchanged: true });
}
