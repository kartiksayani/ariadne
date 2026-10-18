import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { historyFailureFacts, withFailureEvidence } from './history-evidence.mjs';
import { folded, ownerReplyTarget, waitForOwnerReplyTarget } from './owner-reply.mjs';
import { admissions, assertSlimEnvelope, awaitConnected, cliRequest, completeTurn, journeyResultRequest, snapshot } from './scripted-provider.mjs';
import { openSessionButton } from './session-button.mjs';
import { goToPeekItem, search } from './tree.spec.mjs';

const wait = (condition, message) => browser.waitUntil(condition, { timeout: 60000, interval: 100, timeoutMsg: message });
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const evidence = () => process.env.ARIADNE_E2E_EVIDENCE;
const request = operations => ({ op_id: randomUUID(), source_input_id: null, attempt_id: null,
  expected_item_revisions: {}, expected_topic_revisions: {}, summary: '', operations, input_result: null });
const detail = () => browser.$('.item-detail');
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
// The detail's canonical item ID and complete title tooltip identify selection;
// a fork's source round is proved by its link on the originating message.
export async function waitForHistoryItem(item, label = 'history-item') {
  await failureEvidence(label, () => wait(() => browser.execute(expected => {
    const article = document.querySelector('article.item-detail[data-detail-item-id]');
    const question = article?.querySelector('.detail-question');
    return article?.dataset.detailItemId === expected.id && question?.getAttribute('title') === expected.question
      && !!question.textContent?.trim();
  }, { id: item.id, question: item.question }),
  'Native detail did not reveal the registered item and its complete question'),
  { id: item.id, question: item.question, source_round_id: item.source_round_id });
}
// Every owner input of the detail: the answer slot of a waiting item and the action box of the others.
const ownerInput = itemId => itemId ? `[data-owner-input="${itemId}"]` : '[data-owner-input]';
// Kept under "Before you reopened it"; the Paperwhite detail shows the former outcome, not the former why.
const formerOutcome = 'Full native completed outcome\nKeep the former outcome after reopening.';
const inputs = session => Object.values(session.inputs).sort((a, b) => a.seq - b.seq);
const row = id => browser.$(`.tree-rows [data-item-id="${id}"]`);
let navigationRecovered = false;
const updatedNavigation = 'Updated to the latest. Try again if needed.';
const preferencesSnapshot = async () => (await readJson(join(process.env.ARIADNE_HOME, 'ui.json'))).snapshot;
export async function navigationUpdated() {
  const notice = await browser.$('.pw-notices .pw-note[data-notice-id="navigation-action-failed"][data-tone="info"]');
  return await notice.isExisting() && await notice.$('.pw-note-text').getText() === updatedNavigation
    && !(await notice.$('button=Refresh').isExisting());
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
  const result = await cliRequest(history.cli, ['apply', '--binding', history.bindingId, '--generation', history.generation, '--json-stdin', '--full'], value);
  assert.equal(result.code, 0); assert.equal(result.value.session_id, history.sessionId);
  return { request: value, receipt: result.value };
}
async function open(history, itemId = '1') {
  // The session is reached from the switcher's All sessions page; pages are not saved, so the saved session proves it finished.
  const selectedSession = async () => {
    const selected = (await preferencesSnapshot()).global.selected_navigation;
    return selected.kind === 'session' && selected.session.session_id === history.sessionId;
  };
  const choose = async () => {
    const session = await openSessionButton(history.sessionId); await session.scrollIntoView(); await session.click();
    await wait(async () => await selectedSession() || await navigationUpdated(), 'History session navigation did not finish or refresh its changed view');
  };
  await choose();
  if (!await selectedSession()) {
    assert.equal(navigationRecovered, false, 'Only one fresh history navigation choice is allowed per native launch');
    navigationRecovered = true;
    const refreshed = { sessionId: history.sessionId, message: updatedNavigation,
      preferences: await preferencesSnapshot(), body: await browser.$('body').getText() };
    // The changed view refreshes itself; navigation still needs a deliberate fresh owner choice.
    await choose();
    await wait(selectedSession, 'Fresh history session choice did not persist after automatic refresh');
    await writeFile(join(evidence(), 'history-navigation-recovery.json'), JSON.stringify({ refreshed, recovered: await preferencesSnapshot() }, null, 2));
  }
  await wait(async () => await browser.$('.tree-column').getAttribute('data-session-status') === 'ready'
    && await browser.$('.tree-column').getAttribute('data-session-busy') === 'false', 'History session did not finish loading its Map');
  const target = await row(itemId); await target.waitForDisplayed(); await target.scrollIntoView(); await target.click();
  await waitForHistoryItem((await snapshot(history)).items[itemId]);
}
async function selectParent(item) {
  await (await search()).waitForEnabled();
  const parent = await row('1'); await parent.waitForDisplayed(); await parent.scrollIntoView(); await parent.click();
  await waitForHistoryItem(item);
  await (await search()).waitForEnabled();
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
  const review = await browser.$(ownerInput()).$('button=Review this question');
  if (!await review.isExisting()) return false;
  await review.waitForEnabled(); await review.scrollIntoView(); await review.click();
  return true;
}
export async function waitForHistoryControl(control, label) {
  await control.waitForEnabled();
  // A refreshing answer control keeps focus with aria-disabled instead of native disabled.
  await wait(async () => await control.isEnabled() && await control.getAttribute('aria-disabled') !== 'true',
    `Native ${label} remained unavailable`);
}
async function answer(history, ordinal, text) {
  // The preceding CLI ask/result is complete; wait for its exact target before opening or reviewing a draft.
  await waitForOwnerReplyTarget(history, ownerReplyTarget(await snapshot(history), history.itemId));
  // Details answers the selected waiting item with the answer cards: odd rounds have one option card (pick it, then Send); even
  // rounds have no options, so the words box is open at once (type, then Send).
  const odd = ordinal % 2 === 1;
  const editor = await browser.$(odd ? `${ownerInput('1')} [data-answer-option="0"]` : `${ownerInput('1')} textarea`);
  await failureEvidence(`owner-input-editor-round-${ordinal}`, async () => {
    try { await editor.waitForDisplayed(); } catch (error) { await browser.saveScreenshot(join(evidence(), `owner-input-editor-round-${ordinal}.png`)); throw error; }
  }, { ordinal, text });
  // The answer slot locks a draft written against an older question until "Review this question" updates it.
  await wait(async () => await editor.isEnabled() || await reviewCurrentTarget(), 'The answer editor neither enabled nor offered Review this question');
  await editor.waitForEnabled();
  // Odd rounds send the chosen option alone; even rounds send a reply in the owner's own words.
  if (odd) { await waitForHistoryControl(editor, `round ${ordinal} choice`); assert.ok((await editor.getText()).includes(option(ordinal).label)); await editor.scrollIntoView(); await editor.click(); }
  else { await editor.scrollIntoView(); await editor.setValue(text); }
  const send = await browser.$(`${ownerInput('1')} button[data-answer-send]`); await failureEvidence(`owner-input-send-${ordinal}`, () => waitForHistoryControl(send, `round ${ordinal} Send`)); await send.scrollIntoView(); await send.click();
  await wait(async () => inputs(await snapshot(history)).length === ordinal && (await admissions(history)).length === ordinal,
    'A genuine native round answer did not persist and reach its isolated host');
}
async function result(history, ordinal, body, extra = []) {
  const queued = await admissions(history), admission = queued[ordinal - 1];
  const saved = await snapshot(history), input = inputs(saved)[ordinal - 1];
  assert.equal(admission.inputId, input.id); assert.equal(admission.bindingId, history.bindingId); assert.equal(admission.generation, history.generation);
  assert.equal(input.attempts.length, 1); assert.equal(admission.attemptId, input.attempts[0].id);
  assert.equal(admission.payload, input.attempts[0].formatted_payload);
  assertSlimEnvelope(admission, input);
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
    id: card.dataset.messageId, body: card.querySelector('.detail-bubble-agent .md')?.textContent,
  })), selector);
}
// Ask, owner and correlated reply are separate chronological messages. A full
// agent reply replaces the duplicate result summary; gate on that exact reply.
export async function waitForRoundResult(round, owner, reply) {
  await wait(async () => {
    const ask = await browser.$(`.detail-chat-list [data-round="${round.ordinal}"]`);
    const answer = await browser.$(`.detail-chat-list [data-message-id="${owner.id}"]`);
    const result = await browser.$(`.detail-chat-list [data-message-id="${reply.id}"] .detail-bubble-agent .md`);
    return await ask.isExisting() && await answer.isExisting() && await answer.getAttribute('data-owner-said') === 'true'
      && folded(await answer.getText()).includes(folded(owner.text))
      && await result.isExisting() && folded(await result.getText()) === folded(reply.body)
      && (await browser.$$('.detail-chat-list [data-pending]')).length === 0;
  }, 'Native detail did not publish the final closed round, its complete correlated result and the settled owner message');
}
async function proveRounds(history, saved, ownerTexts, resultTexts, paged) {
  // One Conversation contains every complete message, ask and fork.
  const back = await browser.$('.item-detail [aria-label="Conversation"]'); await failureEvidence('history-conversation', () => back.waitForDisplayed()); await back.scrollIntoView();
  // Restoration runs against the final session, whose open sixth round (no result) is also rendered.
  const every = Object.keys(saved.rounds).length;
  await failureEvidence('history-rounds', () => wait(async () => (await browser.$$('.detail-chat-list li[data-round]')).length === every, `Native detail did not load all ${every} real rounds`));
  const rounds = Object.values(saved.rounds).filter(round => round.closed_at).sort((a, b) => a.ordinal - b.ordinal);
  assert.equal(rounds.length, 5); assert.equal(Object.keys(saved.items).length, 3);
  // Five ask anchors already exist after the fifth answer. The Core completion
  // barrier does not imply that the selected native history has refreshed yet.
  const expected = rounds.map((round, index) => {
    const input = saved.inputs[round.result_input_ids[0]]; assert.ok(input);
    assert.ok(round.owner_message_ids.includes(input.message_id), 'Result input must identify its round owner message');
    const reply = saved.messages.find(message => round.agent_message_ids.includes(message.id)
      && message.input_id === input.id && message.body === resultTexts[index]);
    assert.ok(reply, `Round ${round.ordinal} lost its full canonical correlated reply`);
    return { owner: { id: input.message_id, text: index % 2 === 0 ? `You chose “${option(index + 1).label}”`
      : ownerTexts[index].trim() }, reply };
  });
  const finalRound = rounds.at(-1), final = expected.at(-1);
  await failureEvidence('history-final-round-result', () => waitForRoundResult(finalRound, final.owner, final.reply));
  for (let index = 0; index < 5; index++) {
    const section = await browser.$(`.detail-chat-list [data-round="${index + 1}"]`);
    const text = folded(await section.getText()), round = rounds[index];
    // The ask anchor retains its full ask; owner and result keep their own IDs.
    assert.ok(text.includes(folded(round.ask_snapshot ?? round.question_snapshot)), `Round ${index + 1} lost its full stored ask`);
    const owner = await browser.$(`.detail-chat-list [data-message-id="${expected[index].owner.id}"]`);
    assert.ok(folded(await owner.getText()).includes(folded(expected[index].owner.text)), `Round ${index + 1} lost the owner's full choice or reply`);
    assert.equal(await owner.getAttribute('data-owner-said'), 'true');
    assert.ok(round.closed_at); assert.equal(round.result_input_ids.length, 1);
    const result = saved.inputs[round.result_input_ids[0]].attempts[0].domain_result; assert.ok(result);
    const input = saved.inputs[round.result_input_ids[0]];
    assert.equal(result.explanation, `Explicit native result ${index + 1}\nComplete stored explanation for ${input.kind} #${input.seq}.`, 'Stored round result explanation must retain its complete body');
    const reply = await browser.$(`.detail-chat-list [data-message-id="${expected[index].reply.id}"] .detail-bubble-agent .md`);
    assert.equal(folded(await reply.getText()), folded(resultTexts[index]), 'Native correlated reply must retain its complete body');
  }
  // Paging must include the same complete bodies in the single chat.
  const firstRound = rounds[0].agent_message_ids;
  assert.ok(firstRound.length > 100, 'The actual nested round page must exceed its canonical 100-message boundary');
  assert.equal((await browser.$$('button.detail-fork')).length, 2);
  for (const id of ['1.1', '1.2']) {
    // The fork sits on its creation message, with its canonical source round.
    const source = saved.rounds[saved.items[id].source_round_id]; assert.ok(source);
    assert.ok(source.fork_item_ids.includes(id));
    const fork = await browser.$(`.detail-chat-list [data-message-id="${saved.items[id].created_message_id}"]`).$('button.detail-fork');
    assert.equal(await fork.getAttribute('title'), saved.items[id].question, 'The creation-message fork keeps its complete saved question');
    await fork.scrollIntoView(); await fork.click();
    await goToPeekItem(saved.items[id], '1');
    await waitForHistoryItem(saved.items[id], `after-fork-${id}`);
    await selectParent(saved.items['1']);
  }
  const conversation = await browser.$('.item-detail [aria-label="Conversation"]'); await conversation.waitForDisplayed(); await conversation.scrollIntoView();
  await failureEvidence('history-conversation-paging', () => wait(async () => (await renderedBodies('.detail-chat-list > li[data-message-id]')).length > 100, 'Native item conversation paging did not produce complete history'));
  const visible = await renderedBodies('.detail-chat-list > li[data-message-id]');
  assert.equal(new Set(visible.map(value => value.id)).size, visible.length, 'Overlapping created/updated/round pages must not duplicate chat entries');
  for (const operation of paged) assert.equal(visible.filter(value => value.body === operation.text).length, 1);
  return { rounds, conversationMessageIds: visible.map(value => value.id), firstRoundMessageIds: firstRound };
}

