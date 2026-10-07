// Graph view model: one graph per topic, laid out left to right exactly as
// Ariadne.dc.html `buildGraph` (with `only` set) does. Rows, filters and
// expansion come from the tree's selector, so the graph follows the tree's
// expansion and filters (handoff README §7).
import type { Item, Session, Topic } from '../../generated/domain/models';
import type { SessionPreferences } from '../../generated/core';
import { indexSession, type Immutable } from '../../data';
import { normalizeSearch, sentenceRows, type SentenceRow } from '../../selectors/tree/rows';

export type GraphStatus = 'open' | 'waiting' | 'progress' | 'decided' | 'done' | 'dropped' | 'replaced';

/** Status icons and labels of the handoff's Status Badge. */
export const statusVisual: Readonly<Record<GraphStatus, { readonly label: string; readonly icon: string }>> = {
  open: { label: 'Open', icon: 'ph ph-circle' },
  waiting: { label: 'Waiting on me', icon: 'ph-fill ph-question' },
  progress: { label: 'In progress', icon: 'ph ph-circle-half' },
  decided: { label: 'Decided', icon: 'ph ph-check-circle' },
  done: { label: 'Done', icon: 'ph-fill ph-check-circle' },
  dropped: { label: 'Dropped', icon: 'ph ph-x-circle' },
  replaced: { label: 'Replaced', icon: 'ph ph-arrow-circle-right' },
};

export const graphStatus = (status: Item['status']): GraphStatus =>
  status === 'waiting_on_me' ? 'waiting' : status === 'in_progress' ? 'progress' : status;

const closedStatuses: ReadonlySet<Item['status']> = new Set(['decided', 'done', 'dropped', 'replaced']);
export const isClosed = (status: Item['status']): boolean => closedStatuses.has(status);

/** The handoff's Item.short is not a domain field yet; snapshots may carry it. */
export type ItemWithShort = Immutable<Item> & { readonly short?: string | null };

