import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cliRequest, journeyResultRequest, journeySeedRequest } from '../../../apps/desktop/tests/e2e/scripted-provider.mjs';

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
