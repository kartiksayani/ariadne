import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { admissions, cliRequest, snapshot } from './scripted-provider.mjs';
import { goToPeekItem, search, searchBox, showFullItemQuestion } from './tree.spec.mjs';

const wait = (condition, message) => browser.waitUntil(condition, { timeout: 60000, interval: 100, timeoutMsg: message });
const graph = () => browser.$('.graph-view');
// The Tree / Graph switch is the top bar's segmented control.
const views = () => browser.$('.shell-top [role="group"][aria-label="View"]');
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
  // SPEC 1.3: one column width for every node, fitted when the Graph opened (col − 26, col within 150..196), 40 high.
  const width = sample.nodes[0]?.width ?? 0;
  assert.ok(width >= 150 - 26 - 0.01 && width <= 196 - 26 + 0.01, `Node width ${width} is a fitted column less 26`);
  for (const value of sample.nodes) {
    assert.ok(session.items[value.id], 'Every native node belongs to the actual registered session');
    near(value.width, width, 0.01, 'Every node shares the fitted width'); near(value.height, 40, 0.01, 'Node height');
    assert.equal(value.title, session.items[value.id].question, 'The node title retains the complete stored sentence');
  }
  for (const edge of sample.edges.filter(value => value.id.startsWith('parent:'))) {
    const [, parent, child] = edge.id.split(':');
    assert.equal(session.items[child]?.parent, parent, 'Rendered native edges follow canonical ancestry');
    assert.match(edge.path, /^M[\d.-]+ [\d.-]+ (H[\d.-]+ )?V[\d.-]+ H[\d.-]+$/, 'Parent edges are orthogonal elbows');
  }
}
export function assertCentered(sample, id) {
  const target = sample.nodes.find(value => value.id === id); assert.ok(target, `Item ${id} is not in the graph`);
  // The floating dock covers the bottom of the canvas (SPEC 5.2), so the visible area, and its centre, end above it.
  near(target.top + target.height / 2, (sample.height - (sample.inset ?? 0)) / 2, 2, `Item ${id} is centred vertically`);
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
    const inset = parseFloat(document.querySelector('.shell-body-viewport')?.style.getPropertyValue('--dock-inset')) || 0;
    return { width: rect.width, height: rect.height, inset, focused: document.activeElement?.getAttribute('data-item-id') ?? null,
      titles: [...root.querySelectorAll('.graph-topic-title')].map(element => element.textContent),
      nodes: [...root.querySelectorAll('.graph-node[data-item-id]')].map(element => {
        const box = element.getBoundingClientRect();
        return { id: element.dataset.itemId, top: box.top - rect.top, left: box.left - rect.left, width: box.width, height: box.height,
          title: element.getAttribute('title'), selected: element.getAttribute('aria-selected') === 'true',
          match: element.classList.contains('is-match'), below: element.querySelector('.graph-node-inside')?.textContent ?? null };
      }),
      edges: [...root.querySelectorAll('[data-edge]')].map(element => ({ id: element.dataset.edge,
        path: (element.tagName === 'path' ? element : element.querySelector('path')).getAttribute('d') })) };
  });
}
async function click(selector, parent = browser) { const button = await parent.$(selector); await button.waitForEnabled(); await button.scrollIntoView(); await button.click(); }
async function detail(session, id) {
  await showFullItemQuestion(session.items[id]);
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
  await click('button[aria-label="Graph"]', views()); await (await graph()).waitForDisplayed();
  await wait(async () => (await sample()).nodes.some(value => value.id === '10.50'), 'The real registered session did not open in native Graph');
  const driverOpenToReadyMs = Date.now() - started;

  // Opening centres the saved selection and shows the tree's saved expansion.
  const opened = await sample(); assertGraph(opened, canonical, '10.50', expected); assertCentered(opened, '10.50');
  assert.equal(opened.focused, '10.50', 'Opening the graph focuses the selected node');
  assert.ok(opened.titles.length > 0 && opened.titles.every(value => value.length > 0), 'Every topic is titled');
  const collapsed = opened.nodes.filter(value => value.below);
  const inside = id => Object.values(canonical.items).filter(item => item.parent === id).reduce((count, item) => count + 1 + inside(item.id), 0);
  for (const value of collapsed) assert.equal(value.below, `+${inside(value.id)}`, 'Folded nodes count every item inside');
  samples.push({ action: 'open', nodes: opened.nodes.length, edges: opened.edges.length, collapsed: collapsed.map(value => value.id) });
  await browser.saveScreenshot(join(evidence, 'native-graph-open.png'));

  // Detail references preview first; Go to moves the graph selection and centres it.
  // Accessible names carry the complete question independently of short chip labels.
  await detail(canonical, '10.50'); await click('button[aria-label^="Native branch 10\\a "]', browser.$('[aria-label="Item location"]'));
  await goToPeekItem(canonical.items['10'], '10.50'); await detail(canonical, '10');
  await selectedIn('10');
  await wait(async () => (await view(tree)).selected_item_id === '10' && await views().$('button[aria-label="Graph"]').isEnabled(),
    'The parent reveal must finish saving before the separate child reveal');
  await click('button[aria-label^="Native sentence 10.80\\a "]', browser.$('[aria-label="Child items"]'));
  await goToPeekItem(canonical.items['10.80'], '10'); await detail(canonical, '10.80');
  const revealed = await selectedIn('10.80'); assertCentered(revealed, '10.80');
  await wait(async () => (await view(tree)).selected_item_id === '10.80', 'Registered reveal selection was not persisted');
  samples.push({ action: 'registered-reveal', selected: '10.80' });

  // The Graph has no fold button (SPEC 1.3): ← on the selected 10.80 goes to its parent 10, ← again folds 10 behind a
  // quiet "+99", and clicking the folded node opens it again.
  await click('.graph-node[data-item-id="10.80"]'); await detail(canonical, '10.80');
  await wait(async () => (await sample()).focused === '10.80', 'Clicking a native graph node focuses it');
  await browser.keys('ArrowLeft'); await selectedIn('10');
  // The parent selection finishes saving before the second ←: a press that lands mid-write still sees the old selection.
  await wait(async () => (await view(tree)).selected_item_id === '10' && await views().$('button[aria-label="Graph"]').isEnabled(),
    'The ← to the parent must finish saving before the fold');
  await browser.keys('ArrowLeft');
  await wait(async () => (await sample()).nodes.find(value => value.id === '10')?.below === '+99', 'Native ← did not fold item 10');
  await wait(async () => !(await view(tree)).expanded_item_ids.includes('10'), 'Native fold was not persisted');
  await click('.graph-node[data-item-id="10"]');
  await wait(async () => (await sample()).nodes.some(value => value.id === '10.99'), 'Clicking the folded node did not open its branch');
  await detail(canonical, '10');
  await wait(async () => (await view(tree)).expanded_item_ids.includes('10'), 'Native unfold was not persisted');
  assertGraph(await sample(), canonical, '10', expected);
  samples.push({ action: 'fold-unfold', item: '10' });
  await click('button[aria-label^="Native sentence 10.80\\a "]', browser.$('[aria-label="Child items"]'));
  await goToPeekItem(canonical.items['10.80'], '10'); await detail(canonical, '10.80'); await selectedIn('10.80');

  // Search tints the match in place; it filters neither the Graph nor the Tree (alpha.20, contract C4).
  await (await search()).waitForEnabled(); await (await searchBox()).setValue('Native token_10_80_end');
  await wait(async () => (await sample()).nodes.find(value => value.id === '10.80')?.match === true, 'Graph search must tint the match');
  const searched = await sample();
  assertGraph(searched, canonical, '10.80', expected);
  assert.deepEqual(searched.nodes.filter(value => value.match).map(value => value.id), ['10.80'], 'Graph search tints only the match');
  await detail(canonical, '10.80');
  await click('button[aria-label="Tree"]', views());
  await wait(async () => await browser.execute(() => document.querySelectorAll('.tree-rows .tree-item').length === 1901), 'The Tree keeps every row under search too');
  await detail(canonical, '10.80');
  const searchedView = await view(tree); assert.equal(searchedView.selected_item_id, '10.80');
  assert.deepEqual([...searchedView.expanded_item_ids].sort(), [...beforeView.expanded_item_ids].sort(), 'Graph fold then unfold restores the saved expansion');
  await (await search()).waitForEnabled(); await (await searchBox()).setValue('');
  await wait(async () => (await view(tree)).filters.search === '' && await browser.execute(() => document.querySelectorAll('.tree-rows .tree-item').length === 1901), 'Clear shared search must preserve the saved collapsed tree branch');
  const finalView = await view(tree);
  assert.deepEqual(await snapshot(tree), canonical, 'Graph view actions must not change canonical items, messages or inputs');
  assert.deepEqual(await snapshot(configuration), original); assert.deepEqual(await admissions(configuration), journal); assert.equal(journal.length, 5);
  assert.deepEqual(await readFile(configuration.demo.sessionPath), demoBytes);
  await writeFile(join(evidence, 'graph-acceptance.json'), JSON.stringify({ environment: 'Actual embedded WKWebView with real App/Core/Store',
    tree, canonicalItems: 2000, canonicalMessages: canonical.messages.length, publicationMessages: prior.performance.messages, driverOpenToReadyMs,
    beforeView, searchedView, finalView, samples, searched: searched.nodes.filter(value => value.match).map(value => value.id), originalAdmissions: journal.length,
    proofLimits: 'Native driver clicks, keys and registered detail routes prove open, reveal, fold/unfold, search tint and tree parity. Driver open-to-ready timing includes automation overhead and is diagnostic only. Render timing, keyboard moves, scrolling and the still-under-every-trigger anchor are covered by the graph browser suites.' }, null, 2));
  await browser.saveScreenshot(join(evidence, 'native-graph-tree-parity.png'));
}
