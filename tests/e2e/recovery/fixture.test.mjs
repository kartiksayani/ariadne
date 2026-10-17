import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { openFollowUp, openOwnerReply, ownerReplyTarget, replyControlState, sendDetailReply, waitForOwnerReplyTarget } from '../../../apps/desktop/tests/e2e/owner-reply.mjs';
import { assertRepairAdmission, originalReplyRequest, repairResultRequest } from '../../../apps/desktop/tests/e2e/recovery.spec.mjs';
import { cliRequest } from '../../../apps/desktop/tests/e2e/scripted-provider.mjs';

function fixture() {
  const bindingId = randomUUID(), generation = randomUUID(), inputId = randomUUID();
  const configuration = { bindingId, generation, itemId: '1' };
  const original = { inputId, attemptId: randomUUID(), bindingId, generation, turnId: 'original-turn' };
  const reply = { id: randomUUID(), body: 'Original complete reply', input_id: inputId, attempt_id: original.attemptId };
  const body = { purpose: 'result_repair',
    repair_for_attempt_id: original.attemptId, source_input_id: inputId, binding_id: bindingId, generation,
    original_message_ids: [reply.id], original_domain_result: null };
  const admission = { inputId, attemptId: randomUUID(), bindingId, generation, turnId: 'repair-turn', ordinal: 2 };
  admission.payload = `[ARIADNE_INPUT:${inputId}:${admission.attemptId}]\n${JSON.stringify(body)}`;
  const input = { id: inputId, binding_id: bindingId, message_id: randomUUID(), payload: { text: 'Original work must never be resent\nPreserve "quotes", \\backslashes and the entire second line.' },
    attempts: [{ id: admission.attemptId, binding_generation: generation, purpose: 'result_repair',
      repair_for_attempt_id: original.attemptId, formatted_payload: admission.payload }] };
  const session = { inputs: { [inputId]: input }, messages: [{ id: input.message_id, number: 7 }], items: { 1: { revision: 3 } } };
  return { configuration, original, reply, body, admission, input, session };
}

function payload(fixture, body) {
  fixture.admission.payload = `[ARIADNE_INPUT:${fixture.input.id}:${fixture.admission.attemptId}]\n${JSON.stringify(body)}`;
  fixture.input.attempts[0].formatted_payload = fixture.admission.payload;
}

test('repair assertion rejects replayed original work, missing retained effects and foreign identities', () => {
  const valid = fixture();
  assert.deepEqual(assertRepairAdmission(valid.configuration, valid.admission, valid.session, valid.original, valid.reply), valid.body);
  const mutations = [
    state => { state.admission.generation = randomUUID(); },
    state => { state.input.attempts[0].binding_generation = randomUUID(); },
    state => { state.input.attempts[0].purpose = 'work'; },
    state => { state.input.attempts[0].repair_for_attempt_id = randomUUID(); },
    state => { state.admission.turnId = state.original.turnId; },
    state => { payload(state, { ...state.body, original_message_ids: [] }); },
    state => { payload(state, { ...state.body, saved_input: state.input.payload }); },
    state => { payload(state, { ...state.body, instruction: 'result-only repair' }); },
    state => { payload(state, { ...state.body, text: state.input.payload.text }); },
    state => { payload(state, { ...state.body, context: [{ original_work: state.input.payload.text }] }); },
    state => { payload(state, { ...state.body, source_input_id: randomUUID() }); },
  ];
  for (const mutate of mutations) {
    const state = fixture(); mutate(state);
    assert.throws(() => assertRepairAdmission(state.configuration, state.admission, state.session, state.original, state.reply), assert.AssertionError);
  }
});