/** The item's short title: Item.short when present, else the question's first clause. Capitalised like the prototype. */
export function itemShort(item: ItemWithShort): string {
  const text = item.short?.trim() || item.question.split(/[?.:;,(]/u)[0]?.trim() || item.question;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Node and grid sizes (Ariadne.dc.html:1515). "Tight" is when detail or the rail is open. */
export const NODE_WIDTH = 190, NODE_HEIGHT = 66, ROW_HEIGHT = 84;
export const graphMetrics = (tight: boolean) => ({ pad: tight ? 14 : 20, gap: tight ? 18 : 26 });

export interface GraphNode {
  readonly item: ItemWithShort;
  readonly status: GraphStatus;
  readonly short: string;
  readonly x: number;
  readonly y: number;
  /** Items below this node, visible or not. */
  readonly below: number;
  /** Has children but none are shown: draws the "+N" pill. */
  readonly collapsed: boolean;
  /** Shows "−": expanded with children and no filter active. */
  readonly canCollapse: boolean;
  readonly selected: boolean;
  /** On the thread from the topic to the selected item, but not the selected item. */
  readonly onThread: boolean;
  readonly closed: boolean;
  /** Shown only as context for a filter: 40% opacity. */
  readonly dimmed: boolean;
}
export interface GraphEdge { readonly id: string; readonly d: string; readonly on: boolean }
export interface GraphReplacement { readonly id: string; readonly d: string; readonly labelX: number; readonly labelY: number }
export interface TopicGraph {
  readonly topic: Immutable<Topic>;
  readonly counts: string;
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly replacements: readonly GraphReplacement[];
}
export interface SessionGraph {
  readonly topics: readonly TopicGraph[];
  /** Node ids in layout order (topic by topic, depth first): the ↑/↓ order. */
  readonly order: readonly string[];
  /** Visible node by id. */
  readonly nodes: ReadonlyMap<string, GraphNode>;
  /** Visible children by parent id, in layout order. */
  readonly children: ReadonlyMap<string, readonly string[]>;
  readonly filtering: boolean;
}

export interface GraphInput {
  readonly session: Immutable<Session>;
  readonly view: Immutable<SessionPreferences>;
  readonly later: ReadonlySet<string>;
  readonly temporaryExpandedItemIds?: readonly string[];
  readonly revealedItemId?: string | null;
  readonly selectedId: string | null;
  readonly tight: boolean;
}

const descendantsBySession = new WeakMap<Immutable<Session>, Map<string, number>>();
/** Every item below `id`, visible or not. */
export function descendantCount(session: Immutable<Session>, id: string): number {
  let counts = descendantsBySession.get(session);
  if (!counts) { counts = new Map(); descendantsBySession.set(session, counts); }
  const known = counts.get(id);
  if (known !== undefined) return known;
  const children = indexSession(session).childrenByParent.get(id) ?? [];
  const total = children.reduce((sum, child) => sum + 1 + descendantCount(session, child.id), 0);
  counts.set(id, total);
  return total;
}

/** "1 waiting on you · 1 open · 8 closed" over every item of the topic (Ariadne.dc.html:1909). */
export function topicCounts(items: readonly Immutable<Item>[]): string {
  const count = (status: Item['status']) => items.filter(item => item.status === status).length;
  const closed = items.filter(item => isClosed(item.status)).length;
  return [[count('waiting_on_me'), 'waiting on you'], [count('open'), 'open'], [count('in_progress'), 'in progress'], [closed, 'closed']]
    .filter(([n]) => n).map(([n, words]) => `${n} ${words}`).join(' · ');
}

export const isFiltering = (filters: Immutable<SessionPreferences['filters']>): boolean =>
  normalizeSearch(filters.search).trim().length > 0 || filters.statuses.length > 0 || filters.owners.length > 0 || filters.hide_later;

/** Bezier from the parent's right edge to the child's left edge (Ariadne.dc.html:1573). */
export const edgePath = (x1: number, y1: number, x2: number, y2: number): string => {
  const mx = (x1 + x2) / 2;
  return `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
};

export function sessionGraph(input: GraphInput): SessionGraph {
  const { session, view, later, selectedId, tight } = input;
  const filtering = isFiltering(view.filters);
  const rows = sentenceRows(session, view, later, input.temporaryExpandedItemIds ?? [], input.revealedItemId ?? null).rows;
  const visible = new Map<string, SentenceRow>(rows.map(row => [row.item.id, row]));
  const children = new Map<string, string[]>();
  for (const row of rows) {
    const parent = row.item.parent;
    if (parent && visible.has(parent)) children.set(parent, [...children.get(parent) ?? [], row.item.id]);
  }
  const thread = new Set<string>();
  for (let id: string | null | undefined = selectedId; id && session.items[id]; id = session.items[id]?.parent) thread.add(id);
  const { pad, gap } = graphMetrics(tight);
  const columnX = (depth: number) => pad + gap + (depth - 1) * (NODE_WIDTH + gap);
  const byTopic = new Map<string, SentenceRow[]>();
  for (const row of rows) if (row.depth === 0) byTopic.set(row.item.topic_id, [...byTopic.get(row.item.topic_id) ?? [], row]);
  const allByTopic = new Map<string, Immutable<Item>[]>();
  for (const item of Object.values(session.items)) if (item) allByTopic.set(item.topic_id, [...allByTopic.get(item.topic_id) ?? [], item]);
  const topics = Object.values(session.topics).filter((topic): topic is Immutable<Topic> => !!topic && byTopic.has(topic.id))
    .sort((a, b) => a.order - b.order);
  const order: string[] = [], nodes = new Map<string, GraphNode>();
  const graphs = topics.map((topic): TopicGraph => {
    const position = new Map<string, { x: number; y: number }>();
    let y = pad, deepest = 1;
    const place = (row: SentenceRow, depth: number): number => {
      deepest = Math.max(deepest, depth);
      order.push(row.item.id);
      const kids = children.get(row.item.id) ?? [];
      let top: number;
      if (!kids.length) { top = y; y += ROW_HEIGHT; }
      else { const ys = kids.map(id => place(visible.get(id)!, depth + 1)); top = (ys[0] + ys[ys.length - 1]) / 2; }
      position.set(row.item.id, { x: columnX(depth), y: top });
      return top;
    };
    const tops = byTopic.get(topic.id)!;
    const ys = tops.map(row => place(row, 1));
    const topicY = (ys[0] + ys[ys.length - 1]) / 2;
    const edges: GraphEdge[] = tops.map(row => ({ id: `topic:${row.item.id}`, on: thread.has(row.item.id),
      d: edgePath(2, topicY + NODE_HEIGHT / 2, columnX(1), position.get(row.item.id)!.y + NODE_HEIGHT / 2) }));
    const replacements: GraphReplacement[] = [];
    const topicNodes = rows.filter(row => position.has(row.item.id)).map((row): GraphNode => {
      const item = row.item as ItemWithShort, at = position.get(item.id)!;
      const parent = item.parent ? position.get(item.parent) : undefined;
      if (parent) edges.push({ id: `parent:${item.parent}:${item.id}`, on: thread.has(item.parent!) && thread.has(item.id),
        d: edgePath(parent.x + NODE_WIDTH, parent.y + NODE_HEIGHT / 2, at.x, at.y + NODE_HEIGHT / 2) });
      const target = item.replaced_by ? position.get(item.replaced_by) : undefined;
      if (target) {
        const x1 = at.x + NODE_WIDTH / 2, y1 = at.y + NODE_HEIGHT, x2 = target.x + NODE_WIDTH / 2, y2 = target.y + NODE_HEIGHT;
        replacements.push({ id: `replacement:${item.id}:${item.replaced_by}`, labelX: (x1 + x2) / 2, labelY: Math.max(y1, y2) + 30,
          d: `M${x1} ${y1 + 2} C${x1} ${y1 + 44} ${x2} ${y2 + 44} ${x2} ${y2 + 6}` });
      }
      const below = descendantCount(session, item.id), shown = (children.get(item.id)?.length ?? 0) > 0;
      const collapsed = row.childCount > 0 && !shown, selected = selectedId === item.id;
      const node: GraphNode = { item, status: graphStatus(item.status), short: itemShort(item), x: at.x, y: at.y, below,
        collapsed: collapsed && below > 0, canCollapse: !filtering && !collapsed && below > 0, selected,
        onThread: thread.has(item.id) && !selected, closed: isClosed(item.status), dimmed: filtering && row.context && !selected };
      nodes.set(item.id, node);
      return node;
    });
    return { topic, counts: topicCounts(allByTopic.get(topic.id) ?? []), width: columnX(deepest) + NODE_WIDTH + pad, height: y + 20,
      nodes: topicNodes, edges, replacements };
  });
  return { topics: graphs, order, nodes, children, filtering };
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
