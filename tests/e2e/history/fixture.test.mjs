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
  const dom = new JSDOM(`<aside class="pw-rail"><div class="pw-rail-list"><button data-message-id="message" class="pw-excerpt pw-excerpt-active" aria-pressed="true"></button></div></aside>
    <div class="tree-rows"><div role="treeitem" data-item-id="1" data-highlight="strong"></div></div>
    <section class="detail-timeline"><div data-message-id="message" class="excerpt-timeline excerpt-highlighted"></div></section>`);
  const previousBrowser = globalThis.browser, previousDocument = globalThis.document;
  t.after(() => { globalThis.browser = previousBrowser; globalThis.document = previousDocument; dom.window.close(); });
  globalThis.document = dom.window.document;
  const excerpt = document.querySelector('.pw-rail-list [data-message-id]'), item = document.querySelector('[role="treeitem"]');
  const detail = document.querySelector('.detail-timeline [data-message-id]');
  let pinWait = true;
  const actions = [], admitted = [];
  const card = {
    async scrollIntoView() { actions.push('scroll'); },
    async click() { actions.push('unpin'); },
    async getAttribute(name) {
      assert.ok(name === 'class' || name === 'aria-pressed'); return excerpt.getAttribute(name);
    },
  };
  globalThis.browser = {
    $(selector) {
      assert.equal(selector, 'button[aria-label="Hide messages"]');
      return { async waitForEnabled() { actions.push('close enabled'); }, async click() { actions.push('close'); } };
    },
    execute: async (condition, id) => condition(id),
    async waitUntil(condition, options) {
      assert.equal(options.timeout, 20000);
      if (pinWait) {
        admitted.push(await condition()); // A clicked but still pinned card cannot pass.
        excerpt.classList.remove('pw-excerpt-active');
        admitted.push(await condition()); // A cleared class cannot excuse a still-pressed toggle.
        excerpt.setAttribute('aria-pressed', 'false');
        admitted.push(await condition());
        assert.deepEqual(actions, ['scroll', 'unpin']);
        pinWait = false;
      } else {
        assert.deepEqual(actions, ['scroll', 'unpin', 'close enabled', 'close']);
        admitted.push(await condition()); // A clicked but still mounted rail cannot pass.
        item.removeAttribute('data-highlight'); detail.classList.remove('excerpt-highlighted');
        admitted.push(await condition()); // Even cleared references cannot excuse a rail that never closed.
        item.setAttribute('data-highlight', 'strong'); detail.classList.add('excerpt-highlighted');
        document.querySelector('.pw-rail').remove();
        admitted.push(await condition()); // Unmount alone cannot excuse stale highlights.
        item.setAttribute('data-highlight', 'weak');
        admitted.push(await condition()); // A weak (folded) highlight is still a highlight.
        item.removeAttribute('data-highlight');
        admitted.push(await condition()); // A cleared tree cannot excuse stale detail highlighting.
        detail.classList.remove('excerpt-highlighted');
        item.remove(); admitted.push(Boolean(await condition())); // A missing row cannot prove cleanup.
        document.querySelector('.tree-rows').append(item);
        admitted.push(await condition());
      }
      assert.equal(admitted.at(-1), true);
    },
  };
  await unpinHistoryMessage(card, { id: 'message', number: 4 });
  assert.deepEqual(actions, ['scroll', 'unpin']);
  assert.equal(detail.classList.contains('excerpt-highlighted'), true, 'Unpin must not claim clearing a separate hover highlight');
  await closeHistoryRailReferences({ id: 'message' });
  assert.deepEqual(actions, ['scroll', 'unpin', 'close enabled', 'close']);
  assert.deepEqual(admitted, [false, false, true, false, false, false, false, false, false, true]);
});