async function conversationState() {
  return browser.execute(() => {
    const pane = document.querySelector('.item-detail .detail-body'), editor = document.querySelector('[data-owner-input] textarea');
    return { top: pane.scrollTop, height: pane.scrollHeight, viewport: pane.clientHeight,
      focused: document.activeElement === editor, draft: editor?.value };
  });
}
async function proveConversationMessages(saved, itemId) {
  const item = saved.items[itemId], parent = item.parent ? saved.items[item.parent] : null;
  const roundMessageIds = new Set(Object.values(saved.rounds).filter(round => round.item_id === itemId)
    .flatMap(round => [round.opened_message_id, ...round.agent_message_ids, ...round.owner_message_ids]));
  const expected = saved.messages.filter(message => message.item_id === itemId || message.items_touched.includes(itemId)
    || message.id === item.created_message_id || message.id === parent?.created_message_id
    || item.updated_message_ids.includes(message.id) || roundMessageIds.has(message.id));
  await wait(async () => {
    const visible = await renderedBodies('.detail-chat-list > li[data-message-id]');
    return expected.every(message => visible.some(value => value.id === message.id));
  }, 'Item conversation did not load every canonical message page');
  const visible = await renderedBodies('.detail-chat-list > li[data-message-id]');
  assert.equal(new Set(visible.map(value => value.id)).size, visible.length, 'Complete item message pages must not duplicate conversation entries');
  for (const message of expected) {
    // Owner choices and replies have their own readable rendering, proved round by round above.
    if (message.author !== 'owner') assert.equal(folded(visible.find(value => value.id === message.id).body), folded(message.body),
      `Item conversation lost the complete canonical body #${message.number}`);
  }
  return expected.map(message => message.id);
}
async function conversation(history, saved, paged) {
  const messageIds = await proveConversationMessages(saved, '1');
  const parentMessage = saved.messages.find(message => message.body === paged[0].text); assert.ok(parentMessage);
  const childMessage = saved.messages.find(message => message.item_id === '1.1' && message.kind === 'reply'); assert.ok(childMessage);
  const parent = await row('1');
  if (await parent.getAttribute('aria-expanded') !== 'true') {
    await parent.scrollIntoView();
    const fold = await parent.$('button[aria-label="Expand or collapse"]'); await fold.waitForEnabled(); await fold.click();
  }
  await (await search()).waitForEnabled();
  const child = await row('1.1'); await child.waitForDisplayed(); await child.scrollIntoView(); await child.click();
  await waitForHistoryItem(saved.items['1.1']);
  const childMessageIds = await proveConversationMessages(saved, '1.1');
  const childReply = await browser.$(`.detail-chat-list [data-message-id="${childMessage.id}"] .detail-bubble-agent .md`);
  assert.equal(folded(await childReply.getText()), folded(childMessage.body), 'Registered child navigation must reveal its own complete reply');
  const sibling = await row('1.2'); await sibling.waitForDisplayed(); await sibling.scrollIntoView(); await sibling.click();
  await waitForHistoryItem(saved.items['1.2']);
  const siblingMessageIds = await proveConversationMessages(saved, '1.2');
  assert.equal(await browser.$('.session-activity').isExisting(), false, 'Session history has no disclosure');
  const conversationMessageIds = new Set([...messageIds, ...childMessageIds, ...siblingMessageIds]);
  const storedHistoryMessages = saved.messages.filter(message => !conversationMessageIds.has(message.id));
  const persisted = await snapshot(history);
  assert.deepEqual(persisted.messages, saved.messages, 'Reading item conversations must preserve every complete stored message');
  await selectParent(saved.items['1']);
  await proveConversationMessages(saved, '1');
  // Scroll the actual detail body: the docked editor is outside this reading region.
  const domScroll = (element, block) => browser.execute((node, position) => node.scrollIntoView({ behavior: 'instant', block: position }), element, block);
  await browser.execute(() => {
    const pane = document.querySelector('.item-detail .detail-body');
    pane.scrollTop = pane.scrollHeight; pane.dispatchEvent(new window.Event('scroll', { bubbles: true }));
  });
  let previous = null, beforeUp = null, lastState = null;
  await failureEvidence('conversation-older-navigation', async () => {
    try {
      await wait(async () => {
        const state = lastState = await conversationState();
        const stable = previous && previous.top === state.top && previous.height === state.height;
        previous = state;
        if (!stable) { beforeUp = null; return false; }
        if (!beforeUp) beforeUp = state;
        const target = await browser.$(`.detail-chat-list [data-message-id="${parentMessage.id}"]`);
        await domScroll(target, 'start');
        const after = lastState = await conversationState();
        if (after.top < beforeUp.top - 100) return true;
        beforeUp = null; previous = null; return false;
      }, 'Older-message navigation did not actually scroll the item conversation upward');
    } catch (error) {
      error.message += ` conversationState=${JSON.stringify(lastState)}`; throw error;
    }
  });
  await waitForOwnerReplyTarget(history, ownerReplyTarget(saved, history.itemId));
  const reply = await browser.$('[aria-label="Item actions"]').$('button*=Reply'); await reply.waitForEnabled(); await reply.scrollIntoView(); await reply.click();
  const editor = await browser.$(`${ownerInput('1')} textarea`); await failureEvidence('owner-input-editor-first', () => editor.waitForEnabled());
  const draft = `Unsent native history draft ${process.env.ARIADNE_E2E_NONCE}\nKeep focus and every word.`;
  await editor.scrollIntoView(); await editor.setValue(draft);
  const paused = await conversationState(); assert.equal(paused.focused, true); assert.equal(paused.draft, draft);
  assert.ok(paused.height - paused.viewport - paused.top > 80, 'Live history proof must start while reading an older message');
  const before = await snapshot(history), revisions = { '1': before.items['1'].revision };
  const additions = [0, 1].map(index => ({ op: 'reply', ref: `history_live_${index}`, item: { id: '1' }, round_id: null,
    text: `New complete native conversation reply ${index}\nRetain the live body without stealing owner focus.` }));
  await apply(history, additions, revisions);
  const live = await snapshot(history), count = live.messages.length - before.messages.length;
  assert.ok(count >= additions.length, 'Count includes real Activity messages, not only explicit replies');
  await proveConversationMessages(live, '1');
  const held = await conversationState(); assert.equal(held.focused, true); assert.equal(held.draft, draft); assert.ok(Math.abs(held.top - paused.top) <= 1);
  assert.equal(inputs(live).length, 7, 'Live history publication cannot manufacture an owner submission');
  // A deliberate scroll to the transcript end resumes following arrivals without moving editor focus.
  await browser.execute(() => {
    const pane = document.querySelector('.item-detail .detail-body');
    pane.scrollTop = pane.scrollHeight; pane.dispatchEvent(new window.Event('scroll', { bubbles: true }));
  });
  await wait(async () => { const state = await conversationState(); return state.height - state.viewport - state.top <= 2; },
    'Deliberate scrolling to latest did not reach the item conversation end');
  const following = await conversationState(); assert.equal(following.focused, true); assert.equal(following.draft, draft);
  await apply(history, [{ op: 'reply', ref: 'history_followed', item: { id: '1' }, round_id: null,
    text: 'Following native conversation reply\nThe genuine subsequent message remains visible.' }], { '1': live.items['1'].revision });
  const final = await snapshot(history);
  assert.deepEqual(final.messages.slice(0, saved.messages.length), saved.messages,
    'Live conversation arrivals must preserve every earlier complete stored message');
  await proveConversationMessages(final, '1');
  await wait(async () => { const state = await conversationState(); return state.height - state.viewport - state.top <= 2; },
    'Item conversation did not keep following the next genuine message');
  const followed = await conversationState(); assert.equal(followed.focused, true); assert.equal(followed.draft, draft);
  return { messageIds, childMessageIds, siblingMessageIds, storedHistoryMessageIds: storedHistoryMessages.map(message => message.id), beforeUp, paused, held, following, followed, count, draft, final };
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
    const text = ordinal % 2 ? '' : `Native history answer ${ordinal} ${process.env.ARIADNE_E2E_NONCE}\nFull owner explanation for round ${ordinal}.`;
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
    await waitForOwnerReplyTarget(history, ownerReplyTarget(await snapshot(history), history.itemId));
    // The renderer must show the previous CLI-applied result before the next intent, or its draft is marked changed.
    await failureEvidence(`previous-result-${intent}`, () => wait(async () => (await detail().getText()).includes(previousReply),
      'Native detail did not show the previous explicit response before the next owner intent'));
    // Revisit (Ariadne.dc.html): Follow up opens a box for the owner's words; Back to Open sends its fixed request at once.
    const label = intent === 'followup' ? 'Follow up' : 'Back to Open';
    const control = await browser.$('[aria-label="Item actions"]').$(`button*=${label}`);
    await control.scrollIntoView(); await control.waitForEnabled(); await control.click();
    if (intent === 'followup') {
      // A click during the re-render after the CLI-published result can miss the box; click once more.
      const opened = () => browser.$(`${ownerInput('1')} textarea`).isExisting();
      if (!await browser.waitUntil(opened, { timeout: 2000, interval: 100 }).catch(() => false)) {
        console.warn(`[history] first ${intent} click did not open the editor; clicked again`);
        const again = await browser.$('[aria-label="Item actions"]').$(`button*=${label}`);
        await again.scrollIntoView(); await again.waitForEnabled(); await again.click();
        await wait(opened, `Native ${intent} owner input editor did not open after a second click`);
      }
      const editor = await browser.$(`${ownerInput('1')} textarea`); await failureEvidence(`owner-input-editor-${intent}`, () => editor.waitForEnabled());
      reviewedTarget[intent] = await reviewCurrentTarget();
      const text = `Native ${intent} after closed history\nThe owner's deliberate request leaves the status unchanged.`;
      await editor.scrollIntoView(); await editor.setValue(text);
      const send = await browser.$(`${ownerInput('1')} button[aria-label="Send follow-up"]`); await failureEvidence(`owner-input-send-${intent}`, () => send.waitForEnabled()); await send.scrollIntoView(); await send.click();
    } else reviewedTarget[intent] = false;
    await wait(async () => inputs(await snapshot(history)).length === ordinal && (await admissions(history)).length === ordinal, 'Closed-item deliberate owner intent did not reach its isolated host');
    saved = await snapshot(history); assert.equal(saved.items['1'].status, 'done'); assert.equal(inputs(saved)[ordinal - 1].kind, intent);
    const extra = intent === 'reopen' ? [{ op: 'item.status', item: { id: '1' }, status: 'open', outcome: null, why: null, reason: 'The owner explicitly requested native reopening.' }] : [];
    publication.push(await result(history, ordinal, `Explicit native ${intent} response\nRetain the full result.`, extra));
    previousReply = `Explicit native ${intent} response`;
  }
  saved = await snapshot(history); assert.equal(saved.items['1'].status, 'open'); assert.equal(saved.items['1'].outcome, null);
  await wait(async () => {
    const former = await browser.$('.item-detail [aria-label="Former outcome"]');
    return await former.isExisting() && folded(await former.getText()).includes(folded(formerOutcome));
  }, 'Genuine reopening lost its former outcome in native detail');
  publication.push(await apply(history, [{ op: 'reply', ref: 'history_child_reply', item: { id: '1.1' }, round_id: null,
    text: 'Native child conversation reply\nIts registered link remains distinct from the selected parent.' }], { '1.1': saved.items['1.1'].revision }));
  saved = await snapshot(history);
  const conversationProof = await conversation(history, saved, paged), finalSession = conversationProof.final;
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
    roundIds, reviewedTarget, proof, conversationProof, finalSession, queued: await admissions(history), originalAdmissions }, null, 2));
}

