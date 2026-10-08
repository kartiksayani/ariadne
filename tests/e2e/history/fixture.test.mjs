import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { cliRequest } from '../../../apps/desktop/tests/e2e/scripted-provider.mjs';
import { closeHistoryRailReferences, historyAsk, historyMessageBatch, historySeedRequest, navigationRejection, unpinHistoryMessage, waitForHistoryControl, waitForHistoryItem, waitForRoundResult } from '../../../apps/desktop/tests/e2e/history.spec.mjs';
import { archiveClosedTopic, topicAction } from '../../../apps/desktop/tests/e2e/history-actions.spec.mjs';

test('history recovery requires the plain changed-view alert and enabled Refresh without uncertain Check again', async t => {
  const previousBrowser = globalThis.browser;
  t.after(() => { globalThis.browser = previousBrowser; });
  const changed = 'This changed while you were working. Look at it as it is now, then try again.';
  let message, refresh, enabled, uncertain;
  globalThis.browser = { $(selector) {
    if (selector === '.nav-banner[role="alert"] p') return { async isExisting() { return message !== null; }, async getText() { return message; } };
    assert.equal(selector, '.nav-banner[role="alert"]');
    return { $(selector) {
      assert.notEqual(message, null, 'An absent alert must not initiate a nested element lookup');
      if (selector === 'button=Refresh') return { async isExisting() { return refresh; }, async isEnabled() { return enabled; } };
      assert.equal(selector, 'button=Check again'); return { async isExisting() { return uncertain; } };
    } };
  } };
  const admitted = [];
  for ([message, refresh, enabled, uncertain] of [[null, false, false, false], ['Preferences revision changed; reload before applying this new patch', true, true, false],
    [changed, false, false, false], [changed, true, false, false], [changed, true, true, true], [changed, true, true, false]]) {
    admitted.push(await navigationRejection());
  }
  assert.deepEqual(admitted, [false, false, false, false, false, true]);
});

test('history topic actions use their accessible names and the all-closed prompt stays outside the sticky band', async t => {
  const dom = new JSDOM(`<div class="tree-rows"><div class="tree-topic" role="treeitem" aria-label="Native topic" data-topic-id="topic" tabindex="0">
    <button aria-label="Continue here"><i></i></button><button aria-label="Archive"><i></i></button></div>
    <div class="tree-topic-content"><div class="tree-prompt"><button>Archive topic</button></div></div>
    <div data-topic-id="other"></div><div class="tree-topic-content"><div class="tree-prompt"><button>Archive other topic</button></div></div></div>`);
  const previousBrowser = globalThis.browser;
  t.after(() => { globalThis.browser = previousBrowser; dom.window.close(); });
  const clicked = [];
  const wrap = node => {
    assert.ok(node, 'The current native selector must find an actual rendered control');
    return { node, async waitForDisplayed() {}, async waitForEnabled() {},
      async click() { clicked.push(node.getAttribute('aria-label') ?? node.textContent); },
      $(selector) { return wrap(node.querySelector(selector)); } };
  };
  globalThis.browser = { $(selector) { return wrap(dom.window.document.querySelector(selector)); },
    async execute(callback, element) { return callback(element.node); } };
  await topicAction('Native topic', 'Continue here');
  await topicAction('Native topic', 'Archive');
  await archiveClosedTopic('topic');
  assert.deepEqual(clicked, ['Continue here', 'Archive', 'Archive topic']);
});

test('history choice and Send wait for both native enabled and refresh aria-disabled to clear', async t => {
  const previousBrowser = globalThis.browser;
  t.after(() => { globalThis.browser = previousBrowser; });
  let enabled = false, frozen = true;
  const admitted = [];
  globalThis.browser = { async waitUntil(condition, options) {
    assert.equal(options.timeout, 20000);
    admitted.push(await condition());
    enabled = true; admitted.push(await condition());
    frozen = false; admitted.push(await condition());
    assert.equal(admitted.at(-1), true);
  } };
  await waitForHistoryControl({ async waitForEnabled() {}, async isEnabled() { return enabled; },
    async getAttribute(name) { assert.equal(name, 'aria-disabled'); return frozen ? 'true' : null; } }, 'round choice');
  assert.deepEqual(admitted, [false, false, true]);
});

