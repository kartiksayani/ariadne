import type { Item } from '../../generated/domain/models';
import type { Immutable } from '../../data/session-store';

export const NODE_WIDTH = 190, NODE_HEIGHT = 66, DEPTH_STEP = 254, LEAF_STEP = 94, ROOT_GAP = 32;
export interface Bounds { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface LayoutNode extends Bounds { readonly item: Immutable<Item>; readonly depth: number }
export interface LayoutEdge { readonly id: string; readonly source: string; readonly target: string;
  readonly kind: 'parent' | 'replacement'; readonly path: string; readonly bounds: Bounds;
  readonly label: { readonly x: number; readonly y: number } | null }
export interface GraphLayout { readonly nodes: readonly LayoutNode[]; readonly edges: readonly LayoutEdge[]; readonly bounds: Bounds }
const order = (a: Immutable<Item>, b: Immutable<Item>) => a.ordinal - b.ordinal || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
function edge(source: LayoutNode, target: LayoutNode, kind: LayoutEdge['kind']): LayoutEdge {
  const x1 = source.x + NODE_WIDTH, y1 = source.y + NODE_HEIGHT / 2;
  const x2 = target.x, y2 = target.y + NODE_HEIGHT / 2, controlX = (x1 + x2) / 2;
  return Object.freeze({ id: `${kind}:${source.item.id}:${target.item.id}`, source: source.item.id, target: target.item.id, kind,
    path: `M ${x1} ${y1} C ${controlX} ${y1}, ${controlX} ${y2}, ${x2} ${y2}`,
    // Conservative control-point bounds are also the future culling seam.
    bounds: Object.freeze({ x: Math.min(x1, x2, controlX), y: Math.min(y1, y2), width: Math.max(x1, x2, controlX) - Math.min(x1, x2, controlX), height: Math.abs(y2 - y1) }),
    label: kind === 'replacement' ? Object.freeze({ x: controlX, y: (y1 + y2) / 2 - 6 }) : null });
}

// Canonical filtered items already include their ordinary ancestor context.
// Replacement pointers never alter parent ordering, placement or cycle checks.
export function layoutGraph(items: readonly Immutable<Item>[]): GraphLayout {
  const byId = new Map(items.map(item => [item.id, item]));
  if (byId.size !== items.length) throw new Error('Graph item identities must be unique.');
  const children = new Map<string | null, Immutable<Item>[]>();
  for (const item of items) {
    if (item.parent && !byId.has(item.parent)) throw new Error('Graph parent context is missing.');
    const group = children.get(item.parent) ?? []; group.push(item); children.set(item.parent, group);
  }
  children.forEach(group => group.sort(order));
  const roots = children.get(null) ?? [], positions = new Map<string, LayoutNode>();
  let leafCenter = NODE_HEIGHT / 2;
  for (const root of roots) {
    const pending = [{ item: root, depth: 0, exit: false }];
    while (pending.length) {
      const next = pending.pop()!, group = children.get(next.item.id) ?? [];
      if (!next.exit && group.length) {
        pending.push({ ...next, exit: true });
        for (let i = group.length - 1; i >= 0; i--) pending.push({ item: group[i], depth: next.depth + 1, exit: false });
        continue;
      }
      const center = group.length
        ? (positions.get(group[0].id)!.y + positions.get(group.at(-1)!.id)!.y) / 2 + NODE_HEIGHT / 2
        : leafCenter;
      if (!group.length) leafCenter += LEAF_STEP;
      positions.set(next.item.id, Object.freeze({ item: next.item, depth: next.depth, x: next.depth * DEPTH_STEP,
        y: center - NODE_HEIGHT / 2, width: NODE_WIDTH, height: NODE_HEIGHT }));
    }
    leafCenter += ROOT_GAP;
  }
  if (positions.size !== items.length) throw new Error('Graph parent structure contains a cycle.');
  // Return stable preorder even when the authoritative item map arrives in a
  // different insertion order. Geometry never depends on the viewport.
  const nodes: LayoutNode[] = [], pending = [...roots].reverse();
  while (pending.length) {
    const item = pending.pop()!; nodes.push(positions.get(item.id)!);
    const group = children.get(item.id) ?? []; for (let i = group.length - 1; i >= 0; i--) pending.push(group[i]);
  }
  const edges: LayoutEdge[] = [];
  for (const node of nodes) {
    if (node.item.parent) edges.push(edge(positions.get(node.item.parent)!, node, 'parent'));
    const replacement = node.item.replaced_by && positions.get(node.item.replaced_by);
    if (replacement) edges.push(edge(node, replacement, 'replacement'));
  }
  const right = Math.max(0, ...nodes.map(node => node.x + node.width));
  const bottom = Math.max(0, ...nodes.map(node => node.y + node.height));
  return Object.freeze({ nodes: Object.freeze(nodes), edges: Object.freeze(edges), bounds: Object.freeze({ x: 0, y: 0, width: right, height: bottom }) });
}

export function selectedParentEdges(layout: GraphLayout, selected: string | null): ReadonlySet<string> {
  const nodes = new Map(layout.nodes.map(node => [node.item.id, node])), selectedEdges = new Set<string>();
  let node = selected ? nodes.get(selected) : undefined;
  while (node?.item.parent) { selectedEdges.add(`parent:${node.item.parent}:${node.item.id}`); node = nodes.get(node.item.parent); }
  return selectedEdges;
}