export async function restoreHistoryAcceptance(configuration) {
  const prior = await readJson(join(process.env.ARIADNE_E2E_PRIOR_EVIDENCE, 'history-acceptance.json'));
  const { history, finalSession } = prior;
  assert.equal(history.externalSessionId, configuration.history.externalSessionId);
  assert.deepEqual(await snapshot(history), finalSession); assert.deepEqual(await admissions(history), prior.queued);
  await open(history);
  await proveRounds(history, finalSession, prior.ownerTexts, prior.resultTexts, prior.paged);
  await proveConversationMessages(finalSession, '1');
  // The Reply box is docked on the open item; it shows the draft the relaunch retained.
  const reply = await browser.$('[aria-label="Item actions"]').$('button*=Reply'); await reply.waitForEnabled(); await reply.scrollIntoView(); await reply.click();
  const editor = await browser.$(`${ownerInput('1')} textarea`); await failureEvidence('restored-owner-draft', () => editor.waitForDisplayed());
  assert.equal(await editor.getValue(), prior.conversationProof.draft, 'Actual process relaunch must retain the unsent owner draft without creating a new input');
  assert.ok(folded(await browser.$('.item-detail [aria-label="Former outcome"]').getText()).includes(folded(formerOutcome)));
  assert.deepEqual(await snapshot(history), finalSession); assert.deepEqual(await admissions(history), prior.queued);
  assert.deepEqual(await admissions(configuration), prior.originalAdmissions);
  await browser.saveScreenshot(join(evidence(), 'native-restored-complete-history.png'));
  await writeFile(join(evidence(), 'history-restoration.json'), JSON.stringify({ sameCanonicalHistory: true,
    sameFiveRoundsTwoForksAndSevenInputs: true, noReseedOrExtraAdmissions: true, proof: prior.proof }, null, 2));
}
