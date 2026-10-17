import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { cliRequest } from '../../../apps/desktop/tests/e2e/scripted-provider.mjs';
import { historyAsk, historyMessageBatch, historySeedRequest, navigationUpdated, waitForHistoryControl, waitForHistoryItem, waitForRoundResult } from '../../../apps/desktop/tests/e2e/history.spec.mjs';
import { historyFailureFacts } from '../../../apps/desktop/tests/e2e/history-evidence.mjs';
import { archiveClosedTopic, topicAction } from '../../../apps/desktop/tests/e2e/history-actions.spec.mjs';

test('history recovery requires the automatically refreshed navigation notification without Refresh', async t => {
  const previousBrowser = globalThis.browser;
  t.after(() => { globalThis.browser = previousBrowser; });
  const updated = 'Updated to the latest. Try again if needed.';
  let present, message, refresh;
  globalThis.browser = { $(selector) {
    assert.equal(selector, '.pw-notices .pw-note[data-notice-id="navigation-action-failed"][data-tone="info"]');
    return { async isExisting() { return present; }, $(selector) {
      assert.equal(present, true, 'An absent notification must not initiate a nested element lookup');
      if (selector === '.pw-note-text') return { async getText() { return message; } };
      assert.equal(selector, 'button=Refresh'); return { async isExisting() { return refresh; } };
    } };
  } };
  const admitted = [];
  for ([present, message, refresh] of [[false, null, false], [true, 'Another notification', false],
    [true, updated, true], [true, updated, false]]) admitted.push(await navigationUpdated());
  assert.deepEqual(admitted, [false, false, false, true]);
});

test('history failure evidence finds the docked follow-up send control', t => {
  const dom = new JSDOM(`<article class="item-detail"><div class="detail-dock"><div data-owner-input="fixture"><div class="detail-box">
    <div class="detail-composer-row"><textarea>Kept words</textarea><button aria-label="Send follow-up">Send follow-up</button></div>
    </div></div></div></article>`);
  const previousDocument = globalThis.document;
  globalThis.document = dom.window.document;
  t.after(() => { globalThis.document = previousDocument; dom.window.close(); });
  const facts = historyFailureFacts();
  assert.deepEqual(facts.ownerInput.send, { text: 'Send follow-up', disabled: false, ariaPressed: null });
  assert.deepEqual(facts.ownerInput.textarea, { disabled: false, valueLength: 'Kept words'.length });
});

test('history topic actions use their accessible names and the all-closed prompt stays outside the sticky band', async t => {
  const dom = new JSDOM(`<section class="tree-column" aria-label="Session tree" data-session-status="stale" data-session-busy="true"><div class="tree-rows"><div class="tree-topic" role="treeitem" aria-label="Native topic" data-topic-id="topic" tabindex="0">
    <button aria-label="Continue elsewhere"><i></i></button><button aria-label="More actions for “Native topic”"><i></i></button></div>
    <div role="menu"><button role="menuitem" aria-label="Archive topic…"><span>Archive topic…</span><span>Out of the Map</span></button><button role="menuitem" aria-label="Remove topic…"><span>Remove topic…</span></button></div>
    <div class="tree-topic-content"><div class="tree-prompt"><button>Archive topic</button></div></div>
    <div data-topic-id="other"></div><div class="tree-topic-content"><div class="tree-prompt"><button>Archive other topic</button></div></div></div></section>`);
  const previousBrowser = globalThis.browser;
  t.after(() => { globalThis.browser = previousBrowser; dom.window.close(); });
  const clicked = [], admitted = [];
  const wrap = node => {
    assert.ok(node, 'The current native selector must find an actual rendered control');
    return { node, async waitForDisplayed() {}, async waitForEnabled() {},
      async getAttribute(name) { return node.getAttribute(name); },
      async getText() { return node.textContent; },
      async isExisting() { return node.isConnected; },
      async click() { clicked.push(node.getAttribute('aria-label') ?? node.textContent); },
      $(selector) { return wrap(node.querySelector(selector)); } };
  };
  // WebdriverIO's `[role="menuitem"]*=Text` (a menu entry whose text contains Text) is not CSS, so the fake resolves it itself.
  const bandActions = ['Continue elsewhere', 'More actions for “Native topic”', 'Archive topic…'];
  globalThis.browser = { $(selector) {
      const entry = /^\[role="menuitem"\]\*=(.*)$/.exec(selector);
      if (entry) return wrap([...dom.window.document.querySelectorAll('[role="menuitem"]')].find(node => node.textContent.includes(entry[1])));
      return wrap(dom.window.document.querySelector(selector));
    },
    async waitUntil(condition, options) {
      assert.equal(options.timeout, 60000);
      admitted.push(await condition());
      assert.deepEqual(clicked, bandActions, 'A stale session must wait before clicking its archive prompt');
      dom.window.document.querySelector('.tree-column').setAttribute('data-session-status', 'ready');
      admitted.push(await condition());
      assert.deepEqual(clicked, bandActions, 'A busy session must also wait before clicking its archive prompt');
      dom.window.document.querySelector('.tree-column').setAttribute('data-session-busy', 'false');
      admitted.push(await condition());
      assert.equal(admitted.at(-1), true);
    },
    async execute(callback, element) { return callback(element.node); } };
  await topicAction('Native topic', 'Continue here');
  await topicAction('Native topic', 'Archive');
  await archiveClosedTopic('topic');
  assert.deepEqual(admitted, [false, false, true]);
  assert.deepEqual(clicked, [...bandActions, 'Archive topic']);
});