test('fork links and parent references cannot admit a different selected history item', async t => {
  const child = { id: '1.1', question: 'Native history fork 1.1\nKeep its original source round.', source_round_id: 'round-one' };
  const parent = { id: '1', question: 'Retain five complete native rounds and their forks.\nThis question remains unchanged.', source_round_id: null };
  const dom = new JSDOM();
  const previousBrowser = globalThis.browser, previousDocument = globalThis.document;
  t.after(() => { globalThis.browser = previousBrowser; globalThis.document = previousDocument; dom.window.close(); });
  globalThis.document = dom.window.document;
  // The Paperwhite detail names the item by its agent reference and question only;
  // a fork's source round is its fork link inside the parent's round (proveRounds).
  const view = (header, question, nested) => `<article class="item-detail"><div class="detail-head"><h2 class="detail-question">${question}</h2></div>
    ${nested}<div class="detail-reference"><span>Agent reference</span><code>${header}</code></div></article>`;
  const views = [
    view(parent.id, parent.question, `<section aria-label="Child items"><button class="detail-kid">${child.question}</button></section>
      <section class="detail-chat" aria-label="Conversation"><ol class="detail-chat-list"><li class="detail-turn" data-round="1"><button class="detail-fork">${child.question}</button></li></ol></section>`),
    view(child.id, parent.question, ''),
    view(parent.id, child.question, ''),
    view(child.id, child.question.split('\n')[0], ''),
    view(child.id, child.question, ''),
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
    view(child.id, child.question, `<nav aria-label="Item location"><button>${parent.question}</button></nav><section>${parent.question}</section>`),
    view(parent.id, parent.question, ''));
  await waitForHistoryItem(parent);
  assert.deepEqual(admitted, [false, true]);
});

// An exchange of the Conversation renders its ask, the owner's answer and the result's explanation
// as one-paragraph lines; its explanation alone proves the closed result. It carries no visible number.
const roundText = (ask, you, result = null) => [ask, you, result].filter(Boolean).join('\n');
const roundAsk = 'History round 5: choose and explain. Full ask line 5.';
const roundChoice = 'You chose “Use round 5 choice”';

test('five existing round sections do not admit assertions before the final closed result reaches native detail', async t => {
  const round = { ordinal: 5, closed_at: '2026-10-05T11:51:57.000Z' };
  const explanation = 'Explicit native result 5\nComplete stored explanation for answer #5.';
  const absent = { async isExisting() { return false; }, getText: async () => assert.fail('An absent round has no text') };
  const complete = roundText(roundAsk, roundChoice, 'Explicit native result 5 Complete stored explanation for answer #5.');
  // The last two states carry the full result; in the first of them the owner's message is still a pending bubble.
  const states = [[absent, 0], [roundText(roundAsk, roundChoice), 0], [roundText(roundAsk, roundChoice, 'Explicit native result 5'), 0],
    [complete, 1], [complete, 0]];
  let state, pending;
  const admitted = [];
  const previousBrowser = globalThis.browser;
  t.after(() => { globalThis.browser = previousBrowser; });
  globalThis.browser = {
    $(selector) {
      assert.equal(selector, '.detail-chat-list [data-round="5"]');
      return typeof state === 'string' ? { isExisting: async () => true, getText: async () => state } : state;
    },
    async $$(selector) {
      assert.equal(selector, '.detail-chat-list [data-pending]');
      return Array.from({ length: pending }, () => ({}));
    },
    async waitUntil(condition, options) {
      assert.equal(options.timeout, 20000);
      for ([state, pending] of states) admitted.push(await condition());
      assert.equal(admitted.at(-1), true);
    },
  };
  await waitForRoundResult(round, explanation);
  assert.deepEqual(admitted, [false, false, false, false, true]);
});

test('a permanently omitted or truncated final result remains a native acceptance failure', async t => {
  const round = { ordinal: 5, closed_at: '2026-10-05T11:51:57.000Z' };
  const explanation = 'Explicit native result 5\nComplete stored explanation for answer #5.';
  let text;
  const previousBrowser = globalThis.browser;
  t.after(() => { globalThis.browser = previousBrowser; });
  globalThis.browser = {
    $() { return { isExisting: async () => true, getText: async () => text }; },
    async $$() { return []; },
    async waitUntil(condition, options) {
      for (text of [roundText(roundAsk, roundChoice), roundText(roundAsk, roundChoice, 'Explicit native result 5\nComplete stored')]) {
        assert.equal(await condition(), false);
      }
      throw new Error(options.timeoutMsg);
    },
  };
  await assert.rejects(waitForRoundResult(round, explanation), /did not publish the final closed round, its complete correlated result and the settled owner message/);
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
    const path = join(home, 'projects', demo.value.data.project_id, 'sessions',`${demo.value.data.session_id}.json`), before = await readFile(path);
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
