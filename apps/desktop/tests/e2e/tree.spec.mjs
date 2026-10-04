import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { admissions, cliRequest, snapshot } from './scripted-provider.mjs';

const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const wait = (condition, message) => browser.waitUntil(condition, { timeout: 20000, interval: 100, timeoutMsg: message });
const row = id => browser.$(`.sentence-rows [data-item-id="${id}"]`);
const search = () => browser.$('.sentence-search input');
const applyRequest = operations => ({ op_id: randomUUID(), source_input_id: null, attempt_id: null,
  expected_item_revisions: {}, expected_topic_revisions: {}, summary: '', operations, input_result: null });
async function apply(configuration, operations, expectedItemRevisions = {}) {
  const request = { ...applyRequest(operations), expected_item_revisions: expectedItemRevisions };
  assert.ok(Buffer.byteLength(JSON.stringify(request)) < 512 * 1024, 'Every real CLI request remains within its protocol limit');
  const result = await cliRequest(configuration.cli, ['apply', '--binding', configuration.bindingId, '--generation', configuration.generation, '--json-stdin'], request);
  assert.equal(result.code, 0); assert.equal(result.value.session_id, configuration.sessionId);
  return { request, receipt: result.value };
}
function item(reference, topicId, parent, question, status, owner, outcome = null) {
  return { op: 'item.add', ref: reference, topic: { id: topicId }, parent, question, type: 'task', status, owner,
    ask: null, options: null, note: null, links: null, outcome, why: outcome === null ? null : 'Retain the complete native outcome.', replaced_by: null, source_round_id: null };
}
// Deterministic content is published through actual CLI/Core/Store, never by
// writing session JSON or replacing the native renderer's service/DOM.
export function treeBatch(topicId, branch) {
  const root = `native_root_${branch}`;
  const operations = [item(root, topicId, null, `Native branch ${branch}\nThe complete branch sentence remains visible.`, 'done', { kind: 'other', name: 'Native collaborator' },
    `Full terminal outcome ${branch}\nThis second outcome line must remain readable.`)];
  for (let child = 1; child <= 99; child++) {
    const done = child % 3 === 0;
    const question = `Native sentence ${branch}.${child}\nFull retained second line for ${branch}.${child}.\nUnique token_${branch}_${child}_end.${branch === 1 && child === 1 ? '\nNative café needle.' : ''}`;
    operations.push(item(`native_child_${branch}_${child}`, topicId, { ref: root }, question, done ? 'done' : 'open',
      child % 2 === 1 ? { kind: 'me' } : { kind: 'other', name: 'Native collaborator' }, done ? `Complete child outcome ${branch}.${child}\nKeep this second line too.` : null));
  }
  return operations;
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
    sessionPath: join(selected.projectRoot, '.ariadne/sessions', `${receipt.session_id}.json`) };
  const publication = [await apply(tree, [{ op: 'topic.add', ref: 'native_tree_topic', name: 'Native tree acceptance' }])];
  const topic = Object.values((await snapshot(tree)).topics).find(topic => topic.name === 'Native tree acceptance'); assert.ok(topic);
  for (let branch = 1; branch <= 20; branch++) publication.push(await apply(tree, treeBatch(topic.id, branch)));
  const session = await snapshot(tree); assert.equal(Object.keys(session.items).length, 2000); assert.equal(Object.keys(session.inputs).length, 0);
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
  return browser.execute(() => [...document.querySelectorAll('.sentence-rows [role="treeitem"]')].map(element => element.dataset.itemId));
}
async function focusedId() { return browser.execute(() => document.activeElement?.getAttribute('data-item-id')); }
async function roving() {
  assert.equal(await browser.execute(() => [...document.querySelectorAll('.sentence-rows [role="treeitem"]')].filter(element => element.tabIndex === 0).length), 1);
}
async function catalogue() { const button = await browser.$('button=All sessions'); await button.waitForEnabled(); await button.click(); }
async function open(tree) {
  await catalogue(); const button = await browser.$(`[data-session-id="${tree.sessionId}"]`); await button.waitForDisplayed(); await button.click();
  await wait(async () => (await visibleIds()).includes('20.99'), 'The real native 2,000-item tree did not open');
}
// Passive WebView measurement starts at the real driver-generated click/input,
// stops after the expected canonical rows render and a layout frame completes.
async function measureAction(eventName, selector, expectedIds, action) {
  await browser.execute(({ eventName, selector, expectedIds }) => {
    const sample = { started: null, elapsed: null }; window.__ariadneTreeMeasurement = sample;
    const start = event => { if (event.target.closest(selector)) sample.started = window.performance.now(); };
    document.addEventListener(eventName, start, true);
    const observer = new window.MutationObserver(() => {
      const ids = [...document.querySelectorAll('.sentence-rows [role="treeitem"]')].map(element => element.dataset.itemId);
      if (sample.started === null || ids.length !== expectedIds.length || ids.some((id, index) => id !== expectedIds[index])) return;
      observer.disconnect(); document.removeEventListener(eventName, start, true);
      requestAnimationFrame(() => { document.querySelector('.sentence-rows')?.getBoundingClientRect(); sample.elapsed = window.performance.now() - sample.started; });
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  }, { eventName, selector, expectedIds });
  await action();
  await wait(async () => typeof await browser.execute(() => window.__ariadneTreeMeasurement.elapsed) === 'number', 'Native layout measurement did not reach its exact expected rows');
  return browser.execute(() => { const result = window.__ariadneTreeMeasurement.elapsed; delete window.__ariadneTreeMeasurement; return result; });
}
async function choose(group, name, pressed) {
  const button = await browser.$(`[aria-label="${group}"] button=${name}`); await button.waitForEnabled(); await button.click();
  await wait(async () => await button.getAttribute('aria-pressed') === String(pressed) && await button.isEnabled(), 'Native filter write was not confirmed');
}
async function anchor() {
  return browser.execute(() => {
    const tree = document.querySelector('.sentence-rows'), top = tree.getBoundingClientRect().top;
    const element = [...tree.querySelectorAll('[role="treeitem"]')].find(element => element.getBoundingClientRect().bottom > top);
    return { id: element.dataset.itemId, offset: element.getBoundingClientRect().top - top, scrollTop: tree.scrollTop };
  });
}
async function isolated(configuration, original, journal, demoBytes) {
  assert.deepEqual(await snapshot(configuration), original);
  assert.deepEqual(await admissions(configuration), journal); assert.equal(journal.length, 5);
  assert.deepEqual(await readFile(configuration.demo.sessionPath), demoBytes);
}

export async function runTreeAcceptance(configuration) {
  const original = await snapshot(configuration), journal = await admissions(configuration), demoBytes = await readFile(configuration.demo.sessionPath);
  const { tree, publication, initialSession } = await seedTree(configuration);
  await writeFile(join(process.env.ARIADNE_E2E_EVIDENCE, 'tree-publication.json'), JSON.stringify({ tree, publication, initialSession }, null, 2));
  await browser.refresh(); await catalogue();
  const expectedIds = Array.from({ length: 20 }, (_, index) => [String(index + 1), ...Array.from({ length: 99 }, (_, child) => `${index + 1}.${child + 1}`)]).flat();
  const sessionButton = await browser.$(`[data-session-id="${tree.sessionId}"]`); await sessionButton.waitForDisplayed();
  const usableMs = await measureAction('click', `[data-session-id="${tree.sessionId}"]`, expectedIds, () => sessionButton.click());
  assert.deepEqual(await visibleIds(), expectedIds); await roving();
  assert.equal(await (await row('1')).getAttribute('aria-level'), '1'); assert.equal(await (await row('1.1')).getAttribute('aria-level'), '2');
  assert.ok((await (await row('1')).getText()).includes(initialSession.items['1'].question));
  assert.ok((await (await row('1')).getText()).includes(initialSession.items['1'].outcome));
  await browser.saveScreenshot(join(process.env.ARIADNE_E2E_EVIDENCE, 'native-tree-2000.png'));

  const searchMs = [];
  const measuredIds = ['1.1', '20.99', '10.50', '2.10', '15.25', '5.60',
    ...Array.from({ length: 14 }, (_, index) => `${index + 3}.${1 + (index * 17) % 99}`)];
  for (const id of measuredIds) {
    searchMs.push(await measureAction('input', '.sentence-search input', [id.split('.')[0], id], async () => { const input = await search(); await input.waitForEnabled(); await input.setValue(`Native token_${id.replace('.', '_')}_end`); }));
  }
  await (await search()).setValue('ＮＡＴＩＶＥ café needle');
  await wait(async () => JSON.stringify(await visibleIds()) === JSON.stringify(['1', '1.1']), 'NFKC/lowercase AND-token search did not retain the contextual ancestor');
  assert.equal((await snapshot(tree)).items['1.1'].question, initialSession.items['1.1'].question, 'Search normalization must not rewrite stored text');
  await (await search()).setValue(''); await wait(async () => (await visibleIds()).length === 2000, 'Clear search did not restore the complete tree');
  await choose('Item status', 'Open', true); await wait(async () => (await browser.$('.sentence-tree footer').getText()).includes('1320 matching'), 'Open status count differs from the canonical fixture');
  await choose('Item status', 'Done', true); await wait(async () => (await browser.$('.sentence-tree footer').getText()).includes('2000 matching'), 'Within-category status OR did not restore all items');
  await choose('Item owner', 'Me', true); await wait(async () => (await browser.$('.sentence-tree footer').getText()).includes('1000 matching'), 'Owner AND filtering did not retain exactly the Me items');
  await choose('Item owner', 'Native collaborator', true); await wait(async () => (await browser.$('.sentence-tree footer').getText()).includes('2000 matching'), 'Within-category owner OR did not restore all items');
  await choose('Item owner', 'Me', false); await choose('Item owner', 'Native collaborator', false);
  await choose('Item status', 'Open', false); await choose('Item status', 'Done', false);

  await (await row('1')).click(); await wait(async () => (await browser.$('[aria-label="Item detail"]').getText()).includes(initialSession.items['1'].question), 'Native tree selection did not use full registered item detail');
  await (await row('1')).$('button[aria-label="Expand or collapse"]').click();
  await wait(async () => !(await preferences(tree)).view.expanded_item_ids.includes('1'), 'Explicit collapse was not persisted');
  await (await search()).setValue('ＮＡＴＩＶＥ café needle');
  await wait(async () => (await visibleIds()).includes('1.1'), 'Filtered context must temporarily expose its ancestry');
  const beforeReveal = (await preferences(tree)).view;
  const child = await browser.$('[aria-label="Child items"] button*=Item 1.2 ·'); await child.waitForDisplayed(); await child.click();
  await wait(async () => (await browser.$('.sentence-tree').getText()).includes('Item 1.2 is outside the current filters.'), 'Detail child reveal did not preserve the filter and expose an outside-filter row');
  assert.equal(await focusedId(), '1.2');
  const revealed = (await preferences(tree)).view;
  assert.deepEqual(revealed.filters, beforeReveal.filters); assert.deepEqual(revealed.expanded_item_ids, beforeReveal.expanded_item_ids);
  await browser.$('button=Dismiss temporary reveal').click();
  await wait(async () => JSON.stringify(await visibleIds()) === JSON.stringify(['1', '1.1']), 'Dismiss must remove only temporary outside-filter reveal');
  await (await row('1.1')).click(); await wait(async () => (await preferences(tree)).view.selected_item_id === '1.1', 'Selected item preference did not persist');
  const beforeKeys = (await preferences(tree)).view;
  for (const [key, id] of [['ArrowUp', '1'], ['j', '1.1'], ['k', '1'], ['End', '1.1'], ['Home', '1'], ['l', '1.1'], ['h', '1']]) {
    await browser.keys(key); assert.equal(await focusedId(), id); await roving();
  }
  assert.equal((await preferences(tree)).view.selected_item_id, beforeKeys.selected_item_id, 'Focus movement alone must not select or mutate preferences');
  await browser.keys('Enter'); await wait(async () => (await preferences(tree)).view.selected_item_id === '1', 'Keyboard Enter did not select through the registered reveal route');
  await (await row('1.1')).click();
  await wait(async () => (await preferences(tree)).view.selected_item_id === '1.1', 'The explicit selection must finish before the separate Later key');
  await (await search()).waitForEnabled(); await browser.keys('z');
  await wait(async () => (await preferences(tree)).snapshot.later.some(value => value.session_id === tree.sessionId && value.item_id === '1.1'), 'Later keyboard action did not persist canonical local preferences');
  await (await search()).setValue('No canonical native tree question matches this phrase');
  await wait(async () => await browser.$('button=Dismiss temporary reveal').isExisting(), 'A selected item outside new filters must offer explicit dismissal');
  await browser.$('button=Dismiss temporary reveal').click();
  await wait(async () => (await browser.$('.sentence-tree').getText()).includes('No sentences match these filters.'), 'No-result state did not provide explicit clear');
  await browser.$('button=Clear filters').click();
  await wait(async () => (await visibleIds()).length === 1901, 'Clear filters must preserve the saved collapsed branch');

  // Reopen the explicitly collapsed branch through its visible toggle, then
  // collapse a different branch so restart can prove this exact saved choice.
  await (await row('1')).$('button[aria-label="Expand or collapse"]').click();
  await wait(async () => (await visibleIds()).length === 2000, 'Explicit re-expansion did not restore children');
  await (await row('2')).scrollIntoView(); await (await row('2')).$('button[aria-label="Expand or collapse"]').click();
  await wait(async () => !(await preferences(tree)).view.expanded_item_ids.includes('2'), 'Second explicit collapse was not persisted');
  await (await row('10.50')).scrollIntoView({ block: 'start' }); await (await row('10.50')).click();
  await wait(async () => (await preferences(tree)).view.selected_item_id === '10.50', 'The anchor selection must finish before the real CLI live edit');
  await (await search()).waitForEnabled();
  const beforeEdit = await anchor(); assert.ok(beforeEdit.scrollTop > 0);
  const live = await snapshot(tree), longer = `${live.items['1'].question}\n${'A complete upstream sentence wraps across the native row. '.repeat(40)}`;
  const edit = await apply(tree, [{ op: 'item.edit', item: { id: '1' }, patch: { question: longer } }], { 1: live.items['1'].revision });
  await wait(async () => (await (await row('1')).getText()).includes(longer), 'Real CLI edit did not reach the native shared session');
  const afterEdit = await anchor(); assert.equal(afterEdit.id, beforeEdit.id); assert.ok(Math.abs(afterEdit.offset - beforeEdit.offset) <= 2, 'Live wrapped-row growth must preserve the actual visible scroll anchor');
  assert.equal(await focusedId(), '10.50', 'Live update must not steal native keyboard focus');
  await (await search()).click();
  await wait(async () => (await preferences(tree)).view.scroll?.item_id === afterEdit.id, 'Native blur did not persist the scroll anchor');
  const saved = await preferences(tree), finalSession = await snapshot(tree);
  assert.equal(Object.keys(finalSession.items).length, 2000); assert.equal(Object.keys(finalSession.inputs).length, 0);
  assert.ok(saved.snapshot.later.some(value => value.session_id === tree.sessionId && value.item_id === '1.1'));
  assert.ok(!saved.view.expanded_item_ids.includes('2')); assert.equal(saved.view.filters.search, '');
  await isolated(configuration, original, journal, demoBytes);
  const performance = { environment: 'Actual embedded WKWebView with real Core/Store', rows: 2000, firstUsableMs: usableMs,
    localSearchSamplesMs: searchMs, localSearchP95Ms: [...searchMs].sort((a, b) => a - b)[Math.ceil(searchMs.length * 0.95) - 1], targets: { firstUsableMs: 2000, localSearchP95Ms: 150 } };
  await writeFile(join(process.env.ARIADNE_E2E_EVIDENCE, 'tree-acceptance.json'), JSON.stringify({ tree, publication, edit, finalSession, savedView: saved.view, savedLater: saved.snapshot.later,
    beforeEdit, afterEdit, performance, originalAdmissions: journal.length }, null, 2));
  await browser.saveScreenshot(join(process.env.ARIADNE_E2E_EVIDENCE, 'native-tree-anchor.png'));
  assert.ok(usableMs <= performance.targets.firstUsableMs, `Native first usable tree ${usableMs}ms exceeds the 2s target`);
  assert.ok(performance.localSearchP95Ms <= performance.targets.localSearchP95Ms, `Native local search p95 ${performance.localSearchP95Ms}ms exceeds the 150ms target`);
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