test('archive diagnostics preserve the failure when browser inspection throws or rejects', async t => {
  const previousBrowser = globalThis.browser;
  t.after(() => { globalThis.browser = previousBrowser; });
  const failure = new Error('Session was not ready for direct topic archive');
  for (const asynchronous of [false, true]) {
    const unavailable = () => {
      if (asynchronous) return Promise.reject(new Error('Inspection unavailable'));
      throw new Error('Inspection unavailable');
    };
    globalThis.browser = {
      async waitUntil() { throw failure; },
      $() { return { getText: unavailable, isExisting: unavailable }; },
    };
    await assert.rejects(archiveClosedTopic('topic'), error => {
      assert.equal(error.cause, failure);
      assert.equal(error.message, `${failure.message}\nTree column text: (unavailable)\nDialog exists: (unavailable)`);
      return true;
    });
  }
});

test('history choice and Send wait for both native enabled and refresh aria-disabled to clear', async t => {
  const previousBrowser = globalThis.browser;
  t.after(() => { globalThis.browser = previousBrowser; });
  let enabled = false, frozen = true;
  const admitted = [];
  globalThis.browser = { async waitUntil(condition, options) {
    assert.equal(options.timeout, 60000);
    admitted.push(await condition());
    enabled = true; admitted.push(await condition());
    frozen = false; admitted.push(await condition());
    assert.equal(admitted.at(-1), true);
  } };
  await waitForHistoryControl({ async waitForEnabled() {}, async isEnabled() { return enabled; },
    async getAttribute(name) { assert.equal(name, 'aria-disabled'); return frozen ? 'true' : null; } }, 'round choice');
  assert.deepEqual(admitted, [false, false, true]);
});

test('fork links and parent references cannot admit a different selected history item', async t => {
  const child = { id: '1.1', question: 'Native history fork 1.1\nKeep its original source round.', source_round_id: 'round-one' };
  const parent = { id: '1', question: 'Retain five complete native rounds and their forks.\nThis question remains unchanged.', source_round_id: null };
  const dom = new JSDOM();
  const previousBrowser = globalThis.browser, previousDocument = globalThis.document;
  t.after(() => { globalThis.browser = previousBrowser; globalThis.document = previousDocument; dom.window.close(); });
  globalThis.document = dom.window.document;
  // Selection uses the canonical article ID and complete title tooltip, even when
  // other items appear as child, location or creation-message fork links.
  const view = (header, question, nested, visible = question) => {
    const title = document.createElement('h2');
    title.className = 'detail-question'; title.setAttribute('title', question); title.textContent = visible;
    return `<article class="item-detail" data-detail-item-id="${header}"><div class="detail-head">${title.outerHTML}</div>${nested}</article>`;
  };
  const views = [
    view(parent.id, parent.question, `<section aria-label="Child items"><button class="detail-kid">${child.question}</button></section>
      <section class="detail-chat" aria-label="Conversation"><ol class="detail-chat-list"><li class="detail-turn" data-message-id="ask" data-round="1"></li><li class="detail-turn" data-message-id="fork-created"><button class="detail-fork">${child.question}</button></li></ol></section>`),
    view(child.id, parent.question, ''),
    view(parent.id, child.question, ''),
    view(child.id, child.question.split('\n')[0], ''),
    view(child.id, child.question, '', ''),
    view(child.id, child.question, ''),
    view(child.id, child.question, '', child.question.split('\n')[0]),
  ];
  const admitted = [];
  globalThis.browser = {
    execute: async (condition, expected) => condition(expected),
    async waitUntil(condition, options) {
      assert.equal(options.timeout, 60000);
      for (const html of views) { document.body.innerHTML = html; admitted.push(await condition()); }
      assert.equal(admitted.at(-1), true);
    },
  };
  await waitForHistoryItem(child);
  assert.deepEqual(admitted, [false, false, false, false, false, true, true]);
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
    assert.equal(options.timeout, 60000);
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
