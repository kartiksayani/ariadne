import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { historyFailureFacts, withFailureEvidence } from './history-evidence.mjs';
import { admissions, awaitConnected, cliRequest, completeTurn, journeyResultRequest, snapshot } from './scripted-provider.mjs';

const wait = (condition, message) => browser.waitUntil(condition, { timeout: 20000, interval: 100, timeoutMsg: message });
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const evidence = () => process.env.ARIADNE_E2E_EVIDENCE;
const request = operations => ({ op_id: randomUUID(), source_input_id: null, attempt_id: null,
  expected_item_revisions: {}, expected_topic_revisions: {}, summary: '', operations, input_result: null });
const detail = () => browser.$('.item-history');
const failureEvidence = (label, action, expected = null) => withFailureEvidence(action, async error => {
  const dom = await browser.execute(historyFailureFacts);
  let canonical;
  try {
    const preferences = (await readJson(join(process.env.ARIADNE_HOME, 'ui.json'))).snapshot;
    canonical = { revision: preferences.revision, selectedNavigation: preferences.global.selected_navigation,
      sessions: preferences.sessions.map(value => ({ session: value.session, selectedItemId: value.selected_item_id })) };
  } catch (reading) { canonical = { unreadable: String(reading) }; }
  await writeFile(join(evidence(), `history-failure-${label}.json`), JSON.stringify({ failedWait: label, error: String(error?.message ?? error), expected, dom, canonical }, null, 2));
});
export async function waitForHistoryItem(item, label = 'history-item') {
  await failureEvidence(label, () => wait(() => browser.execute(expected => {
    const header = document.querySelector('.item-history > .history-header > strong');
    const question = document.querySelector('.item-history > h2');
    const source = [...document.querySelectorAll('.item-history > .history-meta')]
      .some(value => value.textContent === `Source round · ${expected.source_round_id}`);
    return header?.textContent === `Item ${expected.id}` && question?.textContent === expected.question
      && (expected.source_round_id === null || source);
  }, { id: item.id, question: item.question, source_round_id: item.source_round_id }),
  'Native detail did not reveal the registered item, complete question and correlated source round'),
  { id: item.id, question: item.question, source_round_id: item.source_round_id });
}
const inputs = session => Object.values(session.inputs).sort((a, b) => a.seq - b.seq);
const row = id => browser.$(`.tree-rows [data-item-id="${id}"]`);
let navigationRecovered = false;
const revisionConflict = 'Preferences revision changed; reload before applying this new patch';
const preferencesSnapshot = async () => (await readJson(join(process.env.ARIADNE_HOME, 'ui.json'))).snapshot;
async function navigationRejection() {
  const message = await browser.$('.nav-banner[role="alert"] p');
  return await message.isExisting() && await message.getText() === revisionConflict;
}
const option = ordinal => ({ id: `history-choice-${ordinal}`, label: `Use round ${ordinal} choice`,
  consequence: `Keep the exact consequence for round ${ordinal}.`, recommended: true });
