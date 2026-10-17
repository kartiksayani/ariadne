// Graph view model (SPEC §5.1 state 1.3): one canvas, topics stacked down it, each with its title, a trunk joining its
// top items and orthogonal branch edges. Rows, filters and expansion come from the Tree's selector, so the Graph
// follows the Tree's folds and status filter. Search never filters here: matches are tinted by the view.
import type { Item, Session, Topic } from '../../generated/domain/models';
import type { SessionPreferences } from '../../generated/core';
import { indexSession, type Immutable } from '../../data';
import { itemRemoved } from '../../selectors/removed';
import { sentenceRows, type SentenceRow } from '../../selectors/tree/rows';
import { itemLabels } from '../shared/short';
import { displayStatus, type DisplayStatus } from '../../selectors/waiting/replied';
import { waitingOnOwner } from '../../selectors/sessionClosed';
import { hiddenItems } from '../tree/hidden';
import { filterOf, type FilterScope, type LocalChip } from '../../selectors/tree/filter';
import { connectedItems } from '../../selectors/related';
import { branchSlot } from '../tree/branch';
import { STATUS, statusKey, type StatusKey } from '../shared/status';

export type GraphStatus = StatusKey;

/** Status icons and labels of the handoff's Status Badge. */
export const statusVisual = STATUS;

export const graphStatus = (status: DisplayStatus): GraphStatus => statusKey[status];

const closedStatuses: ReadonlySet<Item['status']> = new Set(['decided', 'done', 'dropped', 'replaced']);
export const isClosed = (status: Item['status']): boolean => closedStatuses.has(status);

/** SPEC 1.3 geometry, in px: 40px nodes on 50px lanes, the first lane 50 down, depth 1 at 36, the trunk at 16. */
export const NODE_HEIGHT = 40, LANE = 50, FIRST_LANE = 50, LEFT = 36, TRUNK_X = 16, TRUNK_TOP = 36;
/** A branch edge leaves its parent's right edge, turns down this far out, then runs across into the child. */
export const ELBOW = 13;
/** Space between one topic's last lane and the next topic's title. */
export const TOPIC_GAP = 16;
const COLUMN_MIN = 150, COLUMN_MAX = 196, NODE_GAP = 26;

/**
 * SPEC 1.3's column, `clamp(150, floor((mapW − 56) / 5), 196)`. Deviation (maintainer, alpha.20): the view fits it to
 * the Map's width (as it is with Details folded, so the names fit on one line) only when the Graph opens or the session
 * changes, never on a Details or window width change, because re-fitting slides every node sideways and the Map never moves
 * on its own.
 */
export const graphColumn = (mapWidth: number): number => Math.min(COLUMN_MAX, Math.max(COLUMN_MIN, Math.floor((mapWidth - 56) / 5)));
export const nodeWidth = (column: number): number => column - NODE_GAP;

export interface GraphNode {
  readonly item: Immutable<Item>;
  readonly topicId: string;
  readonly status: GraphStatus;
  readonly short: string;
  /** Top-left inside its topic's block. */
  readonly x: number;
  readonly y: number;
  readonly depth: number;
  /** Folded with children: draws the quiet "+N" chip so children never vanish unseen. */
  readonly folded: boolean;
  /** Unfolded with drawn children: ← folds it. */
  readonly canFold: boolean;
  /** What unfolding would bring back into the Graph, across every tier (hidden branches are not drawn, so not counted). */
  readonly inside: number;
  /** Of those, the ones waiting on the owner. */
  readonly waitingInside: number;
  readonly selected: boolean;
  /** On the path from the topic to the selected item, but not the selected item. */
  readonly onPath: boolean;
  readonly closed: boolean;
  /** Shown only as context for a status filter. */
  readonly dimmed: boolean;
  /** Hidden by the owner and drawn only because it is on the selected or revealed route. */
  readonly hidden: boolean;
  /** Slot in BRANCH_HUES, from the top item's ordinal (ui/tree/branch.ts). Carried, not drawn: the board's nodes are plain. */
  readonly branch: number;
}
export interface GraphEdge { readonly id: string; readonly d: string }
export interface TopicGraph {
  readonly topic: Immutable<Topic>;
  /** The topic block's top in the canvas. */
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly GraphNode[];
  /** The trunk, its branch into each top item, and every parent-to-child elbow. */
  readonly edges: readonly GraphEdge[];
}
export interface SessionGraph {
  readonly topics: readonly TopicGraph[];
  readonly column: number;
  readonly nodeWidth: number;
  readonly width: number;
  readonly height: number;
  /** Node ids in layout order (topic by topic, depth first): the ↑/↓ order, and top-then-left reading order. */
  readonly order: readonly string[];
  /** Drawn node by id. */
  readonly nodes: ReadonlyMap<string, GraphNode>;
  /** Drawn children by parent id, in layout order. */
  readonly children: ReadonlyMap<string, readonly string[]>;
  readonly filtering: boolean;
  /** The selected node's path from its topic's trunk, in canvas coordinates; null with no drawn selection. */
  readonly path: string | null;
}

