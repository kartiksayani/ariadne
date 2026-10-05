import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCulled, assertFullFit, corpusBounds } from '../../../apps/desktop/tests/e2e/graph.spec.mjs';

test('native Fit assertion rejects culled bounds and reports the full 20-tree corpus', () => {
  assert.deepEqual(corpusBounds, { width: 444, height: 186700 });
  const fitted = { width: 800, height: 420, x: 344.5, y: -23127.5, scale: 0.25 };
  assertFullFit(fitted);
  assert.throws(() => assertFullFit({ ...fitted, y: -100 }), /all vertical bounds/);
  assert.throws(() => assertFullFit({ ...fitted, scale: 1 }), /minimum zoom/);
});

test('native culling assertions reject lost selection, duplicate identities and corrupted canonical counts', () => {
  const session = { items: { 10: { question: 'Complete root\nSecond line', parent: null }, '10.80': { question: 'Complete child\nSecond line', parent: '10' } } };
  const sample = { x: 0, y: 0, scale: 1, width: 800, height: 420, footer: '2000 matching · 2000 in this topic', nodes: [
    { id: '10', x: 0, y: 0, width: 190, height: 66, title: session.items['10'].question },
    { id: '10.80', x: 254, y: 0, width: 190, height: 66, title: session.items['10.80'].question },
  ], edges: [{ id: 'parent:10:10.80', path: 'M 190 33 C 222 33, 222 33, 254 33' }] };
  assertCulled(sample, session, '10.80');
  assert.throws(() => assertCulled({ ...sample, nodes: sample.nodes.slice(0, 1) }, session, '10.80'), /selected node/);
  assert.throws(() => assertCulled({ ...sample, nodes: [...sample.nodes, sample.nodes[0]] }, session, '10.80'), /duplicate node IDs/);
  assert.throws(() => assertCulled({ ...sample, edges: [...sample.edges, sample.edges[0]] }, session, '10.80'), /duplicate edge IDs/);
  assert.throws(() => assertCulled({ ...sample, footer: '2 matching · 2 in this topic' }, session, '10.80'), /canonical counts/);
  assert.throws(() => assertCulled({ ...sample, nodes: sample.nodes.map(node => ({ ...node, title: 'Truncated…' })) }, session, '10.80'), /complete stored sentence/);
  assert.throws(() => assertCulled({ ...sample, edges: [{ ...sample.edges[0], id: 'parent:11:10.80' }] }, session, '10.80'), /canonical ancestry/);
  assert.throws(() => assertCulled({ ...sample, nodes: sample.nodes.map(node => ({ ...node, y: 1000 })) }, session, '10.80'), /200-screen-pixel margin/);
});
