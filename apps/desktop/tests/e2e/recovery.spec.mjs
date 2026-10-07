import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { delay, json } from '../../../../scripts/run-native-e2e.mjs';
import { admissions, cliRequest, completeTurn, journeyResultRequest, publishResult, snapshot } from './scripted-provider.mjs';
import { sendDetailReply } from './owner-reply.mjs';

const wait = (condition, message) => browser.waitUntil(condition, { timeout: 20000, interval: 100, timeoutMsg: message });
const dialog = () => browser.$('[role="dialog"]');
const sessionPresence = () => browser.$('.tree-session-bar .tree-run');
async function click(control) { await control.waitForDisplayed(); await control.waitForEnabled(); await control.scrollIntoView({ block: 'center' }); await control.click(); }

export function originalReplyRequest(configuration, admission, session, text) {
  const request = journeyResultRequest(configuration, admission, session, text);
  request.input_result = null;
  return request;
}

export function assertRepairAdmission(configuration, admission, session, original, reply) {
  const input = session.inputs[admission.inputId], attempt = input.attempts.find(attempt => attempt.id === admission.attemptId);
  assert.equal(input.id, original.inputId); assert.equal(input.binding_id, configuration.bindingId);
  assert.equal(admission.bindingId, configuration.bindingId); assert.equal(admission.generation, configuration.generation);
  assert.ok(attempt); assert.equal(attempt.binding_generation, configuration.generation);
  assert.equal(attempt.purpose, 'result_repair'); assert.equal(attempt.repair_for_attempt_id, original.attemptId);
  assert.equal(attempt.formatted_payload, admission.payload);
  assert.ok(admission.payload.startsWith(`[ARIADNE_INPUT:${input.id}:${attempt.id}]\n`));
  const body = JSON.parse(admission.payload.slice(admission.payload.indexOf('\n') + 1));
  assert.equal(body.purpose, 'result_repair'); assert.equal(body.repair_for_attempt_id, original.attemptId);
  assert.equal(body.binding_id, configuration.bindingId); assert.equal(body.generation, configuration.generation);
  assert.equal(body.source_input_id, input.id); assert.ok(body.original_message_ids.includes(reply.id), 'Repair must reference the retained original reply');
  assert.ok(body.instruction.includes('result-only')); assert.equal(body.original_domain_result, null);
  assert.equal(Object.hasOwn(body, 'saved_input'), false, 'Repair cannot include the original action payload');
  const repeatsOriginalWork = value => typeof value === 'string' ? value.includes(input.payload.text)
    : value !== null && typeof value === 'object' && Object.values(value).some(repeatsOriginalWork);
  assert.equal(repeatsOriginalWork(body), false, 'Repair cannot repeat the original owner work');
  assert.notEqual(attempt.id, original.attemptId); assert.notEqual(admission.turnId, original.turnId);
  return body;
}

export function repairResultRequest(configuration, admission, session, original, reply) {
  assertRepairAdmission(configuration, admission, session, original, reply);
  const request = journeyResultRequest(configuration, admission, session, '');
  request.operations = [];
  request.expected_item_revisions = {};
  request.input_result.explanation = 'Verified retained original reply; publish only the missing structured result.';
  request.input_result.reply_refs = [{ id: reply.id }];
  return request;
}

async function apply(configuration, request) {
  const result = await cliRequest(configuration.cli, ['apply', '--binding', configuration.bindingId, '--generation', configuration.generation, '--json-stdin'], request);
  assert.equal(result.code, 0); assert.equal(result.value.session_id, configuration.sessionId);
  return { request, receipt: result.value };
}

