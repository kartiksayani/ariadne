import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { delay, json } from '../../../../scripts/run-native-e2e.mjs';
import { admissions, cliRequest, completeTurn, journeyResultRequest, publishResult, snapshot } from './scripted-provider.mjs';
import { folded, openFollowUp, openOwnerReply, sendDetailReply } from './owner-reply.mjs';
import { openSessionButton } from './session-button.mjs';

const wait = (condition, message) => browser.waitUntil(condition, { timeout: 20000, interval: 100, timeoutMsg: message });
const dialog = () => browser.$('[role="dialog"]');
const sendingLabel = () => browser.$('.tree-session-bar .dispatch-chip .dispatch-label');
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
  assert.equal(body.original_domain_result, null);
  assert.equal(Object.hasOwn(body, 'saved_input'), false, 'Repair cannot include the original action payload');
  assert.equal(Object.hasOwn(body, 'text'), false, 'Repair cannot include the original owner text');
  const repeatsOriginalWork = value => typeof value === 'string' ? value.includes(input.payload.text)
    : value !== null && typeof value === 'object' && Object.values(value).some(repeatsOriginalWork);
  assert.equal(repeatsOriginalWork(body), false, 'Repair cannot repeat the original owner work');
  // The repair rules live in the skill; the envelope carries no instruction.
  assert.equal(Object.hasOwn(body, 'instruction'), false, 'Repair envelope carries no instruction');
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
  const result = await cliRequest(configuration.cli, ['apply', '--binding', configuration.bindingId, '--generation', configuration.generation, '--json-stdin', '--full'], request);
  assert.equal(result.code, 0); assert.equal(result.value.session_id, configuration.sessionId);
  return { request, receipt: result.value };
}

async function openPrimary(configuration) {
  await click(await browser.$('button[data-shell-tab="all_sessions"]'));
  await wait(async () => {
    const selected = JSON.parse(await readFile(join(process.env.ARIADNE_HOME, 'ui.json'), 'utf8')).snapshot.global.selected_navigation;
    return selected.kind === 'all_sessions' && await browser.$('button[data-shell-tab="all_sessions"]').isEnabled();
  }, 'Recovery All sessions navigation did not finish');
  await click(await openSessionButton(configuration.sessionId));
  await wait(async () => {
    const selected = JSON.parse(await readFile(join(process.env.ARIADNE_HOME, 'ui.json'), 'utf8')).snapshot.global.selected_navigation;
    return selected.kind === 'session' && selected.session.session_id === configuration.sessionId
      && await browser.$('button[data-shell-tab="all_sessions"]').isEnabled();
  }, 'Recovery did not open the restored primary session');
  // Graph mode can be retained from the preceding acceptance; choose Tree explicitly.
  await click(await browser.$('button[title="Tree (g)"]'));
  await click(await browser.$(`.tree-item[data-item-id="${configuration.itemId}"]`));
  await wait(async () => await browser.$('.item-detail').getAttribute('data-detail-item-id') === configuration.itemId, 'Recovery selected a different item');
}

/** Opens the "Sending to <agent>" dialog from the session card in All sessions (its sending button, title "Sending and connection"). */
async function openDispatch(configuration) {
  await click(await browser.$('button[data-shell-tab="all_sessions"]'));
  await click(await browser.$(`[data-session-card="${configuration.sessionId}"] button[title="Sending and connection"]`));
  await wait(async () => (await dialog().getText()).includes('Sending to'), 'Sending dialog did not open');
}