export function historyAsk(bindingId, ordinal, item = { id: '1' }) {
  return { op: 'item.ask', item, ask: `History round ${ordinal}: choose and explain.\nFull ask line ${ordinal}.`,
    options: ordinal % 2 ? [option(ordinal)] : [], recipient_binding_id: bindingId };
}
function item(reference, topic, parent, question, sourceRoundId = null) {
  return { op: 'item.add', ref: reference, topic, parent, question, type: 'task', status: 'open', owner: { kind: 'me' },
    ask: null, options: null, note: null, links: null, outcome: null, why: null, replaced_by: null, source_round_id: sourceRoundId };
}
export function historySeedRequest(bindingId) {
  return request([{ op: 'topic.add', ref: 'history_topic', name: 'Native complete history' },
    item('history_item', { ref: 'history_topic' }, null, 'Retain five complete native rounds and their forks.\nThis question remains unchanged.'),
    historyAsk(bindingId, 1, { ref: 'history_item' })]);
}
export function historyMessageBatch(roundId, first, count) {
  return Array.from({ length: count }, (_, offset) => {
    const number = first + offset;
    return { op: 'reply', ref: `history_message_${number}`, item: { id: '1' }, round_id: roundId,
      text: `Complete native history body ${number}\n${'Keep every original word and its line. '.repeat(55)}\nExact final history marker ${number}.` };
  });
}
async function apply(history, operations, revisions = {}, frozen = null) {
  const value = frozen ?? { ...request(operations), expected_item_revisions: revisions };
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 512 * 1024);
  const result = await cliRequest(history.cli, ['apply', '--binding', history.bindingId, '--generation', history.generation, '--json-stdin'], value);
  assert.equal(result.code, 0); assert.equal(result.value.session_id, history.sessionId);
  return { request: value, receipt: result.value };
}
async function open(history, itemId = '1') {
  const catalogue = await browser.$('button[data-shell-tab="all_sessions"]'); await catalogue.waitForEnabled(); await catalogue.scrollIntoView(); await catalogue.click();
  const selectedCatalogue = async () => (await preferencesSnapshot()).global.selected_navigation.kind === 'all_sessions'
    && await catalogue.getAttribute('aria-current') === 'page' && await catalogue.isEnabled();
  let rejectedNavigation = false;
  await wait(async () => {
    rejectedNavigation ||= await navigationRejection();
    return rejectedNavigation || await selectedCatalogue();
  }, 'History catalogue navigation neither completed nor showed a definitive revision conflict');
  if (rejectedNavigation) {
    assert.equal(navigationRecovered, false, 'Only one explicit history navigation recovery is allowed per native launch');
    navigationRecovered = true;
    const rejected = { sessionId: history.sessionId, message: revisionConflict,
      preferences: await preferencesSnapshot(), body: await browser.$('body').getText() };
    const refresh = await browser.$('.nav-banner[role="alert"]').$('button=Refresh');
    await refresh.waitForDisplayed(); await refresh.waitForEnabled(); await refresh.scrollIntoView(); await refresh.click();
    // The actual Refresh control returns after its awaited read completes;
    // the definitive mutation error remains visible until a fresh choice.
    await wait(async () => {
      const refreshed = await browser.$('.nav-banner[role="alert"]').$('button=Refresh');
      return await refreshed.isExisting() && await refreshed.isDisplayed() && await refreshed.isEnabled() && await catalogue.isEnabled();
    }, 'Explicit history Refresh did not finish before the fresh navigation choice');
    assert.equal(await navigationRejection(), true, 'History Refresh must retain the exact definitive revision conflict before a fresh navigation choice');
    // A visible definitive rejection permits one fresh owner navigation choice.
    await catalogue.waitForEnabled(); await catalogue.scrollIntoView(); await catalogue.click();
    await wait(selectedCatalogue, 'Fresh history catalogue navigation did not persist after Refresh');
    await writeFile(join(evidence(), 'history-navigation-recovery.json'), JSON.stringify({ rejected, recovered: await preferencesSnapshot() }, null, 2));
  }
  const session = await browser.$(`[data-session-id="${history.sessionId}"]`); await session.waitForDisplayed(); await session.waitForEnabled(); await session.scrollIntoView(); await session.click();
  await wait(async () => {
    const selected = (await preferencesSnapshot()).global.selected_navigation;
    return selected.kind === 'session' && selected.session.session_id === history.sessionId && await catalogue.isEnabled();
  }, 'History session navigation did not finish its saved preference update');
  const target = await row(itemId); await target.waitForDisplayed(); await target.scrollIntoView(); await target.click();
  await waitForHistoryItem((await snapshot(history)).items[itemId]);
}
async function selectParent(item) {
  await (await browser.$('[data-shell-search]')).waitForEnabled();
  const parent = await row('1'); await parent.waitForDisplayed(); await parent.scrollIntoView(); await parent.click();
  await waitForHistoryItem(item);
  await (await browser.$('[data-shell-search]')).waitForEnabled();
}
async function seed(configuration) {
  const selected = configuration.history;
  const registered = await cliRequest(configuration.cli, ['project', 'register', '--json-stdin'], {
    session: null, command: { command: 'project_register', api_version: 1, op_id: randomUUID(), params: { canonical_root: selected.projectRoot } },
  });
  assert.equal(registered.code, 0);
  const projectId = registered.value.data.project_id;
  const connected = await cliRequest(configuration.cli, ['binding', 'connect', '--json-stdin'], {
    session: null, command: { command: 'binding_connect', api_version: 1, op_id: randomUUID(), params: {
      project_id: projectId, adapter_id: 'codex', external_session_id: selected.externalSessionId,
      endpoint: { kind: 'unix_socket', path: selected.socketPath }, configuration: { namespace: 'codex', values: {} }, existing_session_id: null,
    } },
  });
  assert.equal(connected.code, 0);
  const receipt = connected.value.data;
  const history = { ...selected, cli: configuration.cli, thread: selected.externalSessionId,
    projectId, sessionId: receipt.session_id, bindingId: receipt.data.binding_id, generation: receipt.data.generation,
    itemId: '1', sessionPath: join(process.env.ARIADNE_HOME, 'projects', projectId, 'sessions', `${receipt.session_id}.json`) };
  await awaitConnected(history);
  const publication = [await apply(history, [], {}, historySeedRequest(history.bindingId))];
  return { history, publication };
}
// A draft marked changed by a newer saved target stays locked until the owner reviews it explicitly.
async function reviewCurrentTarget() {
  const review = await browser.$('.owner-input').$('button=Review current target');
  if (!await review.isExisting()) return false;
  await review.waitForEnabled(); await review.scrollIntoView(); await review.click();
  return true;
}
async function answer(history, ordinal, text) {
  const another = await browser.$('.owner-input').$('button=Write another input');
  if (await another.isExisting()) { await another.waitForEnabled(); await another.scrollIntoView(); await another.click(); }
  const editor = await browser.$('[aria-label="Owner input for #1"] textarea'); await editor.waitForEnabled();
  await reviewCurrentTarget();
  if (ordinal % 2) { const choice = await browser.$('.owner-input').$(`button*=${option(ordinal).label}`); await choice.waitForEnabled(); await choice.scrollIntoView(); await choice.click(); }
  await editor.scrollIntoView(); await editor.setValue(text);
  const send = await browser.$('.owner-input .ref-send-row button'); await failureEvidence(`owner-input-send-${ordinal}`, () => send.waitForEnabled()); await send.scrollIntoView(); await send.click();
  await wait(async () => inputs(await snapshot(history)).length === ordinal && (await admissions(history)).length === ordinal,
    'A genuine native round answer did not persist and reach its isolated host');
}
async function result(history, ordinal, body, extra = []) {
  const queued = await admissions(history), admission = queued[ordinal - 1];
  const saved = await snapshot(history), input = inputs(saved)[ordinal - 1];
  assert.equal(admission.inputId, input.id); assert.equal(admission.bindingId, history.bindingId); assert.equal(admission.generation, history.generation);
  assert.equal(input.attempts.length, 1); assert.equal(admission.attemptId, input.attempts[0].id);
  assert.equal(admission.payload, input.attempts[0].formatted_payload);
  assert.deepEqual(JSON.parse(admission.payload.slice(admission.payload.indexOf('\n') + 1)).saved_input, input.payload);
  const value = journeyResultRequest(history, admission, saved, body);
  value.operations[0].round_id = input.payload.context.round_id;
  value.input_result.explanation = `Explicit native result ${ordinal}\nComplete stored explanation for ${input.kind} #${input.seq}.`;
  value.operations.push(...extra);
  value.input_result.followup_item_refs = extra.filter(operation => operation.op === 'item.add').map(operation => ({ ref: operation.ref }));
  const published = await apply(history, [], {}, value);
  assert.notEqual((await snapshot(history)).inputs[input.id].state, 'handled', 'Result cannot manufacture host completion');
  await completeTurn(history, admission);
  await wait(async () => (await snapshot(history)).inputs[input.id].state === 'handled', 'Correlated history result and separately controlled host completion did not join');
  return published;
}
async function renderedBodies(selector) {
  return browser.execute(selector => [...document.querySelectorAll(selector)].map(card => ({
    id: card.dataset.messageId, body: card.querySelector('.history-body')?.textContent,
  })), selector);
}
export async function waitForRoundResult(round, reply, explanation) {
  await wait(async () => {
    const text = await browser.$(`[aria-label="Round ${round.ordinal}"]`).getText();
    return text.includes(`Closed · ${round.closed_at}`) && text.includes(reply) && text.includes(explanation);
  }, 'Native detail did not publish the final closed round and its complete correlated result');
}
async function proveRounds(history, saved, ownerTexts, resultTexts, paged) {
  const back = await browser.$('[aria-label="Item history view"]').$('button=Back and forth'); await failureEvidence('history-back-and-forth', () => back.waitForEnabled()); await back.scrollIntoView(); await back.click();
  // Restoration runs against the final session, whose open sixth round (no result) is also rendered.
  const every = Object.keys(saved.rounds).length;
  await failureEvidence('history-rounds', () => wait(async () => (await browser.$$('.history-round')).length === every, `Native detail did not load all ${every} real rounds`));
  const rounds = Object.values(saved.rounds).filter(round => round.closed_at).sort((a, b) => a.ordinal - b.ordinal);
  assert.equal(rounds.length, 5); assert.equal(Object.keys(saved.items).length, 3);
  // Five sections already exist after the fifth answer. The Core completion
  // barrier does not imply that the selected native history has refreshed yet.
  const finalRound = rounds.at(-1);
  await failureEvidence('history-final-round-result', () => waitForRoundResult(finalRound, resultTexts.at(-1), saved.inputs[finalRound.result_input_ids[0]].attempts[0].domain_result.explanation));
  for (let index = 0; index < 5; index++) {
    const section = await browser.$(`[aria-label="Round ${index + 1}"]`);
    const text = await section.getText(), round = rounds[index];
    for (const full of [round.question_snapshot, round.ask_snapshot, ownerTexts[index], resultTexts[index]]) assert.ok(text.includes(full), `Round ${index + 1} lost full stored text`);
    for (const choice of round.options_snapshot) { assert.ok(text.includes(choice.label)); assert.ok(text.includes(choice.consequence)); }
    if (index % 2 === 0) assert.ok(text.includes(`Chosen: ${option(index + 1).label}`));
    assert.ok(round.closed_at); assert.equal(round.result_input_ids.length, 1);
    const result = saved.inputs[round.result_input_ids[0]].attempts[0].domain_result; assert.ok(result);
    assert.ok(text.includes(result.explanation), 'Native round result explanation must retain its complete stored body');
  }
  const firstRound = await renderedBodies('[aria-label="Round 1"] [data-message-id]');
  assert.equal(new Set(firstRound.map(value => value.id)).size, firstRound.length);
  for (const operation of paged) {
    const message = saved.messages.find(message => message.body === operation.text);
    assert.ok(message); assert.equal(firstRound.filter(value => value.id === message.id).length, 1);
    assert.equal(firstRound.find(value => value.id === message.id).body, operation.text);
  }
  assert.ok(rounds[0].agent_message_ids.length > 100, 'The actual nested round page must exceed its canonical 100-message boundary');
  assert.equal((await browser.$$('button.history-fork')).length, 2);
  for (const id of ['1.1', '1.2']) {
    const fork = await browser.$(`button.history-fork*=Fork · Item ${id}`); await fork.scrollIntoView(); await fork.click();
    await waitForHistoryItem(saved.items[id], `after-fork-${id}`);
    assert.ok((await detail().getText()).includes(saved.items[id].source_round_id));
    await selectParent(saved.items['1']);
  }
  const timeline = await browser.$('[aria-label="Item history view"]').$('button*=Timeline'); await timeline.waitForEnabled(); await timeline.scrollIntoView(); await timeline.click();
  await failureEvidence('history-timeline-paging', () => wait(async () => (await renderedBodies('.history-timeline [data-message-id]')).length > 100, 'Native item conversation paging did not produce complete history'));
  const visible = await renderedBodies('.history-timeline [data-message-id]');
  assert.equal(new Set(visible.map(value => value.id)).size, visible.length, 'Overlapping created/updated/round pages must not duplicate timeline entries');
  for (const operation of paged) assert.equal(visible.filter(value => value.body === operation.text).length, 1);
  return { rounds, timelineMessageIds: visible.map(value => value.id), firstRoundMessageIds: firstRound.map(value => value.id) };
}

