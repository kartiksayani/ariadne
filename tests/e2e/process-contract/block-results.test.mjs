import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptanceBlocks, blockFailureSummary, completedBlockResults } from '../../../apps/desktop/tests/e2e/block-results.mjs';

async function fixture(action) {
  const evidence = await mkdtemp(join(tmpdir(), 'ariadne-block-results-'));
  try { await action(evidence); } finally { await rm(evidence, { recursive: true }); }
}
const failedCommand = (exitCode = 1, expired = false) => Object.assign(new Error('WDIO failed'), { exitCode, expired });
const savedResults = async evidence => JSON.parse(await readFile(join(evidence, 'block-results.json'), 'utf8'));

test('passing blocks retain order and publish results only after fatal shutdown, without recovery or evidence calls', async () => fixture(async evidence => {
  const order = [], unexpected = () => assert.fail('Passing blocks must not recover or capture failure evidence');
  const blocks = acceptanceBlocks({ evidence, reset: unexpected, capture: unexpected });
  await blocks.run('tree', async () => { order.push('tree'); });
  await blocks.run('history', async () => { order.push('history'); }, ['tree']);
  await blocks.finish(async () => {
    order.push('shutdown'); await assert.rejects(stat(join(evidence, 'block-results.json')), { code: 'ENOENT' });
  });
  assert.deepEqual(order, ['tree', 'history', 'shutdown']);
  assert.deepEqual(await savedResults(evidence), blocks.results);
  assert.deepEqual(blocks.results.map(({ name, status, error }) => ({ name, status, error })), [
    { name: 'tree', status: 'passed', error: null }, { name: 'history', status: 'passed', error: null },
  ]);
  assert.ok(blocks.results.every(result => Number.isInteger(result.ms) && result.ms >= 0));
  assert.equal(blockFailureSummary(blocks.results), '');
  assert.deepEqual(await completedBlockResults(evidence, null), blocks.results);
}));

test('independent failures aggregate first lines, retain full messages/stacks and run shutdown before throwing', async () => fixture(async evidence => {
  const order = [], errors = [new Error('First error\nMore context'), new Error('Second error')];
  const blocks = acceptanceBlocks({ evidence, reset: async () => { order.push('reset'); },
    capture: async (name, error, started) => { order.push(`capture ${name}`); assert.ok(started <= Date.now()); assert.ok(errors.includes(error)); } });
  await blocks.run('discovery', async () => { order.push('discovery'); throw errors[0]; });
  await blocks.run('tree', async () => { order.push('tree'); throw errors[1]; });
  await blocks.run('accessibility', async () => { order.push('accessibility'); });
  await assert.rejects(blocks.finish(async () => { order.push('shutdown'); }), {
    message: 'Native acceptance blocks failed:\ndiscovery: failed: First error\ntree: failed: Second error',
  });
  assert.deepEqual(order, ['discovery', 'capture discovery', 'reset', 'tree', 'capture tree', 'reset', 'accessibility', 'shutdown']);
  const saved = await savedResults(evidence);
  assert.equal(saved[0].error.message, errors[0].message); assert.equal(saved[0].error.stack, errors[0].stack);
  assert.equal(saved[1].error.stack, errors[1].stack); assert.equal(saved[2].status, 'passed');
  assert.deepEqual(await completedBlockResults(evidence, failedCommand()), saved);
}));

test('dependencies skip actions transitively, preserve the root failure and recover before the next independent block', async () => fixture(async evidence => {
  let resets = 0;
  const blocks = acceptanceBlocks({ evidence, reset: async () => { resets++; }, capture: async () => {} });
  await blocks.run('discovery', async () => { throw new Error('Discovery unavailable'); });
  const forbidden = () => assert.fail('Skipped action must never run');
  await blocks.run('history-actions', forbidden, ['discovery']);
  await blocks.run('remove', forbidden, ['history-actions']);
  assert.equal(resets, 0);
  await blocks.run('accessibility', async () => {});
  assert.equal(resets, 1);
  await assert.rejects(blocks.finish(async () => {}), /remove: skipped: skipped because discovery failed/);
  const results = await savedResults(evidence);
  assert.deepEqual(results.map(result => result.status), ['failed', 'skipped', 'skipped', 'passed']);
  for (const result of results.slice(1, 3)) {
    assert.equal(result.ms, 0); assert.equal(result.error.message, 'skipped because discovery failed'); assert.equal(result.error.stack, null);
  }
}));

