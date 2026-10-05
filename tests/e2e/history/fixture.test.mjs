import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { cliRequest } from '../../../apps/desktop/tests/e2e/scripted-provider.mjs';
import { historyAsk, historyMessageBatch, historySeedRequest, waitForHistoryItem, waitForRoundResult } from '../../../apps/desktop/tests/e2e/history.spec.mjs';

test('fork links and parent references cannot admit a different selected history item', async t => {
  const child = { id: '1.1', question: 'Native history fork 1.1\nKeep its original source round.', source_round_id: 'round-one' };
  const parent = { id: '1', question: 'Retain five complete native rounds and their forks.\nThis question remains unchanged.', source_round_id: null };
  const dom = new JSDOM();
  const previousBrowser = globalThis.browser, previousDocument = globalThis.document;
  t.after(() => { globalThis.browser = previousBrowser; globalThis.document = previousDocument; dom.window.close(); });
  globalThis.document = dom.window.document;
  const view = (header, question, metadata, nested) => `<aside class="item-history"><header class="history-header"><strong>Item ${header}</strong></header>
    <h2>${question}</h2><p class="history-meta">${metadata}</p>${nested}</aside>`;
  const views = [
    view(parent.id, parent.question, '', `<section aria-label="Child items">Item ${child.id} · ${child.question}</section>
      <section aria-label="Round 1"><button class="history-fork">Fork · Item ${child.id} · ${child.question}</button></section>`),
    view(child.id, parent.question, `Source round · ${child.source_round_id}`, ''),
    view(child.id, child.question, 'Source round · wrong-round', ''),
    view(child.id, child.question, '', `<section><p class="history-meta">Source round · ${child.source_round_id}</p></section>`),
    view(child.id, child.question, `Source round · ${child.source_round_id}`, ''),
  ];
  const admitted = [];
  globalThis.browser = {
    execute: async (condition, expected) => condition(expected),
    async waitUntil(condition, options) {
      assert.equal(options.timeout, 20000);
      for (const html of views) { document.body.innerHTML = html; admitted.push(await condition()); }
      assert.equal(admitted.at(-1), true);
    },
  };
  await waitForHistoryItem(child);
  assert.deepEqual(admitted, [false, false, false, false, true]);
  admitted.length = 0;
  views.splice(0, views.length,
    view(child.id, child.question, `Source round · ${child.source_round_id}`, `<button>Parent · Item ${parent.id}</button><section>${parent.question}</section>`),
    view(parent.id, parent.question, '', ''));
  await waitForHistoryItem(parent);
  assert.deepEqual(admitted, [false, true]);
});

test('five existing round sections do not admit assertions before the final closed result reaches native detail', async t => {
  const round = { ordinal: 5, closed_at: '2026-10-05T11:51:57.000Z' };
  const reply = 'Explicit native round 5 result\nFull correlated agent reply for the saved answer.';
  const explanation = 'Explicit native result 5\nComplete stored explanation for answer #5.';
  const initial = 'Round 5Current round\nFull owner explanation for round 5.';
  const closed = `Round 5Closed · ${round.closed_at}\n${reply}`;
  const completed = `${closed}\n${explanation}`;
  let text = initial;
  const admitted = [];
  const previousBrowser = globalThis.browser;
  t.after(() => { globalThis.browser = previousBrowser; });
  globalThis.browser = {
    $(selector) { assert.equal(selector, '[aria-label="Round 5"]'); return { getText: async () => text }; },
    async waitUntil(condition, options) {
      assert.equal(options.timeout, 20000);
      for (text of [initial, closed, completed]) admitted.push(await condition());
      assert.equal(admitted.at(-1), true);
    },
  };
  await waitForRoundResult(round, reply, explanation);
  assert.deepEqual(admitted, [false, false, true]);
});

test('a permanently omitted or truncated final result remains a native acceptance failure', async t => {
  const round = { ordinal: 5, closed_at: '2026-10-05T11:51:57.000Z' };
  const reply = 'Explicit native round 5 result\nFull correlated agent reply for the saved answer.';
  const explanation = 'Explicit native result 5\nComplete stored explanation for answer #5.';
  let text;
  const previousBrowser = globalThis.browser;
  t.after(() => { globalThis.browser = previousBrowser; });
  globalThis.browser = {
    $() { return { getText: async () => text }; },
    async waitUntil(condition, options) {
      for (text of [`Round 5Closed · ${round.closed_at}\n${reply}`, `Round 5Closed · ${round.closed_at}\n${reply}\nExplicit native result 5`]) {
        assert.equal(await condition(), false);
      }
      throw new Error(options.timeoutMsg);
    },
  };
  await assert.rejects(waitForRoundResult(round, reply, explanation), /did not publish the final closed round and its complete correlated result/);
});

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