// The primary item is still waiting: with nothing pending its answer slot takes the reply; once an
// input is held, the slot hides and the next reply queues behind it from the follow-up box.
async function ownerReply(configuration, text, held = false) {
  if (held) await openFollowUp(true); else await openOwnerReply();
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
  // The stopped delivery is answered on its tree row; with that row visible there is no recovery banner.
  const recoveryRow = () => browser.$(`[role="tree"] .stuck-note[data-stuck="decision"][data-stuck-input="${input.id}"]`);
  const row = await recoveryRow();
  await wait(async () => await row.isExisting() && (await row.getText()).includes('finished without saving its answer'), 'Missing result was not visible on its tree row');
  assert.ok((await row.getText()).includes('Couldn’t deliver'), 'The tree row must say the message could not be delivered');
  assert.equal(await browser.$('[aria-label="Delivery recovery"]').isExisting(), false, 'A decision on a visible row must not also raise a banner');
  // The session bar says why nothing is sent, with no Resume while a decision is open.
  await wait(async () => (await sendingLabel().getText()) === 'Not sending: the agent finished without saving its answer', 'Session bar did not explain the missing result');
  assert.equal(await browser.$('.tree-session-bar .dispatch-chip').$('button[aria-label="Resume"]').isExisting(), false, 'Missing result must not offer Resume');
  await openDispatch(configuration);
  assert.equal(await dialog().$('button=Resume sending').isEnabled(), false, 'Missing result must block Resume');
  await browser.saveScreenshot(join(evidence, 'native-result-missing.png'));
  await click(await dialog().$('button=Done'));
  await wait(async () => !(await dialog().isExisting()), 'Dispatch dialog remained open');
  await openPrimary(configuration);
  // The row offers Retry / Mark as done in one click; the result-only repair sits behind More options.
  assert.ok(await (await recoveryRow()).$('button=Retry').isExisting(), 'The tree row must offer Retry');
  assert.ok(await (await recoveryRow()).$('button=Mark as done').isExisting(), 'The tree row must offer Mark as done');
  await click(await (await recoveryRow()).$('button=More options'));
  const reviewed = await dialog().getText();
  assert.ok(reviewed.includes(workText.split('\n')[0]), 'Recovery dialog must show the owner’s message');
  assert.equal(reviewed.includes(input.id) || reviewed.includes(original.attemptId), false, 'Recovery dialog shows no internal ids');
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
  // A saved decision is the owner's go-ahead: with no other input blocking this binding, sending
  // resumes by itself (no Resume click) and the result-only repair goes out next.
  assert.ok(['queued', 'in_flight'].includes(preparedInput.state)); assert.ok(preparedInput.attempts[0].sealed_at);
  assert.equal(Object.values(prepared.inputs).some(other => other.id !== input.id && other.binding_id === configuration.bindingId
    && ['in_flight', 'needs_attention'].includes(other.state)), false, 'No other input may block the binding for auto-resume');
  assert.equal(prepared.bindings[configuration.bindingId].owner_paused, false, 'Saving a recovery decision must not pause sending');
  assert.equal(prepared.bindings[configuration.bindingId].pause_reason, null);
  assert.notEqual(prepared.bindings[configuration.bindingId].dispatch_state, 'recovery_required');
  await wait(async () => (await admissions(configuration)).length === queuedBefore.length + 2, 'Sending did not resume by itself to deliver the result-only repair');
  await wait(async () => (await sendingLabel().getText()) === 'Sending', 'Session bar did not return to Sending after the decision');
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
  await (await browser.$('.item-detail [aria-label="Conversation"]')).waitForDisplayed();
  await wait(async () => {
    // The timeline lays a multi-line body out as one paragraph: compare with white space folded.
    const text = folded(await browser.$('[aria-label="Item detail"]').getText());
    return [workText, replyText, successorText, successorReply].every(body => text.includes(folded(body)));
  }, 'Native detail lost retained original work/reply or the FIFO successor');
  await browser.saveScreenshot(join(evidence, 'native-recovery-completed.png'));
  await json(join(evidence, 'recovery-acceptance.json'), { original, successor, reply, completed, expired, prepared, resolution, receipt,
    repair, repairBody, resultOnly, finalSession, finalAdmissions, replyPublication, repairPublication, successorPublication });
}
