import type { Bounds, GraphLayout, LayoutEdge, LayoutNode } from '../layout/geometry';
import type { Viewport } from '../layout/viewport';

export const CELL_SIZE = 512, CULL_THRESHOLD = 300, SCREEN_MARGIN = 200;
export const intersects = (a: Bounds, b: Bounds): boolean => a.x <= b.x + b.width && a.x + a.width >= b.x
  && a.y <= b.y + b.height && a.y + a.height >= b.y;

export function worldViewport(view: Viewport, width: number, height: number, margin = SCREEN_MARGIN): Bounds {
  return { x: (-view.x - margin) / view.scale, y: (-view.y - margin) / view.scale,
    width: (width + 2 * margin) / view.scale, height: (height + 2 * margin) / view.scale };
}

// Each entry may occupy several cells. Query deduplicates before intersection
// testing and restores layout order, so viewport movement never changes stacking.
function buckets<T>(values: readonly T[], bounds: (value: T) => Bounds) {
  const cells = new Map<string, number[]>();
  const visit = (rect: Bounds, consume: (key: string) => void) => {
    for (let x = Math.floor(rect.x / CELL_SIZE); x <= Math.floor((rect.x + rect.width) / CELL_SIZE); x++) {
      for (let y = Math.floor(rect.y / CELL_SIZE); y <= Math.floor((rect.y + rect.height) / CELL_SIZE); y++) consume(`${x}:${y}`);
    }
  };
  values.forEach((value, index) => visit(bounds(value), key => {
    const cell = cells.get(key) ?? []; cell.push(index); cells.set(key, cell);
  }));
  return (rect: Bounds, retained: readonly number[] = []): readonly T[] => {
    const candidates = new Set<number>();
    visit(rect, key => cells.get(key)?.forEach(index => candidates.add(index)));
    const matches = new Set([...candidates].filter(index => intersects(bounds(values[index]), rect)));
    retained.forEach(index => matches.add(index));
    return [...matches].sort((a, b) => a - b).map(index => values[index]);
  };
}

export interface RenderedGraph { readonly nodes: readonly LayoutNode[]; readonly edges: readonly LayoutEdge[] }
export function indexGraph(layout: GraphLayout): (rect: Bounds, retainedIds?: readonly (string | null)[]) => RenderedGraph {
  if (layout.nodes.length <= CULL_THRESHOLD) return () => layout;
  const nodes = buckets(layout.nodes, node => node), edges = buckets(layout.edges, edge => edge.bounds);
  const nodeIndices = new Map(layout.nodes.map((node, index) => [node.item.id, index]));
  return (rect, retainedIds = []) => ({ nodes: nodes(rect, retainedIds.flatMap(id => {
    const index = id === null ? undefined : nodeIndices.get(id); return index === undefined ? [] : [index];
  })), edges: edges(rect) });
}
