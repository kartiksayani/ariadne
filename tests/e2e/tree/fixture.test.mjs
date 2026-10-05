import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cliRequest } from '../../../apps/desktop/tests/e2e/scripted-provider.mjs';
import { publishTreeRequest, treeBatch, treeMessageBatch } from '../../../apps/desktop/tests/e2e/tree.spec.mjs';

test('tree setup repeats only definitive Busy with the identical frozen request and stops on other failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ariadne-tree-retry-')), priorEvidence = process.env.ARIADNE_E2E_EVIDENCE;
  try {
    process.env.ARIADNE_E2E_EVIDENCE = root;
    const cli = join(root, 'fixture-cli.mjs'), journal = join(root, 'calls.json'), sessionPath = join(root, 'session.json');
    await writeFile(sessionPath, JSON.stringify({ operation_receipts: {} }));
    const configuration = { cli, sessionPath, bindingId: 'binding', generation: 'generation', sessionId: 'session' };
    const request = { op_id: randomUUID(), operations: [], expected_item_revisions: { 1: 7 } };
    const script = async failures => {
      await writeFile(journal, '[]');
      // This executable tests only fixture retry classification; the separate
      // corpus test and native journey retain the actual CLI/Core/Store.
      await writeFile(cli, `#!${process.execPath}\nimport{readFileSync,writeFileSync}from'node:fs';let input='';for await(const bytes of process.stdin)input+=bytes;const path=${JSON.stringify(journal)},calls=JSON.parse(readFileSync(path));calls.push({args:process.argv.slice(2),request:JSON.parse(input)});writeFileSync(path,JSON.stringify(calls));const code=${JSON.stringify(failures)}[calls.length-1];console.log(JSON.stringify(code?{ok:false,error:{code}}:{ok:true,data:{session_id:'session'}}));process.exitCode=code?4:0;\n`);
      await chmod(cli, 0o700);
    };
    const calls = async () => JSON.parse(await readFile(journal, 'utf8'));
    await script(['store_busy', 'store_busy']);
    assert.deepEqual(await publishTreeRequest(configuration, request), { request, receipt: { session_id: 'session' } });
    const repeated = await calls(); assert.equal(repeated.length, 3);
    assert.ok(repeated.every(call => JSON.stringify(call) === JSON.stringify(repeated[0])));
    assert.deepEqual(repeated[0].request, request); assert.ok(repeated[0].args.includes('--json'));
    for (const failure of ['revision_conflict', 'commit_uncertain', 'store_io', 'binding_mismatch', 'store_busy']) {
      await script(failure === 'store_busy' ? [failure, failure, failure] : [failure]);
      await assert.rejects(publishTreeRequest(configuration, request), new RegExp(failure));
      assert.equal((await calls()).length, failure === 'store_busy' ? 3 : 1);
    }
    await script(['store_busy', 'revision_conflict']);
    await assert.rejects(publishTreeRequest(configuration, request), /revision_conflict/); assert.equal((await calls()).length, 2);
    assert.deepEqual(JSON.parse(await readFile(sessionPath, 'utf8')), { operation_receipts: {} });
  } finally {
    if (priorEvidence === undefined) delete process.env.ARIADNE_E2E_EVIDENCE; else process.env.ARIADNE_E2E_EVIDENCE = priorEvidence;
    await rm(root, { recursive: true });
  }
});

test('2,000-item / 5,000-message corpus requests pass real CLI wire validation and reach the Core dispatch barrier', { timeout: 60000 }, async () => {
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
    const publish = async (operations, summary = '') => {
      const revisions = Object.fromEntries(operations.filter(operation => operation.op === 'reply').map(operation => [operation.item.id, 1]));
      const request = { op_id: randomUUID(), source_input_id: null, attempt_id: null, expected_item_revisions: revisions,
        expected_topic_revisions: {}, summary, operations, input_result: null };
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
    const replies = [];
    for (let first = 1; first <= 5000; first += 100) {
      const batch = treeMessageBatch(first, 100); replies.push(...batch); await publish(batch, 'Publish complete native message history.');
    }
    await publish([], 'Publish complete native message history.');
    assert.equal(replies.length, 5000); assert.equal(new Set(replies.map(reply => reply.ref)).size, 5000);
    assert.ok(replies.every(reply => reply.text.includes('\nFull retained message body') && reply.text.includes('\nUnique history_token_')));
    assert.deepEqual(await readFile(sessionPath), beforeBytes,
      'Disconnected demo remains unchanged; real native acceptance proves publication against its qualified binding');
  } finally { await rm(root, { recursive: true, force: true }); }
});
