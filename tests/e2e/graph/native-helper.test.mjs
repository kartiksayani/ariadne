import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCentered, assertGraph, visibleIds } from '../../../apps/desktop/tests/e2e/graph.spec.mjs';

const session = { items: {
  10: { id: '10', question: 'Complete root\nSecond line', parent: null },
  '10.80': { id: '10.80', question: 'Complete child\nSecond line', parent: '10' },
  11: { id: '11', question: 'Other root', parent: null },
  '11.1': { id: '11.1', question: 'Hidden child', parent: '11' },
} };

test('visible ids follow the saved expansion', () => {
  assert.deepEqual(visibleIds(session, ['10']).sort(), ['10', '10.80', '11']);
  assert.deepEqual(visibleIds(session, []).sort(), ['10', '11']);
});

test('native graph assertions reject lost selection, duplicates, wrong membership, truncated titles and broken ancestry', () => {
  const node = (id, top) => ({ id, top, left: 0, width: 190, height: 66, title: session.items[id].question, selected: id === '10.80', below: null });
  const sample = { width: 800, height: 420, focused: '10.80', counts: ['2 open'], nodes: [node('10', 0), node('10.80', 177), node('11', 300)],
    edges: [{ id: 'topic:10', path: 'M2 33 C24 33 24 33 46 33' }, { id: 'parent:10:10.80', path: 'M236 33 C249 33 249 210 262 210' }] };
  const expected = ['10', '10.80', '11'];
  assertGraph(sample, session, '10.80', expected);
  assertCentered(sample, '10.80');
  assert.throws(() => assertCentered(sample, '10'), /centred/);
  assert.throws(() => assertGraph({ ...sample, nodes: sample.nodes.filter(value => value.id !== '10.80') }, session, '10.80', expected.slice(0, 1).concat('11')), /selected node/);
  assert.throws(() => assertGraph({ ...sample, nodes: [...sample.nodes, sample.nodes[0]] }, session, '10.80', expected), /duplicate node IDs/);
  assert.throws(() => assertGraph({ ...sample, edges: [...sample.edges, sample.edges[0]] }, session, '10.80', expected), /duplicate edge IDs/);
  assert.throws(() => assertGraph(sample, session, '10.80', ['10', '10.80']), /saved expansion/);
  assert.throws(() => assertGraph({ ...sample, nodes: sample.nodes.map(value => ({ ...value, title: 'Truncated…' })) }, session, '10.80', expected), /complete stored sentence/);
  assert.throws(() => assertGraph({ ...sample, edges: [{ id: 'parent:11:10.80', path: sample.edges[1].path }] }, session, '10.80', expected), /canonical ancestry/);
  assert.throws(() => assertGraph({ ...sample, nodes: sample.nodes.map(value => ({ ...value, selected: true })) }, session, '10.80', expected), /marked selected/);
});
