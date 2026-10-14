import { activeItems } from '../../selectors/removed';
// Graph view model: one graph per topic, laid out left to right exactly as
// Ariadne.dc.html `buildGraph` (with `only` set) does. Rows, filters and
// expansion come from the tree's selector, so the graph follows the tree's
// expansion and filters (handoff README §7).
import type { Item, Session, Topic } from '../../generated/domain/models';
import type { SessionPreferences } from '../../generated/core';
import { indexSession, type Immutable } from '../../data';
import { normalizeSearch, sentenceRows, type SentenceRow } from '../../selectors/tree/rows';
import { itemLabels } from '../shared/short';
import { displayStatus, type DisplayStatus } from '../../selectors/waiting/replied';
import { waitingOnOwner } from '../../selectors/sessionClosed';
import { hiddenGroupKey, hiddenGroupsFor, hiddenItems } from '../tree/hidden';
import { connectedItems } from '../../selectors/related';
import { ackTarget } from '../../selectors/ack';
import { hasStatusFilter } from '../../selectors/tree/folds';

export type GraphStatus = 'open' | 'waiting' | 'agent' | 'progress' | 'decided' | 'done' | 'dropped' | 'replaced';

/** Status icons and labels of the handoff's Status Badge. */
export const statusVisual: Readonly<Record<GraphStatus, { readonly label: string; readonly icon: string }>> = {
  open: { label: 'Open', icon: 'ph ph-circle' },
  waiting: { label: 'Waiting on me', icon: 'ph-fill ph-question' },
  agent: { label: 'Waiting on agent', icon: 'ph ph-hourglass-medium' },
  progress: { label: 'In progress', icon: 'ph ph-circle-half' },
  decided: { label: 'Decided', icon: 'ph ph-check-circle' },
  done: { label: 'Done', icon: 'ph-fill ph-check-circle' },
  dropped: { label: 'Dropped', icon: 'ph ph-x-circle' },
  replaced: { label: 'Replaced', icon: 'ph ph-arrow-circle-right' },
};

export const graphStatus = (status: DisplayStatus): GraphStatus =>
  status === 'waiting_on_me' ? 'waiting' : status === 'waiting_on_agent' ? 'agent' : status === 'in_progress' ? 'progress' : status;

const closedStatuses: ReadonlySet<Item['status']> = new Set(['decided', 'done', 'dropped', 'replaced']);
export const isClosed = (status: Item['status']): boolean => closedStatuses.has(status);

/** Node and grid sizes (Ariadne.dc.html:1515). "Tight" is when detail is open. */
export const NODE_WIDTH = 190, NODE_HEIGHT = 66, ROW_HEIGHT = 84;
/** The "N hidden" stub that stands in for hidden siblings: far smaller than a card, with its own short slot. */
export const STUB_WIDTH = 124, STUB_HEIGHT = 26, STUB_SLOT = 40;
export const graphMetrics = (tight: boolean) => ({ pad: tight ? 14 : 20, gap: tight ? 18 : 26 });

/** The Map's "N items hidden" row, drawn as a stub: one per parent that has hidden children (ui/tree/hidden.ts keys). */
export interface GraphStub {
  readonly key: string;
  readonly topicId: string;
  readonly parent: string | null;
  readonly x: number;
  readonly y: number;
  /** Hidden siblings it stands for. */
  readonly count: number;
  /** Something under them waits on the owner. */
  readonly waiting: boolean;
  readonly expanded: boolean;
}

export interface GraphNode {
  readonly item: Immutable<Item>;
  readonly status: GraphStatus;
  readonly short: string;
  readonly x: number;
  readonly y: number;
  /** Items below this node that expanding it can draw: hidden items and what is under them are not counted. */
  readonly below: number;
  /** Hidden items below this node (each hidden branch counted once): the stub's items. */
  readonly hiddenBelow: number;
  /** Has children but none are shown: draws the "+N" pill. */
  readonly collapsed: boolean;
  /** Shows "−": expanded with children, including filter context. */
  readonly canCollapse: boolean;
  readonly selected: boolean;
  /** On the thread from the topic to the selected item, but not the selected item. */
  readonly onThread: boolean;
  readonly closed: boolean;
  /** Shown only as context for a filter: 40% opacity. */
  readonly dimmed: boolean;
  /** Hidden by the owner, directly or through a parent. Still opens in detail. */
  readonly hidden: boolean;
  readonly ack: NonNullable<Item['ack_to']> | null;
}
export interface GraphEdge { readonly id: string; readonly d: string; readonly on: boolean }
export interface GraphReplacement { readonly id: string; readonly d: string; readonly labelX: number; readonly labelY: number }
export interface RelatedEdge { readonly id: string; readonly from: string; readonly to: string }
export interface TopicGraph {
  readonly topic: Immutable<Topic>;
  readonly counts: string;
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly GraphNode[];
  readonly stubs: readonly GraphStub[];
  readonly edges: readonly GraphEdge[];
  readonly replacements: readonly GraphReplacement[];
  readonly related: readonly { readonly id: string; readonly d: string }[];
}
export interface SessionGraph {
  readonly topics: readonly TopicGraph[];
  /** Node ids in layout order (topic by topic, depth first): the ↑/↓ order. Hidden items count only while their stub is open. */
  readonly order: readonly string[];
  /** Visible node by id. */
  readonly nodes: ReadonlyMap<string, GraphNode>;
  /** Hidden-sibling stubs by group key. */
  readonly stubs: ReadonlyMap<string, GraphStub>;
  /** Drawn children by parent id, in layout order. */
  readonly children: ReadonlyMap<string, readonly string[]>;
  readonly filtering: boolean;
  readonly crossTopicRelated: readonly RelatedEdge[];
}