async function railState() {
  return browser.execute(() => {
    const rail = document.querySelector('.rail-messages'), editor = document.querySelector('.owner-input textarea');
    return { top: rail.scrollTop, height: rail.scrollHeight, viewport: rail.clientHeight,
      focused: document.activeElement === editor, draft: editor?.value };
  });
}
export async function unpinHistoryMessage(card, message) {
  await card.scrollIntoView(); await card.$(`button[aria-label="Unpin message ${message.number}"]`).click();
  await wait(async () => !(await card.getAttribute('class')).includes('history-pinned')
    && await card.$(`button[aria-label="Pin message ${message.number}"]`).getAttribute('aria-pressed') === 'false',
  'Native unpin did not remove the actual message pin');
}
export async function closeHistoryRailReferences(message) {
  // Unpin does not clear a separate hover source. This embedded driver cannot
  // produce hover transitions; deliberate Close proves the rail cleanup instead.
  const close = await browser.$('button[aria-label="Close message rail"]');
  await close.waitForEnabled(); await close.click();
  await wait(async () => browser.execute(id => {
    const item = document.querySelector('[role="treeitem"][data-item-id="1"]');
    const message = document.querySelector(`.history-timeline [data-message-id="${id}"]`);
    return !document.querySelector('.message-history-rail')
      && item && !item.hasAttribute('data-highlight')
      && message && !message.classList.contains('history-highlight');
  }, message.id), 'Native rail Close did not clear transient tree and detail references');
}
async function rail(history, saved, paged) {
  const toggle = await browser.$('button[title="Messages (m)"]');
  if (!(await browser.$('.rail-messages').isExisting())) {
    await failureEvidence('rail-messages-toggle', () => toggle.waitForEnabled()); await toggle.scrollIntoView(); await toggle.click();
  }
  await wait(async () => (await browser.$$('.rail-messages [data-message-id]')).length === saved.messages.length, 'Rail did not load every actual canonical message page');
  const visible = await renderedBodies('.rail-messages [data-message-id]');
  assert.equal(new Set(visible.map(value => value.id)).size, saved.messages.length);
  for (const message of saved.messages) assert.equal(visible.find(value => value.id === message.id).body, message.body);
  const parentMessage = saved.messages.find(message => message.body === paged[0].text);
  let card = await browser.$(`.rail-messages [data-message-id="${parentMessage.id}"]`);
  await card.scrollIntoView();
  await card.$(`button[aria-label="Pin message ${parentMessage.number}"]`).click();
  await wait(async () => browser.execute(id => {
    const tree = document.querySelector('[role="treeitem"][data-item-id="1"]');
    const detail = document.querySelector(`.history-timeline [data-message-id="${id}"]`);
    return tree?.getAttribute('data-highlight') === 'strong' && detail?.classList.contains('history-highlight');
  }, parentMessage.id), 'Native rail pin did not cross-highlight its real tree item and detail message');
  const childMessage = saved.messages.find(message => message.item_id === '1.1' && message.kind === 'reply'); assert.ok(childMessage);
  const parent = await row('1');
  if (await parent.getAttribute('aria-expanded') !== 'true') {
    await parent.scrollIntoView();
    const fold = await parent.$('button[aria-label="Expand or collapse"]'); await fold.waitForEnabled(); await fold.click();
  }
  await (await browser.$('[data-shell-search]')).waitForEnabled();
  const child = await row('1.1'); await child.waitForDisplayed(); await child.scrollIntoView(); await child.click();
  await waitForHistoryItem(saved.items['1.1']);
  await wait(async () => browser.execute(id => document.querySelector(`.rail-messages [data-message-id="${id}"]`)?.classList.contains('history-highlight'), childMessage.id), 'Native tree selection did not highlight its canonical rail backlink');
  assert.ok((await card.getAttribute('class')).includes('history-pinned'));
  await selectParent(saved.items['1']);
  const timeline = await browser.$('[aria-label="Item history view"]').$('button*=Timeline'); await timeline.waitForEnabled(); await timeline.scrollIntoView(); await timeline.click();
  await wait(async () => browser.execute(id => document.querySelector(`.history-timeline [data-message-id="${id}"]`)?.classList.contains('history-highlight'), parentMessage.id), 'Pinned canonical detail reference was lost after registered child navigation');
  const preferences = async () => {
    const result = await cliRequest(history.cli, ['preferences', 'get', '--json-stdin'], { session: null, request: { command: 'preferences_get', params: {} } });
    assert.equal(result.code, 0); return result.value.data.data;
  };
  await wait(async () => (await preferences()).sessions.find(view => view.session.session_id === history.sessionId)?.selected_item_id === '1', 'Registered parent selection did not finish its deliberate preference write');
  const beforeUnpin = await preferences();
  await unpinHistoryMessage(card, parentMessage);
  assert.deepEqual(await preferences(), beforeUnpin, 'Unpin must not write saved navigation or selection');
  await closeHistoryRailReferences(parentMessage);
  await toggle.waitForEnabled(); await toggle.click();
  await wait(async () => (await browser.$$('.rail-messages [data-message-id]')).length === saved.messages.length, 'Reopened rail did not reload the complete canonical history');
  // WebdriverIO's scrollIntoView injects a wheel gesture sized for the window, which may not move
  // this nested rail on a CI runner. Scroll the DOM element directly; the rail's reaction is ours.
  const domScroll = (element, block) => browser.execute((node, position) => node.scrollIntoView({ behavior: 'instant', block: position }), element, block);
  const latest = await browser.$(`.rail-messages [data-message-id="${saved.messages.at(-1).id}"]`); await domScroll(latest, 'end');
  // Wait for the rail to settle, then scroll up; a late refresh that re-pins the rail is retried.
  let previous = null, beforeUp = null, lastState = null;
  await failureEvidence('rail-older-navigation', async () => {
    try {
      await wait(async () => {
        const state = lastState = await railState();
        const stable = previous && previous.top === state.top && previous.height === state.height;
        previous = state;
        if (!stable) { beforeUp = null; return false; }
        if (!beforeUp) beforeUp = state;
        const target = await browser.$(`.rail-messages [data-message-id="${parentMessage.id}"]`);
        await domScroll(target, 'start');
        const after = lastState = await railState();
        if (after.top < beforeUp.top - 100) return true;
        beforeUp = null; previous = null; return false;
      }, 'Older-message navigation did not actually scroll the nested rail upward');
    } catch (error) {
      error.message += ` railState=${JSON.stringify(lastState)}`; throw error;
    }
  });
  const reply = await browser.$('[aria-label="Owner actions"]').$('button=Reply'); await reply.waitForEnabled(); await reply.scrollIntoView(); await reply.click();
  const another = await browser.$('.owner-input').$('button=Write another input');
  if (await another.isExisting()) { await another.waitForEnabled(); await another.scrollIntoView(); await another.click(); }
  const editor = await browser.$('.owner-input textarea'); await failureEvidence('owner-input-editor-first', () => editor.waitForEnabled());
  const draft = `Unsent native history draft ${process.env.ARIADNE_E2E_NONCE}\nKeep focus and every word.`;
  await editor.scrollIntoView(); await editor.setValue(draft);
  const paused = await railState(); assert.equal(paused.focused, true); assert.equal(paused.draft, draft);
  const before = await snapshot(history), revisions = { '1': before.items['1'].revision };
  const additions = [0, 1].map(index => ({ op: 'reply', ref: `history_live_${index}`, item: { id: '1' }, round_id: null,
    text: `New complete native rail reply ${index}\nRetain the live body without stealing owner focus.` }));
  await apply(history, additions, revisions);
  const live = await snapshot(history), count = live.messages.length - before.messages.length;
  assert.ok(count >= additions.length, 'Count includes real Activity messages, not only explicit replies');
  const jump = await browser.$(`button=${count} new messages · Jump to latest`); await jump.waitForDisplayed({ timeout: 20000 });
  const held = await railState(); assert.equal(held.focused, true); assert.equal(held.draft, draft); assert.ok(Math.abs(held.top - paused.top) <= 1);
  assert.equal(inputs(live).length, 7, 'Live history publication cannot manufacture an owner submission');
  await jump.click();
  await wait(async () => { const state = await railState(); return state.height - state.viewport - state.top <= 2; }, 'Deliberate Jump to latest did not resume the actual nested rail');
  await editor.scrollIntoView(); await editor.click();
  const following = await railState(); assert.equal(following.focused, true); assert.equal(following.draft, draft);
  await apply(history, [{ op: 'reply', ref: 'history_followed', item: { id: '1' }, round_id: null,
    text: 'Following native rail reply\nThe genuine subsequent message remains visible.' }], { '1': live.items['1'].revision });
  const final = await snapshot(history);
  await wait(async () => (await browser.$$('.rail-messages [data-message-id]')).length === final.messages.length, 'Following rail did not load the next genuine message');
  const followed = await railState(); assert.ok(followed.height - followed.viewport - followed.top <= 2);
  assert.equal(followed.focused, true); assert.equal(followed.draft, draft);
  assert.equal(await browser.$('button*=Jump to latest').isExisting(), false);
  return { beforeUp, paused, held, following, followed, count, draft, final };
}

