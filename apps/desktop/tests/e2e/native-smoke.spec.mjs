import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { alive, delay, identity, listeners, json, proveQuit } from '../../../../scripts/run-native-e2e.mjs';
import { admissions, assertSlimEnvelope, completeTurn, publishResult, seedJourney, snapshot } from './scripted-provider.mjs';
import { openSessionButton } from './session-button.mjs';
import { runAccessibilityAcceptance } from './accessibility.spec.mjs';
import { runDiscoveryAcceptance } from './discovery.spec.mjs';
import { runHistoryActionsAcceptance } from './history-actions.spec.mjs';
import { runTreeAcceptance, restoreTreeAcceptance } from './tree.spec.mjs';
import { navigationRejection, runHistoryAcceptance, restoreHistoryAcceptance } from './history.spec.mjs';
import { runGraphAcceptance } from './graph.spec.mjs';
import { runRecoveryAcceptance } from './recovery.spec.mjs';
import { runRemoveAcceptance } from './remove.spec.mjs';
import { folded, openFollowUp, sendDetailReply } from './owner-reply.mjs';

const root = process.env.ARIADNE_E2E_ROOT;
const nonce = process.env.ARIADNE_E2E_NONCE;
const evidence = process.env.ARIADNE_E2E_EVIDENCE;
const phase = process.env.ARIADNE_E2E_PHASE;
const receiptPath = join(root, 'smoke/receipt.json');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const wait = (condition, message) => browser.waitUntil(condition, { timeout: 20000, interval: 100, timeoutMsg: message });
const invoke = (command, request) => browser.execute(async (command, request) => {
  try { return { ok: true, data: await window.__TAURI_INTERNALS__.invoke(command, { request }) }; }
  // WebDriver reserves top-level "error" in its script-result envelope.
  catch (error) { return { ok: false, rejection: error }; }
}, command, request);