export interface GraphInput {
  readonly session: Immutable<Session>;
  readonly view: Immutable<SessionPreferences>;
  readonly later: ReadonlySet<string>;
  readonly temporaryExpandedItemIds?: readonly string[];
  readonly revealedItemId?: string | null;
  readonly filterCollapsedItemIds?: ReadonlySet<string>;
  /** Hidden groups the owner opened (keys of `hiddenGroupKey`); local to the view, never saved. */
  readonly expandedHiddenGroups?: ReadonlySet<string>;
  readonly selectedId: string | null;
  readonly tight: boolean;
}

/** "1 waiting on you · 1 waiting on agent · 1 open · 8 closed" over every item of the topic (Ariadne.dc.html:1909). */
export function topicCounts(items: readonly Immutable<Item>[], session?: Immutable<Session>): string {
  const shown = (item: Immutable<Item>): DisplayStatus => session ? displayStatus(session, item) : item.status;
  const count = (status: DisplayStatus) => items.filter(item => shown(item) === status).length;
  const closed = items.filter(item => isClosed(item.status)).length;
  const ack = session ? items.filter(item => ackTarget(session, item)).length : 0;
  const waiting = session ? items.filter(item => waitingOnOwner(session, item)).length : count('waiting_on_me');
  return [[waiting, 'waiting on you'], [count('waiting_on_agent'), 'waiting on agent'], [ack, 'to ack'],
    [count('open'), 'open'], [count('in_progress'), 'in progress'], [closed, 'closed']]
    .filter(([n]) => n).map(([n, words]) => `${n} ${words}`).join(' · ');
}

export const isFiltering = (filters: Immutable<SessionPreferences['filters']>): boolean =>
  normalizeSearch(filters.search).trim().length > 0 || hasStatusFilter(filters.statuses) || filters.owners.length > 0 || filters.hide_later;

