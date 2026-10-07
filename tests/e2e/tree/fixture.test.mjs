import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { cliRequest } from '../../../apps/desktop/tests/e2e/scripted-provider.mjs';
import { choose, observeTreeClickReadiness, publishTreeRequest, treeBatch, treeClickReadinessStatus, treeMessageBatch } from '../../../apps/desktop/tests/e2e/tree.spec.mjs';

for (const target of ['filter', 'session']) test(`${target} click readiness requires the same enabled hit target and stable nested geometry without clicking`, () => {
  const frames = new Map(), listeners = new Map(), scrolls = [];
  let nextFrame = 0, rect = { top: 200, bottom: 220, left: 400, right: 440, width: 40, height: 20 };
  const parent = { scrollLeft: 0, scrollTop: 0, parentElement: null };
  const button = { textContent: 'Me', disabled: false, isConnected: true, parentElement: parent, outerHTML: '<button>Me</button>',
    scrollIntoView: options => { scrolls.push(options); if (rect.top > 700) rect = { ...rect, top: 200, bottom: 220 }; }, getBoundingClientRect: () => ({ ...rect }),
    getAttribute: () => 'false', contains: value => value === button };
  let named = button, hit = button;
  const document = {
    visibilityState: 'visible', hidden: false, hasFocus: () => true,
    querySelector: selector => {
      assert.equal(selector, target === 'filter' ? '[aria-label="Item owner"]' : '[data-session-id="fixture"]');
      return target === 'filter' ? { querySelectorAll: () => [named] } : named;
    },
    elementFromPoint: () => hit,
    addEventListener: (type, listener, capture) => { assert.equal(capture, true); listeners.set(type, listener); },
    removeEventListener: (type, listener) => { assert.equal(listeners.get(type), listener); listeners.delete(type); },
  };
  const window = { innerWidth: 1000, innerHeight: 700, requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: id => frames.delete(id) };
  // Exercise the same self-contained callback WebDriver serializes; this proves
  // readiness admission only, not native rendering or OS input acceptance.
  runInNewContext(`(${observeTreeClickReadiness.toString()})(button, 'Item owner', 'Me', true, selector)`,
    { window, document, button, selector: target === 'session' ? '[data-session-id="fixture"]' : null });
  const state = window.__ariadneTreeFilterAction;
  const status = () => runInNewContext(`(${treeClickReadinessStatus.toString()})(true)`, { window, document });
  assert.equal(state.readiness.callbacks, 0); assert.equal(state.readiness.callbackError, null);
  assert.equal(state.readiness.visibilityState, 'visible'); assert.equal(state.readiness.hidden, false); assert.equal(state.readiness.hasFocus, true);
  const frame = () => { const [id, callback] = frames.entries().next().value; frames.delete(id); callback(); };
  frame(); assert.equal(state.readiness.ready, false); frame(); assert.equal(state.readiness.ready, true);
  rect = { ...rect, top: 210, bottom: 230 };
  frame(); assert.equal(state.readiness.ready, false); frame(); assert.equal(state.readiness.ready, true);
  parent.scrollTop = 20;
  frame(); assert.equal(state.readiness.ready, false); frame(); assert.equal(state.readiness.ready, true);
  for (const change of [
    () => { button.disabled = true; },
    () => { button.isConnected = false; },
    () => { named = { ...button }; },
    () => { hit = parent; },
  ]) {
    change(); frame(); assert.equal(state.readiness.ready, false); assert.equal(state.readiness.frames, 0);
    button.disabled = false; button.isConnected = true; named = button; hit = button;
    frame(); assert.equal(state.readiness.ready, false); frame(); assert.equal(state.readiness.ready, true);
  }
  assert.equal(scrolls.length, 1); assert.equal(scrolls[0].behavior, 'instant');
  assert.equal(scrolls[0].block, 'center'); assert.equal(scrolls[0].inline, 'center');
  rect = { ...rect, top: 900, bottom: 920 };
  frame(); assert.equal(state.readiness.ready, false); assert.equal(state.readiness.frames, 0);
  assert.equal(state.readiness.recenters, 1); assert.equal(scrolls.length, 2);
  frame(); assert.equal(state.readiness.ready, false); frame(); assert.equal(state.readiness.ready, true);
  hit = parent; frame(); assert.equal(state.readiness.ready, false);
  assert.equal(scrolls.length, 2, 'An overlay over a visible target must not trigger re-centering');
  rect = { ...rect, top: 900, bottom: 920 }; named = { ...button };
  frame(); assert.equal(scrolls.length, 2, 'A replacement target must not trigger re-centering');
  rect = { ...rect, top: 200, bottom: 220 }; named = button; hit = button;
  frame(); frame(); assert.equal(status().ready, true);
  document.visibilityState = 'hidden'; document.hidden = true;
  assert.equal(state.readiness.ready, true, 'Last ready frame remains stale while native animation callbacks pause');
  assert.equal(status().ready, false, 'Live hidden state prevents admission without waiting for another animation frame');
  document.visibilityState = 'visible'; document.hidden = false; document.hasFocus = () => false;
  assert.equal(status().ready, false, 'Live focus loss prevents admission even if the last frame was ready');
  frame(); assert.equal(state.readiness.frames, 0); assert.equal(state.readiness.ready, false);
  assert.equal(state.readiness.connectedNamedTarget, true); assert.equal(state.readiness.enabled, true); assert.equal(state.readiness.centreHit, true);
  document.hasFocus = () => true;
  frame(); assert.equal(state.readiness.ready, false); frame(); assert.equal(state.readiness.ready, true);
  assert.equal(state.click, null, 'Readiness must not generate an input');
  listeners.get('click')({ target: parent, isTrusted: false }); assert.equal(state.click, null);
  listeners.get('click')({ target: button, isTrusted: true }); assert.equal(state.click.trusted, true);
  document.visibilityState = 'hidden'; document.hidden = true; document.hasFocus = () => false;
  frame(); assert.equal(state.readiness.visibilityState, 'hidden'); assert.equal(state.readiness.hasFocus, false);
  assert.equal(state.readiness.ready, false); assert.equal(state.readiness.frames, 0);
  assert.ok(state.readiness.callbacks > 0); assert.equal(state.readiness.callbackError, null);
  document.elementFromPoint = () => { throw new Error('native hit-test diagnostic failure'); };
  frame();
  assert.equal(state.readiness.ready, false); assert.equal(state.readiness.callbackError.message, 'native hit-test diagnostic failure');
  assert.match(state.readiness.callbackError.stack, /native hit-test diagnostic failure/);
  assert.equal(status().ready, false); assert.equal(status().callbackError.message, 'native hit-test diagnostic failure');
  window.__ariadneTreeFilterCleanup(); assert.equal(frames.size, 0); assert.equal(listeners.size, 0);
});