test('restoration uses prior phase dependencies while running independent recovery even when every prerequisite failed', async () => fixture(async evidence => {
  const priorResults = [{ name: 'tree', status: 'failed', error: { message: 'Tree failed' } },
    { name: 'history', status: 'skipped', error: { message: 'skipped because tree failed', dependency: 'tree' } }];
  let recovered = false;
  const blocks = acceptanceBlocks({ evidence, priorResults, reset: () => assert.fail('Fresh phase must not recover a previous process'), capture: async () => {} });
  const forbidden = () => assert.fail('Missing delivery evidence must skip restoration action');
  await blocks.run('restore-tree', forbidden, ['tree']);
  await blocks.run('graph', forbidden, ['restore-tree']);
  await blocks.run('restore-history', forbidden, ['history']);
  await blocks.run('recovery', async () => { recovered = true; });
  await assert.rejects(blocks.finish(async () => {}), /restore-history: skipped: skipped because tree failed/);
  assert.equal(recovered, true);
  assert.deepEqual((await completedBlockResults(evidence, failedCommand())).map(result => result.status), ['skipped', 'skipped', 'skipped', 'passed']);
}));

test('a failed recovery step records the next block as failed and retries recovery for later independent blocks', async () => fixture(async evidence => {
  let resets = 0, ran = false;
  const resetError = new Error('Dialog could not close');
  const blocks = acceptanceBlocks({ evidence, reset: async () => { if (++resets === 1) throw resetError; }, capture: async () => {} });
  await blocks.run('first', async () => { throw new Error('First block failed'); });
  await blocks.run('second', () => assert.fail('Do not run an action when its recovery fails'));
  await blocks.run('third', async () => { ran = true; });
  assert.equal(ran, true); assert.equal(resets, 2);
  assert.equal(blocks.results[1].error.message, resetError.message); assert.equal(blocks.results[1].error.stack, resetError.stack);
  assert.equal(blocks.results[2].status, 'passed');
}));

test('failure evidence is best effort and cannot replace the original failure, including non-Error throws', async () => fixture(async evidence => {
  const original = new Error('Original assertion');
  const blocks = acceptanceBlocks({ evidence, reset: async () => {}, capture: async () => { throw new Error('Evidence unavailable'); } });
  await blocks.run('first', async () => { throw original; });
  await blocks.run('second', async () => { throw 'Plain failure'; });
  assert.deepEqual(blocks.results[0].error, { message: original.message, stack: original.stack });
  assert.deepEqual(blocks.results[1].error, { message: 'Plain failure', stack: null });
}));

test('fatal shutdown failures propagate unchanged and never publish a completed phase, even after acceptance failures', async () => fixture(async evidence => {
  const fatal = new Error('Native Quit failed');
  const blocks = acceptanceBlocks({ evidence, reset: async () => {}, capture: async () => {} });
  await blocks.run('tree', async () => { throw new Error('Tree failed'); });
  await assert.rejects(blocks.finish(async () => { throw fatal; }), error => error === fatal);
  await assert.rejects(stat(join(evidence, 'block-results.json')), { code: 'ENOENT' });
  const execution = failedCommand();
  await assert.rejects(completedBlockResults(evidence, execution), error => error === execution);
}));

test('missing dependency declarations stay fatal rather than silently passing or skipping', async () => fixture(async evidence => {
  const blocks = acceptanceBlocks({ evidence, reset: async () => {}, capture: async () => {} });
  await assert.rejects(blocks.run('history', () => assert.fail('Missing prerequisite'), ['tree']), /Missing acceptance dependency: tree/);
  assert.deepEqual(blocks.results, []);
}));

test('runner rejects deadlines, interruption and unrelated process errors despite a completed block-failure file', async () => fixture(async evidence => {
  await writeFile(join(evidence, 'block-results.json'), JSON.stringify([{ name: 'tree', status: 'failed', ms: 1, error: { message: 'Tree failed' } }]));
  for (const failure of [failedCommand(1, true), failedCommand(null, true), failedCommand(2), new Error('Acknowledgement failed')])
    await assert.rejects(completedBlockResults(evidence, failure), error => error === failure);
}));

test('runner never treats passing, missing or malformed results as an acceptance-only WDIO failure', async () => fixture(async evidence => {
  const failure = failedCommand();
  await assert.rejects(completedBlockResults(evidence, failure), error => error === failure);
  for (const value of ['invalid JSON', JSON.stringify([{ name: 'tree', status: 'passed', ms: 1, error: null }])]) {
    await writeFile(join(evidence, 'block-results.json'), value);
    await assert.rejects(completedBlockResults(evidence, failure), error => error === failure);
  }
}));