test('escaped multiline owner work injected into the decoded repair instruction is rejected', () => {
  const state = fixture();
  payload(state, { ...state.body, instruction: `result-only repair\n${state.input.payload.text}` });
  assert.equal(state.admission.payload.includes(state.input.payload.text), false, 'JSON escaping defeats a raw payload substring check');
  assert.throws(() => assertRepairAdmission(state.configuration, state.admission, state.session, state.original, state.reply), /Repair cannot repeat the original owner work/);
});

// The non-waiting detail: its Reply box is always docked and empties once the previous reply saved.
// Polling its words is how the helper learns the reply was acknowledged; the box is never pressed open.
function replyBoxBrowser(emptiesAfter) {
  const calls = []; let polls = 0, rendered = 'sent box';
  const box = {
    async isExisting() { return true; },
    async getValue() {
      if (++polls > emptiesAfter) rendered = 'emptied box';
      calls.push(`box ${rendered}`); return rendered === 'emptied box' ? '' : 'The sent reply';
    },
  };
  const exists = value => ({ async isExisting() { return value(); } });
  const browser = {
    $(selector) {
      if (selector === '.item-detail .detail-answer-slot[data-owner-input]') return exists(() => false);
      if (selector.includes('[aria-label="Reply"]')) return exists(() => false);
      if (selector === '.item-detail [data-owner-input] .detail-box textarea') return box;
      return assert.fail(`The docked Reply box needs no press: ${selector}`);
    },
    async waitUntil(condition, options) {
      for (let attempt = 0; attempt < 3; attempt++) if (await condition()) return true;
      throw new Error(options.timeoutMsg);
    },
  };
  return { browser, calls };
}

test('a known successive Reply waits for the sent Reply box to empty, then writes in the docked box without pressing Reply', async t => {
  const previousBrowser = globalThis.browser;
  t.after(() => { globalThis.browser = previousBrowser; });
  const fake = replyBoxBrowser(1);
  globalThis.browser = fake.browser;
  await openOwnerReply(true);
  assert.deepEqual(fake.calls, ['box sent box', 'box emptied box']);
});

test('a sent Reply box that never empties fails; a waiting item\'s successive words go through Add a reply', async t => {
  const previousBrowser = globalThis.browser;
  t.after(() => { globalThis.browser = previousBrowser; });
  const fake = replyBoxBrowser(Infinity);
  globalThis.browser = fake.browser;
  await assert.rejects(openOwnerReply(true), /The sent Reply box did not empty/);
  assert.equal(fake.calls.every(call => call === 'box sent box'), true);
  // A waiting item with an answer in flight takes its next words through "Add a reply" (the sealed cards take none); there is
  // no "Write another input" step any more (SPEC 5.2/5.3: the sent answer keeps its cards sealed).
  const clicks = [];
  const exists = value => ({ async isExisting() { return value; } });
  globalThis.browser = {
    $(selector) {
      if (selector === '.item-detail [data-owner-input] .detail-box textarea' || selector === '.item-detail [data-owner-input] .detail-box') return exists(false);
      if (selector === '.item-detail[data-status="waiting"] [aria-label="Reply"] [aria-label="Item actions"] button') return exists(true);
      if (selector === '.item-detail') return { async getAttribute(name) { return name === 'data-status' ? 'waiting' : 'item-detail'; } };
      if (selector === '.item-detail [aria-label="Reply"] [aria-label="Item actions"] button') {
        return { async waitForDisplayed() {}, async waitForEnabled() {}, async scrollIntoView() {}, async getText() { return 'Add a reply r'; }, async click() { clicks.push('Add a reply'); } };
      }
      return assert.fail(`Successive answer cannot choose another form: ${selector}`);
    },
    async waitUntil(condition, options) { assert.ok(await condition(), options.timeoutMsg); },
  };
  await openOwnerReply(true);
  assert.deepEqual(clicks, ['Add a reply']);
});