for (const scenario of ['focused', 'unfocused', 'hidden', 'activation_error', 'focus_timeout', 'readiness_error']) {
  test(`untimed filter choice prepares owned focus once and preserves one click: ${scenario}`, async () => {
    const calls = [], environment = { ARIADNE_E2E_ROOT: '/private/fixture', ARIADNE_E2E_BINARY: '/private/fixture/App', ARIADNE_E2E_NONCE: 'owned' };
    const document = { visibilityState: scenario === 'hidden' ? 'hidden' : 'visible', hidden: scenario === 'hidden', hasFocus: () => scenario === 'focused' || scenario === 'readiness_error' };
    const window = { __ariadneTreeFilterCleanup: () => calls.push('cleanup') };
    const button = { waitForClickable: async () => { calls.push('clickable'); }, click: async () => { calls.push('click'); },
      getAttribute: async () => 'true', isEnabled: async () => true };
    // Run the actual orchestration with observed browser/OS boundaries; this
    // checks input ordering and rejection, not real macOS activation or rendering.
    const context = {
      process: { env: environment },
      browser: {
        $: () => ({ $: async () => button }),
        execute: async callback => {
          if (callback === observeTreeClickReadiness) { calls.push('observe'); return; }
          return runInNewContext(`(${callback.toString()})()`, { document, window });
        },
      },
      observeTreeClickReadiness,
      activateOwned: async (...args) => {
        assert.deepEqual(args, Object.values(environment)); calls.push('activate');
        if (scenario === 'activation_error') throw new Error('Owned activation rejected');
        if (scenario !== 'focus_timeout') { document.visibilityState = 'visible'; document.hidden = false; document.hasFocus = () => true; }
      },
      wait: async (condition, message) => { calls.push('wait'); if (!await condition()) throw new Error(message); },
      waitClickReadiness: async (_message, admit) => {
        assert.equal(admit, true); calls.push('ready');
        if (scenario === 'readiness_error') throw new Error('Native readiness callback failed');
      },
    };
    const action = runInNewContext(`(${choose.toString()})('Item status', 'Open', true)`, context);
    if (scenario === 'activation_error') { await assert.rejects(action, /Owned activation rejected/); assert.deepEqual(calls, ['activate']); }
    else if (scenario === 'focus_timeout') { await assert.rejects(action, /did not become visible and focused before filtering/); assert.deepEqual(calls, ['activate', 'wait']); }
    else if (scenario === 'readiness_error') { await assert.rejects(action, /Native readiness callback failed/); assert.deepEqual(calls, ['clickable', 'observe', 'ready', 'cleanup']); }
    else {
      await action;
      assert.deepEqual(calls, [...(scenario === 'focused' ? [] : ['activate', 'wait']), 'clickable', 'observe', 'ready', 'click', 'wait', 'cleanup']);
    }
  });
}

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
    assert.deepEqual(await publishTreeRequest(configuration, request, true), { request, receipt: { session_id: 'session' } });
    const repeated = await calls(); assert.equal(repeated.length, 3);
    assert.ok(repeated.every(call => JSON.stringify(call) === JSON.stringify(repeated[0])));
    assert.deepEqual(repeated[0].request, request); assert.ok(repeated[0].args.includes('--json'));
    for (const failure of ['revision_conflict', 'commit_uncertain', 'store_io', 'binding_mismatch', 'store_busy']) {
      await script(failure === 'store_busy' ? [failure, failure, failure] : [failure]);
      await assert.rejects(publishTreeRequest(configuration, request, true), new RegExp(failure));
      assert.equal((await calls()).length, failure === 'store_busy' ? 3 : 1);
    }
    await script(['store_busy', 'revision_conflict']);
    await assert.rejects(publishTreeRequest(configuration, request, true), /revision_conflict/); assert.equal((await calls()).length, 2);
    await script(['store_busy']);
    await assert.rejects(publishTreeRequest(configuration, request), /store_busy/); assert.equal((await calls()).length, 1, 'Live edit defaults to one attempt');
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
    const sessionPath = join(home, 'projects', demo.value.data.project_id, 'sessions',`${demo.value.data.session_id}.json`);
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
