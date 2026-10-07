import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { cliRequest, admissions, snapshot } from './scripted-provider.mjs';
import { json } from '../../../../scripts/run-native-e2e.mjs';

const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const wait = (condition, message) => browser.waitUntil(condition, { timeout: 20000, interval: 100, timeoutMsg: message });
const dialog = () => browser.$('[role="dialog"]');
// Close/Reopen sit in the tree's session bar; Archive and Continue on each topic band.
const sessionBar = () => browser.$('.tree-session-bar');
const topicBand = name => browser.$(`.tree-rows [role="treeitem"][aria-label="${name}"]`);
async function click(control) { await control.waitForDisplayed(); await control.waitForEnabled(); await control.click(); }
async function openSession(sessionId) {
  await click(await browser.$('button[data-shell-tab="all_sessions"]'));
  await click(await browser.$(`[data-session-id="${sessionId}"]`));
  await sessionBar().waitForDisplayed();
}
// A topic band shows its actions while it holds focus (the prototype's hover).
async function topicAction(name, label) {
  const band = await topicBand(name); await band.waitForDisplayed();
  await browser.execute(element => element.focus(), band);
  await click(await band.$(`button*=${label}`));
}
async function lifecycle(button, confirmation, path, predicate) {
  await click(await sessionBar().$(`button*=${button}`));
  await click(await dialog().$(`button=${confirmation}`));
  await wait(async () => predicate(await readJson(path)), `Persisted ${confirmation} was not visible on disk`);
  await wait(async () => !(await dialog().isExisting()), 'Saved history confirmation did not close');
}
async function continuePreview(sourceSession, topicName, targetTitle) {
  await openSession(sourceSession);
  await topicAction(topicName, 'Continue here');
  await click(await dialog().$(`button=${targetTitle}`));
  const send = await dialog().$(`button=Send to ${targetTitle}`);
  try { await send.waitForEnabled(); } catch (failure) {
    throw new Error(`${failure.message}\nDialog text: ${await dialog().getText().catch(() => '(unavailable)')}`, { cause: failure });
  }
  const text = await dialog().getText();
  for (const label of ['Waiting (', 'Open (', 'Terminal (', 'Source revision', 'immutable source provenance']) assert.ok(text.includes(label), `Preview omitted ${label}`);
  return send;
}