export async function runHistoryAcceptance(configuration) {
  const original = await snapshot(configuration), originalAdmissions = await admissions(configuration);
  const demoBytes = await readFile(configuration.demo.sessionPath);
  const treeProof = await readJson(join(evidence(), 'tree-acceptance.json'));
  const treeBytes = await readFile(treeProof.tree.sessionPath);
  const { history, publication } = await seed(configuration);
  assert.notEqual(history.bindingId, configuration.bindingId); assert.notEqual(history.generation, configuration.generation);
  const questionRevision = (await snapshot(history)).items[history.itemId].question_revision;
  // Observe the real App's seed-triggered preference publication before navigation.
  await wait(async () => ((await preferencesSnapshot()).global.notification_ledger ?? []).some(episode =>
    episode.session.session_id === history.sessionId && episode.session.project_id === history.projectId
    && episode.item_id === history.itemId && episode.question_revision === questionRevision),
  'History question did not reach the genuine native notification ledger');
  await open(history);
  const ownerTexts = [], resultTexts = [], paged = [], roundIds = [];
  for (let ordinal = 1; ordinal <= 5; ordinal++) {
    if (ordinal > 1) {
      const saved = await snapshot(history);
      publication.push(await apply(history, [historyAsk(history.bindingId, ordinal)], { '1': saved.items['1'].revision }));
    }
    await wait(async () => (await detail().getText()).includes(`History round ${ordinal}: choose and explain.`), 'Real next-round ask did not reach native detail');
    const text = `Native history answer ${ordinal} ${process.env.ARIADNE_E2E_NONCE}\nFull owner explanation for round ${ordinal}.`;
    ownerTexts.push(text); await answer(history, ordinal, text);
    let saved = await snapshot(history), input = inputs(saved)[ordinal - 1];
    const roundId = input.payload.context.round_id; assert.ok(roundId); roundIds.push(roundId);
    const answerValue = saved.answers.find(answer => answer.id === input.answer_id); assert.ok(answerValue);
    assert.equal(answerValue.text, text); assert.equal(answerValue.selected_option_id, ordinal % 2 ? option(ordinal).id : null);
    assert.equal(answerValue.ask_snapshot, saved.rounds[roundId].ask_snapshot);
    if (ordinal === 1) {
      for (const [first, count] of [[1, 50], [51, 50], [101, 5]]) {
        const operations = historyMessageBatch(roundId, first, count); paged.push(...operations);
        saved = await snapshot(history);
        publication.push(await apply(history, operations, { '1': saved.items['1'].revision }));
      }
    }
    saved = await snapshot(history);
    const extra = [];
    if (ordinal === 1 || ordinal === 3) {
      const id = ordinal === 1 ? '1.1' : '1.2';
      extra.push(item(`history_fork_${ordinal}`, { id: saved.items['1'].topic_id }, { id: '1' }, `Native history fork ${id}\nKeep its original source round.`, roundId));
    }
    extra.push({ op: 'item.status', item: { id: '1' }, status: ordinal === 5 ? 'done' : 'open',
      outcome: ordinal === 5 ? 'Full native completed outcome\nKeep the former outcome after reopening.' : null,
      why: ordinal === 5 ? 'Full native completion reason\nEvery round was answered explicitly.' : null,
      reason: ordinal === 5 ? null : `Continue after answered round ${ordinal}.` }, { op: 'round.close', round_id: roundId });
    const body = `Explicit native round ${ordinal} result\nFull correlated agent reply for the saved answer.`;
    resultTexts.push(body); publication.push(await result(history, ordinal, body, extra));
  }
  let saved = await snapshot(history);
  const proof = await proveRounds(history, saved, ownerTexts, resultTexts, paged);
  let previousReply = resultTexts.at(-1).split('\n')[0];
  const reviewedTarget = {};
  for (const [intent, ordinal] of [['followup', 6], ['reopen', 7]]) {
    // The renderer must show the previous CLI-applied result before the next intent, or its draft is marked changed.
    await failureEvidence(`previous-result-${intent}`, () => wait(async () => (await detail().getText()).includes(previousReply),
      'Native detail did not show the previous explicit response before the next owner intent'));
    const label = intent === 'followup' ? 'Follow up' : 'Request reopen';
    const control = await browser.$('.history-actions').$(`button=${label}`);
    await control.scrollIntoView(); await control.waitForEnabled(); await control.click();
    // A click during the re-render after the CLI-published result can leave the previous saved receipt showing; click once more.
    const opened = () => browser.$('.owner-input textarea').isExisting();
    if (!await browser.waitUntil(opened, { timeout: 2000, interval: 100 }).catch(() => false)) {
      console.warn(`[history] first ${intent} click did not open the editor; clicked again`);
      const again = await browser.$('.history-actions').$(`button=${label}`);
      await again.scrollIntoView(); await again.waitForEnabled(); await again.click();
      await wait(opened, `Native ${intent} owner input editor did not open after a second click`);
    }
    const editor = await browser.$('.owner-input textarea'); await failureEvidence(`owner-input-editor-${intent}`, () => editor.waitForEnabled());
    reviewedTarget[intent] = await reviewCurrentTarget();
    const text = `Native ${intent} after closed history\nThe owner's deliberate request leaves the status unchanged.`;
    await editor.scrollIntoView(); await editor.setValue(text);
    const send = await browser.$('.owner-input .ref-send-row button'); await failureEvidence(`owner-input-send-${intent}`, () => send.waitForEnabled()); await send.scrollIntoView(); await send.click();
    await wait(async () => inputs(await snapshot(history)).length === ordinal && (await admissions(history)).length === ordinal, 'Closed-item deliberate owner intent did not reach its isolated host');
    saved = await snapshot(history); assert.equal(saved.items['1'].status, 'done'); assert.equal(inputs(saved)[ordinal - 1].kind, intent);
    const extra = intent === 'reopen' ? [{ op: 'item.status', item: { id: '1' }, status: 'open', outcome: null, why: null, reason: 'The owner explicitly requested native reopening.' }] : [];
    publication.push(await result(history, ordinal, `Explicit native ${intent} response\nRetain the full result.`, extra));
    previousReply = `Explicit native ${intent} response`;
  }
  saved = await snapshot(history); assert.equal(saved.items['1'].status, 'open'); assert.equal(saved.items['1'].outcome, null);
  await wait(async () => {
    const former = await browser.$('.item-history > [aria-label="Former outcome"]');
    return await former.isExisting() && (await former.getText()).includes('Full native completed outcome\nKeep the former outcome after reopening.');
  }, 'Genuine reopening lost its former outcome in native detail');
  assert.ok((await detail().getText()).includes('Full native completion reason\nEvery round was answered explicitly.'));
  publication.push(await apply(history, [{ op: 'reply', ref: 'history_child_reply', item: { id: '1.1' }, round_id: null,
    text: 'Native child rail backlink\nIts registered link remains distinct from the selected parent.' }], { '1.1': saved.items['1.1'].revision }));
  saved = await snapshot(history);
  const railProof = await rail(history, saved, paged), finalSession = railProof.final;
  const unchanged = await snapshot(configuration);
  assert.equal(unchanged.active_binding_id, original.active_binding_id);
  assert.equal(unchanged.bindings[configuration.bindingId].generation, configuration.generation);
  assert.deepEqual(unchanged.inputs, original.inputs); assert.deepEqual(unchanged.operation_receipts, original.operation_receipts);
  assert.deepEqual(await admissions(configuration), originalAdmissions);
  assert.deepEqual(await readFile(configuration.demo.sessionPath), demoBytes);
  assert.deepEqual(await readFile(treeProof.tree.sessionPath), treeBytes, 'History work cannot alter the real 2k-item / 5k-message tree corpus');
  assert.ok(inputs(finalSession).every(input => input.state === 'handled' && input.attempts.length === 1));
  assert.equal(new Set((await admissions(history)).map(entry => entry.attemptId)).size, 7);
  await browser.saveScreenshot(join(evidence(), 'native-complete-history.png'));
  await writeFile(join(evidence(), 'history-acceptance.json'), JSON.stringify({ history, publication, ownerTexts, resultTexts, paged,
    roundIds, reviewedTarget, proof, railProof, nativePinAndSelectionRefs: true, clearReferenceProof: 'Actual Unpin removes pin state without preferences writes; deliberate rail Close clears references',
    hoverProof: 'Focused actual-App component tests; embedded driver lacks hover transitions', finalSession, queued: await admissions(history), originalAdmissions }, null, 2));
}