export interface GraphInput {
  readonly session: Immutable<Session>;
  readonly view: Immutable<SessionPreferences>;
  readonly later: ReadonlySet<string>;
  /** The local chips picked in this session (D15); the saved chips are in `view`. */
  readonly local?: readonly LocalChip[];
  readonly temporaryExpandedItemIds?: readonly string[];
  readonly revealedItemId?: string | null;
  readonly filterCollapsedItemIds?: ReadonlySet<string>;
  readonly selectedId: string | null;
  /** The fitted column (graphColumn); the narrowest when unmeasured. */
  readonly column?: number;
}

type Point = { readonly x: number; readonly y: number };
/** Orthogonal branch edge: from the parent's right edge, out ELBOW px, down (or up) to the child's centre, across into it. */
export const elbowPath = (parentRight: number, parentCentre: number, childLeft: number, childCentre: number): string =>
  `M${parentRight} ${parentCentre} H${parentRight + ELBOW} V${childCentre} H${childLeft}`;

/**
 * A related edge: cubic and undirected, between the nearest sides of two nodes (`a` and `b` are top-left corners in one
 * coordinate space, `width` the node width).
 */
export function relatedPath(a: Point, b: Point, width: number): string {
  const ac = a.y + NODE_HEIGHT / 2, bc = b.y + NODE_HEIGHT / 2;
  if (Math.abs(a.x - b.x) < width / 2) {
    // One above the other in a column: leave and enter on the right, bowing out.
    const x = a.x + width, bow = Math.min(60, 18 + Math.abs(bc - ac) / 6);
    return `M${x} ${ac} C${x + bow} ${ac} ${x + bow} ${bc} ${x} ${bc}`;
  }
  const [left, right] = a.x < b.x ? [{ x: a.x + width, y: ac }, { x: b.x, y: bc }] : [{ x: b.x + width, y: bc }, { x: a.x, y: ac }];
  const mid = (left.x + right.x) / 2;
  return `M${left.x} ${left.y} C${mid} ${left.y} ${mid} ${right.y} ${right.x} ${right.y}`;
}

/**
 * Related lines for `sources` (the selected node and the one under the pointer, SPEC 1.3) in canvas coordinates, once
 * per pair whatever the kind or direction, and the drawn nodes they reach. Built apart from `sessionGraph` so a hover
 * never rebuilds the layout.
 */
export function relatedLines(graph: SessionGraph, session: Immutable<Session>, sources: readonly (string | null)[]): {
  readonly paths: readonly GraphEdge[]; readonly related: ReadonlySet<string>;
} {
  const paths: GraphEdge[] = [], related = new Set<string>(), pairs = new Set<string>();
  const tops = new Map(graph.topics.map(topic => [topic.topic.id, topic.top]));
  const at = (node: GraphNode) => ({ x: node.x, y: (tops.get(node.topicId) ?? 0) + node.y });
  for (const source of new Set(sources)) {
    const from = source ? graph.nodes.get(source) : undefined;
    if (!from) continue;
    for (const item of connectedItems(session, from.item.id)) {
      const to = graph.nodes.get(item.id);
      if (!to) continue;
      related.add(to.item.id);
      const pair = [from.item.id, to.item.id].sort().join('|');
      if (pairs.has(pair)) continue;
      pairs.add(pair);
      paths.push({ id: `related:${from.item.id}:${to.item.id}`, d: relatedPath(at(from), at(to), graph.nodeWidth) });
    }
  }
  return { paths, related };
}