async function openPrimary(configuration) {
  await click(await browser.$('button[data-shell-tab="all_sessions"]'));
  await wait(async () => {
    const selected = JSON.parse(await readFile(join(process.env.ARIADNE_HOME, 'ui.json'), 'utf8')).snapshot.global.selected_navigation;
    return selected.kind === 'all_sessions' && await browser.$('button[data-shell-tab="all_sessions"]').isEnabled();
  }, 'Recovery All sessions navigation did not finish');
  await click(await browser.$(`[data-session-id="${configuration.sessionId}"]`));
  await wait(async () => {
    const selected = JSON.parse(await readFile(join(process.env.ARIADNE_HOME, 'ui.json'), 'utf8')).snapshot.global.selected_navigation;
    return selected.kind === 'session' && selected.session.session_id === configuration.sessionId
      && await browser.$('button[data-shell-tab="all_sessions"]').isEnabled();
  }, 'Recovery did not open the restored primary session');
  // Graph mode can be retained from the preceding acceptance; choose Tree explicitly.
  await click(await browser.$('button[title="Tree (g)"]'));
  await click(await browser.$(`.tree-item[data-item-id="${configuration.itemId}"]`));
  await wait(async () => await browser.$('.history-header strong').getText() === `Item ${configuration.itemId}`, 'Recovery selected a different item');
}

export async function openRecoveryReply(afterSaved = false) {
  const another = await browser.$('.owner-input').$('button=Write another input');
  // A successive Reply has already saved on disk; its renderer receipt may still
  // be arriving. Await that acknowledgement before choosing the next form.
  if (afterSaved || await another.isExisting()) await click(another);
  await click(await browser.$('[aria-label="Owner actions"]').$('button=Reply'));
}

async function ownerReply(configuration, text, afterSaved = false) {
  await openRecoveryReply(afterSaved);
  await sendDetailReply(configuration, text);
}

async function holdSuccessor(configuration, expectedCount, successorId, message) {
  await delay(750);
  assert.equal((await admissions(configuration)).length, expectedCount, message);
  const successor = (await snapshot(configuration)).inputs[successorId];
  assert.equal(successor.state, 'queued', message); assert.equal(successor.attempts.length, 0, message);
}

