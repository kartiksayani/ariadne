import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { admissions, awaitConnected, cliRequest, snapshot } from './scripted-provider.mjs';
import { installSearchTimingObservation, takeSearchTimingObservation } from './search-timing-observation.mjs';
import { openSessionButton } from './session-button.mjs';
import { activateOwned, identity } from '../../../../scripts/run-native-e2e.mjs';

const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const wait = (condition, message) => browser.waitUntil(condition, { timeout: 20000, interval: 100, timeoutMsg: message });
const row = id => browser.$(`.tree-rows [data-item-id="${id}"]`);
const search = () => browser.$('[data-shell-search]');
// Types the text, then waits until the debounced preference write has made it durable.
async function setSearch(tree, value) {
  const input = await search(); await input.waitForEnabled(); await input.setValue(value);
  await wait(async () => (await preferences(tree)).view.filters.search === value, 'Search text was not durably saved');
}
const applyRequest = operations => ({ op_id: randomUUID(), source_input_id: null, attempt_id: null,
  expected_item_revisions: {}, expected_topic_revisions: {}, summary: '', operations, input_result: null });
async function apply(configuration, operations, expectedItemRevisions = {}, summary = '', setup = false) {
  const request = { ...applyRequest(operations), expected_item_revisions: expectedItemRevisions, summary };
  return publishTreeRequest(configuration, request, setup);
}
export async function publishTreeRequest(configuration, request, setup = false) {
  assert.ok(Buffer.byteLength(JSON.stringify(request)) < 512 * 1024, 'Every real CLI request remains within its protocol limit');
  const args = ['apply', '--binding', configuration.bindingId, '--generation', configuration.generation, '--json-stdin', '--full', '--json'];
  const before = await snapshot(configuration), rejections = [];
  const maximumRetries = setup ? 2 : 0;
  for (let retry = 0; retry <= maximumRetries; retry++) {
    const started = Date.now();
    const result = await cliRequest(configuration.cli, args, request);
    if (result.value.ok === true) {
      assert.equal(result.code, 0); assert.equal(result.value.data.session_id, configuration.sessionId);
      return { request, receipt: result.value.data };
    }
    const elapsedMs = Date.now() - started, after = await snapshot(configuration); rejections.push({ retry, elapsedMs, result, after });
    await writeFile(join(process.env.ARIADNE_E2E_EVIDENCE, `tree-apply-${request.op_id}-failure.json`), JSON.stringify({ args, request, before, rejections }, null, 2));
    // StoreBusy is a definitive lock-acquisition rejection before the batch
    // callback. Only setup may repeat this exact frozen operation; uncertain
    // writes, revision conflicts and every other error remain failures.
    assert.ok(!after.operation_receipts[request.op_id], 'Rejected tree setup must have no saved receipt for this operation');
    if (result.value.error.code !== 'store_busy' || retry === maximumRetries) {
      if (result.value.error.code === 'store_busy' && process.env.ARIADNE_E2E_ROOT) await captureBusy(configuration);
      assert.fail(result.output);
    }
  }
  assert.fail('Bounded tree setup publication did not complete');
}
async function captureBusy(configuration) {
  const evidence = process.env.ARIADNE_E2E_EVIDENCE, facts = {};
  try {
    const owned = await readJson(join(process.env.ARIADNE_E2E_ROOT, 'observed.json')), current = identity(owned.pid);
    assert.equal(current.exe, process.env.ARIADNE_E2E_BINARY); assert.equal(current.birth, owned.birth); facts.owned = owned;
    const lock = join(process.env.ARIADNE_HOME, 'projects', configuration.projectId, 'locks', `${configuration.sessionId}.lock`);
    try { facts.lockHolder = execFileSync('/usr/sbin/lsof', ['-nP', lock], { encoding: 'utf8', timeout: 5000 }); }
    catch (error) { facts.lockHolderError = error.message; }
    execFileSync('/usr/bin/sample', [String(owned.pid), '1', '-file', join(evidence, 'native-app-busy-sample.txt')], { encoding: 'utf8', timeout: 5000 });
    const probes = [ ['read', '--binding', configuration.bindingId, '--generation', configuration.generation, '--view', 'items', '--limit', '1', '--json'],
      ['preferences', 'get', '--json'] ];
    facts.reads = [];
    for (const args of probes) {
      const started = Date.now(), result = await cliRequest(configuration.cli, args, undefined);
      facts.reads.push({ args, elapsedMs: Date.now() - started, result });
    }
  } catch (error) { facts.observationError = error.message; }
  await writeFile(join(evidence, 'native-app-busy.json'), JSON.stringify(facts, null, 2));
}
function item(reference, topicId, parent, question, owner) {
  return { op: 'item.add', ref: reference, topic: { id: topicId }, parent, question, type: 'task', status: 'open', owner,
    ask: null, options: null, note: null, links: null, outcome: null, why: null, replaced_by: null, source_round_id: null };
}
// Deterministic content is published through actual CLI/Core/Store, never by
// writing session JSON or replacing the native renderer's service/DOM.
export function treeBatch(topicId, branch) {
  const root = `native_root_${branch}`;
  const operations = [item(root, topicId, null, `Native branch ${branch}\nThe complete branch sentence remains visible.`, { kind: 'other', name: 'Native collaborator' })];
  for (let child = 1; child <= 99; child++) {
    const question = `Native sentence ${branch}.${child}\nFull retained second line for ${branch}.${child}.\nUnique token_${branch}_${child}_end.${branch === 1 && child === 1 ? '\nNative café needle.' : ''}`;
    operations.push(item(`native_child_${branch}_${child}`, topicId, { ref: root }, question,
      child % 2 === 1 ? { kind: 'me' } : { kind: 'other', name: 'Native collaborator' }));
  }
  return operations;
}
// Closed rows are fixture setup, not new unread reports. Finish the existing
// Open items in a later Apply without an acknowledgment target (ADR-0093).
export function treeCompletionBatch(branch) {
  const finish = (id, outcome) => ({ op: 'item.status', item: { id }, status: 'done', outcome,
    why: 'Retain the complete native outcome.', reason: null });
  const operations = [finish(String(branch), `Full terminal outcome ${branch}\nThis second outcome line must remain readable.`)];
  for (let child = 3; child <= 99; child += 3)
    operations.push(finish(`${branch}.${child}`, `Complete child outcome ${branch}.${child}\nKeep this second line too.`));
  return operations;
}
export function treeMessageBatch(first, count) {
  return Array.from({ length: count }, (_, index) => {
    const number = first + index, itemId = `${1 + (number - 1) % 20}.${1 + Math.floor((number - 1) / 20) % 99}`;
    return { op: 'reply', ref: `native_message_${number}`, item: { id: itemId }, round_id: null,
      text: `Native recorded reply ${number}\nFull retained message body for item ${itemId}.\nUnique history_token_${number}_end.` };
  });
}
async function seedTree(configuration) {
  const selected = configuration.tree;
  const registered = await cliRequest(configuration.cli, ['project', 'register', '--json-stdin'], {
    session: null, command: { command: 'project_register', api_version: 1, op_id: randomUUID(), params: { canonical_root: selected.projectRoot } },
  });
  assert.equal(registered.code, 0);
  const projectId = registered.value.data.project_id;
  const connected = await cliRequest(configuration.cli, ['binding', 'connect', '--json-stdin'], {
    session: null, command: { command: 'binding_connect', api_version: 1, op_id: randomUUID(), params: {
      project_id: projectId, adapter_id: 'codex', external_session_id: selected.externalSessionId,
      endpoint: { kind: 'unix_socket', path: selected.socketPath }, configuration: { namespace: 'codex', values: {} }, existing_session_id: null,
    } },
  });
  assert.equal(connected.code, 0);
  const receipt = connected.value.data;
  const tree = { ...selected, cli: configuration.cli, projectId, sessionId: receipt.session_id,
    bindingId: receipt.data.binding_id, generation: receipt.data.generation,
    sessionPath: join(process.env.ARIADNE_HOME, 'projects', projectId, 'sessions', `${receipt.session_id}.json`) };
  await awaitConnected(tree);
  const publication = [await apply(tree, [{ op: 'topic.add', ref: 'native_tree_topic', name: 'Native tree acceptance' }], {}, '', true)];
  const topic = Object.values((await snapshot(tree)).topics).find(topic => topic.name === 'Native tree acceptance'); assert.ok(topic);
  for (let branch = 1; branch <= 20; branch++) {
    publication.push(await apply(tree, treeBatch(topic.id, branch), {}, '', true));
    const created = await snapshot(tree), completion = treeCompletionBatch(branch);
    for (const operation of completion) {
      assert.equal(created.items[operation.item.id].status, 'open');
      assert.equal(created.items[operation.item.id].ack_to ?? null, null);
    }
    const revisions = Object.fromEntries(completion.map(operation => [operation.item.id, created.items[operation.item.id].revision]));
    publication.push(await apply(tree, completion, revisions, '', true));
  }
  let live = await snapshot(tree), nextMessage = 1;
  while (live.messages.length < 5000) {
    // Every nonempty apply adds one genuine activity message as well as its
    // explicit replies. The final activity-only batch closes an exact count.
    const operations = treeMessageBatch(nextMessage, Math.min(100, 5000 - live.messages.length - 1));
    const revisions = Object.fromEntries(operations.map(operation => [operation.item.id, live.items[operation.item.id].revision]));
    publication.push(await apply(tree, operations, revisions, 'Publish complete native message history.', true));
    nextMessage += operations.length; live = await snapshot(tree);
  }
  const session = await snapshot(tree); assert.equal(Object.keys(session.items).length, 2000); assert.equal(Object.keys(session.inputs).length, 0);
  assert.equal(Object.values(session.items).filter(item => item.status === 'open').length, 1320);
  assert.equal(Object.values(session.items).filter(item => item.status === 'done').length, 680);
  assert.ok(Object.values(session.items).every(item => (item.ack_to ?? null) === null));
  assert.equal(session.messages.length, 5000, 'The native performance corpus must meet the complete 2,000-item / 5,000-message target');
  assert.equal(session.bindings[tree.bindingId].external_session_id, selected.externalSessionId);
  tree.topicId = topic.id;
  return { tree, publication, initialSession: session };
}
async function preferences(tree) {
  const result = await cliRequest(tree.cli, ['preferences', 'get', '--json-stdin'], { session: null, request: { command: 'preferences_get', params: {} } });
  assert.equal(result.code, 0);
  const snapshot = result.value.data.data;
  const view = snapshot.sessions.find(view => view.session.project_id === tree.projectId && view.session.session_id === tree.sessionId);
  assert.ok(view); return { snapshot, view };
}
async function visibleIds() {
  // Item rows only; topic bands are tree items without an item id.
  return browser.execute(() => [...document.querySelectorAll('.tree-rows .tree-item')].map(element => element.dataset.itemId));
}
async function focusedId() { return browser.execute(() => document.activeElement?.getAttribute('data-item-id')); }
async function roving() {
  assert.equal(await browser.execute(() => [...document.querySelectorAll('.tree-rows [role="treeitem"]')].filter(element => element.tabIndex === 0).length), 1);
}
async function catalogue() {
  const button = await browser.$('button[data-shell-tab="all_sessions"]'); await button.waitForDisplayed(); await button.waitForEnabled(); await button.click();
  await wait(async () => await button.getAttribute('aria-current') === 'page' && await button.isEnabled(), 'Tree catalogue navigation did not finish its actual preference write');
}
async function open(tree) {
  await catalogue(); const button = await readySessionButton(tree); await button.click();
  await wait(async () => (await visibleIds()).includes('20.99'), 'The real native 2,000-item tree did not open');
}
// Passive WebView measurement starts at the real driver-generated click/input,
// stops after the expected canonical rows render and a layout frame completes.
async function measureAction(eventName, selector, expectedIds, action, tree) {
  await browser.execute(({ eventName, selector, expectedIds }) => {
    const target = document.querySelector(selector), bounds = target?.getBoundingClientRect();
    const sample = { started: null, elapsed: null, target: target ? { disabled: target.disabled,
      bounds: { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      centreTarget: document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.outerHTML.slice(0, 1000) } : null };
    window.__ariadneTreeMeasurement = sample;
    const start = event => { if (event.target.closest(selector)) {
      sample.started = window.performance.now(); sample.trusted = event.isTrusted;
      window.__ariadneSearchTimingObservation?.mark('input');
    } };
    document.addEventListener(eventName, start, true);
    const observer = new window.MutationObserver(() => {
      const ids = [...document.querySelectorAll('.tree-rows .tree-item')].map(element => element.dataset.itemId);
      if (sample.started === null || ids.length !== expectedIds.length || ids.some((id, index) => id !== expectedIds[index])) return;
      observer.disconnect(); document.removeEventListener(eventName, start, true);
      window.__ariadneSearchTimingObservation?.mark('result');
      requestAnimationFrame(() => {
        document.querySelector('.tree-rows')?.getBoundingClientRect(); sample.elapsed = window.performance.now() - sample.started;
        window.__ariadneSearchTimingObservation?.mark('frame');
      });
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  }, { eventName, selector, expectedIds });
  await action();
  try {
    await wait(async () => typeof await browser.execute(() => window.__ariadneTreeMeasurement.elapsed) === 'number', 'Native layout measurement did not reach its exact expected rows');
  } catch (error) {
    const observed = await browser.execute(() => ({ measurement: window.__ariadneTreeMeasurement,
      visibilityState: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus(),
      rows: [...document.querySelectorAll('.tree-rows [role="treeitem"]')].map(element => ({ id: element.dataset.itemId ?? element.dataset.topicId, tabIndex: element.tabIndex })),
      active: document.activeElement?.outerHTML.slice(0, 1000),
      alerts: [...document.querySelectorAll('[role="alert"],.nav-banner')].map(element => element.textContent),
      statuses: [...document.querySelectorAll('[role="status"]')].slice(0, 12).map(element => element.textContent.slice(0, 500)),
      sessions: [...document.querySelectorAll('button[data-session-id]')].map(element => ({ id: element.dataset.sessionId, text: element.textContent, disabled: element.disabled })),
      current: [...document.querySelectorAll('[aria-current]')].map(element => element.outerHTML.slice(0, 1000)) }));
    await writeFile(join(process.env.ARIADNE_E2E_EVIDENCE, 'tree-measurement-failure.json'), JSON.stringify({ eventName, selector, expectedIds,
      observed, preferences: tree ? await cliRequest(tree.cli, ['preferences', 'get', '--json-stdin'],
        { session: null, request: { command: 'preferences_get', params: {} } }) : null }, null, 2));
    await browser.saveScreenshot(join(process.env.ARIADNE_E2E_EVIDENCE, 'tree-measurement-failure.png'));
    throw error;
  }
  return browser.execute(() => { const result = window.__ariadneTreeMeasurement.elapsed; delete window.__ariadneTreeMeasurement; return result; });
}
export function observeTreeClickReadiness(button, group, name, expectedPressed, selector = null) {
  window.__ariadneTreeFilterCleanup?.();
  // Match the driver's own centering before observing readiness. WDIO's wheel
  // scroll returns before nested layout settles; a subsequent driver centering
  // can otherwise change the target after waitForClickable has passed.
  button.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
  const bounds = button.getBoundingClientRect();
  const sample = { text: button.textContent, expectedPressed, priorPressed: button.getAttribute('aria-pressed'), disabled: button.disabled,
    bounds: { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right },
    centreTarget: document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.outerHTML.slice(0, 1000),
    click: null, readiness: { frames: 0, ready: false, callbacks: 0, recenters: 0, callbackError: null,
      visibilityState: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus() } };
  window.__ariadneTreeFilterAction = sample;
  let previous, frame;
  const observe = event => {
    if (!button.contains(event.target)) return;
    sample.click = { trusted: event.isTrusted, target: event.target.outerHTML.slice(0, 1000) };
  };
  document.addEventListener('click', observe, true);
  window.__ariadneTreeFilterCleanup = () => {
    window.cancelAnimationFrame(frame);
    document.removeEventListener('click', observe, true);
    delete window.__ariadneTreeFilterCleanup;
  };
  const inspect = () => {
    sample.readiness.callbacks++;
    sample.readiness.visibilityState = document.visibilityState;
    sample.readiness.hidden = document.hidden;
    sample.readiness.hasFocus = document.hasFocus();
    try {
      const current = selector ? document.querySelector(selector) : [...(document.querySelector(`[aria-label="${group}"]`)?.querySelectorAll('button') ?? [])]
        .find(value => value.textContent.trim() === name);
      const rect = button.getBoundingClientRect(), hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const enabled = !button.disabled && button.getAttribute('aria-disabled') !== 'true';
      const scroll = [];
      for (let parent = button.parentElement; parent; parent = parent.parentElement) scroll.push([parent.scrollLeft, parent.scrollTop]);
      const geometry = { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, scroll };
      sample.readiness.geometry = geometry;
      sample.readiness.connectedNamedTarget = button.isConnected && current === button;
      sample.readiness.enabled = enabled;
      sample.readiness.centreHit = hit !== null && button.contains(hit);
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      if (button.isConnected && current === button && enabled
        && sample.readiness.visibilityState === 'visible' && !sample.readiness.hidden && sample.readiness.hasFocus
        && (x < 0 || x >= window.innerWidth || y < 0 || y >= window.innerHeight)) {
        // Native nested scrolling can settle after the initial centering. Move
        // only the original offscreen target, then require two fresh frames.
        button.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
        sample.readiness.recenters++;
        sample.readiness.frames = 0; sample.readiness.ready = false; previous = undefined;
        frame = window.requestAnimationFrame(inspect); return;
      }
      const valid = sample.readiness.visibilityState === 'visible' && !sample.readiness.hidden && sample.readiness.hasFocus
        && button.isConnected && current === button && enabled && hit !== null && button.contains(hit);
      const signature = JSON.stringify(geometry);
      sample.readiness.frames = valid ? (signature === previous ? sample.readiness.frames + 1 : 1) : 0;
      sample.readiness.ready = sample.readiness.frames >= 2;
      previous = valid ? signature : undefined;
      frame = window.requestAnimationFrame(inspect);
    } catch (error) {
      sample.readiness.frames = 0; sample.readiness.ready = false;
      sample.readiness.callbackError = { message: String(error.message ?? error), stack: error.stack ?? null };
    }
  };
  frame = window.requestAnimationFrame(inspect);
}
export function treeClickReadinessStatus(admit = false) {
  const sample = window.__ariadneTreeFilterAction;
  const callbackError = sample.readiness.callbackError;
  const ready = !callbackError && sample.readiness.ready && document.visibilityState === 'visible' && !document.hidden && document.hasFocus();
  if (ready && admit) sample.admittedReadiness = { ...sample.readiness };
  return { ready, callbackError };
}
async function waitClickReadiness(message, admit = false) {
  let status;
  await wait(async () => {
    status = await browser.execute(treeClickReadinessStatus, admit);
    // WDIO retries a rejected condition until its deadline. End the wait on a
    // captured callback error and propagate it before any owner input instead.
    return status.ready || status.callbackError !== null;
  }, message);
  if (status.callbackError) throw new Error(`Native readiness callback failed: ${status.callbackError.message}`);
}
async function readySessionButton(tree) {
  // WKWebView suspends animation frames while the native App is hidden. Make
  // the genuine owned window visible before readiness and timing begin.
  await activateOwned(process.env.ARIADNE_E2E_ROOT, process.env.ARIADNE_E2E_BINARY, process.env.ARIADNE_E2E_NONCE);
  await wait(() => browser.execute(() => document.visibilityState === 'visible' && !document.hidden && document.hasFocus()),
    'Owned native App did not become visible and focused');
  const selector = `[data-session-id="${tree.sessionId}"]`, button = await openSessionButton(tree.sessionId);
  await browser.execute(observeTreeClickReadiness, button, null, null, null, selector);
  let failure;
  try {
    await waitClickReadiness('Native session target did not become stable and enabled');
  } catch (error) { failure = error;
  } finally {
    try { await browser.execute(() => window.__ariadneTreeFilterCleanup?.()); }
    catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
  return button;
}
// Status chips toggle a set; their names carry a live count, so the chip
// key (all, waiting, open, progress, closed) names the control instead.
export async function choose(chip, pressed) {
  const focused = () => browser.execute(() => document.visibilityState === 'visible' && !document.hidden && document.hasFocus());
  if (!await focused()) {
    await activateOwned(process.env.ARIADNE_E2E_ROOT, process.env.ARIADNE_E2E_BINARY, process.env.ARIADNE_E2E_NONCE);
    await wait(focused, 'Owned native App did not become visible and focused before filtering');
  }
  const selector = `[data-chip="${chip}"]`, find = () => browser.$('[aria-label="Filter items"]').$(selector);
  const button = await find();
  await button.waitForClickable();
  await browser.execute(observeTreeClickReadiness, button, null, null, pressed, selector);
  let failure;
  try {
    await waitClickReadiness('Native filter target did not become stable and enabled', true);
    await button.click();
    await wait(async () => {
      // Reacquire the chip after the saved preference renders instead of
      // observing a possibly replaced DOM element.
      const current = await find();
      return await current.getAttribute('aria-pressed') === String(pressed) && await current.isEnabled();
    }, 'Native filter write was not confirmed');
  } catch (error) { failure = error;
  } finally {
    try { await browser.execute(() => window.__ariadneTreeFilterCleanup?.()); }
    catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
}
export function observeTreeAnchor() {
  // The reading edge is below the visible sticky band. Saved offsets reserve
  // the anchor's own topic height, including when the next topic pushes it up.
  const tree = document.querySelector('.tree-scroll'), top = tree.getBoundingClientRect().top;
  const readingTop = [...tree.querySelectorAll('.tree-topic')].reduce((edge, header) => {
    const rect = header.getBoundingClientRect();
    return rect.top <= top && rect.bottom > top ? Math.max(edge, rect.bottom) : edge;
  }, top);
  const element = [...tree.querySelectorAll('.tree-item')].find(element => element.getBoundingClientRect().bottom > readingTop);
  const header = element.closest('.tree-topic-group').querySelector('.tree-topic');
  return { id: element.dataset.itemId, offset: element.getBoundingClientRect().top - top - header.getBoundingClientRect().height, scrollTop: tree.scrollTop };
}
const anchor = () => browser.execute(observeTreeAnchor);

export async function assertStatusFilters(tree, expectedIds) {
  const chipCount = async chip => Number(await (await browser.$(`[data-chip="${chip}"] .tree-chip-count`)).getText());
  const pressed = async () => browser.execute(() => [...document.querySelectorAll('.tree-filters [data-chip][aria-pressed="true"]')].map(element => element.dataset.chip));
  assert.deepEqual(await Promise.all(['all', 'open', 'closed'].map(chipCount)), [2000, 1320, 680]);
  await choose('open', true); await wait(async () => (await visibleIds()).length === 1340, 'Open chip differs from the canonical fixture');
  assert.deepEqual((await preferences(tree)).view.filters.statuses, ['open']); assert.equal(await chipCount('open'), 1320);
  assert.deepEqual(await pressed(), ['open']);
  await choose('closed', true); await wait(async () => (await visibleIds()).length === 2000, 'Open and Closed together did not restore the complete fixture');
  assert.deepEqual(await visibleIds(), expectedIds);
  assert.deepEqual(await pressed(), ['open', 'closed']);
  assert.deepEqual((await preferences(tree)).view.filters.statuses, ['open', 'decided', 'done', 'dropped', 'replaced']);
  await choose('open', false); await wait(async () => (await visibleIds()).length === 680, 'Closed chip did not keep exactly the terminal items');
  assert.deepEqual(await pressed(), ['closed']);
  assert.deepEqual((await preferences(tree)).view.filters.statuses, ['decided', 'done', 'dropped', 'replaced']);
  await choose('all', true); await wait(async () => (await visibleIds()).length === 2000, 'All chip did not restore every item');
  assert.deepEqual(await visibleIds(), expectedIds); assert.deepEqual(await pressed(), ['all']);
  assert.deepEqual((await preferences(tree)).view.filters.statuses, []);
}
async function completeRowLayout(id, item) {
  // Preview text is deliberately bounded; verify complete native layout after Show more opens it.
  const opened = await browser.execute(id => {
    const row = document.querySelector(`.tree-rows [data-item-id="${id}"]`);
    const more = row.querySelector('.tree-more[aria-expanded="false"]');
    if (more) more.click();
    return !!more;
  }, id);
  if (opened) await wait(async () => await browser.execute(id => document.querySelector(`.tree-rows [data-item-id="${id}"]`)?.hasAttribute('data-open'), id), 'Show more did not expand the complete row');
  const layout = await browser.execute(id => {
    const row = document.querySelector(`.tree-rows [data-item-id="${id}"]`);
    const bounds = element => { const value = element.getBoundingClientRect(); return { top: value.top, bottom: value.bottom, left: value.left, right: value.right, height: value.height }; };
    const parts = ['.tree-question', '.tree-outcome > .tree-clamp'].map(selector => {
      const element = row.querySelector(selector); if (!element) return null;
      const range = document.createRange(); range.selectNodeContents(element);
      const fragments = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0)
        .map(rect => ({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }));
      const containers = [];
      for (let parent = element; parent; parent = parent.parentElement) {
        const style = window.getComputedStyle(parent);
        containers.push({ bounds: bounds(parent), clientHeight: parent.clientHeight, scrollHeight: parent.scrollHeight,
          clientWidth: parent.clientWidth, scrollWidth: parent.scrollWidth,
          lineClamp: style.getPropertyValue('-webkit-line-clamp'), display: style.display, textOverflow: style.textOverflow });
        if (parent === row) break;
      }
      return { text: element.textContent, bounds: bounds(element), fragments, containers,
        lineHeight: Number.parseFloat(window.getComputedStyle(element).lineHeight) };
    });
    return { row: bounds(row), question: parts[0], outcome: parts[1] };
  }, id);
  for (const [name, text] of [['question', item.question], ['outcome', item.outcome]]) {
    if (text === null) continue;
    const part = layout[name]; assert.ok(part); assert.equal(part.text, text);
    assert.ok(part.fragments.length > 0, `${id} ${name} must have actual native text layout`);
    const lines = new Set(part.fragments.map(rect => Math.round(rect.top)));
    assert.ok(lines.size >= text.split('\n').length, `${id} ${name} must retain its complete multiline layout`);
    for (const container of part.containers) {
      // Expanded rows keep both texts whole; short collapsed rows may use the two-line clamp.
      const clamp = Number.parseInt(container.lineClamp, 10);
      assert.ok(container.display !== '-webkit-box' || !clamp || (clamp === 2 && lines.size <= clamp), `${id} ${name} must not fold any of its lines`);
      assert.notEqual(container.textOverflow, 'ellipsis', `${id} ${name} must not truncate with an ellipsis`);
      assert.ok(container.scrollHeight <= container.clientHeight + 1 && container.scrollWidth <= container.clientWidth + 1,
        `${id} ${name} must fit every containing row box without overflow`);
      for (const fragment of part.fragments) assert.ok(fragment.top >= container.bounds.top - 1 && fragment.bottom <= container.bounds.bottom + 1
        && fragment.left >= container.bounds.left - 1 && fragment.right <= container.bounds.right + 1,
      `${id} ${name} text fragments must fit inside their native row and content bounds`);
    }
  }
  return layout;
}
async function isolated(configuration, original, journal, demoBytes) {
  assert.deepEqual(await snapshot(configuration), original);
  assert.deepEqual(await admissions(configuration), journal); assert.equal(journal.length, 5);
  assert.deepEqual(await readFile(configuration.demo.sessionPath), demoBytes);
}

export async function runTreeAcceptance(configuration) {
  try { await treeAcceptance(configuration); }
  catch (error) {
    // Observe the original failure once, without changing or replaying an
    // owner action. Later filter/reveal/anchor failures need the same evidence
    // as the measured opening, before the existing teardown removes the App.
    try {
      const observed = await browser.execute(() => ({
        viewport: { width: window.innerWidth, height: window.innerHeight },
        visibilityState: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus(),
        measurement: window.__ariadneTreeMeasurement, filterAction: window.__ariadneTreeFilterAction,
        rows: [...document.querySelectorAll('.tree-rows [role="treeitem"]')].slice(0, 2000)
          .map(element => ({ id: element.dataset.itemId ?? element.dataset.topicId, tabIndex: element.tabIndex })),
        active: document.activeElement?.outerHTML.slice(0, 1000),
        alerts: [...document.querySelectorAll('[role="alert"],.nav-banner')].slice(0, 12).map(element => element.textContent.slice(0, 500)),
        statuses: [...document.querySelectorAll('[role="status"]')].slice(0, 12).map(element => element.textContent.slice(0, 500)),
        current: [...document.querySelectorAll('[aria-current]')].slice(0, 12).map(element => element.outerHTML.slice(0, 1000)),
        controls: [...document.querySelectorAll('.tree-filters button,.tree-filters select,[data-shell-search],button[data-session-id]')].slice(0, 40).map(element => {
          const bounds = element.getBoundingClientRect();
          return { text: element.textContent.slice(0, 200), sessionId: element.dataset.sessionId, disabled: element.disabled,
            pressed: element.getAttribute('aria-pressed'), bounds: { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right },
            centreTarget: document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.outerHTML.slice(0, 1000) };
        }) }));
      const path = join(process.env.ARIADNE_E2E_EVIDENCE, 'tree-journey-failure.json');
      await writeFile(path, JSON.stringify({ error: error.message, observed }, null, 2));
      await browser.saveScreenshot(join(process.env.ARIADNE_E2E_EVIDENCE, 'tree-journey-failure.png'));
      const saved = await cliRequest(configuration.cli, ['preferences', 'get', '--json-stdin'],
        { session: null, request: { command: 'preferences_get', params: {} } });
      await writeFile(path, JSON.stringify({ error: error.message, observed, preferences: saved }, null, 2));
    } catch (observationError) { console.error('Tree failure observation failed:', observationError.message); }
    throw error;
  }
}
async function treeAcceptance(configuration) {
  const viewport = await browser.execute(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const nativeWindow = await browser.execute(async () => {
    try {
      const physical = await window.__TAURI_INTERNALS__.invoke('plugin:window|outer_size', { label: 'main' });
      const scaleFactor = await window.__TAURI_INTERNALS__.invoke('plugin:window|scale_factor', { label: 'main' });
      return { ok: true, physical, scaleFactor, logical: { width: physical.width / scaleFactor, height: physical.height / scaleFactor } };
    } catch (error) { return { ok: false, message: String(error) }; }
  });
  await writeFile(join(process.env.ARIADNE_E2E_EVIDENCE, 'native-tree-window.json'), JSON.stringify({ viewport, nativeWindow }, null, 2));
  assert.equal(nativeWindow.ok, true, nativeWindow.message);
  assert.ok(nativeWindow.logical.width >= 1300 && nativeWindow.logical.height >= 760,
    'Native tree acceptance must use the supported minimum outer-window size');
  const original = await snapshot(configuration), journal = await admissions(configuration), demoBytes = await readFile(configuration.demo.sessionPath);
  const { tree, publication, initialSession } = await seedTree(configuration);
  await writeFile(join(process.env.ARIADNE_E2E_EVIDENCE, 'tree-publication.json'), JSON.stringify({ tree, publication, initialSession }, null, 2));
  // Discover real CLI publication through the App's normal catalogue/event
  // refresh. A document reload is unnecessary and races the native driver.
  await catalogue();
  const expectedIds = Array.from({ length: 20 }, (_, index) => [String(index + 1), ...Array.from({ length: 99 }, (_, child) => `${index + 1}.${child + 1}`)]).flat();
  const sessionButton = await readySessionButton(tree);
  const usableMs = await measureAction('click', `[data-session-id="${tree.sessionId}"]`, expectedIds, () => sessionButton.click(), tree);
  assert.deepEqual(await visibleIds(), expectedIds); await roving();
  // Root items sit under their topic band (aria-level 1).
  assert.equal(await (await row('1')).getAttribute('aria-level'), '2'); assert.equal(await (await row('1.1')).getAttribute('aria-level'), '3');
  const initialLayouts = await Promise.all(['1', '1.1', '1.3'].map(id => completeRowLayout(id, initialSession.items[id])));
  await browser.saveScreenshot(join(process.env.ARIADNE_E2E_EVIDENCE, 'native-tree-2000.png'));

  const searchMs = [];
  const measuredIds = ['1.1', '20.99', '10.50', '2.10', '15.25', '5.60',
    ...Array.from({ length: 14 }, (_, index) => `${index + 3}.${1 + (index * 17) % 99}`)];
  const timingInstallation = await browser.execute(installSearchTimingObservation);
  let searchFailure;
  try {
    for (const id of measuredIds) {
      searchMs.push(await measureAction('input', '[data-shell-search]', [id.split('.')[0], id], async () => { const input = await search(); await input.waitForEnabled(); await input.setValue(`Native token_${id.replace('.', '_')}_end`); }, tree));
    }
  } catch (error) { searchFailure = error;
  } finally {
    try {
      const observation = await browser.execute(takeSearchTimingObservation);
      await writeFile(join(process.env.ARIADNE_E2E_EVIDENCE, 'tree-search-timing-observation.json'), JSON.stringify({ installation: timingInstallation, ...observation }, null, 2));
    } catch (error) { searchFailure ??= error; }
  }
  if (searchFailure) throw searchFailure;
  await writeFile(join(process.env.ARIADNE_E2E_EVIDENCE, 'tree-performance-samples.json'), JSON.stringify({ rows: 2000,
    messages: initialSession.messages.length, viewport, firstUsableMs: usableMs, localSearchSamplesMs: searchMs }, null, 2));
  await setSearch(tree, 'ＮＡＴＩＶＥ café needle');
  await wait(async () => JSON.stringify(await visibleIds()) === JSON.stringify(['1', '1.1']), 'NFKC/lowercase AND-token search did not retain the contextual ancestor');
  assert.equal((await snapshot(tree)).items['1.1'].question, initialSession.items['1.1'].question, 'Search normalization must not rewrite stored text');
  await setSearch(tree, ''); await wait(async () => (await visibleIds()).length === 2000, 'Clear search did not restore the complete tree');
  // Chip counts follow the search and topic, never the chip itself. Open keeps
  // its 1,320 matches plus the 20 done roots as context; Closed matches 680 rows.
  await assertStatusFilters(tree, expectedIds);

  // The detail heading folds the stored line breaks in rendered text, so its DOM text carries the complete question.
  const heading = () => browser.$('[aria-label="Item detail"] .detail-question');
  await (await row('1')).click(); await wait(async () => await heading().isDisplayed()
    && await browser.execute(element => element.textContent, await heading()) === initialSession.items['1'].question, 'Native tree selection did not use full registered item detail');
  const firstToggle = await (await row('1')).$('button[aria-label="Expand or collapse"]');
  await firstToggle.waitForEnabled(); await firstToggle.click();
  await wait(async () => !(await preferences(tree)).view.expanded_item_ids.includes('1'), 'Explicit collapse was not persisted');
  await setSearch(tree, 'ＮＡＴＩＶＥ café needle');
  await wait(async () => (await visibleIds()).includes('1.1'), 'Filtered context must temporarily expose its ancestry');
  await (await search()).waitForEnabled();
  const beforeReveal = (await preferences(tree)).view;
  const child = await browser.$('[aria-label="Child items"]').$(`button*=${initialSession.items['1.2'].question.split('\n')[0]}`); await child.waitForDisplayed(); await child.click();
  await wait(async () => (await browser.$('.tree-column').getText()).includes('Showing an item outside your current filters.'), 'Detail child reveal did not preserve the filter and expose an outside-filter row');
  assert.equal(await focusedId(), '1.2');
  const revealed = (await preferences(tree)).view;
  assert.deepEqual(revealed.filters, beforeReveal.filters); assert.deepEqual(revealed.expanded_item_ids, beforeReveal.expanded_item_ids);
  await browser.$('button=Resume filtered view').click();
  await wait(async () => JSON.stringify(await visibleIds()) === JSON.stringify(['1', '1.1']), 'Resume must remove only temporary outside-filter reveal');
  await (await search()).waitForEnabled(); await (await row('1.1')).click(); await wait(async () => (await preferences(tree)).view.selected_item_id === '1.1', 'Selected item preference did not persist');
  const beforeKeys = (await preferences(tree)).view;
  // Home lands on the topic band (no item id); l steps into its first row.
  for (const [key, id] of [['ArrowUp', '1'], ['j', '1.1'], ['k', '1'], ['End', '1.1'], ['Home', null], ['l', '1'], ['l', '1.1'], ['h', '1']]) {
    await browser.keys(key); assert.equal(await focusedId(), id); await roving();
  }
  assert.equal((await preferences(tree)).view.selected_item_id, beforeKeys.selected_item_id, 'Focus movement alone must not select or mutate preferences');
  await (await search()).waitForEnabled(); await browser.keys('Enter'); await wait(async () => (await preferences(tree)).view.selected_item_id === '1', 'Keyboard Enter did not select through the registered reveal route');
  await (await search()).waitForEnabled(); await (await row('1.1')).click();
  await wait(async () => (await preferences(tree)).view.selected_item_id === '1.1', 'The explicit selection must finish before the separate Later key');
  await (await search()).waitForEnabled(); await browser.keys('z');
  await wait(async () => (await preferences(tree)).snapshot.later.some(value => value.session_id === tree.sessionId && value.item_id === '1.1'), 'Later keyboard action did not persist canonical local preferences');
  // A plain selection outside new filters stays as its own row with its
  // ancestry; only a reveal raises the banner (Ariadne.dc.html:2169).
  await setSearch(tree, 'No canonical native tree question matches this phrase');
  await wait(async () => JSON.stringify(await visibleIds()) === JSON.stringify(['1', '1.1']), 'The selected item must stay visible under a search it does not match');
  assert.equal(await browser.$('button=Resume filtered view').isExisting(), false);
  await setSearch(tree, '');
  await wait(async () => (await visibleIds()).length === 1901, 'Clearing the search must preserve the saved collapsed branch');

  // Reopen the explicitly collapsed branch through its visible toggle, then
  // collapse a different branch so restart can prove this exact saved choice.
  const reopenToggle = await (await row('1')).$('button[aria-label="Expand or collapse"]');
  await reopenToggle.waitForEnabled(); await reopenToggle.click();
  await wait(async () => (await visibleIds()).length === 2000, 'Explicit re-expansion did not restore children');
  await (await row('2')).scrollIntoView(); const secondToggle = await (await row('2')).$('button[aria-label="Expand or collapse"]');
  await secondToggle.waitForEnabled(); await secondToggle.click();
  await wait(async () => !(await preferences(tree)).view.expanded_item_ids.includes('2'), 'Second explicit collapse was not persisted');
  await (await search()).waitForEnabled();
  // Centre the driver target below the sticky band before the click. Selecting
  // an already visible tree row must keep this reading position.
  const anchorRow = await row('10.50');
  await browser.execute(observeTreeClickReadiness, anchorRow, null, null, null, '.tree-rows [data-item-id="10.50"]');
  try { await waitClickReadiness('The visible anchor row did not settle below its sticky header'); }
  finally { await browser.execute(() => window.__ariadneTreeFilterCleanup?.()); }
  const beforeSelection = await anchor(); await anchorRow.click();
  await wait(async () => (await preferences(tree)).view.selected_item_id === '10.50', 'The anchor selection must finish before the real CLI live edit');
  assert.equal((await anchor()).scrollTop, beforeSelection.scrollTop, 'A click inside the tree must not scroll it');
  await (await search()).waitForEnabled();
  const beforeEdit = await anchor(); assert.ok(beforeEdit.scrollTop > 0);
  const live = await snapshot(tree), longer = `${live.items['1'].question}\n${'A complete upstream sentence wraps across the native row. '.repeat(40)}`;
  const beforeRowLayout = await completeRowLayout('1', live.items['1']);
  const edit = await apply(tree, [{ op: 'item.edit', item: { id: '1' }, patch: { question: longer } }], { 1: live.items['1'].revision });
  // `longer` ends in a space that pre-line rendering drops, so the row's DOM question text is compared.
  await wait(async () => await browser.execute(element => element.querySelector('.tree-question')?.textContent, await row('1')) === longer, 'Real CLI edit did not reach the native shared session');
  const afterRowLayout = await completeRowLayout('1', { ...live.items['1'], question: longer });
  assert.ok(afterRowLayout.row.height - beforeRowLayout.row.height >= Math.max(64, 2 * beforeRowLayout.question.lineHeight),
    'The real upstream edit must materially grow its native row before it can prove scroll anchoring');
  const afterEdit = await anchor(); assert.equal(afterEdit.id, beforeEdit.id); assert.ok(Math.abs(afterEdit.offset - beforeEdit.offset) <= 2, 'Live wrapped-row growth must preserve the actual visible scroll anchor');
  assert.equal(await focusedId(), '10.50', 'Live update must not steal native keyboard focus');
  await (await search()).waitForEnabled(); await (await search()).click();
  await wait(async () => (await preferences(tree)).view.scroll?.item_id === afterEdit.id, 'Native blur did not persist the scroll anchor');
  await (await search()).waitForEnabled();
  const saved = await preferences(tree), finalSession = await snapshot(tree);
  assert.equal(Object.keys(finalSession.items).length, 2000); assert.equal(Object.keys(finalSession.inputs).length, 0);
  assert.ok(saved.snapshot.later.some(value => value.session_id === tree.sessionId && value.item_id === '1.1'));
  assert.ok(!saved.view.expanded_item_ids.includes('2')); assert.equal(saved.view.filters.search, '');
  await isolated(configuration, original, journal, demoBytes);
  const performance = { environment: 'Actual embedded WKWebView with real Core/Store', rows: 2000, messages: initialSession.messages.length, firstUsableMs: usableMs,
    localSearchSamplesMs: searchMs, localSearchP95Ms: [...searchMs].sort((a, b) => a - b)[Math.ceil(searchMs.length * 0.95) - 1], targets: { firstUsableMs: 2000, localSearchP95Ms: 150 } };
  await writeFile(join(process.env.ARIADNE_E2E_EVIDENCE, 'tree-acceptance.json'), JSON.stringify({ tree, publication, edit, finalSession, savedView: saved.view, savedLater: saved.snapshot.later,
    initialLayouts, beforeRowLayout, afterRowLayout, beforeEdit, afterEdit, performance, originalAdmissions: journal.length }, null, 2));
  await browser.saveScreenshot(join(process.env.ARIADNE_E2E_EVIDENCE, 'native-tree-anchor.png'));
}

export async function restoreTreeAcceptance(configuration) {
  const prior = await readJson(join(process.env.ARIADNE_E2E_PRIOR_EVIDENCE, 'tree-acceptance.json')), { tree } = prior;
  const original = await snapshot(configuration), journal = await admissions(configuration), demoBytes = await readFile(configuration.demo.sessionPath);
  await open(tree); await wait(async () => await (await row('2')).getAttribute('aria-expanded') === 'false', 'Relaunch did not restore the explicit branch collapse');
  assert.equal((await visibleIds()).length, 1901); await roving();
  const restored = await preferences(tree);
  assert.deepEqual(restored.view.filters, prior.savedView.filters); assert.deepEqual(restored.view.expanded_item_ids, prior.savedView.expanded_item_ids);
  assert.equal(restored.view.selected_item_id, prior.savedView.selected_item_id); assert.deepEqual(restored.view.scroll, prior.savedView.scroll);
  assert.deepEqual(restored.snapshot.later.filter(value => value.session_id === tree.sessionId), prior.savedLater.filter(value => value.session_id === tree.sessionId));
  const actualAnchor = await anchor(); assert.equal(actualAnchor.id, prior.savedView.scroll.item_id); assert.ok(Math.abs(actualAnchor.offset - prior.savedView.scroll.offset) <= 2);
  assert.deepEqual(await snapshot(tree), prior.finalSession); assert.equal(Object.keys((await snapshot(tree)).inputs).length, 0);
  await isolated(configuration, original, journal, demoBytes);
  await browser.saveScreenshot(join(process.env.ARIADNE_E2E_EVIDENCE, 'native-tree-restored.png'));
  await writeFile(join(process.env.ARIADNE_E2E_EVIDENCE, 'tree-restoration.json'), JSON.stringify({ tree, restoredView: restored.view, actualAnchor, noInputs: true, originalAdmissions: journal.length }, null, 2));
}