export function sessionGraph(input: GraphInput): SessionGraph {
  const { session, view, later, selectedId } = input;
  const column = input.column ?? COLUMN_MIN, width = nodeWidth(column);
  // Search tints matches and never filters (contract C4); the scope has no search. The Tree and the Graph share one filter (D17).
  const scope: FilterScope = { session, view, later, local: input.local ?? [] };
  const filtering = filterOf(scope).active;
  const explicit = new Set(view.hidden_item_ids ?? []);
  const hidden = hiddenItems(session, explicit);
  // Hidden items are not drawn (SPEC 1.3), except on the route to the selected or revealed item, dimmed: a path needs them.
  const route = new Set<string>();
  for (const end of [selectedId, input.revealedItemId ?? null]) {
    for (let id = end; id && session.items[id]; id = session.items[id]?.parent ?? null) route.add(id);
  }
  const temporary = new Set(input.temporaryExpandedItemIds ?? []);
  if (selectedId && [...route].some(id => hidden.has(id))) {
    for (let id = session.items[selectedId]?.parent; id; id = session.items[id]?.parent) temporary.add(id);
  }
  const rows = sentenceRows(scope, [...temporary], input.revealedItemId ?? null, input.filterCollapsedItemIds).rows;
  const drawable = (id: string) => !hidden.has(id) || route.has(id);
  const kidsByParent = new Map<string, SentenceRow[]>(), rootsByTopic = new Map<string, SentenceRow[]>();
  for (const row of rows) {
    if (!drawable(row.item.id)) continue;
    const list = row.depth === 0 ? rootsByTopic : kidsByParent, key = row.depth === 0 ? row.item.topic_id : row.item.parent;
    if (key) list.set(key, [...list.get(key) ?? [], row]);
  }
  // What unfolding a folded node brings back: its drawable subtree. Hidden branches stay out unless on the route.
  const { childrenByParent } = indexSession(session);
  const insideOf = (id: string): { inside: number; waiting: number } => {
    let inside = 0, waiting = 0;
    const visit = (parent: string) => {
      for (const child of childrenByParent.get(parent) ?? []) {
        if (!drawable(child.id) || itemRemoved(session, child.id)) continue;
        inside++; if (waitingOnOwner(session, child)) waiting++;
        visit(child.id);
      }
    };
    visit(id);
    return { inside, waiting };
  };
  const path = new Set<string>();
  for (let id: string | null | undefined = selectedId; id && session.items[id]; id = session.items[id]?.parent) path.add(id);
  const topics = Object.values(session.topics).filter((topic): topic is Immutable<Topic> => !!topic && rootsByTopic.has(topic.id))
    .sort((a, b) => a.order - b.order);
  const order: string[] = [], children = new Map<string, string[]>();
  const placed: { row: SentenceRow; topicId: string; x: number; y: number; branch: number; folded: boolean; canFold: boolean }[] = [];
  let top = 0, deepest = 1;
  const layouts = topics.map(topic => {
    let lane = 0;
    const position = new Map<string, Point>();
    /** Leaves take the next lane; a parent sits on its first child's lane (SPEC 1.3). Returns the row's lane. */
    const place = (row: SentenceRow, depth: number, branch: number): number => {
      deepest = Math.max(deepest, depth);
      order.push(row.item.id);
      const index = placed.length;
      placed.push({ row, topicId: topic.id, x: LEFT + (depth - 1) * column, y: 0, branch, folded: false, canFold: false });
      const kids = row.expanded ? kidsByParent.get(row.item.id) ?? [] : [];
      if (kids.length) children.set(row.item.id, kids.map(kid => kid.item.id));
      const at = kids.length ? kids.map(kid => place(kid, depth + 1, branch))[0]! : lane++;
      const y = FIRST_LANE + at * LANE;
      placed[index] = { ...placed[index]!, y, folded: !kids.length && row.childCount > 0, canFold: kids.length > 0 };
      position.set(row.item.id, { x: placed[index]!.x, y });
      return at;
    };
    const roots = rootsByTopic.get(topic.id)!;
    roots.forEach(row => place(row, 1, branchSlot(row.item.ordinal)));
    const height = FIRST_LANE + lane * LANE;
    const block = { topic, top, height, position, roots };
    top += height + TOPIC_GAP;
    return block;
  });
  const canvasWidth = LEFT + (deepest - 1) * column + width + 24;
  const labels = itemLabels(placed.map(entry => entry.row.item), session.topics);
  const nodes = new Map<string, GraphNode>();
  const nodesByTopic = new Map<string, GraphNode[]>();
  for (const entry of placed) {
    const { row } = entry, item = row.item, selected = item.id === selectedId;
    const { inside, waiting } = entry.folded ? insideOf(item.id) : { inside: 0, waiting: 0 };
    const node: GraphNode = { item, topicId: entry.topicId, status: graphStatus(displayStatus(session, item)), short: labels.get(item.id)!,
      x: entry.x, y: entry.y, depth: row.depth + 1, folded: entry.folded && inside > 0, canFold: entry.canFold, inside, waitingInside: waiting,
      selected, onPath: path.has(item.id) && !selected, closed: isClosed(item.status), dimmed: filtering && row.context && !selected,
      hidden: hidden.has(item.id), branch: entry.branch };
    nodes.set(item.id, node);
    nodesByTopic.set(entry.topicId, [...nodesByTopic.get(entry.topicId) ?? [], node]);
  }
  const centre = (point: Point) => point.y + NODE_HEIGHT / 2;
  const graphs = layouts.map(({ topic, top: blockTop, height, position, roots }): TopicGraph => {
    const firstCentre = centre(position.get(roots[0]!.item.id)!), lastCentre = centre(position.get(roots[roots.length - 1]!.item.id)!);
    const edges: GraphEdge[] = [{ id: `trunk:${topic.id}`, d: `M${TRUNK_X} ${Math.min(TRUNK_TOP, firstCentre)} V${lastCentre}` },
      ...roots.map(row => ({ id: `topic:${row.item.id}`, d: `M${TRUNK_X} ${centre(position.get(row.item.id)!)} H${LEFT}` }))];
    for (const [parent, kids] of children) {
      const from = position.get(parent);
      if (!from) continue;
      // The first child gets the whole elbow; each later one only its stretch of the shared vertical, so a hundred
      // children never stack a hundred antialiased copies of the same line.
      let previous = centre(from);
      kids.forEach((kid, index) => {
        const to = position.get(kid)!, at = centre(to);
        edges.push({ id: `parent:${parent}:${kid}`, d: index === 0 ? elbowPath(from.x + width, previous, to.x, at)
          : `M${from.x + width + ELBOW} ${previous} V${at} H${to.x}` });
        previous = at;
      });
    }
    return { topic, top: blockTop, width: canvasWidth, height, nodes: nodesByTopic.get(topic.id) ?? [], edges };
  });
  // The selected path: down the trunk from its top into the first ancestor, then elbow by elbow to the selection.
  let selectedPath: string | null = null;
  const chosen = selectedId ? nodes.get(selectedId) : undefined;
  if (chosen) {
    const block = graphs.find(graph => graph.topic.id === chosen.topicId)!;
    const chain: GraphNode[] = [];
    for (let id: string | null | undefined = chosen.item.id; id; id = session.items[id]?.parent) {
      const node = nodes.get(id);
      if (!node) break;
      chain.unshift(node);
    }
    const root = chain[0]!, y = (value: number) => block.top + value;
    const parts = [`M${TRUNK_X} ${y(TRUNK_TOP)} V${y(centre(root))} H${LEFT}`];
    for (let i = 1; i < chain.length; i++) {
      const from = chain[i - 1]!, to = chain[i]!;
      parts.push(elbowPath(from.x + width, y(centre(from)), to.x, y(centre(to))));
    }
    selectedPath = parts.join(' ');
  }
  return { topics: graphs, column, nodeWidth: width, width: canvasWidth, height: Math.max(0, top - TOPIC_GAP), order, nodes, children,
    filtering, path: selectedPath };
}

export type ExpansionChange = { readonly kind: 'expand' | 'collapse'; readonly id: string };
/** A pending view change: the latest selection and the expansion edits since the saved view. */
export interface ViewChange { readonly selected?: string; readonly expansion: readonly ExpansionChange[] }

export function mergeChange(previous: ViewChange | null, next: ViewChange): ViewChange {
  return { selected: next.selected ?? previous?.selected, expansion: [...previous?.expansion ?? [], ...next.expansion] };
}

/** The saved view with `change` applied; returns `view` itself when nothing changes. */
export function applyChange<T extends Immutable<SessionPreferences>>(view: T, change: ViewChange | null): T {
  if (!change) return view;
  const expanded = new Set(view.expanded_item_ids);
  for (const edit of change.expansion) if (edit.kind === 'expand') expanded.add(edit.id); else expanded.delete(edit.id);
  const selected = change.selected ?? view.selected_item_id;
  const same = selected === view.selected_item_id && expanded.size === view.expanded_item_ids.length
    && view.expanded_item_ids.every(id => expanded.has(id));
  return same ? view : { ...view, selected_item_id: selected, expanded_item_ids: [...expanded] };
}