test('a missing Reply box after a send is a clear failure, not a saved reply, and never presses Reply', async t => {
  const previousBrowser = globalThis.browser;
  t.after(() => { globalThis.browser = previousBrowser; });
  const exists = value => ({ async isExisting() { return value; } });
  globalThis.browser = {
    $(selector) {
      if (selector === '.item-detail .detail-answer-slot[data-owner-input]' || selector.includes('[aria-label="Reply"]')) return exists(false);
      if (selector === '.item-detail [data-owner-input] .detail-box textarea') return exists(false);
      return assert.fail(`A closed item has no Reply to press: ${selector}`);
    },
    async waitUntil(condition, options) {
      for (let attempt = 0; attempt < 3; attempt++) if (await condition()) return true;
      throw new Error(options.timeoutMsg);
    },
  };
  await assert.rejects(openOwnerReply(true), /The sent Reply box is missing/);
  // Without a send to wait for, no box and no Reply button says so instead of timing out on a click.
  globalThis.browser = {
    $(selector) {
      if (selector === '.item-detail .detail-answer-slot[data-owner-input]' || selector === '.item-detail [data-owner-input] .detail-box textarea'
        || selector.includes('[aria-label="Item actions"]')) return exists(false);
      return assert.fail(`Unexpected lookup: ${selector}`);
    },
  };
  await assert.rejects(openOwnerReply(false), /shows no Reply box and offers no Reply button/);
});

test('original publication deliberately omits its result; repair references the retained reply without another mutation', () => {
  const state = fixture();
  const originalRequest = originalReplyRequest(state.configuration, state.admission, state.session, state.reply.body);
  assert.equal(originalRequest.input_result, null); assert.equal(originalRequest.operations.length, 1);
  assert.equal(originalRequest.operations[0].text, state.reply.body);
  const request = repairResultRequest(state.configuration, state.admission, state.session, state.original, state.reply);
  assert.deepEqual(request.operations, []); assert.deepEqual(request.expected_item_revisions, {});
  assert.equal(request.source_input_id, state.input.id); assert.equal(request.attempt_id, state.admission.attemptId);
  assert.deepEqual(request.input_result.reply_refs, [{ id: state.reply.id }]);
  assert.equal(request.input_result.handled_through_message_number, 7);
  assert.deepEqual(request.input_result.followup_item_refs, []);
});