// Call only after restoration/history/Graph assertions. New ordinary owner inputs
// extend the restored primary lane without changing the delivery golden snapshot.
export async function runRecoveryAcceptance(configuration) {
  const evidence = process.env.ARIADNE_E2E_EVIDENCE, nonce = process.env.ARIADNE_E2E_NONCE;
  const baseline = await snapshot(configuration), queuedBefore = await admissions(configuration);
  assert.ok(Object.values(baseline.inputs).every(input => input.state === 'handled'));
  assert.equal(baseline.bindings[configuration.bindingId].dispatch_state, 'enabled');
  const demoBefore = await readFile(configuration.demo.sessionPath);
  await openPrimary(configuration);
  const workText = `native-recovery-work-${nonce}\nPreserve this completed work; never dispatch its action again.`;
  const successorText = `native-recovery-successor-${nonce}\nDispatch only after the result repair joins.`;
  await ownerReply(configuration, workText);
  await wait(async () => (await admissions(configuration)).length === queuedBefore.length + 1, 'Recovery original input did not reach real runtime delivery');
  const original = (await admissions(configuration)).at(-1);
  await ownerReply(configuration, successorText, true);
  let session = await snapshot(configuration);
  const input = session.inputs[original.inputId], successor = Object.values(session.inputs).find(input => input.payload.text === successorText);
  assert.ok(successor); assert.equal(input.payload.text, workText); assert.equal(input.attempts.length, 1);
  assert.equal(successor.seq, input.seq + 1);
  await holdSuccessor(configuration, queuedBefore.length + 1, successor.id, 'Original running turn must hold its successor');
  const replyText = `native-retained-recovery-reply-${nonce}\nThe completed original work remains published in full.`;
  const replyPublication = await apply(configuration, originalReplyRequest(configuration, original, await snapshot(configuration), replyText));
  session = await snapshot(configuration);
  const reply = session.messages.find(message => message.input_id === input.id && message.attempt_id === original.attemptId && message.kind === 'reply' && message.body === replyText);
  assert.ok(reply); assert.equal(session.inputs[input.id].attempts[0].domain_result, null);
  await completeTurn(configuration, original);
  await wait(async () => (await snapshot(configuration)).inputs[input.id].attempts[0].turn_state === 'completed', 'Real provider history completion did not reach Core');
  const completed = await snapshot(configuration), completedAttempt = completed.inputs[input.id].attempts[0];
  assert.ok(['pending', 'missing'].includes(completedAttempt.result_state)); assert.equal(completedAttempt.domain_result, null);
  await holdSuccessor(configuration, queuedBefore.length + 1, successor.id, 'Completion without a result cannot admit a successor');
  await wait(async () => (await snapshot(configuration)).inputs[input.id].attempts[0].result_state === 'missing', 'Native five-second missing-result expiry did not run');
  const expired = await snapshot(configuration), originalAttempt = expired.inputs[input.id].attempts[0];
  assert.equal(expired.inputs[input.id].state, 'needs_attention'); assert.equal(originalAttempt.error.code, 'result_missing');
  assert.ok(Date.parse(originalAttempt.error.observed_at) - Date.parse(originalAttempt.turn_observed_at) >= 5000, 'Missing result must wait the natural grace period');
  assert.equal(expired.bindings[configuration.bindingId].dispatch_state, 'recovery_required');
  assert.equal(expired.bindings[configuration.bindingId].pause_reason, 'result_missing');
  const row = await browser.$(`[aria-label="Delivery recovery"] [data-input-id="${input.id}"][data-attempt-id="${original.attemptId}"]`);
  await wait(async () => await row.isExisting() && (await row.getText()).includes('Missing result'), 'Missing result was not visible in real recovery UI');
  // The session bar carries the qualified presence. Resume dispatch left the
  // tree in P8.3: WP5 puts it on the project page's session rows and must route
  // this lookup there; until then this journey has no Resume control to reach.
  await wait(async () => await sessionPresence().getAttribute('title') === 'Host idle · fresh host poll', 'Recovery requires genuine provider-qualified idle');
  const resume = await browser.$('button=Resume dispatch');
  assert.equal(await resume.isEnabled(), false, 'Missing result must block Resume');
  await browser.saveScreenshot(join(evidence, 'native-result-missing.png'));
  await click(await row.$('button=Review recovery'));
  const reviewed = await dialog().getText();
  assert.ok(reviewed.includes(input.id)); assert.ok(reviewed.includes(original.attemptId)); assert.ok(reviewed.includes(workText));
  // The embedded driver's option click neither changes the select value nor fires change, so set it natively.
  const choice = await dialog().$('select');
  await browser.execute(select => {
    const view = select.ownerDocument.defaultView;
    Object.getOwnPropertyDescriptor(view.HTMLSelectElement.prototype, 'value').set.call(select, 'request_result_repair');
    select.dispatchEvent(new view.Event('change', { bubbles: true }));
  }, choice);
  await wait(async () => (await dialog().getText()).includes('result-only model turn'), 'Recovery choice did not select the result-only repair');
  const reason = `Inspect retained reply ${reply.id}; request only its missing structured result.`;
  await dialog().$('input[required]').setValue(reason);
  await wait(async () => (await dialog().getText()).includes('Host idle · fresh host poll'), 'Recovery dialog did not show qualified idle presence');
  assert.equal(await dialog().$('input[type="checkbox"]').isExisting(), false, 'Qualified idle must not be replaced with owner attestation');
  await click(await dialog().$('button=Save recovery decision'));
  await wait(async () => (await snapshot(configuration)).inputs[input.id].resolution_history.some(entry => entry.kind === 'request_result_repair'), 'Visible repair choice did not persist its audit');
  await wait(async () => !(await dialog().isExisting()), 'Saved recovery dialog remained open');
  const prepared = await snapshot(configuration), preparedInput = prepared.inputs[input.id];
  const resolution = preparedInput.resolution_history.at(-1);
  assert.equal(resolution.attempt_id, original.attemptId); assert.equal(resolution.reason, reason); assert.equal(resolution.evidence, null);
  const receipt = Object.values(prepared.operation_receipts).flat().find(receipt => receipt.operation_id === resolution.op_id && receipt.actor_scope.kind === 'owner');
  assert.ok(receipt); assert.equal(receipt.result.data.kind, 'input_resolve'); assert.equal(receipt.result.data.resolution_kind, 'request_result_repair');
  assert.equal(preparedInput.state, 'queued'); assert.equal(preparedInput.active_attempt_id, null); assert.equal(preparedInput.attempts.length, 1);
  assert.ok(preparedInput.attempts[0].sealed_at); assert.equal(prepared.bindings[configuration.bindingId].owner_paused, true);
  assert.equal(prepared.bindings[configuration.bindingId].dispatch_state, 'paused'); assert.equal(prepared.bindings[configuration.bindingId].pause_reason, null);
  await holdSuccessor(configuration, queuedBefore.length + 1, successor.id, 'Repair preparation cannot dispatch before separate Resume');
  await click(resume);
  assert.equal((await snapshot(configuration)).bindings[configuration.bindingId].dispatch_state, 'paused', 'Opening Resume confirmation must not enable dispatch');
  await click(await dialog().$('button=Confirm resume'));
  await wait(async () => (await admissions(configuration)).length === queuedBefore.length + 2, 'Explicit Resume did not deliver the result-only repair');
  const repair = (await admissions(configuration)).at(-1);
  session = await snapshot(configuration);
  const repairBody = assertRepairAdmission(configuration, repair, session, original, reply);
  assert.deepEqual(session.inputs[input.id].attempts[0], preparedInput.attempts[0], 'Repair dispatch must retain original completion/evidence');
  assert.deepEqual(session.messages.find(message => message.id === reply.id), reply);
  await holdSuccessor(configuration, queuedBefore.length + 2, successor.id, 'Running result repair must hold its successor');
  const repairPublication = await apply(configuration, repairResultRequest(configuration, repair, await snapshot(configuration), original, reply));
  const resultOnly = await snapshot(configuration), repairAttempt = resultOnly.inputs[input.id].attempts.find(attempt => attempt.id === repair.attemptId);
  assert.deepEqual(repairAttempt.domain_result.reply_message_ids, [reply.id]); assert.equal(repairAttempt.result_state, 'committed');
  assert.notEqual(resultOnly.inputs[input.id].state, 'handled', 'Repair result alone cannot seal the running repair turn');
  assert.deepEqual(resultOnly.messages.filter(message => message.kind === 'reply' && message.input_id === input.id), [reply], 'Result-only repair must preserve one original reply without duplicating work');
  await holdSuccessor(configuration, queuedBefore.length + 2, successor.id, 'Repair result alone cannot release FIFO');
  await completeTurn(configuration, repair);
  await wait(async () => (await snapshot(configuration)).inputs[input.id].state === 'handled', 'Repair explicit result and provider completion did not join');
  await wait(async () => (await admissions(configuration)).length === queuedBefore.length + 3, 'Successor did not follow the repair join');
  const next = (await admissions(configuration)).at(-1);
  assert.equal(next.inputId, successor.id);
  const successorReply = `native-recovery-successor-reply-${nonce}\nFIFO continued only after completed result repair.`;
  const successorPublication = await publishResult(configuration, next, successorReply);
  await completeTurn(configuration, next);
  await wait(async () => (await snapshot(configuration)).inputs[successor.id].state === 'handled', 'Recovery successor did not finish its ordinary result/completion join');
  const finalSession = await snapshot(configuration), finalAdmissions = await admissions(configuration);
  assert.deepEqual(finalAdmissions.slice(0, queuedBefore.length), queuedBefore);
  assert.deepEqual(finalAdmissions.slice(queuedBefore.length).map(entry => entry.inputId), [input.id, input.id, successor.id]);
  assert.equal(finalSession.inputs[input.id].attempts.length, 2); assert.equal(finalSession.inputs[successor.id].attempts.length, 1);
  assert.deepEqual(finalSession.inputs[input.id].attempts[0], preparedInput.attempts[0]);
  assert.deepEqual(finalSession.messages.find(message => message.id === reply.id), reply);
  for (const [id, prior] of Object.entries(baseline.inputs)) assert.deepEqual(finalSession.inputs[id], prior, 'Recovery cannot rewrite the restored golden inputs');
  assert.deepEqual(await readFile(configuration.demo.sessionPath), demoBefore);
  await click(await browser.$('[aria-label="Item history view"]').$('button*=Timeline'));
  await wait(async () => {
    const text = await browser.$('[aria-label="Item detail"]').getText();
    return [workText, replyText, successorText, successorReply].every(body => text.includes(body));
  }, 'Native detail lost retained original work/reply or the FIFO successor');
  await browser.saveScreenshot(join(evidence, 'native-recovery-completed.png'));
  await json(join(evidence, 'recovery-acceptance.json'), { original, successor, reply, completed, expired, prepared, resolution, receipt,
    repair, repairBody, resultOnly, finalSession, finalAdmissions, replyPublication, repairPublication, successorPublication });
}
