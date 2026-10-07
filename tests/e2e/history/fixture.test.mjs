import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { cliRequest } from '../../../apps/desktop/tests/e2e/scripted-provider.mjs';
import { closeHistoryRailReferences, historyAsk, historyMessageBatch, historySeedRequest, unpinHistoryMessage, waitForHistoryItem, waitForRoundResult } from '../../../apps/desktop/tests/e2e/history.spec.mjs';

test('unpin proves pin removal independently, while deliberate rail Close requires cleared references', async t => {
  const dom = new JSDOM(`<aside class="message-history-rail"><div class="rail-messages"><article data-message-id="message" class="history-pinned"></article></div></aside>
    <div role="treeitem" data-item-id="1"><span class="ref-tree-mark" style="background: blue"></span></div>
    <div class="history-timeline"><article data-message-id="message" class="history-highlight"></article></div>`);
  const previousBrowser = globalThis.browser, previousDocument = globalThis.document;
  t.after(() => { globalThis.browser = previousBrowser; globalThis.document = previousDocument; dom.window.close(); });
  globalThis.document = dom.window.document;
  const article = document.querySelector('.rail-messages article'), mark = document.querySelector('.ref-tree-mark');
  const detail = document.querySelector('.history-timeline article');
  let pressed = 'true', pinWait = true;
  const actions = [], admitted = [];
  const card = {
    async scrollIntoView() { actions.push('scroll'); },
    async getAttribute(name) { assert.equal(name, 'class'); return article.className; },
    $(selector) {
      if (selector === 'button[aria-label="Unpin message 4"]') return { async click() { actions.push('unpin'); } };
      assert.equal(selector, 'button[aria-label="Pin message 4"]');
      return { async getAttribute(name) { assert.equal(name, 'aria-pressed'); return pressed; } };
    },
  };
  globalThis.browser = {
    $(selector) {
      assert.equal(selector, 'button[aria-label="Close message rail"]');
      return { async waitForEnabled() { actions.push('close enabled'); }, async click() { actions.push('close'); } };
    },
    execute: async (condition, id) => condition(id),
    async waitUntil(condition, options) {
      assert.equal(options.timeout, 20000);
      if (pinWait) {
        admitted.push(await condition()); // A clicked but still pinned card cannot pass.
        article.classList.remove('history-pinned'); pressed = 'false';
        admitted.push(await condition());
        assert.deepEqual(actions, ['scroll', 'unpin']);
        pinWait = false;
      } else {
        assert.deepEqual(actions, ['scroll', 'unpin', 'close enabled', 'close']);
        admitted.push(await condition()); // A clicked but still mounted rail cannot pass.
        mark.style.background = 'transparent'; detail.classList.remove('history-highlight');
        admitted.push(await condition()); // Even cleared references cannot excuse a rail that never closed.
        mark.style.background = 'blue'; detail.classList.add('history-highlight');
        document.querySelector('.message-history-rail').remove();
        admitted.push(await condition()); // Unmount alone cannot excuse stale highlights.
        mark.style.background = 'transparent';
        admitted.push(await condition()); // A cleared tree cannot excuse stale detail highlighting.
        detail.classList.remove('history-highlight');
        mark.remove(); admitted.push(Boolean(await condition())); // A missing marker cannot prove cleanup.
        document.querySelector('[role="treeitem"]').append(mark);
        for (const background of ['transparent', 'none', 'rgba(0, 0, 0, 0)']) {
          mark.style.background = background;
          admitted.push(await condition()); // Equivalent transparent shorthands share one computed color.
        }
      }
      assert.equal(admitted.at(-1), true);
    },
  };
  await unpinHistoryMessage(card, { id: 'message', number: 4 });
  assert.deepEqual(actions, ['scroll', 'unpin']);
  assert.equal(detail.classList.contains('history-highlight'), true, 'Unpin must not claim clearing a separate hover highlight');
  await closeHistoryRailReferences({ id: 'message' });
  assert.deepEqual(actions, ['scroll', 'unpin', 'close enabled', 'close']);
  assert.deepEqual(admitted, [false, true, false, false, false, false, false, true, true, true]);
});

test('fork links and parent references cannot admit a different selected history item', async t => {
  const child = { id: '1.1', question: 'Native history fork 1.1\nKeep its original source round.', source_round_id: 'round-one' };
  const parent = { id: '1', question: 'Retain five complete native rounds and their forks.\nThis question remains unchanged.', source_round_id: null };
  const dom = new JSDOM();
  const previousBrowser = globalThis.browser, previousDocument = globalThis.document;
  t.after(() => { globalThis.browser = previousBrowser; globalThis.document = previousDocument; dom.window.close(); });
  globalThis.document = dom.window.document;
  const view = (header, question, metadata, nested) => `<article class="item-detail"><div class="detail-head"><h2 class="detail-question">${question}</h2></div>
    <p class="history-meta">${metadata}</p>${nested}<div class="detail-reference"><span>Agent reference</span><code>${header}</code></div></article>`;
  const views = [
    view(parent.id, parent.question, '', `<section aria-label="Child items"><button class="detail-kid">${child.question}</button></section>
      <section aria-label="Back and forth"><div aria-label="Round 1"><button class="detail-fork">${child.question}</button></div></section>`),
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
    view(child.id, child.question, `Source round · ${child.source_round_id}`, `<nav aria-label="Item location"><button>${parent.question}</button></nav><section>${parent.question}</section>`),
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
