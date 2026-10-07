import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { admissions, cliRequest, snapshot } from './scripted-provider.mjs';

const wait = (condition, message) => browser.waitUntil(condition, { timeout: 20000, interval: 100, timeoutMsg: message });
const graph = () => browser.$('.graph-view');
const search = () => browser.$('[data-shell-search]');
const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} != ${expected}`);

/** Items the graph shows for an unfiltered view: roots, and children whose ancestors are all expanded. */
export function visibleIds(session, expanded) {
  const open = new Set(expanded);
  return Object.values(session.items).filter(item => {
    for (let parent = item.parent; parent; parent = session.items[parent]?.parent) if (!open.has(parent)) return false;
    return true;
  }).map(item => item.id);
}
export function assertGraph(sample, session, selected, expected) {
  const ids = sample.nodes.map(node => node.id), edges = sample.edges.map(edge => edge.id);
  assert.equal(new Set(ids).size, ids.length, 'Native graph must not duplicate node IDs');
  assert.equal(new Set(edges).size, edges.length, 'Native graph must not duplicate edge IDs');
  assert.deepEqual([...ids].sort(), [...expected].sort(), 'Native graph shows exactly the items its saved expansion opens');
  assert.ok(ids.includes(selected), 'Native graph retains the selected node');
  assert.deepEqual(sample.nodes.filter(node => node.selected).map(node => node.id), [selected], 'Exactly the selected node is marked selected');
  for (const value of sample.nodes) {
    assert.ok(session.items[value.id], 'Every native node belongs to the actual registered session');
    near(value.width, 190, 0.01, 'Node width'); near(value.height, 66, 0.01, 'Node height');
    assert.equal(value.title, session.items[value.id].question, 'The node title retains the complete stored sentence');
  }
  for (const edge of sample.edges.filter(value => value.id.startsWith('parent:'))) {
    const [, parent, child] = edge.id.split(':');
    assert.equal(session.items[child]?.parent, parent, 'Rendered native edges follow canonical ancestry');
    assert.match(edge.path, /^M[\d.-]+ [\d.-]+ C/, 'Parent edges retain cubic geometry');
  }
}
export function assertCentered(sample, id) {
  const target = sample.nodes.find(value => value.id === id); assert.ok(target, `Item ${id} is not in the graph`);
  near(target.top + target.height / 2, sample.height / 2, 2, `Item ${id} is centred vertically`);
}
async function view(tree) {
  const result = await cliRequest(tree.cli, ['preferences', 'get', '--json-stdin'], { session: null, request: { command: 'preferences_get', params: {} } });
  assert.equal(result.code, 0);
  const preferences = result.value.data.data;
  const saved = preferences.sessions.find(value => value.session.project_id === tree.projectId && value.session.session_id === tree.sessionId);
  assert.ok(saved); return saved;
}
async function sample() {
  // Passive reads only: no synthetic input, component replacement or state injection.
  return browser.execute(() => {
    const root = document.querySelector('.graph-view'), scroller = root.querySelector('.graph-scroll'), rect = scroller.getBoundingClientRect();
    return { width: rect.width, height: rect.height, focused: document.activeElement?.getAttribute('data-item-id') ?? null,
      counts: [...root.querySelectorAll('.graph-card-counts')].map(element => element.textContent),
      nodes: [...root.querySelectorAll('.graph-node[data-item-id]')].map(element => {
        const box = element.getBoundingClientRect();
        return { id: element.dataset.itemId, top: box.top - rect.top, left: box.left - rect.left, width: box.width, height: box.height,
          title: element.getAttribute('title'), selected: element.getAttribute('aria-selected') === 'true',
          below: element.querySelector('.graph-node-below')?.textContent ?? null };
      }),
      edges: [...root.querySelectorAll('[data-edge]')].map(element => ({ id: element.dataset.edge,
        path: (element.tagName === 'path' ? element : element.querySelector('path')).getAttribute('d') })) };
  });
}
async function click(selector, parent = browser) { const button = await parent.$(selector); await button.waitForEnabled(); await button.scrollIntoView(); await button.click(); }
async function detail(session, id) {
  await wait(async () => await browser.execute(id => document.querySelector('.item-detail .detail-question')?.textContent === id, session.items[id].question), `Registered detail did not show the complete item ${id}`);
}
async function selectedIn(id) {
  await wait(async () => (await sample()).nodes.some(value => value.id === id && value.selected), `Native graph did not select item ${id}`);
  return sample();
}

// Run after the saved tree has been proved in the real relaunched process. Graph
// deliberately changes selection/search through UI and records those preferences.
export async function runGraphAcceptance(configuration) {
  const evidence = process.env.ARIADNE_E2E_EVIDENCE;
  const prior = JSON.parse(await readFile(join(process.env.ARIADNE_E2E_PRIOR_EVIDENCE, 'tree-acceptance.json'), 'utf8'));
  const { tree } = prior, canonical = await snapshot(tree), original = await snapshot(configuration), journal = await admissions(configuration);
  const demoBytes = await readFile(configuration.demo.sessionPath), beforeView = await view(tree);
  assert.deepEqual(canonical, prior.finalSession);
  assert.equal(Object.keys(canonical.items).length, 2000); assert.equal(prior.performance.messages, 5000);
  assert.equal(canonical.messages.length, prior.performance.messages + 1, 'The subsequent real CLI item edit adds one activity message');
  assert.equal(Object.keys(canonical.inputs).length, 0); assert.equal(beforeView.selected_item_id, '10.50');
  const expected = visibleIds(canonical, beforeView.expanded_item_ids), samples = [], started = Date.now();
  await click('button=Graph', browser.$('.shell-views')); await (await graph()).waitForDisplayed();
  await wait(async () => (await sample()).nodes.some(value => value.id === '10.50'), 'The real registered session did not open in native Graph');
  const driverOpenToReadyMs = Date.now() - started;

  // Opening centres the saved selection and shows the tree's saved expansion.
  const opened = await sample(); assertGraph(opened, canonical, '10.50', expected); assertCentered(opened, '10.50');
  assert.equal(opened.focused, '10.50', 'Opening the graph focuses the selected node');
  assert.ok(opened.counts.length > 0 && opened.counts.every(value => value.length > 0), 'Every topic card shows its counts');
  const collapsed = opened.nodes.filter(value => value.below);
  for (const value of collapsed) assert.equal(value.below, `+${Object.values(canonical.items).filter(item => item.parent === value.id).length}`, 'Collapsed nodes count the items below');
  samples.push({ action: 'open', nodes: opened.nodes.length, edges: opened.edges.length, collapsed: collapsed.map(value => value.id) });
  await browser.saveScreenshot(join(evidence, 'native-graph-open.png'));

  // Existing detail -> parent -> child routes move the graph selection and centre it.
  await detail(canonical, '10.50'); await click('button=Parent · Item 10', browser.$('[aria-label="Item location"]')); await detail(canonical, '10');
  await selectedIn('10');
  await wait(async () => (await view(tree)).selected_item_id === '10' && await browser.$('.shell-views').$('button=Graph').isEnabled(),
    'The parent reveal must finish saving before the separate child reveal');
  await click('button*=Item 10.80 ·', browser.$('[aria-label="Child items"]')); await detail(canonical, '10.80');
  const revealed = await selectedIn('10.80'); assertCentered(revealed, '10.80');
  await wait(async () => (await view(tree)).selected_item_id === '10.80', 'Registered reveal selection was not persisted');
  samples.push({ action: 'registered-reveal', selected: '10.80' });

  // "−" collapses item 10 and moves the selection out of the branch; clicking it opens the branch again.
  await click('.graph-node-collapse', browser.$('.graph-node[data-item-id="10"]'));
  await wait(async () => (await sample()).nodes.find(value => value.id === '10')?.below === '+99', 'Native "−" did not collapse item 10');
  await selectedIn('10');
  await wait(async () => !(await view(tree)).expanded_item_ids.includes('10'), 'Native collapse was not persisted');
  await click('.graph-node[data-item-id="10"]');
  await wait(async () => (await sample()).nodes.some(value => value.id === '10.99'), 'Clicking the collapsed node did not open its branch');
  await detail(canonical, '10');
  await wait(async () => (await view(tree)).expanded_item_ids.includes('10'), 'Native expand was not persisted');
  assertGraph(await sample(), canonical, '10', expected);
  samples.push({ action: 'collapse-expand', item: '10' });
  await click('button*=Item 10.80 ·', browser.$('[aria-label="Child items"]')); await detail(canonical, '10.80'); await selectedIn('10.80');

  await (await search()).waitForEnabled(); await (await search()).setValue('Native token_10_80_end');
  await wait(async () => JSON.stringify((await sample()).nodes.map(value => value.id)) === JSON.stringify(['10', '10.80']), 'Graph search must keep the match and its ancestry');
  const filtered = await sample();
  await detail(canonical, '10.80');
  await click('button=Tree', browser.$('.shell-views'));
  await wait(async () => JSON.stringify(await browser.execute(() => [...document.querySelectorAll('.tree-rows .tree-item')].map(element => element.dataset.itemId))) === JSON.stringify(['10', '10.80']), 'Tree must show the same filtered items as Graph');
  await detail(canonical, '10.80');
  const filteredView = await view(tree); assert.equal(filteredView.filters.search, 'Native token_10_80_end'); assert.equal(filteredView.selected_item_id, '10.80');
  assert.deepEqual([...filteredView.expanded_item_ids].sort(), [...beforeView.expanded_item_ids].sort(), 'Graph collapse then expand restores the saved expansion');
  await (await search()).waitForEnabled(); await (await search()).setValue('');
  await wait(async () => (await view(tree)).filters.search === '' && await browser.execute(() => document.querySelectorAll('.tree-rows .tree-item').length === 1901), 'Clear shared search must preserve the saved collapsed tree branch');
  const finalView = await view(tree);
  assert.deepEqual(await snapshot(tree), canonical, 'Graph view actions must not change canonical items, messages or inputs');
  assert.deepEqual(await snapshot(configuration), original); assert.deepEqual(await admissions(configuration), journal); assert.equal(journal.length, 5);
  assert.deepEqual(await readFile(configuration.demo.sessionPath), demoBytes);
  await writeFile(join(evidence, 'graph-acceptance.json'), JSON.stringify({ environment: 'Actual embedded WKWebView with real App/Core/Store',
    tree, canonicalItems: 2000, canonicalMessages: canonical.messages.length, publicationMessages: prior.performance.messages, driverOpenToReadyMs,
    beforeView, filteredView, finalView, samples, filtered: filtered.nodes.map(value => value.id), originalAdmissions: journal.length,
    proofLimits: 'Native driver clicks and registered detail routes prove open, reveal, collapse/expand, filter and tree parity. Driver open-to-ready timing includes automation overhead and is diagnostic only. Render timing, keyboard moves and scrolling are covered by the 2,000-node graph browser suite.' }, null, 2));
  await browser.saveScreenshot(join(evidence, 'native-graph-tree-parity.png'));
}
