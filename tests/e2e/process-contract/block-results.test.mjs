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

test('the final failed block recovers its UI before shutdown even when dependent blocks were skipped', async () => fixture(async evidence => {
  const order = [];
  const blocks = acceptanceBlocks({ evidence, reset: async () => { order.push('reset'); }, capture: async () => {} });
  await blocks.run('remove', async () => { order.push('remove'); throw new Error('Removal modal assertion failed'); });
  await blocks.run('dependent', () => assert.fail('Skipped action must not run'), ['remove']);
  await assert.rejects(blocks.finish(async () => {
    order.push('shutdown');
    await assert.rejects(stat(join(evidence, 'block-results.json')), { code: 'ENOENT' });
  }), /remove: failed: Removal modal assertion failed/);
  assert.deepEqual(order, ['remove', 'reset', 'shutdown']);
  assert.deepEqual(await savedResults(evidence), blocks.results);
}));

test('shutdown failure publishes fatal results and aggregates all acceptance and shutdown errors', async () => fixture(async evidence => {
  const fatal = new Error('Native Quit failed');
  const tree = new Error('Tree failed\nTree details'), history = new Error('History failed'), order = [];
  const blocks = acceptanceBlocks({ evidence, reset: async () => { order.push('reset'); }, capture: async () => {} });
  await blocks.run('tree', async () => { throw tree; });
  await blocks.run('history', async () => { throw history; });
  await assert.rejects(blocks.finish(async () => { order.push('shutdown'); throw fatal; }), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, 'Native acceptance blocks failed:\ntree: failed: Tree failed\nhistory: failed: History failed\nshutdown: fatal: Native Quit failed');
    assert.deepEqual(error.errors.map(failure => failure.message), [tree.message, history.message, fatal.message]);
    assert.equal(error.errors[0].stack, tree.stack); assert.equal(error.errors[1].stack, history.stack);
    assert.equal(error.errors[2], fatal);
    return true;
  });
  assert.deepEqual(order, ['reset', 'reset', 'shutdown']);
  const results = await savedResults(evidence);
  assert.deepEqual(results, blocks.results);
  assert.deepEqual(results.map(result => result.status), ['failed', 'failed', 'fatal']);
  assert.equal(results[2].error.stack, fatal.stack);
  const execution = failedCommand();
  await assert.rejects(completedBlockResults(evidence, execution), error => error === execution);
  await assert.rejects(completedBlockResults(evidence, null), /shutdown: fatal: Native Quit failed/);
}));

test('failed pending reset still attempts shutdown and publishes both fatal failures with the original block error', async () => fixture(async evidence => {
  const order = [], resetError = new Error('Modal recovery failed'), shutdownError = new Error('Shutdown proof failed');
  const blocks = acceptanceBlocks({ evidence,
    reset: async () => { order.push('reset'); throw resetError; }, capture: async () => {} });
  await blocks.run('remove', async () => { throw new Error('Remove failed'); });
  await assert.rejects(blocks.finish(async () => { order.push('shutdown'); throw shutdownError; }), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map(failure => failure.message), ['Remove failed', resetError.message, shutdownError.message]);
    assert.equal(error.errors[1], resetError); assert.equal(error.errors[2], shutdownError);
    assert.match(error.message, /acceptance-ui-reset: fatal: Modal recovery failed\nshutdown: fatal: Shutdown proof failed/);
    return true;
  });
  assert.deepEqual(order, ['reset', 'shutdown']);
  assert.deepEqual((await savedResults(evidence)).map(result => result.status), ['failed', 'fatal', 'fatal']);
  const execution = failedCommand();
  await assert.rejects(completedBlockResults(evidence, execution), error => error === execution);
}));

test('shutdown-only and recovery-only fatal results remain fatal even with passing blocks or successful shutdown', async () => {
  for (const resetFails of [false, true]) await fixture(async evidence => {
    let shutdownCalled = false;
    const blocks = acceptanceBlocks({ evidence, reset: async () => { throw new Error('Reset failed'); }, capture: async () => {} });
    await blocks.run('tree', async () => { if (resetFails) throw new Error('Tree failed'); });
    await assert.rejects(blocks.finish(async () => {
      shutdownCalled = true;
      if (!resetFails) throw new Error('Shutdown failed');
    }), /fatal: (Reset|Shutdown) failed/);
    assert.equal(shutdownCalled, true);
    const results = await savedResults(evidence);
    assert.equal(results.at(-1).name, resetFails ? 'acceptance-ui-reset' : 'shutdown');
    assert.equal(results.at(-1).status, 'fatal');
    const execution = failedCommand();
    await assert.rejects(completedBlockResults(evidence, execution), error => error === execution);
  });
});

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