// Runs after explicit discovery Connect in the existing native delivery phase.
// Only the isolated discovery target changes; main FIFO and canonical demo stay
// untouched. Every lifecycle/Continue write goes through ordinary App controls.
export async function runHistoryActionsAcceptance(configuration) {
  const evidence = process.env.ARIADNE_E2E_EVIDENCE;
  const fixtureRoot = await realpath(process.env.ARIADNE_E2E_ROOT);
  const targetProject = await realpath(configuration.discovery.projectRoot);
  assert.equal(targetProject, join(fixtureRoot, 'discovery-project'), 'Only the exact owned discovery fixture may be changed');
  const discovered = await readJson(join(evidence, 'discovery-acceptance.json'));
  assert.match(discovered.connected.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // ADR-0082: stores live under the data root at projects/<project-id>.
  const home = process.env.ARIADNE_HOME;
  const targetStore = join(home, 'projects', discovered.connected.project_id);
  const targetPath = join(targetStore, 'sessions', `${discovered.connected.id}.json`);
  const sourcePath = configuration.demo.sessionPath;
  const sourceBytes = await readFile(sourcePath), source = JSON.parse(sourceBytes);
  const sourceProject = await realpath(join(fixtureRoot, 'canonical-demo'));
  assert.equal(sourceProject, join(fixtureRoot, 'canonical-demo'), 'Only the exact owned canonical demo may be made unavailable');
  assert.equal(resolve(sourcePath), join(home, 'projects', source.project_id, 'sessions', `${source.id}.json`));
  const mainBefore = await snapshot(configuration), queuedBefore = await admissions(configuration);
  let target = await readJson(targetPath);
  assert.equal(Object.keys(target.items).length, 0); assert.equal(Object.keys(target.inputs).length, 0);
  const bindingId = target.active_binding_id, generation = target.bindings[bindingId].generation;

  await openSession(target.id);
  await click(await sessionBar().$('button*=Close session'));
  await click(await dialog().$('button=Pause dispatch'));
  assert.equal((await readJson(targetPath)).bindings[bindingId].owner_paused, false, 'Opening Pause confirmation cannot save');
  await click(await dialog().$('button=Confirm Pause dispatch'));
  await wait(async () => (await readJson(targetPath)).bindings[bindingId].dispatch_state === 'paused', 'Close did not await a persisted pause');
  assert.equal((await readJson(targetPath)).state, 'active', 'Pause must not also close');
  await click(await dialog().$('button=Confirm session close'));
  await wait(async () => (await readJson(targetPath)).state === 'closed', 'Separate Close confirmation did not save');
  await wait(async () => !(await dialog().isExisting()), 'Saved Close dialog remained open');
  await lifecycle('Reopen session', 'Confirm session reopen', targetPath, value => value.state === 'active');
  target = await readJson(targetPath);
  assert.equal(target.active_binding_id, bindingId); assert.equal(target.bindings[bindingId].generation, generation);
  assert.equal(target.bindings[bindingId].dispatch_state, 'paused'); assert.equal(target.bindings[bindingId].owner_paused, true);

  const topicName = `Guarded native terminal history ${process.env.ARIADNE_E2E_NONCE}`;
  const seeded = await cliRequest(configuration.cli, ['apply', '--binding', bindingId, '--generation', generation, '--json-stdin'], {
    op_id: randomUUID(), source_input_id: null, attempt_id: null, expected_item_revisions: {}, expected_topic_revisions: {},
    summary: 'Seed one terminal topic through real agent Apply for lifecycle acceptance.', input_result: null,
    operations: [{ op: 'topic.add', ref: 'guarded_topic', name: topicName }, { op: 'item.add', ref: 'guarded_item', topic: { ref: 'guarded_topic' },
      parent: null, question: 'Retain guarded native history', type: 'task', status: 'done', owner: { kind: 'me' }, ask: null,
      options: null, note: null, links: null, outcome: 'Complete saved outcome', why: 'Explicit terminal fixture', replaced_by: null, source_round_id: null }],
  });
  assert.equal(seeded.code, 0);
  target = await readJson(targetPath);
  const terminalTopic = Object.values(target.topics).find(topic => topic.name === topicName);
  assert.ok(terminalTopic);
  await wait(async () => await topicBand(topicName).isExisting(), 'Agent-created terminal topic did not refresh in App');
  const targetHistory = { items: target.items, messages: target.messages, rounds: target.rounds, answers: target.answers, bindings: target.bindings };
  // Nothing blocks an all-closed topic, so its prompt archives at once and the
  // column offers Undo, which restores it (no confirmation dialog either way).
  await click(await topicBand(topicName).$('button*=Archive topic'));
  await wait(async () => (await readJson(targetPath)).topics[terminalTopic.id].archived_at !== null, 'Direct topic archive was not visible on disk');
  assert.equal(await dialog().isExisting(), false, 'An unblocked archive must not open the review');
  await wait(async () => (await browser.$('.tree-column').getText()).includes(`Archived “${topicName}”.`), 'Archive did not report its Undo banner');
  await click(await browser.$('.tree-column').$('button=Undo'));
  await wait(async () => (await readJson(targetPath)).topics[terminalTopic.id].archived_at === null, 'Undo did not restore the topic on disk');
  await wait(async () => await topicBand(topicName).isExisting(), 'Restored topic did not return to the tree');
  target = await readJson(targetPath);
  for (const [field, contents] of Object.entries(targetHistory)) assert.deepEqual(target[field], contents, `${field} changed across archive/restore`);

  await openSession(source.id);
  const sourceTopic = Object.values(source.topics).find(topic => Object.values(source.items).some(item => item.topic_id === topic.id && item.status === 'waiting_on_me'));
  assert.ok(sourceTopic);
  await topicAction(sourceTopic.name, 'Archive');
  assert.equal(await dialog().$('button=Confirm topic archive').isEnabled(), false);
  assert.ok((await dialog().getText()).includes('Input '));
  const blocker = await dialog().$('button*=Item ');
  const blockerId = (await blocker.getText()).match(/^Item ([0-9.]+)/)[1];
  await click(blocker);
  await wait(async () => (await browser.$('[aria-label="Item detail"]').getText()).includes(`Item ${blockerId}`), 'Guard blocker did not reveal its registered item');
  assert.deepEqual(await readFile(sourcePath), sourceBytes);

  const targetBytes = await readFile(targetPath), targetBefore = JSON.parse(targetBytes);
  const send = await continuePreview(source.id, sourceTopic.name, targetBefore.title);
  const approvedSummary = await dialog().$('details p').getProperty('textContent');
  assert.deepEqual(await readFile(targetPath), targetBytes, 'Preview must not allocate or persist a target copy');
  const backup = join(targetStore, 'backups',`${target.id}.previous.json`);
  const preservedBackup = `${backup}.preserved-${randomUUID()}`;
  await rename(backup, preservedBackup);
  let obstruction = false;
  let pendingOperation;
  try {
    await mkdir(backup); obstruction = true;
    await click(send);
    await wait(async () => (await dialog().getText()).includes('Completion is unknown'), 'Target save failure was not retained for exact reconciliation');
    pendingOperation = await dialog().$('[data-operation-id]').getAttribute('data-operation-id');
    assert.match(pendingOperation, /^[0-9a-f-]{36}$/);
    assert.deepEqual(await readFile(sourcePath), sourceBytes, 'Forced target write failure changed source');
    assert.deepEqual(await readFile(targetPath), targetBytes, 'Forced target write failure saved partial target effects');
    const failed = await readJson(targetPath);
    assert.deepEqual(failed.continuations, targetBefore.continuations); assert.deepEqual(failed.inputs, targetBefore.inputs);
  } finally {
    if (obstruction) await rm(backup, { recursive: true });
    await rename(preservedBackup, backup);
  }
  await click(await dialog().$('button=Reconcile saved action'));
  await wait(async () => Object.keys((await readJson(targetPath)).continuations).length === Object.keys(targetBefore.continuations).length + 1, 'Explicit reconciliation did not save one continuation');
  await wait(async () => !(await dialog().isExisting()), 'Reconciled Continue dialog did not close');
  const finalTarget = await readJson(targetPath), copied = Object.values(finalTarget.continuations).find(value => !targetBefore.continuations[value.operation_id]);
  assert.ok(copied); assert.equal(copied.source_project_id, source.project_id); assert.equal(copied.source_session_id, source.id);
  assert.equal(copied.operation_id, pendingOperation, 'Reconcile must use the original uncertain operation ID');
  assert.equal(copied.summary, approvedSummary, 'Reconcile must preserve the exact approved handoff summary');
  assert.equal(copied.source_topic_id, sourceTopic.id); assert.equal(copied.source_revision, source.revision);
  assert.equal(Object.keys(finalTarget.inputs).length, Object.keys(targetBefore.inputs).length + 1);
  const handoff = finalTarget.inputs[copied.target_input_id];
  assert.equal(handoff.kind, 'continue'); assert.equal(handoff.state, 'queued'); assert.equal(handoff.attempts.length, 0);
  assert.equal(finalTarget.bindings[bindingId].dispatch_state, 'paused');
  assert.equal(Object.values(finalTarget.operation_receipts).flat().filter(receipt => receipt.result.data.kind === 'continuation').length, 1);
  const sourceItems = Object.values(source.items).filter(item => item.topic_id === sourceTopic.id);
  assert.deepEqual(Object.keys(copied.item_id_map).sort(), sourceItems.map(item => item.id).sort());
  for (const item of sourceItems) {
    const imported = finalTarget.items[copied.item_id_map[item.id]];
    assert.equal(imported.question, item.question); assert.equal(imported.origin.entity_id, item.id);
  }
  for (const [oldId, localId] of Object.entries(copied.message_id_map)) {
    const original = source.messages.find(message => message.id === oldId), imported = finalTarget.messages.find(message => message.id === localId);
    assert.equal(imported.body, original.body); assert.equal(imported.origin.entity_id, oldId);
  }
  const originalItem = sourceItems.find(item => source.messages.some(message => message.item_id === item.id));
  assert.ok(originalItem);
  const copiedItemId = copied.item_id_map[originalItem.id];
  await openSession(finalTarget.id);
  await click(await browser.$(`.tree-item[data-item-id="${copiedItemId}"]`));
  await click(await browser.$('[aria-label="Item history view"]').$('button*=Timeline'));
  const copiedBodies = source.messages.filter(message => message.item_id === originalItem.id).map(message => message.body);
  await wait(async () => {
    const text = await browser.$('[aria-label="Item detail"]').getText();
    return copiedBodies.every(body => text.includes(body));
  }, 'Copied full conversation was not readable');
  const unavailableProject = `${sourceProject}.unavailable-${randomUUID()}`;
  await rename(sourceProject, unavailableProject);
  try {
    await click(await browser.$('.copied-provenance').$(`button=Source item ${originalItem.id}`));
    await wait(async () => (await browser.$('.copied-provenance').getText()).includes('Full copied history remains here'), 'Unavailable original project did not expose copied local fallback');
    const unavailableReason = await browser.$('.copied-provenance').getText();
    assert.ok(unavailableReason.includes(sourceProject), 'The registered source failure must retain its actual project path');
    assert.ok(unavailableReason.includes('NotFound'), 'The registered source failure must retain the actual missing-directory reason');
    await click(await browser.$('.copied-provenance').$(`button=Open copied item ${copiedItemId}`));
    await wait(async () => (await browser.$('[aria-label="Item detail"]').getText()).includes(`Item ${copiedItemId}`), 'Copied provenance fallback did not use the local registered item');
    await click(await browser.$('[aria-label="Item history view"]').$('button*=Timeline'));
    await wait(async () => {
      const text = await browser.$('[aria-label="Item detail"]').getText();
      return copiedBodies.every(body => text.includes(body));
    }, 'Original project failure lost copied full bodies');
  } finally { await rename(unavailableProject, sourceProject); }
  assert.deepEqual(await readFile(sourcePath), sourceBytes); assert.deepEqual(await snapshot(configuration), mainBefore);
  assert.deepEqual(await admissions(configuration), queuedBefore, 'Lifecycle and queued Continue must not signal any host');
  await browser.saveScreenshot(join(evidence, 'history-actions.png'));
  await json(join(evidence, 'history-actions.json'), { targetBefore, finalTarget, copied, pauseCloseSeparate: true, historyRetained: true,
    forcedFailureSavedNothing: true, sourceUnchanged: true, mainJourneyUnchanged: true, queuedSingleHandoff: true, unavailableSourceLocalFallback: true });
}
