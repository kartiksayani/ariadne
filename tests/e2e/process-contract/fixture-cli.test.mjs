import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cliRequest, journeyResultRequest, journeySeedRequest } from '../../../apps/desktop/tests/e2e/scripted-provider.mjs';
import { sendDetailReply } from '../../../apps/desktop/tests/e2e/owner-reply.mjs';

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
    const path = join(project, '.ariadne/sessions', `${demo.value.data.session_id}.json`), before = await readFile(path);
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

for (const scenario of ['delayed-readiness', 'wrong-text', 'disabled-send', 'save-failure']) {
  test(`detail Reply admits one click only for exact enabled text and retains failure evidence: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'ariadne-reply-admission-'));
    const prior = { browser: globalThis.browser, home: process.env.ARIADNE_HOME, evidence: process.env.ARIADNE_E2E_EVIDENCE };
    const text = 'Exact fixture owner Reply\nSecond retained line.';
    const configuration = { sessionId: 'fixture-session', itemId: '1', sessionPath: join(root, 'session.json') };
    const saved = { id: configuration.sessionId, revision: 7, items: { 1: { revision: 3 } }, inputs: {} };
    const calls = []; let value = '', enabled = false, clicks = 0;
    try {
      process.env.ARIADNE_HOME = root; process.env.ARIADNE_E2E_EVIDENCE = root;
      await writeFile(configuration.sessionPath, JSON.stringify(saved));
      await writeFile(join(root, 'ui.json'), JSON.stringify({ snapshot: { revision: 8, drafts: [] } }));
      const editor = { waitForDisplayed: async () => calls.push('editor displayed'), waitForEnabled: async () => calls.push('editor enabled'),
        setValue: async input => { assert.equal(input, text); calls.push('type'); }, getValue: async () => value, isEnabled: async () => true };
      const send = { waitForDisplayed: async () => calls.push('send displayed'), isEnabled: async () => enabled, click: async () => {
        assert.equal(value, text); assert.equal(enabled, true); clicks++; calls.push('click');
        if (scenario !== 'save-failure') {
          saved.inputs.first = { id: 'fixture-input', seq: 1, kind: 'reply', state: 'queued', payload: { text } };
          await writeFile(configuration.sessionPath, JSON.stringify(saved));
        }
      } };
      globalThis.browser = {
        $: async selector => selector.endsWith(' textarea') ? editor : { $: async selector => { assert.equal(selector, 'button=Send reply'); return send; } },
        waitUntil: async (condition, options) => {
          assert.equal(options.timeout, 20000); assert.equal(options.interval, 100);
          if (options.timeoutMsg.startsWith('Detail Reply')) {
            assert.equal(await condition(), false); assert.equal(clicks, 0);
            value = text; assert.equal(await condition(), false); assert.equal(clicks, 0);
            enabled = true;
            if (scenario === 'wrong-text') value = 'Incomplete fixture Reply';
            if (scenario === 'disabled-send') enabled = false;
          }
          if (!await condition()) throw new Error(options.timeoutMsg);
        },
        execute: async (_callback, itemId) => {
          assert.equal(itemId, configuration.itemId);
          return { value, sendEnabled: enabled, alerts: scenario === 'save-failure' ? ['Fixture save failed'] : [] };
        },
      };
      if (scenario === 'delayed-readiness') {
        await sendDetailReply(configuration, text); assert.equal(clicks, 1);
        assert.deepEqual(calls, ['editor displayed', 'editor enabled', 'type', 'send displayed', 'click']);
        await assert.rejects(readFile(join(root, 'reply-failure.json')), { code: 'ENOENT' });
      } else {
        await assert.rejects(sendDetailReply(configuration, text), /Detail Reply text|Visible detail Reply/);
        assert.equal(clicks, scenario === 'save-failure' ? 1 : 0);
        const proof = JSON.parse(await readFile(join(root, 'reply-failure.json'), 'utf8'));
        assert.equal(proof.stage, scenario === 'save-failure' ? 'persistence' : 'readiness');
        assert.equal(proof.clickRequested, scenario === 'save-failure'); assert.equal(proof.expectedText, text);
        assert.equal(proof.local.value, value); assert.equal(proof.local.sendEnabled, enabled);
        assert.equal(proof.canonical.revision, 7); assert.deepEqual(proof.canonical.inputs, []);
        assert.equal(proof.preferences.revision, 8);
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
