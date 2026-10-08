import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openOwnerReply } from '../../../apps/desktop/tests/e2e/owner-reply.mjs';
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

// The non-waiting detail: its Reply box closes once the previous reply saved.
function replyBoxBrowser(closesAfter) {
  const calls = []; let polls = 0, rendered = 'sent box';
  const reply = {
    async waitForDisplayed() { assert.equal(rendered, 'closed box'); calls.push('Reply displayed'); },
    async waitForEnabled() { assert.equal(rendered, 'closed box'); },
    async scrollIntoView() {},
    async click() { assert.equal(rendered, 'closed box'); calls.push('choose Reply'); rendered = 'new box'; },
  };
  const exists = value => ({ async isExisting() { return value(); } });
  const browser = {
    $(selector) {
      if (selector === '.item-detail .detail-answer-slot') return exists(() => false);
      if (selector === '.item-detail .detail-box') return exists(() => {
        if (++polls > closesAfter) rendered = 'closed box';
        calls.push(`box ${rendered}`); return rendered !== 'closed box';
      });
      if (selector === '.item-detail .detail-box textarea') return exists(() => rendered !== 'closed box');
      assert.equal(selector, '[aria-label="Item actions"]');
      assert.equal(rendered, 'closed box', 'The sent Reply box cannot be reused before Saved closes it');
      return { $(selector) { assert.equal(selector, 'button*=Reply'); return reply; } };
    },
    async waitUntil(condition, options) {
      for (let attempt = 0; attempt < 3; attempt++) if (await condition()) return true;
      throw new Error(options.timeoutMsg);
    },
  };
  return { browser, calls };
}

test('a known successive Reply waits for the sent Reply box to close before choosing another form', async t => {
  const previousBrowser = globalThis.browser;
  t.after(() => { globalThis.browser = previousBrowser; });
  const fake = replyBoxBrowser(1);
  globalThis.browser = fake.browser;
  await openOwnerReply(true);
  assert.deepEqual(fake.calls, ['box sent box', 'box closed box', 'Reply displayed', 'choose Reply']);
});

test('a missing Saved acknowledgement fails before a known successive Reply can choose any form', async t => {
  const previousBrowser = globalThis.browser;
  t.after(() => { globalThis.browser = previousBrowser; });
  const fake = replyBoxBrowser(Infinity);
  globalThis.browser = fake.browser;
  await assert.rejects(openOwnerReply(true), /The sent Reply box did not close/);
  assert.equal(fake.calls.includes('choose Reply'), false);
  // A waiting item's answer slot must show its Saved receipt's "Write another input" first.
  globalThis.browser = {
    $(selector) {
      if (selector === '.item-detail .detail-answer-slot') return { async isExisting() { return true; }, $(selector) {
        assert.equal(selector, 'button=Write another input');
        return { async waitForDisplayed() { throw new Error('Saved acknowledgement absent'); } };
      } };
      assert.fail(`Successive answer cannot choose another form: ${selector}`);
    },
  };
  await assert.rejects(openOwnerReply(true), /Saved acknowledgement absent/);
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