export async function restoreHistoryAcceptance(configuration) {
  const prior = await readJson(join(process.env.ARIADNE_E2E_PRIOR_EVIDENCE, 'history-acceptance.json'));
  const { history, finalSession } = prior;
  assert.equal(history.externalSessionId, configuration.history.externalSessionId);
  assert.deepEqual(await snapshot(history), finalSession); assert.deepEqual(await admissions(history), prior.queued);
  await open(history);
  await proveRounds(history, finalSession, prior.ownerTexts, prior.resultTexts, prior.paged);
  const editor = await browser.$('.owner-input textarea'); await failureEvidence('restored-owner-draft', () => editor.waitForDisplayed());
  assert.equal(await editor.getValue(), prior.railProof.draft, 'Actual process relaunch must retain the unsent owner draft without creating a new input');
  assert.ok((await detail().getText()).includes('Full native completed outcome\nKeep the former outcome after reopening.'));
  assert.ok((await detail().getText()).includes('Full native completion reason\nEvery round was answered explicitly.'));
  assert.deepEqual(await snapshot(history), finalSession); assert.deepEqual(await admissions(history), prior.queued);
  assert.deepEqual(await admissions(configuration), prior.originalAdmissions);
  await browser.saveScreenshot(join(evidence(), 'native-restored-complete-history.png'));
  await writeFile(join(evidence(), 'history-restoration.json'), JSON.stringify({ sameCanonicalHistory: true,
    sameFiveRoundsTwoForksAndSevenInputs: true, noReseedOrExtraAdmissions: true, proof: prior.proof }, null, 2));
}