test('reply-only and result-only recovery requests deserialize through real CLI/Core without touching disconnected history', { timeout: 15000 }, async () => {
  const cli = process.env.ARIADNE_FIXTURE_TEST_CLI;
  assert.ok(cli, 'Run with the existing built CLI in ARIADNE_FIXTURE_TEST_CLI');
  const root = await mkdtemp(join(tmpdir(), 'ariadne-recovery-wire-'));
  try {
    const project = join(root, 'project'), home = join(root, 'data');
    await mkdir(project); await mkdir(home, { mode: 0o700 });
    const env = { ...process.env, ARIADNE_HOME: home };
    const demo = await cliRequest(cli, ['demo', '--root', project, '--json'], undefined, env);
    assert.equal(demo.code, 0);
    const path = join(home, 'projects', demo.value.data.project_id, 'sessions',`${demo.value.data.session_id}.json`), before = await readFile(path);
    const session = JSON.parse(before), binding = session.bindings[session.active_binding_id];
    const retained = Object.values(session.inputs).find(input => input.binding_id === binding.id && input.attempts.length > 0);
    assert.ok(retained);
    const state = fixture();
    const requests = [originalReplyRequest(state.configuration, state.admission, state.session, state.reply.body),
      repairResultRequest(state.configuration, state.admission, state.session, state.original, state.reply)];
    for (const request of requests) {
      // Use an existing scope so native context resolution reaches the actual
      // disconnected route guard. This is wire evidence, not a fabricated repair.
      request.source_input_id = retained.id; request.attempt_id = retained.attempts[0].id;
      const result = await cliRequest(cli, ['apply', '--binding', binding.id, '--generation', binding.generation, '--json-stdin', '--json'], request, env);
      assert.equal(result.code, 3, result.output); assert.equal(result.value.error.code, 'binding_mismatch');
      assert.equal(result.value.error.message, 'This binding is not the selected connected route');
      assert.deepEqual(await readFile(path), before, 'Wire acceptance cannot fabricate native recovery or rewrite canonical storage');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Resolve the helper's selectors against DOM, rather than returning whichever control a mock expects.
function domBrowser(document, onPoll = () => {}) {
  const control = (selector, parent = document) => {
    const node = () => selector.startsWith('button=')
      ? [...parent.querySelectorAll('button')].find(button => button.textContent === selector.slice(7))
      : parent.querySelector(selector);
    const required = () => { assert.ok(node(), `Missing control: ${selector}`); return node(); };
    return {
      $: child => control(child, required()),
      isExisting: async () => Boolean(node()),
      waitForExist: async () => { required(); },
      waitForDisplayed: async () => { required(); },
      waitForEnabled: async () => { assert.equal(required().disabled, false); },
      scrollIntoView: async () => { required(); },
      getValue: async () => required().value,
      setValue: async text => { required().value = text; },
      getText: async () => required().textContent,
      isEnabled: async () => !required().disabled,
      getAttribute: async name => required().getAttribute(name),
      click: async () => { required().click(); },
    };
  };
  return { $: control, waitUntil: async (condition, options) => {
    for (let poll = 0; poll < 3; poll++) { onPoll(); if (await condition()) return; }
    throw new Error(options.timeoutMsg);
  } };
}

const wordsBox = label => `<div class="detail-box"><textarea></textarea><div class="detail-box-row">
  <button aria-label="${label}">${label}</button><button>Cancel</button></div></div>`;
// The answer cards (SPEC 5.2): option and own-words cards, one textarea once own words are chosen, one Send in the bar.
const answerBox = `<div class="detail-answer-slot" data-owner-input="1"><div class="answer answer-details" role="group" aria-label="Answer">
  <div class="answer-options"><button class="answer-option">Chosen option</button><button class="answer-option" data-answer-own aria-pressed="true">Write my own answer</button></div>
  <textarea class="answer-text"></textarea><div class="answer-bar"><button data-answer-send class="answer-send">Send</button></div></div></div>`;

for (const [status, label] of [['waiting', 'Send'], ['open', 'Send reply'], ['progress', 'Send note'], ['done', 'Send follow-up']]) {
  test(`sends exact own words with one click from the ${status} composer and diagnoses its actual Send`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'ariadne-owner-composer-'));
    const dom = new JSDOM(`<article class="item-detail" data-detail-item-id="1" data-item-revision="4" data-status="${status}">${status === 'waiting' ? answerBox
      : `<div data-owner-input="1">${wordsBox(label)}${wordsBox(label + ', another draft')}</div>
        <div class="detail-answer-slot"><button>Write another input</button></div>`}</article>`);
    const previousBrowser = globalThis.browser, previousDocument = globalThis.document;
    t.after(async () => { globalThis.browser = previousBrowser; globalThis.document = previousDocument; dom.window.close(); await rm(root, { recursive: true, force: true }); });
    const document = dom.window.document;
    globalThis.document = document; globalThis.browser = domBrowser(document);
    const configuration = { itemId: '1', sessionPath: join(root, 'session.json') }, text = 'Exact own words\nKeep this full second line.';
    const session = { items: { 1: { revision: 4, question_revision: 2, status, ask: null } }, messages: [], inputs: {} };
    const expected = ownerReplyTarget(session, '1');
    await writeFile(configuration.sessionPath, JSON.stringify(session));
    let clicks = 0;
    // Wrong clicks fail: neither the recommended choice, another draft nor a retained answer may be submitted.
    const send = document.querySelector(status === 'waiting' ? '[data-answer-send]' : '.detail-box button');
    for (const button of document.querySelectorAll('button')) button.addEventListener('click', () => {
      assert.equal(button, send); clicks++;
      assert.equal(document.querySelector('[data-owner-input] textarea').value, text);
    });
    send.addEventListener('click', () => {
      // The snapshot update is awaited by the helper's persistence polling.
      pending = writeFile(configuration.sessionPath, JSON.stringify({ ...session, inputs: { saved: { payload: { text } } } }));
    });
    let pending = Promise.resolve();
    globalThis.browser.waitUntil = async (condition, options) => { await pending; assert.ok(await condition(), options.timeoutMsg); };
    await openOwnerReply();
    await sendDetailReply(configuration, text, expected);
    assert.equal(clicks, 1);
    assert.deepEqual(replyControlState('1'), { formPresent: true, editorPresent: true, value: text,
      editorEnabled: true, sendPresent: true, sendEnabled: true, alerts: [] });
    send.setAttribute('aria-disabled', 'true');
    assert.equal(replyControlState('1').sendEnabled, false);
    send.removeAttribute('aria-disabled'); send.disabled = true;
    assert.equal(replyControlState('1').sendEnabled, false);
  });
}

test('opens the current closed-item Follow up action, scoped to its detail', async t => {
  const dom = new JSDOM(`<button title="Comment, or ask for more">Unrelated</button><article class="item-detail" data-status="done">
    <div aria-label="Item actions"><button title="Comment, or ask for more">Follow up<span>r</span></button></div></article>`);
  const previous = globalThis.browser;
  t.after(() => { globalThis.browser = previous; dom.window.close(); });
  const document = dom.window.document, detail = document.querySelector('.item-detail');
  document.querySelector('.item-detail button').addEventListener('click', () => detail.insertAdjacentHTML('beforeend', `<div data-owner-input="1">${wordsBox('Send follow-up')}</div>`));
  globalThis.browser = domBrowser(document);
  await openOwnerReply();
  assert.ok(detail.querySelector('textarea'));
});

test('a successive progress note waits for its docked box to empty instead of waiting for it to disappear', async t => {
  const dom = new JSDOM(`<article class="item-detail" data-status="progress"><div data-owner-input="1">${wordsBox('Send note')}</div>
    <div class="detail-answer-slot"><button>Write another input</button></div></article>`);
  const previous = globalThis.browser;
  t.after(() => { globalThis.browser = previous; dom.window.close(); });
  const editor = dom.window.document.querySelector('textarea'); editor.value = 'Previously saved note';
  let polls = 0;
  globalThis.browser = domBrowser(dom.window.document, () => { if (++polls === 2) editor.value = ''; });
  await openFollowUp(true);
  assert.equal(polls, 2); assert.equal(editor.value, '');
  assert.ok(editor.isConnected);
});

test('a successive waiting reply waits for its saved box to close, then reopens Add a reply', async t => {
  const dom = new JSDOM(`<article class="item-detail" data-status="waiting"><section aria-label="Reply"><div aria-label="Item actions">
    <button>Add a reply<span>r</span></button></div></section><div data-owner-input="1">${wordsBox('Send reply')}</div></article>`);
  const previous = globalThis.browser;
  t.after(() => { globalThis.browser = previous; dom.window.close(); });
  const document = dom.window.document, detail = document.querySelector('.item-detail'), old = detail.querySelector('[data-owner-input]');
  let polls = 0, clicks = 0;
  detail.querySelector('section button').addEventListener('click', () => {
    assert.equal(old.isConnected, false); clicks++;
    detail.insertAdjacentHTML('beforeend', `<div data-owner-input="1">${wordsBox('Send reply')}</div>`);
  });
  globalThis.browser = domBrowser(document, () => { if (++polls === 2) old.remove(); });
  await openOwnerReply(true);
  assert.equal(polls, 2); assert.equal(clicks, 1);
  assert.equal(detail.querySelector('[data-owner-input] textarea').value, '');
});

async function targetFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ariadne-reply-target-'));
  const dom = new JSDOM(`<article class="item-detail" data-detail-item-id="1" data-item-revision="3">
    <div data-owner-input="1">${wordsBox('Send reply')}</div></article>`);
  const previousBrowser = globalThis.browser, previousDocument = globalThis.document;
  const previousHome = process.env.ARIADNE_HOME, previousEvidence = process.env.ARIADNE_E2E_EVIDENCE;
  t.after(async () => {
    globalThis.browser = previousBrowser; globalThis.document = previousDocument;
    for (const [name, value] of [['ARIADNE_HOME', previousHome], ['ARIADNE_E2E_EVIDENCE', previousEvidence]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    dom.window.close(); await rm(root, { recursive: true, force: true });
  });
  const configuration = { sessionId: 'session', itemId: '1', sessionPath: join(root, 'session.json') };
  const message = { id: 'expected-agent-reply', item_id: '1', author: 'agent', body: 'The complete expected agent change.' };
  const session = { id: 'session', revision: 8, items: { 1: { revision: 4, question_revision: 2, status: 'open', ask: null } },
    messages: [message], inputs: {} };
  const expected = ownerReplyTarget(session, '1');
  const document = dom.window.document, detail = document.querySelector('.item-detail'), editor = document.querySelector('textarea');
  globalThis.document = document; globalThis.browser = domBrowser(document);
  process.env.ARIADNE_HOME = root; process.env.ARIADNE_E2E_EVIDENCE = root;
  await writeFile(join(root, 'ui.json'), JSON.stringify({ snapshot: { revision: 1, drafts: [] } }));
  const save = value => writeFile(configuration.sessionPath, JSON.stringify(value));
  await save(session);
  return { root, configuration, session, expected, document, detail, editor, save };
}

test('reply typing waits for the canonical revision, expected agent publication and renderer independently before one Send', async t => {
  const value = await targetFixture(t), { configuration, session, expected, detail, editor, document, save } = value;
  await save({ ...session, items: { 1: { ...session.items[1], revision: 3 } }, messages: [] });
  let targetPolls = 0, clicks = 0, writes = 0, pending = Promise.resolve();
  const controls = domBrowser(document);
  const get = controls.$;
  controls.$ = selector => {
    const control = get(selector);
    if (selector !== '.item-detail [data-owner-input="1"]') return control;
    const composer = control.$;
    control.$ = selector => {
      const box = composer(selector), child = box.$;
      box.$ = selector => {
        const field = child(selector);
        if (selector === 'textarea') field.setValue = async text => {
          assert.equal(targetPolls, 4, 'Writing must await all three prerequisites'); writes++; editor.value = text;
        };
        return field;
      };
      return box;
    };
    return control;
  };
  controls.waitUntil = async (condition, options) => {
    if (options.timeoutMsg.startsWith('Owner reply target')) {
      for (targetPolls = 1; targetPolls <= 4; targetPolls++) {
        if (targetPolls === 2) await save({ ...session, messages: [] });
        if (targetPolls === 3) await save(session);
        if (targetPolls === 4) detail.setAttribute('data-item-revision', '4');
        const ready = await condition();
        if (targetPolls < 4) assert.equal(ready, false);
        else { assert.equal(ready, true); return; }
      }
    }
    await pending; assert.equal(await condition(), true, options.timeoutMsg);
  };
  const text = 'Exact owner reply\nKeep the second line.';
  document.querySelector('button').addEventListener('click', () => {
    clicks++; pending = save({ ...session, inputs: { saved: { payload: { text } } } });
  });
  globalThis.browser = controls;
  await sendDetailReply(configuration, text, expected);
  assert.equal(writes, 1); assert.equal(clicks, 1);
});

for (const mismatch of ['newer revision', 'question revision', 'status', 'ask', 'missing agent message', 'agent body', 'agent identity', 'rendered revision', 'selected item']) {
  test(`reply target refuses ${mismatch} without typing or silently accepting a different target`, async t => {
    const { configuration, session, expected, detail, editor, save } = await targetFixture(t);
    detail.setAttribute('data-item-revision', '4');
    if (mismatch === 'newer revision') session.items[1].revision = 5;
    if (mismatch === 'question revision') session.items[1].question_revision = 3;
    if (mismatch === 'status') session.items[1].status = 'done';
    if (mismatch === 'ask') session.items[1].ask = 'A different ask';
    if (mismatch === 'missing agent message') session.messages = [];
    if (mismatch === 'agent body') session.messages[0].body = 'A different agent change';
    if (mismatch === 'agent identity') session.messages[0].author = 'owner';
    if (mismatch === 'rendered revision') detail.setAttribute('data-item-revision', '3');
    if (mismatch === 'selected item') detail.setAttribute('data-detail-item-id', '2');
    await save(session);
    await assert.rejects(waitForOwnerReplyTarget(configuration, expected), /revision 4 and expected agent change did not reach disk and detail/);
    assert.equal(editor.value, '');
    assert.equal(expected.revision, 4); assert.equal(expected.agentMessage.body, 'The complete expected agent change.');
  });
}

test('an unexpected change after typing preserves the stale guard, never clicks Send and retains target evidence', async t => {
  const { root, configuration, session, expected, detail, editor, document, save } = await targetFixture(t);
  detail.setAttribute('data-item-revision', '4');
  const send = document.querySelector('button'); let clicks = 0;
  send.addEventListener('click', () => { clicks++; });
  globalThis.browser.execute = async (callback, ...args) => callback(...args);
  const originalWait = globalThis.browser.waitUntil;
  globalThis.browser.waitUntil = async (condition, options) => {
    if (options.timeoutMsg.startsWith('Detail Reply text')) {
      session.items[1].revision = 5; await save(session);
      detail.setAttribute('data-item-revision', '5'); send.setAttribute('aria-disabled', 'true');
    }
    return originalWait(condition, options);
  };
  const text = 'Preserve these unsent words';
  await assert.rejects(sendDetailReply(configuration, text, expected), /Detail Reply text and enabled Send were not ready/);
  assert.equal(editor.value, text); assert.equal(clicks, 0);
  assert.equal(send.getAttribute('aria-disabled'), 'true');
  const evidence = JSON.parse(await readFile(join(root, 'reply-failure.json'), 'utf8'));
  assert.equal(evidence.stage, 'readiness'); assert.equal(evidence.clickRequested, false);
  assert.deepEqual(evidence.expectedTarget, expected); assert.equal(evidence.canonical.itemRevision, 5);
});

test('reply target requires an explicit frozen revision and never derives one while typing', async t => {
  const { configuration, editor } = await targetFixture(t);
  for (const expected of [undefined, { itemId: '2', revision: 4 }, { itemId: '1', revision: '4' }]) {
    await assert.rejects(waitForOwnerReplyTarget(configuration, expected), /requires an explicit canonical target/);
  }
  assert.equal(editor.value, '');
});

test('reply target pins the saved preceding owner message as well as the last agent change', async t => {
  const { configuration, session, detail, editor, save } = await targetFixture(t);
  detail.setAttribute('data-item-revision', '4');
  session.messages.push({ id: 'prior-owner-reply', item_id: '1', author: 'owner', body: 'The preceding saved owner input.' });
  const expected = ownerReplyTarget(session, '1');
  assert.equal(expected.previousMessage.id, 'prior-owner-reply');
  assert.equal(expected.agentMessage.id, 'expected-agent-reply');
  session.messages[1].body = 'A different owner input'; await save(session);
  await assert.rejects(waitForOwnerReplyTarget(configuration, expected), /expected agent change did not reach disk and detail/);
  assert.equal(editor.value, '');
});
