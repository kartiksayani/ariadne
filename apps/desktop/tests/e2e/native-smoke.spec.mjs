import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { alive, delay, identity, listeners, json, proveQuit } from '../../../../scripts/run-native-e2e.mjs';
import { admissions, assertSlimEnvelope, completeTurn, publishResult, seedJourney, snapshot } from './scripted-provider.mjs';
import { openSessionButton } from './session-button.mjs';
import { runAccessibilityAcceptance } from './accessibility.spec.mjs';
import { runDiscoveryAcceptance } from './discovery.spec.mjs';
import { runHistoryActionsAcceptance } from './history-actions.spec.mjs';
import { goToPeekItem, runTreeAcceptance, restoreTreeAcceptance } from './tree.spec.mjs';
import { navigationUpdated, runHistoryAcceptance, restoreHistoryAcceptance } from './history.spec.mjs';
import { runGraphAcceptance } from './graph.spec.mjs';
import { runRecoveryAcceptance } from './recovery.spec.mjs';
import { runRemoveAcceptance } from './remove.spec.mjs';
import { folded, openFollowUp, ownerReplyTarget, sendDetailReply, waitForOwnerReplyTarget } from './owner-reply.mjs';
import { acceptanceBlocks } from './block-results.mjs';
import { selectedBlocks } from './native-specs.mjs';
import { historyFailureFacts } from './history-evidence.mjs';

const root = process.env.ARIADNE_E2E_ROOT;
const nonce = process.env.ARIADNE_E2E_NONCE;
const evidence = process.env.ARIADNE_E2E_EVIDENCE;
const phase = process.env.ARIADNE_E2E_PHASE;
const receiptPath = join(root, 'smoke/receipt.json');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const wait = (condition, message) => browser.waitUntil(condition, { timeout: 60000, interval: 100, timeoutMsg: message });
async function click(control) { await control.waitForDisplayed(); await control.waitForEnabled(); await control.click(); }
// What one surface shows for a saved reply's delivery: its stuck note (when it has words) or else the dock's delivery line.
// `facts` lists every stuck note and delivery line present, so a failure says what was actually there.
const replyDelivery = (root, inputId) => browser.execute((root, inputId) => {
  const scope = document.querySelector(root), shown = element => !!element && element.getClientRects().length > 0;
  const notes = [...(scope?.querySelectorAll('.stuck-note[data-stuck-input]') ?? [])].filter(shown).map(note => ({
    input: note.getAttribute('data-stuck-input'), stuck: note.getAttribute('data-stuck'),
    text: (note.querySelector('[role="status"]')?.textContent ?? '').trim() }));
  const delivery = [...(scope?.querySelectorAll('.detail-delivery[role="status"]') ?? [])].filter(shown).map(line => (line.textContent ?? '').trim());
  const own = notes.find(note => note.input === inputId && note.text !== '');
  const shownState = own ? { kind: 'stuck-note', stuck: own.stuck, text: own.text }
    : delivery.find(text => text !== '') ? { kind: 'delivery', stuck: null, text: delivery.find(text => text !== '') } : null;
  return { state: shownState, facts: `stuck notes ${JSON.stringify(notes)}; delivery lines ${JSON.stringify(delivery)}` };
}, root, inputId);
const invoke = (command, request) => browser.execute(async (command, request) => {
  try { return { ok: true, data: await window.__TAURI_INTERNALS__.invoke(command, { request }) }; }
  // WebDriver reserves top-level "error" in its script-result envelope.
  catch (error) { return { ok: false, rejection: error }; }
}, command, request);

async function resetAcceptanceUI() {
  // Scope Escape to a modal: workspace Escape can clear durable filters.
  const modal = '[role="dialog"], [role="alertdialog"]';
  for (let attempt = 0; attempt < 3 && await browser.$(modal).isExisting(); attempt++) {
    await browser.execute(selector => document.querySelector(selector).focus(), modal);
    await browser.keys('Escape');
    await wait(async () => !(await browser.$(modal).isExisting()), 'Acceptance recovery could not cancel the dialog');
  }
  // Click the existing menu's own trigger; never dismiss removal notices,
  // whose Dismiss buttons can commit deferred domain operations.
  const menu = '[role="menu"]';
  if (await browser.$(menu).isExisting()) {
    const id = await browser.$(menu).getAttribute('id');
    const trigger = await browser.$(`[aria-haspopup="menu"][aria-expanded="true"][aria-controls="${id}"]`);
    await trigger.waitForEnabled(); await trigger.click();
    await wait(async () => !(await browser.$(menu).isExisting()), 'Acceptance recovery could not close the menu');
  }
  // Each independent block already navigates to its own session. Preserve
  // saved selection, search and scroll for the restoration assertions.
}
async function captureBlockFailure(name, error, started) {
  // Helpers may already have recorded the failing DOM. Only accept evidence
  // updated during this block, not an earlier block's retained failure file.
  for (const file of await readdir(evidence)) {
    if (!file.includes('failure') || !file.endsWith('.json') || (await stat(join(evidence, file))).mtimeMs < started) continue;
    const facts = await readJson(join(evidence, file)).catch(() => null);
    if (facts && (facts.dom || facts.observed || facts.frame || facts.body)) return;
  }
  try {
    await json(join(evidence, `block-failure-${name}.json`), { error: String(error?.message ?? error), stack: error?.stack ?? null,
      dom: await browser.execute(historyFailureFacts), body: await browser.$('body').getText() });
  } finally { await browser.saveScreenshot(join(evidence, `block-failure-${name}.png`)); }
}

