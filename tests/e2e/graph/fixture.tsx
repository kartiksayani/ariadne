import { Profiler, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionTopicGraph } from '../../../apps/desktop/src/components/graph/SessionTopicGraph';
import { graphFixture } from '../../../apps/desktop/tests/ui/graph-culling/fixture';
import { layoutGraph } from '../../../apps/desktop/src/graph/layout/geometry';
import { indexGraph, worldViewport } from '../../../apps/desktop/src/graph/culling/bounds-index';
import '../../../apps/desktop/src/styles/reference.css';

declare global {
  interface Window { __graphEvidence: { mountMs: number[]; updateMs: number[]; layoutMs: number; indexMs: number;
    queries: { scale: number; nodes: number; edges: number; p95Ms: number }[] }; }
}
const fixture = await graphFixture(), items = Object.values(fixture.session.items).flatMap(item => item ? [item] : []);
const start = performance.now(), layout = layoutGraph(items), laidOut = performance.now(), query = indexGraph(layout);
window.__graphEvidence = { mountMs: [], updateMs: [], layoutMs: laidOut - start, indexMs: performance.now() - laidOut, queries: [] };
for (const scale of [0.25, 0.5, 1, 2]) {
  const view = { scale, x: 936 / 2 - layout.bounds.width / 2 * scale, y: 420 / 2 - layout.bounds.height / 2 * scale };
  const rect = worldViewport(view, 936, 420);
  const elapsed: number[] = [];
  for (let iteration = 0; iteration < 100; iteration++) {
    const start = performance.now(); query(rect); elapsed.push(performance.now() - start);
  }
  const rendered = query(rect);
  window.__graphEvidence.queries.push({ scale, nodes: rendered.nodes.length, edges: rendered.edges.length,
    p95Ms: elapsed.sort((a, b) => a - b)[94] });
}
function Fixture() {
  const [view, setView] = useState(fixture.view), [tree, setTree] = useState(false);
  return <>
    <button type="button" onClick={() => setView(previous => ({ ...previous, selected_item_id: '20.99' }))}>Select off-screen item</button>
    {tree && <p role="status">Tree route requested</p>}
    <Profiler id="actual-topic-graph" onRender={(_id, phase, duration) => {
      window.__graphEvidence[phase === 'mount' ? 'mountMs' : 'updateMs'].push(duration);
    }}>
      <SessionTopicGraph {...fixture} view={view} later={later} onReveal={() => {}}
        saveSelection={async id => { setView(previous => ({ ...previous, selected_item_id: id })); return true; }}
        onSwitchToTree={() => setTree(true)} />
    </Profiler>
  </>;
}
const later = new Set<string>();
createRoot(document.getElementById('root')!).render(<Fixture />);