let navigationRecovered = false;
const revisionConflict = 'This changed while you were working. Look at it as it is now, then try again.';
async function openSession(sessionId, itemId) {
  const before = await readJson(join(process.env.ARIADNE_HOME, 'ui.json')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  try {
    const catalogue = await browser.$('button[data-shell-tab="all_sessions"]');
    await catalogue.waitForDisplayed(); await catalogue.waitForEnabled();
    await catalogue.click();
    const selectedCatalogue = async () => {
      const selected = (await readJson(join(process.env.ARIADNE_HOME, 'ui.json'))).snapshot.global.selected_navigation;
      return selected.kind === 'all_sessions' && await catalogue.getAttribute('aria-current') === 'page' && await catalogue.isEnabled();
    };
    await wait(async () => await selectedCatalogue() || await navigationRejection(), 'All sessions navigation neither completed nor showed a definitive rejection');
    if (await navigationRejection()) {
      assert.equal(navigationRecovered, false, 'Only one explicit visible navigation recovery is allowed per native launch');
      navigationRecovered = true;
      const rejected = { sessionId, message: revisionConflict, preferences: await readJson(join(process.env.ARIADNE_HOME, 'ui.json')),
        body: await browser.$('body').getText() };
      const refresh = await browser.$('.nav-banner[role="alert"]').$('button=Refresh');
      await refresh.waitForDisplayed(); await refresh.waitForEnabled(); await refresh.click();
      // A deliberate new owner choice after a definite changed-view rejection.
      // Pending/uncertain completion offers Check again instead of Refresh.
      await catalogue.waitForEnabled(); await catalogue.click();
      await wait(selectedCatalogue, 'Explicit refreshed All sessions choice did not persist');
      await json(join(evidence, 'navigation-recovery.json'), { rejected, recovered: await readJson(join(process.env.ARIADNE_HOME, 'ui.json')) });
    }
    const session = await openSessionButton(sessionId);
    // Session cards can extend beyond the nested catalogue viewport.
    await session.scrollIntoView({ block: 'center', inline: 'center' }); await session.waitForClickable(); await session.click();
    await wait(async () => {
      const selected = (await readJson(join(process.env.ARIADNE_HOME, 'ui.json'))).snapshot.global.selected_navigation;
      return selected.kind === 'session' && selected.session.session_id === sessionId && await catalogue.isEnabled();
    }, 'Selected session navigation did not finish its saved preference update');
    const item = await browser.$(`.tree-item[data-item-id="${itemId}"]`);
    await item.waitForDisplayed(); await item.waitForEnabled(); await item.click();
    await wait(async () => await browser.$('.item-detail').getAttribute('data-detail-item-id') === itemId, 'Selected item detail did not load');
  } catch (error) {
    await json(join(evidence, `navigation-failure-${sessionId}.json`), { before,
      after: await readJson(join(process.env.ARIADNE_HOME, 'ui.json')),
      frame: await browser.execute(() => ({ origin: window.performance.timeOrigin, ready: document.readyState,
        body: document.body.textContent, tabs: Array.from(document.querySelectorAll('.shell-tabs button')).map(element => element.outerHTML) })) });
    await browser.saveScreenshot(join(evidence, `navigation-failure-${sessionId}.png`)); throw error;
  }
}
async function showHistory(texts) {
  // The single chat lays multi-line stored bodies out as paragraphs.
  const conversation = await browser.$('.item-detail [aria-label="Conversation"]');
  await conversation.waitForDisplayed(); await conversation.scrollIntoView();
  await wait(async () => {
    const detail = folded(await browser.$('[aria-label="Item detail"]').getText());
    return texts.every(text => detail.includes(folded(text)));
  }, 'Complete saved history was not visible in native item detail');
}
async function nativeCard(kind, question) {
  const region = kind === 'waiting' ? '[aria-label="Waiting questions"] .waiting-card'
    : '[aria-label="Sent · waiting for the agent to pick up"] .waiting-sent';
  for (const card of await browser.$$(`aside[aria-label="Waiting on me"] ${region}`)) {
    if ((await card.getText()).includes(question)) return card;
  }
  return undefined;
}
function orderedInputs(session) { return Object.values(session.inputs).sort((a, b) => a.seq - b.seq); }
function receipts(session, inputs) {
  return inputs.map(input => {
    const receipt = Object.values(session.operation_receipts).flat().find(receipt => receipt.result.data.kind === 'input_submit' && receipt.result.data.input_id === input.id);
    assert.ok(receipt, 'Every UI acknowledgement has its canonical saved receipt'); return receipt;
  });
}
async function unchangedDemo(configuration) {
  assert.deepEqual(await readJson(configuration.demo.sessionPath), configuration.demo.before, 'Scripted host/result activity must not alter the other project');
}

async function delivery(configuration) {
  const setup = await seedJourney(configuration);
  const questionRevision = (await snapshot(configuration)).items[configuration.itemId].question_revision;
  // Observe genuine seed-triggered native preference publication. The running
  // App discovers the CLI data through its ordinary events and catalogue polling.
  await wait(async () => {
    const preferences = (await readJson(join(process.env.ARIADNE_HOME, 'ui.json'))).snapshot;
    return (preferences.global.notification_ledger ?? []).some(episode => episode.session.session_id === configuration.sessionId
      && episode.session.project_id === configuration.projectId && episode.item_id === configuration.itemId && episode.question_revision === questionRevision);
  }, 'Seeded question did not reach the genuine native notification ledger');
  // The demo is published by the real CLI into a separate project, retaining
  // its canonical pending/recovery examples rather than rebinding its storage.
  await openSession(configuration.demo.session_id, '1');
  await showHistory(configuration.demo.before.messages.filter(message => message.item_id === '1').map(message => message.body));
  const child = await browser.$('.item-detail button.detail-fork');
  await child.waitForDisplayed(); assert.ok((await child.getText()).includes('Add the receipt lookup test')); await child.click();
  await wait(async () => await browser.$('.item-detail').getAttribute('data-detail-item-id') === '1.1'
    && (await browser.$('[aria-label="Item detail"]').getText()).includes('Add the receipt lookup test'), 'Canonical demo child navigation failed');
  await browser.saveScreenshot(join(evidence, 'canonical-demo.png'));

  await openSession(configuration.sessionId, configuration.itemId);
  let card;
  await wait(async () => {
    card = await nativeCard('waiting', configuration.question);
    if (!card) return false;
    const choice = await card.$('button*=Use the native window');
    return await choice.isExisting() && await choice.isEnabled() && await choice.getAttribute('aria-disabled') !== 'true';
  }, 'The real unanswered item.ask did not become editable in Waiting');
  const cardText = await card.getText();
  assert.ok(cardText.includes(configuration.ask)); assert.ok(cardText.includes(configuration.options[0].label));
  assert.ok(cardText.includes(configuration.options[0].consequence));
  // The compact Waiting card sends the chosen option alone; later inputs are detail replies.
  const ownerTexts = Array.from({ length: 5 }, (_, index) => index ? `native-owner-${nonce}-${index + 1}\nKeep this complete line for input ${index + 1}.` : '');
  const choice = await card.$('button*=Use the native window'); await choice.click();
  // The compact send button carries its Enter hint ("Send answer ↵"); selecting saves the draft first.
  const send = await card.$('button.answer-send');
  await send.waitForEnabled();
  await wait(async () => await send.isEnabled() && await send.getAttribute('aria-disabled') !== 'true', 'Waiting Send answer did not become editable');
  assert.ok((await send.getText()).includes('Send answer')); await send.click();
  await wait(async () => {
    const saved = orderedInputs(await snapshot(configuration)), queued = await admissions(configuration);
    return saved.length === 1 && queued.length === 1 && saved[0].attempts.length === 1
      && queued[0].payload === saved[0].attempts[0].formatted_payload;
  }, 'Waiting answer did not persist and reach the host with its exact saved payload');
  await wait(async () => !(await nativeCard('waiting', configuration.question)), 'Answered Waiting episode remained in Waiting');
  // The Sent row's delivery line quotes the chosen option once the saved input is read back.
  await wait(async () => (await (await nativeCard('sent', configuration.question))?.getText())?.includes(configuration.options[0].label) ?? false,
    'Waiting answer did not appear in Sent with its chosen option');
  await browser.saveScreenshot(join(evidence, 'native-waiting-answer.png'));

  // The held answer hides the detail's answer slot; each reply queues behind it from the follow-up box.
  for (const text of ownerTexts.slice(1)) {
    await openFollowUp(true);
    await sendDetailReply(configuration, text);
  }
  const held = await snapshot(configuration), inputs = orderedInputs(held), savedReceipts = receipts(held, inputs);
  assert.equal(inputs.length, 5); assert.equal(new Set(inputs.map(input => input.id)).size, 5);
  assert.deepEqual(inputs.map(input => input.seq), [1, 2, 3, 4, 5]);
  assert.equal(new Set(savedReceipts.map(receipt => receipt.operation_id)).size, 5);
  assert.deepEqual(inputs.map(input => input.payload.text), ownerTexts);
  assert.deepEqual(inputs.map(input => input.kind), ['answer', 'reply', 'reply', 'reply', 'reply']);
  assert.equal(inputs[0].attempts.length, 1); assert.ok(inputs.slice(1).every(input => input.state === 'queued' && input.attempts.length === 0));
  const answer = held.answers.find(answer => answer.id === inputs[0].answer_id);
  assert.ok(answer); assert.equal(answer.question_snapshot, configuration.question); assert.equal(answer.ask_snapshot, configuration.ask);
  assert.deepEqual(answer.options_snapshot, configuration.options); assert.equal(answer.selected_option_id, configuration.options[0].id);
  assert.equal(answer.text, ownerTexts[0]); assert.equal(answer.question_revision, held.items[configuration.itemId].question_revision);
  await delay(750); assert.equal((await admissions(configuration)).length, 1, 'Queued successors cannot overlap the held host turn');
  await json(join(evidence, 'held-inputs.json'), { held, savedReceipts, admissions: await admissions(configuration) });

  const results = [], replies = [], queued = [];
  for (let index = 0; index < inputs.length; index++) {
    await wait(async () => (await admissions(configuration)).length === index + 1, 'Next FIFO admission did not follow the prior result/completion join');
    const admission = (await admissions(configuration))[index], session = await snapshot(configuration), input = session.inputs[inputs[index].id];
    assert.equal(admission.inputId, input.id); assert.equal(admission.bindingId, configuration.bindingId); assert.equal(admission.generation, configuration.generation);
    assert.equal(input.attempts.length, 1); const attempt = input.attempts[0];
    assert.equal(admission.attemptId, attempt.id); assert.equal(admission.payload, attempt.formatted_payload); assert.equal(attempt.binding_generation, configuration.generation);
    assertSlimEnvelope(admission, input);
    const reply = `native-explicit-reply-${nonce}-${index + 1}\nComplete reply for saved input ${index + 1}.`;
    results.push(await publishResult(configuration, admission, reply)); replies.push(reply); queued.push(admission);
    await delay(750);
    const resultOnly = await snapshot(configuration);
    assert.ok(resultOnly.inputs[input.id].attempts[0].domain_result, 'The real CLI must save an explicit correlated result');
    assert.notEqual(resultOnly.inputs[input.id].state, 'handled', 'Result alone cannot finish a running host turn');
    assert.equal((await admissions(configuration)).length, index + 1, 'Result alone cannot admit the next FIFO input');
    await completeTurn(configuration, admission);
    try {
      await wait(async () => (await snapshot(configuration)).inputs[input.id].state === 'handled', 'Explicit result and matching host completion did not join');
    } catch (error) {
      await json(join(evidence, 'result-completion-failure.json'), { index, admission, result: results[index],
        session: await snapshot(configuration), admissions: await admissions(configuration), completed: await readJson(configuration.completePath),
        body: await browser.$('body').getText() });
      await browser.saveScreenshot(join(evidence, 'result-completion-failure.png')); throw error;
    }
  }
  const finalSession = await snapshot(configuration), finalInputs = orderedInputs(finalSession);
  await json(join(evidence, 'completed-inputs.json'), { finalSession, admissions: await admissions(configuration), completed: await readJson(configuration.completePath) });
  assert.ok(finalInputs.every(input => input.state === 'handled' && input.attempts.length === 1));
  assert.equal(new Set(queued.map(entry => entry.turnId)).size, 5);
  assert.deepEqual(receipts(finalSession, finalInputs), savedReceipts);
  assert.equal(finalSession.bindings[configuration.bindingId].generation, configuration.generation);
  for (let index = 0; index < finalInputs.length; index++) {
    const input = finalInputs[index], messages = finalSession.messages.filter(message => message.author === 'agent' && message.kind === 'reply'
      && message.input_id === input.id && message.attempt_id === input.attempts[0].id);
    assert.equal(input.attempts[0].host_turn_id, queued[index].turnId);
    assert.ok(input.attempts[0].domain_result);
    assert.equal(messages.length, 1); assert.equal(messages[0].body, replies[index]);
  }
  await showHistory([...ownerTexts, ...replies]); await unchangedDemo(configuration);
  await browser.saveScreenshot(join(evidence, 'native-five-inputs.png'));
  await json(join(evidence, 'domain-journey.json'), { setup, configuration, ownerTexts, replies, inputs: finalInputs, savedReceipts, queued, results, answer, finalSession });
}

async function restoration(configuration, witness) {
  const prior = await readJson(join(process.env.ARIADNE_E2E_PRIOR_EVIDENCE, 'domain-journey.json'));
  const launch = await readJson(join(evidence, 'launch.json'));
  assert.equal(launch.priorPid, (await readJson(join(process.env.ARIADNE_E2E_PRIOR_EVIDENCE, 'observed.json'))).pid);
  assert.notEqual(witness.pid, launch.priorPid); assert.equal(alive(launch.priorPid), false);
  assert.notEqual(nonce, (await readJson(join(process.env.ARIADNE_E2E_PRIOR_EVIDENCE, 'launch.json'))).nonce);
  // No CLI bootstrap/apply, seed, or owner admission occurs in this process.
  await openSession(configuration.sessionId, configuration.itemId);
  await showHistory([...prior.ownerTexts, ...prior.replies]);
  assert.deepEqual(await snapshot(configuration), prior.finalSession);
  assert.deepEqual(await admissions(configuration), prior.queued);
  await delay(750); assert.deepEqual(await admissions(configuration), prior.queued, 'Restart must not blindly resend completed inputs');
  await unchangedDemo(configuration);
  await browser.saveScreenshot(join(evidence, 'native-restored-history.png'));
  await json(join(evidence, 'restoration.json'), { sameCanonicalSession: true, sameReceiptsInputsAttemptsResults: true, noResend: true, witness, priorPid: launch.priorPid });
}

describe('native owner FIFO and real process restoration', () => {
  it('uses ordinary owner controls, explicit CLI results, graceful Quit and a fresh owned launch', async () => {
    const witness = await readJson(join(root, 'startup.json')), observed = await readJson(join(root, 'observed.json'));
    assert.equal(witness.nonce, nonce); assert.equal(identity(witness.pid).exe, process.env.ARIADNE_E2E_BINARY);
    assert.equal(identity(witness.pid).birth, observed.birth);
    assert.equal(observed.ancestry.at(-1).pid, (await readJson(join(root, 'launcher.json'))).pid);
    const sockets = listeners(Number(process.env.ARIADNE_E2E_PORT)); assert.ok(sockets.includes(`p${witness.pid}\n`));
    const addresses = sockets.split('\n').filter(line => line.startsWith('n'));
    assert.ok(addresses.length > 0 && addresses.every(line => /^n(127\.0\.0\.1|\[::1\]):/.test(line)), 'Driver must bind only loopback');
    const configuration = await readJson(join(root, 'journey.json'));
    if (phase === 'delivery') {
      await assert.rejects(stat(receiptPath), { code: 'ENOENT' });
      await delivery(configuration);
      await runDiscoveryAcceptance(configuration);
      await runTreeAcceptance(configuration);
      await runHistoryAcceptance(configuration);
      await runHistoryActionsAcceptance(configuration);
      await runAccessibilityAcceptance(configuration);
      await runRemoveAcceptance(configuration);
    }
    else { assert.equal(phase, 'restoration'); await restoration(configuration, witness); await restoreTreeAcceptance(configuration); await runGraphAcceptance(configuration); await restoreHistoryAcceptance(configuration); await runRecoveryAcceptance(configuration); }

    const payload = `native-domain-${nonce}`, ping = await invoke('native_ping', { nonce, payload }); assert.equal(ping.ok, true);
    const bytes = await readFile(receiptPath), disk = JSON.parse(bytes); assert.deepEqual(ping.data, disk);
    assert.equal(disk.nonce, nonce); assert.equal(disk.payload, payload); assert.equal(disk.pid, witness.pid); assert.match(disk.receipt_id, /^ping-\d+-\d+$/);
    const wrongNonce = nonce === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    const rejected = await invoke('native_ping', { nonce: wrongNonce, payload }); assert.equal(rejected.ok, false); assert.equal(rejected.rejection.code, 'nonce_mismatch');
    for (const request of [{ nonce: wrongNonce }, {}]) {
      assert.equal((await invoke('native_e2e_quit', request)).ok, false);
      await assert.rejects(stat(join(root, 'quit-request.json')), { code: 'ENOENT' }); assert.ok(alive(witness.pid));
    }
    assert.deepEqual(await readFile(receiptPath), bytes); assert.deepEqual(await readdir(join(root, 'smoke')), ['receipt.json']);
    await json(join(evidence, 'assertions.json'), { passed: true, phase, witness, observed, sockets, disk, wrongNonceRejected: true, missingQuitNonceRejected: true, receiptUnchangedAfterRejection: true });
    // Return from the WebView before it closes; observe the actual PID, bridge
    // port and physical locks from Node before WDIO can run its forced teardown.
    await browser.execute(nonce => { void window.__TAURI_INTERNALS__.invoke('native_e2e_quit', { request: { nonce } }); }, nonce);
    await wait(async () => { try { await stat(join(root, 'quit-request.json')); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }, 'Native Quit did not enter the normal shutdown path');
    const quit = await proveQuit(root, process.env.ARIADNE_E2E_BINARY, nonce, observed, process.env.ARIADNE_HOME, configuration.bindingId, Number(process.env.ARIADNE_E2E_PORT));
    await json(join(evidence, 'quit.json'), quit);
    // The embedded WebDriver server died with the independently verified app.
    // WDIO must not issue DELETE /session against that disposed server. This is
    // reached only after real exit/port/lease proof, never after mere acceptance.
    browser.sessionId = undefined;
  });
});
