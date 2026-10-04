import { describe, expect, it } from 'vitest';
import { indexGraph, intersects, worldViewport } from '../../../src/graph/culling/bounds-index';
import { layoutGraph } from '../../../src/graph/layout/geometry';
import { fitBounds } from '../../../src/graph/layout/viewport';
import { selectedParentEdges } from '../../../src/graph/layout/geometry';
import { graphSession } from './fixture';

describe('full-layout bounds index', () => {
  const layout = layoutGraph(Object.values(graphSession().items).flatMap(item => item ? [item] : [])), query = indexGraph(layout);
  it('matches brute-force bounds at multiple zooms, negative coordinates and cell boundaries without duplicates', () => {
    for (const scale of [0.25, 0.5, 1, 2]) {
      for (const x of [-1024, -512, 0, 512]) {
        for (const y of [0, -512, -93000 * scale, -184000 * scale]) {
          const rect = worldViewport({ x, y, scale }, 800, 420), result = query(rect);
          expect(result.nodes).toEqual(layout.nodes.filter(node => intersects(node, rect)));
          expect(result.edges).toEqual(layout.edges.filter(edge => intersects(edge.bounds, rect)));
          expect(new Set(result.nodes.map(node => node.item.id)).size).toBe(result.nodes.length);
          expect(new Set(result.edges.map(edge => edge.id)).size).toBe(result.edges.length);
        }
      }
    }
  });
  it('retains selected/focused IDs once in layout order and ignores unknown retained IDs', () => {
    const rect = { x: -2000, y: -2000, width: 1, height: 1 };
    expect(query(rect, ['20.99', '1.1', '20.99', null, 'missing']).nodes.map(node => node.item.id)).toEqual(['1.1', '20.99']);
    expect(query(rect).nodes).toEqual([]);
  });
  it('retains a crossing Bezier with both endpoints outside the viewport', () => {
    const rect = worldViewport(fitBounds(layout.bounds, 800, 420), 800, 420), result = query(rect);
    expect(result.edges.map(edge => edge.id)).toContain('replacement:1.1:20.99');
    expect(result.nodes.map(node => node.item.id)).not.toContain('1.1');
    expect(result.nodes.map(node => node.item.id)).not.toContain('20.99');
    expect(selectedParentEdges(layout, '20.99')).toEqual(new Set(['parent:20:20.99']));
    expect(layout.nodes).toHaveLength(2000);
    expect(result.nodes.length).toBeLessThan(200);
  });
  it('renders every element through 300 nodes and enables culling at 301', () => {
    const rect = { x: -2000, y: -2000, width: 1, height: 1 };
    const small = layoutGraph(layout.nodes.slice(0, 300).map(node => node.item));
    expect(indexGraph(small)(rect)).toBe(small);
    const larger = layoutGraph(layout.nodes.slice(0, 301).map(node => node.item));
    expect(indexGraph(larger)(rect).nodes).toEqual([]);
  });
});
