import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cliRequest } from '../../../apps/desktop/tests/e2e/scripted-provider.mjs';
import { historyAsk, historyMessageBatch, historySeedRequest } from '../../../apps/desktop/tests/e2e/history.spec.mjs';

test('complete native history batches deserialize through the real CLI/Core dispatch barrier', { timeout: 15000 }, async () => {
  const cli = process.env.ARIADNE_FIXTURE_TEST_CLI;
  assert.ok(cli, 'Use the existing built CLI in ARIADNE_FIXTURE_TEST_CLI');
  const root = await mkdtemp(join(tmpdir(), 'ariadne-history-wire-'));
  try {
    const project = join(root, 'project'), home = join(root, 'data');
    await mkdir(project); await mkdir(home, { mode: 0o700 });
    const env = { ...process.env, ARIADNE_HOME: home };
    const demo = await cliRequest(cli, ['demo', '--root', project, '--json'], undefined, env);
    assert.equal(demo.code, 0);
    const path = join(project, '.ariadne/sessions', `${demo.value.data.session_id}.json`), before = await readFile(path);
    const session = JSON.parse(before), binding = session.bindings[session.active_binding_id];
    const roundId = Object.keys(session.rounds)[0], batches = [[1, 50], [51, 50], [101, 5]].map(([first, count]) => historyMessageBatch(roundId, first, count));
    const replies = batches.flat();
    assert.equal(replies.length, 105); assert.equal(new Set(replies.map(operation => operation.ref)).size, 105);
    assert.ok(replies.every(operation => operation.round_id === roundId && operation.text.split('\n').length === 3 && operation.text.length > 2000));
    const requests = [historySeedRequest(binding.id), ...Array.from({ length: 4 }, (_, index) => ({
      ...historySeedRequest(binding.id), operations: [historyAsk(binding.id, index + 2)],
    })), ...batches.map(operations => ({ ...historySeedRequest(binding.id), operations, expected_item_revisions: { '1': session.items['1'].revision } })),
    { ...historySeedRequest(binding.id), operations: [{ op: 'item.status', item: { id: '1' }, status: 'done',
      outcome: 'Full native completed outcome\nKeep its original body.', why: 'Full native completion reason', reason: null }, { op: 'round.close', round_id: roundId }] },
    { ...historySeedRequest(binding.id), operations: [{ op: 'item.status', item: { id: '1' }, status: 'open',
      outcome: null, why: null, reason: 'The owner explicitly requested native reopening.' }] }];
    for (const request of requests) {
      request.op_id = randomUUID();
      assert.ok(Buffer.byteLength(JSON.stringify(request)) < 512 * 1024);
      const result = await cliRequest(cli, ['apply', '--binding', binding.id, '--generation', binding.generation, '--json-stdin', '--json'], request, env);
      assert.equal(result.code, 3); assert.equal(result.value.error.code, 'binding_mismatch');
      assert.equal(result.value.error.message, 'This binding is not the selected connected route');
      assert.deepEqual(await readFile(path), before, 'Wire/dispatch evidence cannot claim publication or bypass the disconnected demo');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
