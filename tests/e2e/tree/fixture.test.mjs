import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cliRequest } from '../../../apps/desktop/tests/e2e/scripted-provider.mjs';
import { treeBatch } from '../../../apps/desktop/tests/e2e/tree.spec.mjs';

test('all 2,000 native tree fixture operations pass real CLI wire validation and reach the Core dispatch barrier', { timeout: 60000 }, async () => {
  const cli = process.env.ARIADNE_TREE_TEST_CLI;
  assert.ok(cli, 'Run with the existing built CLI in ARIADNE_TREE_TEST_CLI');
  const root = await mkdtemp(join(tmpdir(), 'ariadne-tree-fixture-'));
  try {
    const project = join(root, 'project'), home = join(root, 'data');
    await mkdir(project); await mkdir(home, { mode: 0o700 });
    const env = { ...process.env, ARIADNE_HOME: home };
    const demo = await cliRequest(cli, ['demo', '--root', project, '--json'], undefined, env);
    assert.equal(demo.code, 0);
    const sessionPath = join(project, '.ariadne/sessions', `${demo.value.data.session_id}.json`);
    const read = async () => JSON.parse(await readFile(sessionPath, 'utf8'));
    const beforeBytes = await readFile(sessionPath), before = await read(), binding = before.bindings[before.active_binding_id];
    const publish = async operations => {
      const request = { op_id: randomUUID(), source_input_id: null, attempt_id: null, expected_item_revisions: {},
        expected_topic_revisions: {}, summary: '', operations, input_result: null };
      assert.ok(Buffer.byteLength(JSON.stringify(request)) < 512 * 1024);
      const result = await cliRequest(cli, ['apply', '--binding', binding.id, '--generation', binding.generation, '--json-stdin', '--json'], request, env);
      assert.equal(result.code, 3, result.output); assert.equal(result.value.error.code, 'binding_mismatch');
      assert.equal(result.value.error.message, 'This binding is not the selected connected route');
      assert.deepEqual(await readFile(sessionPath), beforeBytes);
    };
    await publish([{ op: 'topic.add', ref: 'native_tree_topic', name: 'Native tree acceptance' }]);
    const topicId = randomUUID(), operations = [];
    for (let branch = 1; branch <= 20; branch++) {
      const batch = treeBatch(topicId, branch); operations.push(...batch); await publish(batch);
    }
    assert.equal(operations.length, 2000);
    assert.equal(operations.filter(item => item.parent === null).length, 20);
    assert.equal(operations.filter(item => item.status === 'open').length, 1320);
    assert.equal(operations.filter(item => item.status === 'done').length, 680);
    assert.equal(operations.filter(item => item.owner.kind === 'me').length, 1000);
    assert.ok(operations.some(item => item.question.includes('Native café needle.')));
    assert.deepEqual(await readFile(sessionPath), beforeBytes,
      'Disconnected demo remains unchanged; real native acceptance proves publication against its qualified binding');
  } finally { await rm(root, { recursive: true, force: true }); }
});
