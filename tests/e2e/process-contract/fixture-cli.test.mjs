import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cliRequest, journeyResultRequest, journeySeedRequest } from '../../../apps/desktop/tests/e2e/scripted-provider.mjs';
import { ownerReplyTarget, sendDetailReply } from '../../../apps/desktop/tests/e2e/owner-reply.mjs';

async function fixture(t, response, { code = 0, diagnostic = '' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ariadne-scripted-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, 'cli.mjs'), journal = join(root, 'call.json');
  await writeFile(cli, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
let input = '';
for await (const bytes of process.stdin) input += bytes;
writeFileSync(${JSON.stringify(journal)}, JSON.stringify({ args: process.argv.slice(2), input, marker: process.env.ARIADNE_HELPER_MARKER }));
console.log(${JSON.stringify(JSON.stringify(response))});
process.stderr.write(${JSON.stringify(diagnostic)});
process.exitCode = ${code};
`);
  await chmod(cli, 0o700);
  return { cli, call: async () => JSON.parse(await readFile(journal, 'utf8')) };
}

test('scripted full apply requests JSON and retains warnings with its prior raw receipt', async t => {
  const receipt = { session_id: 'session', warnings: ['Bare item number 1. Use an item link.'], repairs: ['Keep new items open for Ack.'] };
  const response = { api_version: 1, ok: true, data: receipt };
  const { cli, call } = await fixture(t, response);
  const args = Object.freeze(['apply', '--binding', 'binding', '--generation', 'generation', '--json-stdin', '--full']);
  const request = { op_id: 'operation', operations: [] };
  const result = await cliRequest(cli, args, request, { ...process.env, ARIADNE_HELPER_MARKER: 'retained' });
  assert.equal(result.code, 0);
  assert.deepEqual(result.value, receipt);
  assert.deepEqual(result.response, response);
  assert.deepEqual(JSON.parse(result.output), response);
  assert.deepEqual(await call(), { args: [...args, '--json'], input: JSON.stringify(request), marker: 'retained' });
});

test('scripted unflagged read preserves the raw page and uses JSON with empty stdin', async t => {
  const page = { items: [{ id: '1' }], next_cursor: null, notices: ['One removed item not shown'] };
  const response = { api_version: 1, ok: true, data: page };
  const { cli, call } = await fixture(t, response);
  const args = ['read', '--binding', 'binding', '--generation', 'generation', '--view', 'items'];
  const result = await cliRequest(cli, args);
  assert.deepEqual(result.value, page);
  assert.deepEqual(result.response, response);
  assert.deepEqual((await call()).args, [...args, '--json']);
  assert.equal((await call()).input, '');
});

test('explicit JSON apply keeps its envelope without adding a second flag or unwrapping twice', async t => {
  const response = { api_version: 1, ok: true, data: { session_id: 'session', warnings: ['Retained advice'] } };
  const { cli, call } = await fixture(t, response);
  const args = ['apply', '--json-stdin', '--full', '--json'];
  const result = await cliRequest(cli, args, { operations: [] });
  assert.deepEqual(result.value, response);
  assert.deepEqual(result.response, response);
  assert.deepEqual((await call()).args, args);
});

for (const args of [['project', 'register', '--json-stdin'], ['binding', 'connect', '--json-stdin'], ['preferences', 'get', '--json-stdin'], ['demo', '--root', '/fixture/project', '--json']]) {
  test(`scripted ${args.slice(0, 2).join(' ')} keeps its existing canonical envelope`, async t => {
    const response = { api_version: 1, ok: true, data: { data: { project_id: 'project' } } };
    const { cli, call } = await fixture(t, response);
    const result = await cliRequest(cli, args, { session: null });
    assert.deepEqual(result.value, response);
    assert.deepEqual(result.response, response);
    assert.deepEqual((await call()).args, args.includes('--json') ? args : [...args, '--json']);
  });
}

for (const json of [false, true]) {
  test(`scripted apply preserves a nonzero exit and error envelope with ${json ? 'explicit' : 'implicit'} JSON`, async t => {
    const response = { api_version: 1, ok: false, error: { code: 'binding_mismatch', message: 'This binding is not the selected connected route' } };
    const { cli } = await fixture(t, response, { code: 3 });
    const result = await cliRequest(cli, ['apply', '--json-stdin', ...(json ? ['--json'] : [])], { operations: [] });
    assert.equal(result.code, 3);
    assert.deepEqual(result.value, response);
    assert.deepEqual(result.response, response);
  });
}

for (const code of [0, 4]) {
  test(`scripted CLI rejects genuine stderr diagnostics even with a JSON response and exit ${code}`, async t => {
    const { cli } = await fixture(t, { api_version: 1, ok: code === 0, data: {} }, { code, diagnostic: 'Unexpected fixture diagnostic\n' });
    await assert.rejects(cliRequest(cli, ['apply', '--json-stdin'], { operations: [] }), /Scripted journey CLI diagnostic: Unexpected fixture diagnostic/);
  });
}

test('native journey seed and result requests reach the real CLI/Core dispatch barrier', { timeout: 15000 }, async () => {
  const cli = process.env.ARIADNE_FIXTURE_TEST_CLI;
  assert.ok(cli, 'Run with the existing built CLI in ARIADNE_FIXTURE_TEST_CLI');
  const root = await mkdtemp(join(tmpdir(), 'ariadne-journey-wire-'));
  try {
    const project = join(root, 'project'), home = join(root, 'data');
    await mkdir(project); await mkdir(home, { mode: 0o700 });
    const env = { ...process.env, ARIADNE_HOME: home };
    const demo = await cliRequest(cli, ['demo', '--root', project, '--json'], undefined, env);
    assert.equal(demo.code, 0);
    const path = join(home, 'projects', demo.value.data.project_id, 'sessions',`${demo.value.data.session_id}.json`), before = await readFile(path);
    const session = JSON.parse(before), binding = session.bindings[session.active_binding_id];
    const input = Object.values(session.inputs).find(input => input.binding_id === binding.id && input.attempts.length > 0);
    assert.ok(input); const attempt = input.attempts[0];
    const configuration = { bindingId: binding.id, generation: binding.generation, itemId: input.target.item_id };
    const admission = { inputId: input.id, attemptId: attempt.id, bindingId: binding.id, generation: binding.generation,
      payload: attempt.formatted_payload, ordinal: 1 };
    const requests = [journeySeedRequest(binding.id).request, journeyResultRequest(configuration, admission, session, 'Exact native reply\nKeep this second line.')];
    for (const request of requests) {
      const result = await cliRequest(cli, ['apply', '--binding', binding.id, '--generation', binding.generation, '--json-stdin', '--json'], request, env);
      assert.equal(result.code, 3); assert.equal(result.value.error.code, 'binding_mismatch');
      assert.equal(result.value.error.message, 'This binding is not the selected connected route');
      assert.deepEqual(await readFile(path), before, 'Disconnected demo remains unchanged; this checks wire validation, not native publication');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const scenario of ['delayed-readiness', 'wrong-text', 'disabled-send', 'frozen-send', 'save-failure']) {
  test(`detail Reply admits one click only for exact enabled text and retains failure evidence: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'ariadne-reply-admission-'));
    const prior = { browser: globalThis.browser, home: process.env.ARIADNE_HOME, evidence: process.env.ARIADNE_E2E_EVIDENCE };
    const text = 'Exact fixture owner Reply\nSecond retained line.';
    const configuration = { sessionId: 'fixture-session', itemId: '1', sessionPath: join(root, 'session.json') };
    const saved = { id: configuration.sessionId, revision: 7, inputs: {}, messages: [],
      items: { 1: { revision: 3, question_revision: 2, status: 'waiting_on_me', ask: 'Which option?' } } };
    // The explicit canonical target the real journeys freeze before typing; the helper refuses to race without one.
    const expected = ownerReplyTarget(saved, configuration.itemId);
    const calls = []; let value = '', enabled = false, frozen = true, clicks = 0;
    try {
      process.env.ARIADNE_HOME = root; process.env.ARIADNE_E2E_EVIDENCE = root;
      await writeFile(configuration.sessionPath, JSON.stringify(saved));
      await writeFile(join(root, 'ui.json'), JSON.stringify({ snapshot: { revision: 8, drafts: [{ session: { session_id: configuration.sessionId },
        target: { item_id: configuration.itemId }, intent: 'answer', op_id: 'answer-draft', target_revision: 3, submission_attempted: true, text }] } }));
      const editor = { waitForDisplayed: async () => calls.push('editor displayed'), waitForEnabled: async () => calls.push('editor enabled'),
        setValue: async input => { assert.equal(input, text); calls.push('type'); }, getValue: async () => value, isEnabled: async () => true };
      const send = { waitForDisplayed: async () => calls.push('send displayed'), isEnabled: async () => enabled,
        getAttribute: async name => { assert.equal(name, 'aria-disabled'); return frozen ? 'true' : null; }, click: async () => {
        assert.equal(value, text); assert.equal(enabled, true); assert.equal(frozen, false); clicks++; calls.push('click');
        if (scenario !== 'save-failure') {
          saved.inputs.first = { id: 'fixture-input', seq: 1, kind: 'reply', state: 'queued', payload: { text } };
          await writeFile(configuration.sessionPath, JSON.stringify(saved));
        }
      } };
      globalThis.browser = {
        $: async selector => {
          // The target wait reads the rendered detail's item and revision before the editor is touched.
          if (selector === '.item-detail') return { getAttribute: async name => name === 'data-detail-item-id' ? configuration.itemId : String(saved.items[1].revision) };
          assert.equal(selector, '.item-detail [data-owner-input="1"]');
          return { waitForExist: async () => {}, $: async selector => {
            assert.equal(selector, '.detail-box, .answer');
            return { waitForExist: async () => {}, $: async selector => {
              if (selector === 'textarea') return editor;
              assert.equal(selector, 'button[aria-label^="Send "], button[data-answer-send]'); return send;
            } };
          } };
        },
        waitUntil: async (condition, options) => {
          assert.equal(options.timeout, 20000); assert.equal(options.interval, 100);
          if (options.timeoutMsg.startsWith('Detail Reply')) {
            assert.equal(await condition(), false); assert.equal(clicks, 0);
            value = text; assert.equal(await condition(), false); assert.equal(clicks, 0);
            enabled = true;
            assert.equal(await condition(), false, 'Native enabled cannot admit a refreshing aria-disabled Send'); assert.equal(clicks, 0);
            frozen = scenario === 'frozen-send';
            if (scenario === 'wrong-text') value = 'Incomplete fixture Reply';
            if (scenario === 'disabled-send') enabled = false;
          }
          if (!await condition()) throw new Error(options.timeoutMsg);
        },
        execute: async (_callback, itemId) => {
          assert.equal(itemId, configuration.itemId);
          return { value, sendEnabled: enabled && !frozen, alerts: scenario === 'save-failure' ? ['Fixture save failed'] : [] };
        },
      };
      if (scenario === 'delayed-readiness') {
        await sendDetailReply(configuration, text, expected); assert.equal(clicks, 1);
        assert.deepEqual(calls, ['editor displayed', 'editor enabled', 'type', 'send displayed', 'click']);
        await assert.rejects(readFile(join(root, 'reply-failure.json')), { code: 'ENOENT' });
      } else {
        await assert.rejects(sendDetailReply(configuration, text, expected), /Detail Reply text|Visible detail Reply/);
        assert.equal(clicks, scenario === 'save-failure' ? 1 : 0);
        const proof = JSON.parse(await readFile(join(root, 'reply-failure.json'), 'utf8'));
        assert.equal(proof.stage, scenario === 'save-failure' ? 'persistence' : 'readiness');
        assert.equal(proof.clickRequested, scenario === 'save-failure'); assert.equal(proof.expectedText, text);
        assert.equal(proof.local.value, value); assert.equal(proof.local.sendEnabled, enabled && !frozen);
        assert.equal(proof.canonical.revision, 7); assert.deepEqual(proof.canonical.inputs, []);
        assert.equal(proof.preferences.revision, 8);
        assert.deepEqual(proof.preferences.drafts, [{ opId: 'answer-draft', targetRevision: 3, submissionAttempted: true, textMatchesExpected: true }]);
      }
    } finally {
      if (prior.browser === undefined) delete globalThis.browser; else globalThis.browser = prior.browser;
      for (const [key, value] of [['ARIADNE_HOME', prior.home], ['ARIADNE_E2E_EVIDENCE', prior.evidence]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}
