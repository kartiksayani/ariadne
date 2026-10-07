import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { admissions, cliRequest, snapshot } from './scripted-provider.mjs';

const wait = (condition, message) => browser.waitUntil(condition, { timeout: 20000, interval: 100, timeoutMsg: message });
const graph = () => browser.$('.session-topic-graph');
const search = () => browser.$('[data-shell-search]');
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) <= 0.01, `${message}: ${actual} != ${expected}`);

// Closed-form bounds of the existing CLI corpus: twenty roots, each with 99
// ordered children. This checks Fit independently of the product layout/index.
export const corpusBounds = { width: 444, height: 19 * (99 * 94 + 32) + 98 * 94 + 66 };
export function assertFullFit(sample) {
  near(sample.scale, 0.25, 'The complete native corpus requires minimum zoom');
  near(sample.x, (sample.width - corpusBounds.width * sample.scale) / 2, 'Fit centers all horizontal bounds');
  near(sample.y, (sample.height - corpusBounds.height * sample.scale) / 2, 'Fit centers all vertical bounds');
}
export function assertCulled(sample, session, selected) {
  const ids = sample.nodes.map(node => node.id), edges = sample.edges.map(edge => edge.id);
  assert.equal(new Set(ids).size, ids.length, 'Native culling must not duplicate node IDs');
  assert.equal(new Set(edges).size, edges.length, 'Native culling must not duplicate edge IDs');
  assert.ok(ids.length > 0 && ids.length < 300, 'The native 2,000-item topic must render a bounded subset');
  assert.ok(ids.includes(selected), 'Native culling retains the selected node');
  assert.ok(sample.footer.includes('2000 matching · 2000 in this topic'), 'Culling must preserve complete canonical counts');
  for (const value of sample.nodes) {
    assert.ok(session.items[value.id], 'Every native SVG node belongs to the actual registered session');
    near(value.width, 190, 'Node width'); near(value.height, 66, 'Node height');
    assert.equal(value.title, session.items[value.id].question, 'The accessible node title retains the complete stored sentence');
    if (value.id !== selected && value.id !== sample.focused) {
      const left = sample.x + value.x * sample.scale, top = sample.y + value.y * sample.scale;
      assert.ok(left <= sample.width + 200 && left + value.width * sample.scale >= -200
        && top <= sample.height + 200 && top + value.height * sample.scale >= -200,
      'Ordinary native nodes must intersect the viewport plus its 200-screen-pixel margin');
    }
  }
  for (const edge of sample.edges) {
    const [, parent, child] = edge.id.split(':');
    assert.equal(session.items[child]?.parent, parent, 'Rendered native edges follow canonical ancestry');
    assert.ok(edge.path.startsWith('M ') && edge.path.includes(' C '), 'Parent edges retain cubic geometry');
  }
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
    const section = document.querySelector('.session-topic-graph'), canvas = section.querySelector('svg');
    const transform = section.querySelector('[data-graph-world]').transform.baseVal.consolidate().matrix;
    const rect = canvas.getBoundingClientRect();
    return { x: transform.e, y: transform.f, scale: transform.a, width: rect.width, height: rect.height,
      footer: section.querySelector('footer').textContent, focused: document.activeElement?.getAttribute('data-graph-node'),
      nodes: [...section.querySelectorAll('[data-graph-node]')].map(element => {
        const box = element.querySelector('rect'), matrix = element.transform.baseVal.consolidate().matrix;
        return { id: element.dataset.graphNode, x: matrix.e, y: matrix.f,
          width: Number(box.getAttribute('width')), height: Number(box.getAttribute('height')), title: element.querySelector('title').textContent };
      }), edges: [...section.querySelectorAll('[data-edge]')].map(element => ({ id: element.dataset.edge, path: element.querySelector('path').getAttribute('d') })) };
  });
}
async function click(selector, parent = browser) { const button = await parent.$(selector); await button.waitForEnabled(); await button.scrollIntoView(); await button.click(); }
async function fit() {
  await click('button=Fit', browser.$('.topic-graph-controls'));
  await wait(async () => {
    const current = await sample();
    return Math.abs(current.scale - 0.25) < 0.01 && Math.abs(current.y - (current.height - corpusBounds.height * 0.25) / 2) < 0.01;
  }, 'Native Fit did not restore the complete canonical bounds');
  const current = await sample(); assertFullFit(current); return current;
}
async function zoom(direction) {
  const previous = await sample(); await click(`[aria-label="Zoom ${direction}"]`);
  const expected = Math.max(0.25, Math.min(2, previous.scale * (direction === 'in' ? 1.2 : 1 / 1.2)));
  await wait(async () => Math.abs((await sample()).scale - expected) < 0.00001, 'Native zoom button did not update the rendered transform');
  return sample();
}
async function detail(session, id) {
  await wait(async () => await browser.execute(id => document.querySelector('.item-history h2')?.textContent === id, session.items[id].question), `Registered detail did not show the complete item ${id}`);
}
async function revealed(session, id) {
  await detail(session, id);
  await wait(async () => (await sample()).focused === id, `Native reveal did not focus item ${id} after committing its viewport`);
  const current = await sample(), target = current.nodes.find(value => value.id === id); assert.ok(target);
  const center = { x: current.x + (target.x + target.width / 2) * current.scale, y: current.y + (target.y + target.height / 2) * current.scale };
  near(center.x, current.width / 2, 'Off-screen reveal centers the target horizontally');
  near(center.y, current.height / 2, 'Off-screen reveal centers the target vertically');
  return current;
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
  const samples = [], started = Date.now();
  await click('button=Graph', browser.$('.shell-views')); await (await graph()).waitForDisplayed();
  await wait(async () => (await sample()).nodes.some(value => value.id === '10.50'), 'The real registered topic did not open in native Graph');
  const driverOpenToReadyMs = Date.now() - started;
  const initialFit = await fit(); assertCulled(initialFit, canonical, '10.50'); samples.push({ action: 'full-fit', ...initialFit });
  for (const id of ['10.99', '11.1']) assert.ok(initialFit.nodes.some(value => value.id === id), 'Full Fit renders the fixed corpus leaves on either side of its midpoint');
  await browser.saveScreenshot(join(evidence, 'native-graph-full-fit.png'));
  assert.ok((await (await graph()).getText()).includes('Full bounds exceed this viewport at 25%'), 'Fit must disclose the actual minimum-zoom overflow');
  const zoomed = await zoom('in'); assertCulled(zoomed, canonical, '10.50');
  assert.notDeepEqual(zoomed.nodes.map(value => value.id), initialFit.nodes.map(value => value.id), 'Zoom must update the culled native membership');
  samples.push({ action: 'zoom-in', ...zoomed }); await zoom('out'); await fit();

  // Existing detail -> parent -> child routes reach an initially off-screen node
  // through the real renderer/Core boundary; no node is added to the DOM by tests.
  await detail(canonical, '10.50'); await click('button=Parent · Item 10', browser.$('[aria-label="Item location"]')); await detail(canonical, '10');
  await wait(async () => (await view(tree)).selected_item_id === '10' && await browser.$('.shell-views').$('button=Graph').isEnabled(),
    'The parent reveal must finish saving before the separate child reveal');
  assert.ok(!(await sample()).nodes.some(value => value.id === '10.80'), 'The reveal target must actually begin culled');
  await click('button*=Item 10.80 ·', browser.$('[aria-label="Child items"]'));
  const offscreenReveal = await revealed(canonical, '10.80'); samples.push({ action: 'registered-offscreen-reveal', ...offscreenReveal });
  await wait(async () => (await view(tree)).selected_item_id === '10.80', 'Registered reveal selection was not persisted');
  while ((await sample()).scale < 2) await zoom('in');
  const maximum = await sample(); assertCulled(maximum, canonical, '10.80');
  assert.ok(!maximum.nodes.some(value => ['10', '10.99'].includes(value.id)), 'Both crossing-edge endpoints must actually be culled');
  assert.ok(maximum.edges.some(value => value.id === 'parent:10:10.99'), 'Native SVG must retain the conservative crossing edge with both endpoints culled');
  assert.equal(await browser.$('[aria-label="Zoom in"]').isEnabled(), false);
  samples.push({ action: 'maximum-zoom-crossing-edge', ...maximum });
  await browser.saveScreenshot(join(evidence, 'native-graph-crossing-edge.png'));
  await fit(); const refitted = await sample(); assertCulled(refitted, canonical, '10.80');
  const retained = refitted.nodes.find(value => value.id === '10.80');
  assert.ok(refitted.y + (retained.y + retained.height) * refitted.scale < -200,
    'The retained selected node must actually lie outside even the expanded culling margin');
  samples.push({ action: 'fit-after-remote-selection', ...refitted });

  await (await search()).waitForEnabled(); await (await search()).setValue('Native token_10_80_end');
  await wait(async () => (await sample()).footer.includes('1 matching · 2000 in this topic'), 'Graph search must preserve canonical scope counts');
  const filtered = await sample(); assert.deepEqual(filtered.nodes.map(value => value.id), ['10', '10.80']);
  await detail(canonical, '10.80');
  await click('button=Switch to tree', browser.$('.topic-graph-controls'));
  await wait(async () => JSON.stringify(await browser.execute(() => [...document.querySelectorAll('.tree-rows .tree-item')].map(element => element.dataset.itemId))) === JSON.stringify(['10', '10.80']), 'Native tree fallback must preserve Graph filters and ordinary ancestry');
  await detail(canonical, '10.80');
  const filteredView = await view(tree); assert.equal(filteredView.filters.search, 'Native token_10_80_end'); assert.equal(filteredView.selected_item_id, '10.80');
  assert.deepEqual(filteredView.expanded_item_ids, beforeView.expanded_item_ids, 'Graph search/reveal must not rewrite explicit tree expansion');
  await (await search()).waitForEnabled(); await (await search()).setValue('');
  await wait(async () => (await view(tree)).filters.search === '' && await browser.execute(() => document.querySelectorAll('.tree-rows .tree-item').length === 1901), 'Clear shared search must preserve the saved collapsed tree branch');
  const finalView = await view(tree);
  assert.deepEqual(await snapshot(tree), canonical, 'Graph view actions must not change canonical items, messages or inputs');
  assert.deepEqual(await snapshot(configuration), original); assert.deepEqual(await admissions(configuration), journal); assert.equal(journal.length, 5);
  assert.deepEqual(await readFile(configuration.demo.sessionPath), demoBytes);
  await writeFile(join(evidence, 'graph-acceptance.json'), JSON.stringify({ environment: 'Actual embedded WKWebView with real App/Core/Store',
    tree, canonicalItems: 2000, canonicalMessages: canonical.messages.length, publicationMessages: prior.performance.messages, driverOpenToReadyMs,
    beforeView, filteredView, finalView, samples, filtered, originalAdmissions: journal.length,
    proofLimits: 'Native driver buttons and registered detail routes prove zoom/Fit/culling/focus/filter parity. Driver open-to-ready timing includes automation overhead and is diagnostic only. Render/performance measurements, cursor-anchored wheel and blank-canvas drag remain covered by the existing graph browser suite; this native join does not exercise those gestures.' }, null, 2));
  await browser.saveScreenshot(join(evidence, 'native-graph-tree-parity.png'));
}