/** Bezier from the parent's right edge to the child's left edge (Ariadne.dc.html:1573). */
export const edgePath = (x1: number, y1: number, x2: number, y2: number): string => {
  const mx = (x1 + x2) / 2;
  return `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
};

/** Connect the nearest sides without arrowheads: a related connection has no direction. */
export function relatedEdgePath(a: { readonly x: number; readonly y: number }, b: { readonly x: number; readonly y: number }): string {
  const dx = b.x - a.x, dy = b.y - a.y;
  const horizontal = Math.abs(dx) / NODE_WIDTH > Math.abs(dy) / NODE_HEIGHT;
  const x1 = a.x + NODE_WIDTH / 2 + (horizontal ? Math.sign(dx) * NODE_WIDTH / 2 : 0);
  const y1 = a.y + NODE_HEIGHT / 2 + (horizontal ? 0 : Math.sign(dy) * NODE_HEIGHT / 2);
  const x2 = b.x + NODE_WIDTH / 2 - (horizontal ? Math.sign(dx) * NODE_WIDTH / 2 : 0);
  const y2 = b.y + NODE_HEIGHT / 2 - (horizontal ? 0 : Math.sign(dy) * NODE_HEIGHT / 2);
  return `M${x1} ${y1} L${x2} ${y2}`;
}

export function sessionGraph(input: GraphInput): SessionGraph {
  const { session, view, later, selectedId, tight } = input;
  const filtering = isFiltering(view.filters);
  const explicit = new Set(view.hidden_item_ids ?? []);
  const hidden = hiddenItems(session, explicit);
  // The Tree's rule (ui/tree/model.ts): a hidden item folds into one stub among its siblings; an outside
  // reveal opens the groups on its route, and the owner opens the rest, locally.
  const openGroups = new Set(input.expandedHiddenGroups ?? []);
  if (input.revealedItemId) hiddenGroupsFor(session, explicit, input.revealedItemId).forEach(key => openGroups.add(key));
  const rows = sentenceRows(session, view, later, input.temporaryExpandedItemIds ?? [], input.revealedItemId ?? null, input.filterCollapsedItemIds).rows;
  const labels = itemLabels(rows.map(row => row.item), session.topics);
  const indexes = indexSession(session);
  const rowsByParent = new Map<string, SentenceRow[]>(), rootsByTopic = new Map<string, SentenceRow[]>();
  for (const row of rows) {
    const list = row.depth === 0 ? rootsByTopic : rowsByParent, key = row.depth === 0 ? row.item.topic_id : row.item.parent;
    if (key) list.set(key, [...list.get(key) ?? [], row]);
  }
  type Entry = { readonly kind: 'item'; readonly row: SentenceRow } | { readonly kind: 'stub'; readonly stub: Omit<GraphStub, 'x' | 'y'> };
  /** Visible siblings, then one stub for the hidden ones, then the hidden ones while the owner has the stub open. */
  const entriesOf = (list: readonly SentenceRow[], topicId: string, parent: string | null): Entry[] => {
    const item = (row: SentenceRow): Entry => ({ kind: 'item', row });
    const hiddenSiblings = list.filter(row => explicit.has(row.item.id));
    if (!hiddenSiblings.length) return list.map(item);
    const key = hiddenGroupKey(topicId, parent), expanded = openGroups.has(key);
    const below: Immutable<Item>[] = [];
    const gather = (value: Immutable<Item>) => { below.push(value); (indexes.childrenByParent.get(value.id) ?? []).forEach(gather); };
    hiddenSiblings.forEach(row => gather(row.item));
    return [...list.filter(row => !explicit.has(row.item.id)).map(item),
      { kind: 'stub', stub: { key, topicId, parent, count: hiddenSiblings.length, waiting: below.some(value => waitingOnOwner(session, value)), expanded } },
      ...(expanded ? hiddenSiblings.map(item) : [])];
  };
  // What expanding a node can draw below it; hidden branches are the stub's, not the node's.
  const belowCache = new Map<string, { below: number; hidden: number }>();
  const belowOf = (id: string): { below: number; hidden: number } => {
    const known = belowCache.get(id);
    if (known) return known;
    let count = 0, hiddenCount = 0;
    for (const child of indexes.childrenByParent.get(id) ?? []) {
      if (explicit.has(child.id)) { hiddenCount++; continue; }
      const inner = belowOf(child.id);
      count += 1 + inner.below; hiddenCount += inner.hidden;
    }
    const value = { below: count, hidden: hiddenCount };
    belowCache.set(id, value);
    return value;
  };
  const children = new Map<string, string[]>(), kidEntries = new Map<string, number>(), stubs = new Map<string, GraphStub>();
  const thread = new Set<string>();
  for (let id: string | null | undefined = selectedId; id && session.items[id]; id = session.items[id]?.parent) thread.add(id);
  const { pad, gap } = graphMetrics(tight);
  const columnX = (depth: number) => pad + gap + (depth - 1) * (NODE_WIDTH + gap);
  const allByTopic = new Map<string, Immutable<Item>[]>();
  for (const item of activeItems(session)) allByTopic.set(item.topic_id, [...allByTopic.get(item.topic_id) ?? [], item]);
  const topics = Object.values(session.topics).filter((topic): topic is Immutable<Topic> => !!topic && rootsByTopic.has(topic.id))
    .sort((a, b) => a.order - b.order);
  const order: string[] = [], nodes = new Map<string, GraphNode>();
  const graphs = topics.map((topic): TopicGraph => {
    const position = new Map<string, { x: number; y: number }>(), topicStubs: GraphStub[] = [], stubTop = new Map<string, number>();
    let y = pad, deepest = 1;
    /** Returns the entry's "card top": its centre is `top + NODE_HEIGHT / 2`, which is what edges and parents average. */
    const place = (entry: Entry, depth: number): number => {
      deepest = Math.max(deepest, depth);
      if (entry.kind === 'stub') {
        const stub: GraphStub = { ...entry.stub, x: columnX(depth), y };
        topicStubs.push(stub); stubs.set(stub.key, stub);
        const top = y + STUB_HEIGHT / 2 - NODE_HEIGHT / 2;
        stubTop.set(stub.key, top); y += STUB_SLOT;
        return top;
      }
      const { row } = entry;
      order.push(row.item.id);
      const kids = entriesOf(rowsByParent.get(row.item.id) ?? [], topic.id, row.item.id);
      kidEntries.set(row.item.id, kids.length);
      const drawn = kids.flatMap(kid => kid.kind === 'item' ? [kid.row.item.id] : []);
      if (drawn.length) children.set(row.item.id, drawn);
      let top: number;
      if (!kids.length) { top = y; y += ROW_HEIGHT; }
      else { const ys = kids.map(kid => place(kid, depth + 1)); top = (ys[0] + ys[ys.length - 1]) / 2; }
      position.set(row.item.id, { x: columnX(depth), y: top });
      return top;
    };
    const tops = entriesOf(rootsByTopic.get(topic.id)!, topic.id, null);
    const ys = tops.map(entry => place(entry, 1));
    const topicY = (ys[0] + ys[ys.length - 1]) / 2;
    const edges: GraphEdge[] = tops.map(entry => {
      const id = entry.kind === 'item' ? entry.row.item.id : entry.stub.key;
      return { id: `topic:${id}`, on: entry.kind === 'item' && thread.has(id),
        d: edgePath(2, topicY + NODE_HEIGHT / 2, columnX(1), (entry.kind === 'item' ? position.get(id)!.y : stubTop.get(id)!) + NODE_HEIGHT / 2) };
    });
    for (const stub of topicStubs) {
      const parent = stub.parent ? position.get(stub.parent) : undefined;
      if (parent) edges.push({ id: `parent:${stub.parent}:${stub.key}`, on: false,
        d: edgePath(parent.x + NODE_WIDTH, parent.y + NODE_HEIGHT / 2, stub.x, stubTop.get(stub.key)! + NODE_HEIGHT / 2) });
    }
    const replacements: GraphReplacement[] = [];
    const topicNodes = rows.filter(row => position.has(row.item.id)).map((row): GraphNode => {
      const item = row.item, at = position.get(item.id)!;
      const parent = item.parent ? position.get(item.parent) : undefined;
      if (parent) edges.push({ id: `parent:${item.parent}:${item.id}`, on: thread.has(item.parent!) && thread.has(item.id),
        d: edgePath(parent.x + NODE_WIDTH, parent.y + NODE_HEIGHT / 2, at.x, at.y + NODE_HEIGHT / 2) });
      const target = item.replaced_by ? position.get(item.replaced_by) : undefined;
      if (target) {
        const x1 = at.x + NODE_WIDTH / 2, y1 = at.y + NODE_HEIGHT, x2 = target.x + NODE_WIDTH / 2, y2 = target.y + NODE_HEIGHT;
        replacements.push({ id: `replacement:${item.id}:${item.replaced_by}`, labelX: (x1 + x2) / 2, labelY: Math.max(y1, y2) + 30,
          d: `M${x1} ${y1 + 2} C${x1} ${y1 + 44} ${x2} ${y2 + 44} ${x2} ${y2 + 6}` });
      }
      // A node whose children are all hidden still has its stub to show: expanding it is what draws that stub.
      const { below, hidden: hiddenBelow } = belowOf(item.id), shown = (kidEntries.get(item.id) ?? 0) > 0, anything = below + hiddenBelow > 0;
      const collapsed = row.childCount > 0 && !shown, selected = selectedId === item.id;
      const node: GraphNode = { item, status: graphStatus(displayStatus(session, item)), short: labels.get(item.id)!, x: at.x, y: at.y, below, hiddenBelow,
        collapsed: collapsed && anything, canCollapse: !collapsed && anything, selected,
        onThread: thread.has(item.id) && !selected, closed: isClosed(item.status), dimmed: filtering && row.context && !selected,
        hidden: hidden.has(item.id), ack: ackTarget(session, item) };
      nodes.set(item.id, node);
      return node;
    });
    return { topic, counts: topicCounts(allByTopic.get(topic.id) ?? [], session), width: columnX(deepest) + NODE_WIDTH + pad, height: y + 20,
      nodes: topicNodes, stubs: topicStubs, edges, replacements, related: [] };
  });
  const crossTopicRelated: RelatedEdge[] = [];
  const selected = selectedId ? nodes.get(selectedId) : undefined;
  const linked = selected ? connectedItems(session, selected.item.id) : [];
  const relatedByTopic = new Map<string, { id: string; d: string }[]>();
  for (const item of linked) {
    const target = nodes.get(item.id);
    if (!selected || !target) continue;
    const id = `related:${selected.item.id}:${target.item.id}`;
    if (selected.item.topic_id !== target.item.topic_id) crossTopicRelated.push({ id, from: selected.item.id, to: target.item.id });
    else {
      const edges = relatedByTopic.get(item.topic_id) ?? [];
      edges.push({ id, d: relatedEdgePath(selected, target) }); relatedByTopic.set(item.topic_id, edges);
    }
  }
  return { topics: graphs.map(topic => ({ ...topic, related: relatedByTopic.get(topic.topic.id) ?? [] })), order, nodes, stubs, children, filtering, crossTopicRelated };
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

/** The session chip of a topic card: the session's agent and day when it is not today ("codex · yesterday"). */
export function sessionChip(agent: string | null, when: string): string | null {
  if (!agent || when.startsWith('Today')) return null;
  return `${agent} · ${when.toLowerCase()}`;
}