test('unpin proves pin removal independently, while deliberate rail Close requires cleared references', async t => {
  const dom = new JSDOM(`<aside class="pw-rail"><div class="pw-rail-list"><button data-message-id="message" class="pw-excerpt pw-excerpt-active" aria-pressed="true"></button></div></aside>
    <div class="tree-rows"><div role="treeitem" data-item-id="1" data-highlight="strong"></div></div>
    <section aria-label="Conversation"><ol class="detail-chat-list"><li data-message-id="message" class="detail-turn excerpt-highlighted"></li></ol></section>`);
  const previousBrowser = globalThis.browser, previousDocument = globalThis.document;
  t.after(() => { globalThis.browser = previousBrowser; globalThis.document = previousDocument; dom.window.close(); });
  globalThis.document = dom.window.document;
  const excerpt = document.querySelector('.pw-rail-list [data-message-id]'), item = document.querySelector('[role="treeitem"]');
  const detail = document.querySelector('.detail-chat-list [data-message-id]');
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
  // Selection uses the canonical article ID and complete question, even when
  // other items appear as child, location or creation-message fork links.
  const view = (header, question, nested) => `<article class="item-detail" data-detail-item-id="${header}"><div class="detail-head"><h2 class="detail-question">${question}</h2></div>
    ${nested}</article>`;
  const views = [
    view(parent.id, parent.question, `<section aria-label="Child items"><button class="detail-kid">${child.question}</button></section>
      <section class="detail-chat" aria-label="Conversation"><ol class="detail-chat-list"><li class="detail-turn" data-message-id="ask" data-round="1"></li><li class="detail-turn" data-message-id="fork-created"><button class="detail-fork">${child.question}</button></li></ol></section>`),
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

// The production detail uses one li per message; only the ask has data-round.
const roundAsk = 'History round 5: choose and explain. Full ask line 5.';
const roundOwner = { id: 'owner-5', text: 'You chose “Use round 5 choice”' };
const roundReply = { id: 'reply-5', body: 'Explicit native round 5 result\nFull correlated agent reply for the saved answer.' };
const roundView = ({ ask = true, owner = true, said = true, ownerText = roundOwner.text,
  reply = true, replyId = roundReply.id, body = roundReply.body, pending = false } = {}) =>
  `<ol class="detail-chat-list">${ask ? `<li data-message-id="ask-5" data-round="5">${roundAsk}</li>` : ''}
    ${owner ? `<li data-message-id="${roundOwner.id}" ${said ? 'data-owner-said="true"' : ''} ${pending ? 'data-pending="input-5"' : ''}><div class="detail-bubble-you">${ownerText}</div></li>` : ''}
    ${reply ? `<li data-message-id="${replyId}"><div class="detail-bubble-agent"><div class="md">${body}</div></div></li>` : ''}</ol>`;
const roundBrowser = (document, waitUntil) => ({
  $(selector) {
    const element = document.querySelector(selector);
    return { async isExisting() { return !!element; }, async getText() { assert.ok(element); return element.textContent; },
      async getAttribute(name) { assert.ok(element); return element.getAttribute(name); } };
  },
  async $$(selector) { return [...document.querySelectorAll(selector)]; }, waitUntil,
});

test('five ask anchors require the complete separate correlated reply and settled owner message', async t => {
  const round = { ordinal: 5, closed_at: '2026-10-05T11:51:57.000Z' };
  const dom = new JSDOM();
  const states = [{ ask: false }, { owner: false }, { said: false }, { ownerText: 'You chose “Use round' }, { reply: false },
    { replyId: 'unrelated-reply' }, { body: 'Explicit native round 5 result' }, { pending: true }, {}];
  const admitted = [];
  const previousBrowser = globalThis.browser;
  t.after(() => { globalThis.browser = previousBrowser; dom.window.close(); });
  globalThis.browser = roundBrowser(dom.window.document, async (condition, options) => {
    assert.equal(options.timeout, 20000);
    for (const state of states) { dom.window.document.body.innerHTML = roundView(state); admitted.push(await condition()); }
    assert.equal(admitted.at(-1), true);
  });
  await waitForRoundResult(round, roundOwner, roundReply);
  assert.deepEqual(admitted, [false, false, false, false, false, false, false, false, true]);
});

test('an omitted, unrelated or truncated correlated reply remains a native acceptance failure', async t => {
  const round = { ordinal: 5, closed_at: '2026-10-05T11:51:57.000Z' };
  const dom = new JSDOM();
  const previousBrowser = globalThis.browser;
  t.after(() => { globalThis.browser = previousBrowser; dom.window.close(); });
  globalThis.browser = roundBrowser(dom.window.document, async (condition, options) => {
    for (const state of [{ reply: false }, { replyId: 'another-round' }, { body: 'Explicit native round 5 result\nFull correlated' }]) {
      dom.window.document.body.innerHTML = roundView(state);
      assert.equal(await condition(), false);
    }
    throw new Error(options.timeoutMsg);
  });
  await assert.rejects(waitForRoundResult(round, roundOwner, roundReply), /did not publish the final closed round, its complete correlated result and the settled owner message/);
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