let navigationRecovered = false;
const updatedNavigation = 'Updated to the latest. Try again if needed.';
// Opens the session from the switcher's All sessions page; with `itemId` it also selects that item (opening Details).
// Pages are not saved as the selected navigation, so the session itself is the saved proof that navigation finished.
async function openSession(sessionId, itemId = null) {
  const before = await readJson(join(process.env.ARIADNE_HOME, 'ui.json')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  try {
    const selectedSession = async () => {
      const selected = (await readJson(join(process.env.ARIADNE_HOME, 'ui.json'))).snapshot.global.selected_navigation;
      return selected.kind === 'session' && selected.session.session_id === sessionId;
    };
    const choose = async () => {
      const session = await openSessionButton(sessionId);
      // Session rows can extend beyond the page's viewport.
      await session.scrollIntoView({ block: 'center', inline: 'center' }); await session.waitForClickable(); await session.click();
      await wait(async () => await selectedSession() || await navigationUpdated(), 'Session navigation did not finish or refresh its changed view');
    };
    await choose();
    if (!await selectedSession()) {
      assert.equal(navigationRecovered, false, 'Only one fresh navigation choice is allowed per native launch');
      navigationRecovered = true;
      const refreshed = { sessionId, message: updatedNavigation, preferences: await readJson(join(process.env.ARIADNE_HOME, 'ui.json')),
        body: await browser.$('body').getText() };
      // The changed view refreshes itself; the next click is a deliberate new owner choice.
      await choose();
      await wait(selectedSession, 'Fresh session choice did not persist after automatic refresh');
      await json(join(evidence, 'navigation-recovery.json'), { refreshed, recovered: await readJson(join(process.env.ARIADNE_HOME, 'ui.json')) });
    }
    await wait(async () => await browser.$('.tree-column').getAttribute('data-session-status') === 'ready'
      && await browser.$('.tree-column').getAttribute('data-session-busy') === 'false', 'Selected session navigation did not finish loading its Map');
    if (itemId !== null) {
      const item = await browser.$(`.tree-item[data-item-id="${itemId}"]`);
      await item.waitForDisplayed(); await item.waitForEnabled(); await item.click();
      await wait(async () => await browser.$('.item-detail').getAttribute('data-detail-item-id') === itemId, 'Selected item detail did not load');
    }
  } catch (error) {
    await json(join(evidence, `navigation-failure-${sessionId}.json`), { before,
      after: await readJson(join(process.env.ARIADNE_HOME, 'ui.json')),
      frame: await browser.execute(() => ({ origin: window.performance.timeOrigin, ready: document.readyState,
        body: document.body.textContent, top: document.querySelector('.shell-top')?.outerHTML ?? null })) });
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
const dockSelector = 'section[aria-label="Answer dock"]';
// The dock holds the session's unsent waiting questions; its "N waiting" pill opens it at the first one. The open dock is the
// question's card: its title, ask and note, the option cards and Send. Undefined while the dock does not show that question.
async function dockQuestion(question) {
  const dock = await browser.$(dockSelector);
  if (await dock.getAttribute('data-open') === null) {
    const pill = await dock.$('button.dock-pill');
    if (!await pill.isExisting()) return undefined;
    await pill.waitForEnabled(); await pill.click();
    await wait(async () => await dock.getAttribute('data-open') !== null, 'The dock did not open at the waiting question');
  }
  const card = await dock.$('.answer-dock-current');
  if (!await card.isExisting()) return undefined;
  return (await card.$('.dock-question-title').getText()).includes(question) ? card : undefined;
}
// What the dock's Sent chip lists for one question: the words as they went out and the delivery line. Opens the list.
async function dockSent(question) {
  const chip = await browser.$(`${dockSelector} button.dock-sent`);
  if (!await chip.isExisting()) return undefined;
  if (await chip.getAttribute('aria-expanded') !== 'true') await chip.click();
  for (const row of await browser.$$(`${dockSelector} [aria-label="Sent answers"] .dock-sent-row`)) {
    if ((await row.getText()).includes(question)) return row;
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
  await child.waitForDisplayed();
  assert.equal(await child.getAttribute('title'), 'Add the receipt lookup test', 'The child chip names its canonical child');
  await child.click();
  await goToPeekItem(configuration.demo.before.items['1.1'], '1');
  await wait(async () => await browser.$('.item-detail').getAttribute('data-detail-item-id') === '1.1'
    && (await browser.$('[aria-label="Item detail"]').getText()).includes('Add the receipt lookup test'), 'Canonical demo child navigation failed');
  await browser.saveScreenshot(join(evidence, 'canonical-demo.png'));

  // The session opens without selecting its item: a question Details is answering leaves the dock, and the dock is where the
  // owner meets it first.
  await openSession(configuration.sessionId);
  let card;
  await wait(async () => {
    card = await dockQuestion(configuration.question);
    if (!card) return false;
    const choice = await card.$('[data-answer-option="0"]');
    return await choice.isExisting() && await choice.isEnabled() && await choice.getAttribute('aria-disabled') !== 'true';
  }, 'The real unanswered item.ask did not become editable in the answer dock');
  const cardText = await card.getText();
  assert.ok(cardText.includes(configuration.ask)); assert.ok(cardText.includes(configuration.options[0].label));
  assert.ok(cardText.includes(configuration.options[0].consequence));
  // The dock sends the chosen option alone; later inputs are detail replies.
  const ownerTexts = Array.from({ length: 5 }, (_, index) => index ? `native-owner-${nonce}-${index + 1}\nKeep this complete line for input ${index + 1}.` : '');
  const choice = await card.$('[data-answer-option="0"]'); assert.ok((await choice.getText()).includes(configuration.options[0].label)); await choice.click();
  // Picking the option saves the draft; Send then carries its Enter hint ("Send ↵").
  const send = await card.$('button[data-answer-send]');
  await send.waitForEnabled();
  await wait(async () => await send.isEnabled() && await send.getAttribute('aria-disabled') !== 'true', 'The dock Send did not become editable');
  assert.ok((await send.getText()).includes('Send')); await send.click();
  await wait(async () => {
    const saved = orderedInputs(await snapshot(configuration)), queued = await admissions(configuration);
    return saved.length === 1 && queued.length === 1 && saved[0].attempts.length === 1
      && queued[0].payload === saved[0].attempts[0].formatted_payload;
  }, 'Dock answer did not persist and reach the host with its exact saved payload');
  // After its Sent hold the dock moves on: nothing unsent waits, so it folds to its line.
  await wait(async () => !(await browser.$(`${dockSelector} button.dock-pill`).isExisting()) && await browser.$(dockSelector).getAttribute('data-open') === null,
    'Answered question remained in the dock');
  // The Sent list quotes the chosen option once the saved input is read back.
  await wait(async () => (await (await dockSent(configuration.question))?.getText())?.includes(configuration.options[0].label) ?? false,
    'Dock answer did not appear in Sent with its chosen option');
  await browser.saveScreenshot(join(evidence, 'native-waiting-answer.png'));
  // Close the Sent list again (its chip toggles it) before the Map is used.
  await click(await browser.$(`${dockSelector} button.dock-sent`));

  // The first follow-up uses the bigger conversation view; the others use the detail's same composer.
  // The held answer hides the answer slot, so all four replies queue behind it.
  const item = await browser.$(`.tree-item[data-item-id="${configuration.itemId}"]`);
  await item.waitForDisplayed(); await item.waitForEnabled(); await item.click();
  await wait(async () => await browser.$('.item-detail').getAttribute('data-detail-item-id') === configuration.itemId, 'Selected item detail did not load');
  let replyTarget = ownerReplyTarget(await snapshot(configuration), configuration.itemId);
  for (const [index, text] of ownerTexts.slice(1).entries()) {
    if (index === 0) {
      const expand = await browser.$('.item-detail button[aria-label="Open the conversation in a bigger view"]');
      await expand.waitForDisplayed(); await expand.waitForEnabled(); await expand.click();
      await browser.$('section[aria-label="Item conversation"]').waitForDisplayed();
    }
    // No agent result is published until this loop finishes. Pin the saved preceding input's
    // revision and the seeded agent ask before opening a draft, then check them again before typing.
    await waitForOwnerReplyTarget(configuration, replyTarget);
    await openFollowUp(true);
    await sendDetailReply(configuration, text, replyTarget);
    replyTarget = ownerReplyTarget(await snapshot(configuration), configuration.itemId);
    if (index === 0) {
      const saved = Object.values((await snapshot(configuration)).inputs).find(input => input.payload.text === text);
      assert.ok(saved, 'The bigger conversation view saved its reply');
      assert.equal(saved.state, 'queued', 'The conversation reply queues behind the held answer');
      const pending = await browser.$(`section[aria-label="Item conversation"] [data-pending="${saved.id}"]`);
      await pending.waitForExist(); await pending.scrollIntoView({ block: 'center' });
      await wait(async () => await pending.isDisplayed() && folded(await pending.getText()).includes(folded(text))
        && (await pending.getText()).includes('Not sent yet'), 'The conversation reply and its queued delivery were not visible');
      // Behind the held answer the reply shows a stuck note instead of the dock line, and the wording depends on the stage.
      // So capture whichever the view shows for the reply and require the detail pane to show the same kind with the same text.
      const viewRoot = 'section[aria-label="Item conversation"]', paneRoot = '.item-detail:not(.item-conversation)';
      let viewShown = await replyDelivery(viewRoot, saved.id);
      try { await wait(async () => (viewShown = await replyDelivery(viewRoot, saved.id)).state !== null, 'unused'); }
      catch { assert.fail(`The bigger conversation view did not show a delivery state for the saved reply; it had ${viewShown.facts}`); }
      const expected = viewShown.state;
      await browser.saveScreenshot(join(evidence, 'native-item-conversation.png'));
      const back = await browser.$('section[aria-label="Item conversation"]').$('button=Back to Map');
      await back.waitForDisplayed(); await back.waitForEnabled(); await back.click();
      await wait(async () => !(await browser.$('section[aria-label="Item conversation"]').isExisting()), 'Back to Map did not close the bigger conversation view');
      assert.equal(await browser.$('.item-detail').getAttribute('data-detail-item-id'), configuration.itemId,
        'Back to Map keeps the conversation item selected');
      let paneShown = await replyDelivery(paneRoot, saved.id);
      const same = ({ state }) => state?.kind === expected.kind && state.stuck === expected.stuck && state.text === expected.text;
      // The message is built after the wait, so it carries what the pane last showed.
      try { await wait(async () => same(paneShown = await replyDelivery(paneRoot, saved.id)), 'unused'); }
      catch { assert.fail(`The detail pane did not show the conversation view's ${JSON.stringify(expected)} for the saved reply; it had ${paneShown.facts}`); }
      await showHistory([text]);
    }
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
    const priorResults = phase === 'restoration' ? await readJson(join(process.env.ARIADNE_E2E_PRIOR_EVIDENCE, 'block-results.json')) : [];
    const blocks = acceptanceBlocks({ evidence, reset: resetAcceptanceUI, capture: captureBlockFailure, priorResults,
      only: selectedBlocks(process.env.ARIADNE_E2E_BLOCKS) });
    if (phase === 'delivery') {
      await assert.rejects(stat(receiptPath), { code: 'ENOENT' });
      await delivery(configuration);
      await blocks.run('runDiscoveryAcceptance', () => runDiscoveryAcceptance(configuration));
      await blocks.run('runTreeAcceptance', () => runTreeAcceptance(configuration));
      await blocks.run('runHistoryAcceptance', () => runHistoryAcceptance(configuration), ['runTreeAcceptance']);
      await blocks.run('runHistoryActionsAcceptance', () => runHistoryActionsAcceptance(configuration), ['runDiscoveryAcceptance']);
      await blocks.run('runAccessibilityAcceptance', () => runAccessibilityAcceptance(configuration));
      await blocks.run('runRemoveAcceptance', () => runRemoveAcceptance(configuration), ['runHistoryActionsAcceptance']);
    }
    else {
      assert.equal(phase, 'restoration'); await restoration(configuration, witness);
      await blocks.run('restoreTreeAcceptance', () => restoreTreeAcceptance(configuration), ['runTreeAcceptance']);
      await blocks.run('runGraphAcceptance', () => runGraphAcceptance(configuration), ['restoreTreeAcceptance']);
      await blocks.run('restoreHistoryAcceptance', () => restoreHistoryAcceptance(configuration), ['runHistoryAcceptance']);
      await blocks.run('runRecoveryAcceptance', () => runRecoveryAcceptance(configuration));
    }

    await blocks.finish(async () => {
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
});
