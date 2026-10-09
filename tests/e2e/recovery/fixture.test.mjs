import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { openFollowUp, openOwnerReply, replyControlState, sendDetailReply } from '../../../apps/desktop/tests/e2e/owner-reply.mjs';
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

test('a missing Saved acknowledgement fails while the sent Reply box still holds its words', async t => {
  const previousBrowser = globalThis.browser;
  t.after(() => { globalThis.browser = previousBrowser; });
  const fake = replyBoxBrowser(Infinity);
  globalThis.browser = fake.browser;
  await assert.rejects(openOwnerReply(true), /The sent Reply box did not empty/);
  assert.equal(fake.calls.every(call => call === 'box sent box'), true);
  // A waiting item's answer slot must show its Saved receipt's "Write another input" first.
  globalThis.browser = {
    $(selector) {
      if (selector === '.item-detail [data-owner-input] .detail-box textarea') return { async isExisting() { return false; } };
      if (selector === '.item-detail .detail-answer-slot[data-owner-input]') return { async isExisting() { return true; }, $(selector) {
        assert.equal(selector, 'button=Write another input');
        return { async waitForDisplayed() { throw new Error('Saved acknowledgement absent'); } };
      } };
      assert.fail(`Successive answer cannot choose another form: ${selector}`);
    },
  };
  await assert.rejects(openOwnerReply(true), /Saved acknowledgement absent/);
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
const answerBox = `<div class="detail-answer-slot" data-owner-input="1"><button class="answer-send">Send “Chosen option”</button>
  <div class="answer-reply answer-composer"><textarea></textarea><button class="answer-reply-send">Send as a reply only</button></div></div>`;

for (const [status, label] of [['waiting', 'Send as a reply only'], ['open', 'Send reply'], ['progress', 'Send note'], ['done', 'Send follow-up']]) {
  test(`sends exact own words with one click from the ${status} composer and diagnoses its actual Send`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'ariadne-owner-composer-'));
    const dom = new JSDOM(`<article class="item-detail" data-status="${status}">${status === 'waiting' ? answerBox
      : `<div data-owner-input="1">${wordsBox(label)}${wordsBox(label + ', another draft')}</div>
        <div class="detail-answer-slot"><button>Write another input</button></div>`}</article>`);
    const previousBrowser = globalThis.browser, previousDocument = globalThis.document;
    t.after(async () => { globalThis.browser = previousBrowser; globalThis.document = previousDocument; dom.window.close(); await rm(root, { recursive: true, force: true }); });
    const document = dom.window.document;
    globalThis.document = document; globalThis.browser = domBrowser(document);
    const configuration = { itemId: '1', sessionPath: join(root, 'session.json') }, text = 'Exact own words\nKeep this full second line.';
    await writeFile(configuration.sessionPath, JSON.stringify({ inputs: {} }));
    let clicks = 0;
    // Wrong clicks fail: neither the recommended choice, another draft nor a retained answer may be submitted.
    const send = document.querySelector(status === 'waiting' ? '.answer-reply-send' : '.detail-box button');
    for (const button of document.querySelectorAll('button')) button.addEventListener('click', () => {
      assert.equal(button, send); clicks++;
      assert.equal(document.querySelector('[data-owner-input] textarea').value, text);
    });
    send.addEventListener('click', () => {
      // The snapshot update is awaited by the helper's persistence polling.
      pending = writeFile(configuration.sessionPath, JSON.stringify({ inputs: { saved: { payload: { text } } } }));
    });
    let pending = Promise.resolve();
    globalThis.browser.waitUntil = async (condition, options) => { await pending; assert.ok(await condition(), options.timeoutMsg); };
    await openOwnerReply();
    await sendDetailReply(configuration, text);
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
