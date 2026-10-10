import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { cliRequest, admissions, snapshot } from './scripted-provider.mjs';
import { json } from '../../../../scripts/run-native-e2e.mjs';
import { openSessionButton } from './session-button.mjs';
import { folded } from './owner-reply.mjs';

const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const wait = (condition, message) => browser.waitUntil(condition, { timeout: 20000, interval: 100, timeoutMsg: message });
const dialog = () => browser.$('[role="dialog"]');
async function archiveDiagnostics(failure) {
  let tree = '(unavailable)', hasDialog = '(unavailable)';
  try { tree = await browser.$('.tree-column').getText(); } catch { /* Keep the original archive failure. */ }
  try { hasDialog = await dialog().isExisting(); } catch { /* Diagnostics may fail before returning a promise. */ }
  return new Error(`${failure.message}\nTree column text: ${tree}\nDialog exists: ${hasDialog}`, { cause: failure });
}
// The detail carries its canonical local item identity.
const detailReference = async () => {
  const detail = await browser.$('.item-detail');
  return await detail.isExisting() ? detail.getAttribute('data-detail-item-id') : null;
};
// Close lives in Session actions; Reopen sits in the session bar; Archive and Continue on each topic band.
const sessionBar = () => browser.$('.tree-session-bar');
const topicBand = name => browser.$(`.tree-rows [role="treeitem"][aria-label="${name}"]`);
async function click(control) { await control.waitForDisplayed(); await control.waitForEnabled(); await control.click(); }
async function openSession(sessionId) {
  await click(await browser.$('button[data-shell-tab="all_sessions"]'));
  await click(await openSessionButton(sessionId));
  await sessionBar().waitForDisplayed();
}
// A topic band shows its actions while it holds focus (the prototype's hover).
export async function topicAction(name, label) {
  const band = await topicBand(name); await band.waitForDisplayed();
  await browser.execute(element => element.focus(), band);
  await click(await band.$(`button[aria-label="${label}"]`));
}
export async function archiveClosedTopic(topicId) {
  // The all-closed prompt sits below the sticky band, in that topic's sibling content.
  try {
    await wait(async () => await browser.$('.tree-column').getAttribute('data-session-status') === 'ready'
      && await sessionBar().getAttribute('aria-busy') === 'false', 'Session was not ready for direct topic archive');
    await click(await browser.$(`.tree-rows [data-topic-id="${topicId}"] + .tree-topic-content .tree-prompt button`));
  } catch (failure) { throw await archiveDiagnostics(failure); }
}
async function lifecycle(button, confirmation, path, predicate) {
  if (button === 'Close session') {
    await click(await sessionBar().$('button[aria-label="Session actions"]'));
    await click(await sessionBar().$('[role="menuitem"]*=Close session'));
  } else await click(await sessionBar().$(`button*=${button}`));
  await click(await dialog().$(`button=${confirmation}`));
  await wait(async () => predicate(await readJson(path)), `Persisted ${confirmation} was not visible on disk`);
  await wait(async () => !(await dialog().isExisting()), 'Saved history confirmation did not close');
}
async function continuePreview(sourceSession, topicName, targetTitle) {
  await openSession(sourceSession);
  await topicAction(topicName, 'Continue here');
  // The picker lists each other active session by title, with its agent and state under it.
  await click(await dialog().$(`button*=${targetTitle}`));
  const send = await dialog().$('button*=Send to');
  try { await send.waitForEnabled(); } catch (failure) {
    throw new Error(`${failure.message}\nDialog text: ${await dialog().getText().catch(() => '(unavailable)')}`, { cause: failure });
  }
  const text = await dialog().getText();
  for (const label of [`Continue “${topicName}” in this session`, 'WAITING ON YOU ·', 'Item references stay the same'])
    assert.ok(text.toUpperCase().includes(label.toUpperCase()), `Preview omitted ${label}`);
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
  // The session bar's chip pauses sending in one click.
  const pauseSending = async () => {
    await click(await sessionBar().$('.dispatch-chip').$('button[aria-label="Pause"]'));
    await wait(async () => (await readJson(targetPath)).bindings[bindingId].dispatch_state === 'paused', 'Pause was not persisted');
    await wait(async () => (await sessionBar().$('.dispatch-chip').getText()).includes('Paused (by you)'), 'Chip did not show Paused (by you)');
  };
  await pauseSending();
  assert.equal((await readJson(targetPath)).state, 'active', 'Pause must not also close');
  // Close is one confirmation in plain words; nothing has to be paused first.
  await lifecycle('Close session', 'Close session', targetPath, value => value.state === 'closed');
  await lifecycle('Reopen session', 'Reopen session', targetPath, value => value.state === 'active');
  target = await readJson(targetPath);
  assert.equal(target.active_binding_id, bindingId); assert.equal(target.bindings[bindingId].generation, generation);
  assert.equal(target.bindings[bindingId].owner_paused, false, 'Reopen resumes sending');
  // Later steps need queued work to stay put: pause again.
  await pauseSending();
  target = await readJson(targetPath);
  assert.equal(target.bindings[bindingId].dispatch_state, 'paused'); assert.equal(target.bindings[bindingId].owner_paused, true);

  const topicName = `Guarded native terminal history ${process.env.ARIADNE_E2E_NONCE}`;
  const seeded = await cliRequest(configuration.cli, ['apply', '--binding', bindingId, '--generation', generation, '--json-stdin'], {
    op_id: randomUUID(), source_input_id: null, attempt_id: null, expected_item_revisions: {}, expected_topic_revisions: {},
    summary: 'Create one Open root through real agent Apply for lifecycle acceptance.', input_result: null,
    operations: [{ op: 'topic.add', ref: 'guarded_topic', name: topicName }, { op: 'item.add', ref: 'guarded_item', topic: { ref: 'guarded_topic' },
      parent: null, question: 'Retain guarded native history', type: 'task', status: 'open', owner: { kind: 'me' }, ask: null,
      options: null, note: null, links: null, outcome: null, why: null, replaced_by: null, source_round_id: null }],
  });
  assert.equal(seeded.code, 0);
  target = await readJson(targetPath);
  const terminalTopic = Object.values(target.topics).find(topic => topic.name === topicName);
  assert.ok(terminalTopic);
  const created = Object.values(target.items).find(item => item.topic_id === terminalTopic.id);
  assert.equal(created.status, 'open'); assert.equal(created.ack_to ?? null, null);
  const completed = await cliRequest(configuration.cli, ['apply', '--binding', bindingId, '--generation', generation, '--json-stdin'], {
    op_id: randomUUID(), source_input_id: null, attempt_id: null, expected_item_revisions: { [created.id]: created.revision }, expected_topic_revisions: {},
    summary: 'Finish the existing fixture root for guarded terminal history.', input_result: null,
    operations: [{ op: 'item.status', item: { id: created.id }, status: 'done', outcome: 'Complete saved outcome', why: 'Explicit terminal fixture', reason: null }],
  });
  assert.equal(completed.code, 0);
  target = await readJson(targetPath);
  assert.equal(target.items[created.id].status, 'done'); assert.equal(target.items[created.id].ack_to ?? null, null);
  await wait(async () => await topicBand(topicName).isExisting(), 'Agent-created terminal topic did not refresh in App');
  const targetHistory = { items: target.items, messages: target.messages, rounds: target.rounds, answers: target.answers, bindings: target.bindings };
  // Nothing blocks an all-closed topic, so its prompt archives at once and the
  // column offers Undo, which restores it (no confirmation dialog either way).
  await archiveClosedTopic(terminalTopic.id);
  try {
    await wait(async () => (await readJson(targetPath)).topics[terminalTopic.id].archived_at !== null, 'Direct topic archive was not visible on disk');
  } catch (failure) { throw await archiveDiagnostics(failure); }
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
  // Archive never refuses a topic with open work: it asks once, in plain words, what stays and what is cancelled (ADR-0090).
  await topicAction(sourceTopic.name, 'Archive');
  await dialog().waitForDisplayed();
  const archiveText = await dialog().getText();
  assert.ok(archiveText.includes(`Archive “${sourceTopic.name}”?`), 'Archive confirmation did not name the topic');
  assert.match(archiveText, /open items? stays? as (it is|they are)\./);
  assert.ok(archiveText.includes('You can restore it any time.'));
  assert.doesNotMatch(archiveText, /[0-9a-f]{8}-[0-9a-f]{4}-/);
  assert.equal(await dialog().$('button=Archive topic').isEnabled(), true);
  // Cancel leaves it as it is; the source is continued below.
  await click(await dialog().$('button=Cancel'));
  await wait(async () => !(await dialog().isExisting()), 'Archive confirmation did not close on Cancel');
  assert.deepEqual(await readFile(sourcePath), sourceBytes);

  const targetBytes = await readFile(targetPath), targetBefore = JSON.parse(targetBytes);
  const send = await continuePreview(source.id, sourceTopic.name, targetBefore.title);
  // The exact summary Send hands over, as the dialog holds it for review.
  const approvedSummary = await dialog().$('[aria-label="Summary"]').getAttribute('data-summary');
  assert.ok(approvedSummary, 'Preview did not hold a summary to send');
  assert.deepEqual(await readFile(targetPath), targetBytes, 'Preview must not allocate or persist a target copy');
  const backup = join(targetStore, 'backups',`${target.id}.previous.json`);
  const preservedBackup = `${backup}.preserved-${randomUUID()}`;
  await rename(backup, preservedBackup);
  let obstruction = false;
  let pendingOperation;
  try {
    await mkdir(backup); obstruction = true;
    await click(send);
    await wait(async () => (await dialog().getText()).includes('isn’t sure the summary was sent'), 'Target save failure was not retained for exact reconciliation');
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
  await click(await dialog().$('button=Check again'));
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
  await (await browser.$('.item-detail [aria-label="Conversation"]')).waitForDisplayed();
  const copiedBodies = source.messages.filter(message => message.item_id === originalItem.id).map(message => message.body);
  await wait(async () => {
    const text = folded(await browser.$('[aria-label="Item detail"]').getText());
    return copiedBodies.every(body => text.includes(folded(body)));
  }, 'Copied full conversation was not readable');
  const unavailableProject = `${sourceProject}.unavailable-${randomUUID()}`;
  await rename(sourceProject, unavailableProject);
  try {
    await click(await browser.$('.copied-provenance').$(`button=Source item ${originalItem.id}`));
    await wait(async () => (await browser.$('.copied-provenance').getText()).includes('Full copied history remains here'), 'Unavailable original project did not expose copied local fallback');
    const unavailableReason = await browser.$('.copied-provenance').getText();
    // The screen names the missing folder and says what to do (data/plain.ts originalFailure; core sends io_error for a missing folder); the OS
    // reason (NotFound) goes to the console for diagnostics, never into the owner-facing text.
    assert.ok(unavailableReason.includes('The original project folder (') && unavailableReason.includes(basename(sourceProject))
      && unavailableReason.includes('is missing or can’t be read. Restore it or move it back, then try again.'), 'The registered source failure must name the folder and say to restore it');
    assert.ok(!unavailableReason.includes('NotFound'), 'The owner-facing failure must not expose the OS error');
    await click(await browser.$('.copied-provenance').$(`button=Open copied item ${copiedItemId}`));
    await wait(async () => await detailReference() === copiedItemId, 'Copied provenance fallback did not use the local registered item');
    await (await browser.$('.item-detail [aria-label="Conversation"]')).waitForDisplayed();
    await wait(async () => {
      const text = folded(await browser.$('[aria-label="Item detail"]').getText());
      return copiedBodies.every(body => text.includes(folded(body)));
    }, 'Original project failure lost copied full bodies');
  } finally { await rename(unavailableProject, sourceProject); }
  assert.deepEqual(await readFile(sourcePath), sourceBytes); assert.deepEqual(await snapshot(configuration), mainBefore);
  assert.deepEqual(await admissions(configuration), queuedBefore, 'Lifecycle and queued Continue must not signal any host');
  await browser.saveScreenshot(join(evidence, 'history-actions.png'));
  await json(join(evidence, 'history-actions.json'), { targetBefore, finalTarget, copied, pauseCloseSeparate: true, historyRetained: true,
    forcedFailureSavedNothing: true, sourceUnchanged: true, mainJourneyUnchanged: true, queuedSingleHandoff: true, unavailableSourceLocalFallback: true });
}
