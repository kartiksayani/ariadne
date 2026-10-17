import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { admissions, cliRequest, snapshot } from './scripted-provider.mjs';
import { json } from '../../../../scripts/run-native-e2e.mjs';
import { goToPage, openSession, sessionReady } from './session-button.mjs';
import { topicAction } from './history-actions.spec.mjs';

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
// The item and topic notes stay listed (dismissible, no timeout), so the × is scoped to the note's own text.
async function dismissNote(matches, description) {
  let note;
  await wait(async () => {
    for (const candidate of await notices().$$('.pw-note')) {
      if (matches(await candidate.$('.pw-note-text').getText())) { note = candidate; return true; }
    }
    return false;
  }, `No note read ${description}`);
  await click(await note.$('button[aria-label="Dismiss"]'));
}
// A session row of All sessions, found by its name button.
const sessionRow = sessionId => browser.$(`//button[@data-session-id="${sessionId}"]/ancestor::div[contains(@class, "sl-row")]`);

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
  // A topic with no root items leaves the tree, so a second root keeps the band listed after the item goes.
  const bindingId = before.active_binding_id, generation = before.bindings[bindingId].generation;
  const kept = await cliRequest(configuration.cli, ['apply', '--binding', bindingId, '--generation', generation, '--json-stdin'], {
    op_id: randomUUID(), source_input_id: null, attempt_id: null, expected_item_revisions: {}, expected_topic_revisions: {},
    summary: 'Create a second Open root so the guarded topic stays listed for its own Remove.', input_result: null,
    operations: [{ op: 'item.add', ref: 'kept_item', topic: { id: topic.id }, parent: null, question: 'Keep the guarded topic listed', type: 'task',
      status: 'open', owner: { kind: 'me' }, ask: null, options: null, note: null, links: null, outcome: null,
      why: null, replaced_by: null, source_round_id: null }],
  });
  assert.equal(kept.code, 0);
  const created = Object.values((await readJson(sessionPath)).items).find(value => value.topic_id === topic.id && value.id !== item.id && value.parent === null);
  assert.equal(created.status, 'open'); assert.equal(created.ack_to ?? null, null);
  const completed = await cliRequest(configuration.cli, ['apply', '--binding', bindingId, '--generation', generation, '--json-stdin'], {
    op_id: randomUUID(), source_input_id: null, attempt_id: null, expected_item_revisions: { [created.id]: created.revision }, expected_topic_revisions: {},
    summary: 'Finish the existing second fixture root for guarded terminal history.', input_result: null,
    operations: [{ op: 'item.status', item: { id: created.id }, status: 'done', outcome: 'Complete saved outcome', why: 'Explicit terminal fixture', reason: null }],
  });
  assert.equal(completed.code, 0);
  const finished = (await readJson(sessionPath)).items[created.id];
  assert.equal(finished.status, 'done'); assert.equal(finished.ack_to ?? null, null);
  await wait(async () => Object.values((await readJson(sessionPath)).items).filter(value => value.topic_id === topic.id).length === 2, 'The second guarded root was not saved');

  // Item: ⌫ on the row asks first, the row goes at once, and the command waits out the Undo window.
  await openSession(sessionId);
  await sessionReady();
  const row = `.tree-rows [role="treeitem"][data-item-id="${item.id}"]`;
  // Item keys act on the selected item: select the row (a click), then press ⌫ on it.
  await (await browser.$(row)).waitForDisplayed(); await click(await browser.$(row));
  await wait(async () => await browser.$('.item-detail').getAttribute('data-detail-item-id') === item.id, 'Selecting the row did not open its detail');
  await browser.execute(selector => document.querySelector(selector).focus(), row);
  await browser.keys('Backspace');
  await confirm('Remove item');
  await wait(async () => !(await browser.$(row).isExisting()), 'The removed row stayed in the tree');
  // Notices arrive as toasts after a short settle, so wait for the text rather than reading it once.
  await wait(async () => (await notices().getText()).includes('unless you undo'), 'Item remove did not offer Undo', 4000);
  assert.ok((await readJson(sessionPath)).items[item.id], 'Item remove ran before the Undo window ended');
  await wait(async () => !(await readJson(sessionPath)).items[item.id], 'Item remove did not run after the Undo window', 30000);
  const afterItem = await readJson(sessionPath);
  assert.ok(Object.values(afterItem.inputs).some(input => input.kind === 'removed'), 'Item remove did not queue the agent notice');

  // Topic: the band's Remove, same deferred command. ⌫ no longer removes a topic (SPEC 6.1: it acts on the selected item
  // only), so the band's own button is the path; it shows while the band holds focus.
  await topicAction(topicName, 'Remove');
  await confirm('Remove topic');
  await wait(async () => !(await topicBand(topicName).isExisting()), 'The removed topic stayed in the tree');
  await wait(async () => !(await readJson(sessionPath)).topics[topic.id], 'Topic remove did not run after the Undo window', 30000);

  // Session: only an archived session is removed for good, from the Archive page's "…". Archive it from All sessions first.
  // Ariadne only, so the command runs on Dismiss.
  await goToPage('All sessions');
  await (await sessionRow(sessionId)).waitForDisplayed();
  await click(await (await sessionRow(sessionId)).$('button[aria-label^="Archive "]'));
  const archiving = await browser.$('[role="dialog"]');
  await click(await archiving.$('button=Archive session'));
  await wait(async () => (await readJson(sessionPath)).archived_at !== null, 'The session was not archived on disk');
  // The dialog's close refreshes the catalogue that the Archive page lists.
  await wait(async () => !(await archiving.isExisting()), 'The archive confirmation did not close');
  await goToPage('Archive');
  const archived = '[role="region"][aria-label="Archive"] .ar-sec[aria-label^="Sessions"] .ar-row';
  await (await browser.$(archived)).waitForDisplayed();
  await click(await browser.$(archived).$('button[aria-label^="More for "]'));
  await click(await browser.$('[role="menuitem"]*=Remove from Ariadne'));
  await confirm('Remove session');
  await wait(async () => !(await browser.$(archived).isExisting()), 'The removed session row stayed listed');
  assert.ok(await exists(sessionPath), 'Session remove ran before Dismiss');
  await dismissNote(text => /^Removed the .+ session from .+\.$/.test(text), 'the session removal');
  await wait(async () => !(await exists(sessionPath)),'Session remove did not delete the session file after Dismiss');

  // Project: its card's "…" on the Projects page; the card is named by its folder.
  await goToPage('Projects');
  const projectName = basename(configuration.discovery.projectRoot);
  const projectMore = `button[aria-label="More for ${projectName}: remove project"]`;
  await click(await browser.$(projectMore));
  await click(await browser.$('[role="menuitem"]*=Remove project'));
  const removing = await browser.$('[role="dialog"]');
  await click(await removing.$('button=Remove project'));
  await wait(async () => !(await removing.isExisting()), 'Remove project confirmation did not close');
  await wait(async () => !(await browser.$(projectMore).isExisting()), 'The removed project card stayed listed');
  assert.ok(await exists(store), 'Project remove ran before Dismiss');
  await dismissNote(text => text === `Removed ${projectName}.`, `“Removed ${projectName}.”`);
  await wait(async () => !(await exists(store)),'Project remove did not delete the project store after Dismiss');

  assert.deepEqual(await readFile(configuration.demo.sessionPath), demoBytes, 'Remove changed the canonical demo');
  assert.deepEqual(await snapshot(configuration), mainBefore, 'Remove changed the main journey');
  assert.deepEqual(await admissions(configuration), queuedBefore, 'Remove signalled the main host');
  await browser.saveScreenshot(join(evidence, 'remove.png'));
  await json(join(evidence, 'remove.json'), { projectId, sessionId, itemId: item.id, topicId: topic.id, itemDeferred: true,
    agentNoticeQueued: true, topicDeferred: true, sessionOnDismiss: true, projectOnDismiss: true, demoUnchanged: true, mainJourneyUnchanged: true });
}
