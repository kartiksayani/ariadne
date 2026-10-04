import type { Item, ItemOwner, Session } from '../../generated/domain/models';
import type { SessionPreferences } from '../../generated/core';
import { indexSession, type Immutable } from '../../data';

export interface SentenceRow {
  readonly item: Immutable<Item>;
  readonly depth: number;
  readonly context: boolean;
  readonly outsideFilters: boolean;
  readonly expanded: boolean;
  readonly childCount: number;
  readonly activeDescendants: number;
  readonly replacement: Immutable<Item> | null;
}
export interface SentenceRows {
  readonly rows: readonly SentenceRow[];
  readonly matchingTotal: number;
  readonly scopeTotal: number;
}
export function sameOwner(left: Immutable<ItemOwner>, right: Immutable<ItemOwner>): boolean {
  return left.kind === right.kind && (left.kind === 'me' || (left.kind === 'agent' && right.kind === 'agent'
    && left.binding_id === right.binding_id) || (left.kind === 'other' && right.kind === 'other' && left.name === right.name));
}
export const normalizeSearch = (text: string): string => text.normalize('NFKC').toLowerCase();
const selectedBySession = new WeakMap<Immutable<Session>, { key: string; value: SentenceRows }>();

// Initial expansion belongs to a new view only. Explicit persisted collapse
// choices are never recomputed when a live snapshot changes.
export function initialExpansion(session: Immutable<Session>): readonly string[] {
  const indexes = indexSession(session);
  return Object.freeze(Object.values(session.items).filter((item): item is Immutable<Item> => !!item)
    .filter(item => (indexes.childrenByParent.get(item.id)?.length ?? 0) > 0
      && ((indexes.activeDescendants.get(item.id) ?? 0) > 0 || ['open', 'waiting_on_me', 'in_progress'].includes(item.status)))
    .map(item => item.id));
}

export function sentenceRows(session: Immutable<Session>, view: Immutable<SessionPreferences>,
  later: ReadonlySet<string>, temporaryAncestors: readonly string[] = [], revealedItemId: string | null = null): SentenceRows {
  if (view.session.project_id !== session.project_id || view.session.session_id !== session.id) throw new Error('Tree view route differs from its registered session.');
  const key = JSON.stringify([view.filters, view.expanded_item_ids, [...later].sort(), temporaryAncestors, revealedItemId]);
  const known = selectedBySession.get(session);
  if (known?.key === key) return known.value;
  const indexes = indexSession(session), filters = view.filters;
  const tokens = normalizeSearch(filters.search).split(/\s+/u).filter(Boolean);
  const filtering = tokens.length > 0 || filters.statuses.length > 0 || filters.owners.length > 0 || filters.hide_later;
  const inScope = new Set(Object.values(session.items).filter((item): item is Immutable<Item> => !!item)
    .filter(item => {
      const topic = session.topics[item.topic_id];
      return !!topic && (filters.topic_id === null || item.topic_id === filters.topic_id)
        && (filters.archived ? topic.archived_at !== null : topic.archived_at === null);
    }).map(item => item.id));
  const matching = new Set<string>();
  for (const id of inScope) {
    const item = session.items[id]!;
    if (filters.statuses.length && !filters.statuses.includes(item.status)) continue;
    if (filters.owners.length && !filters.owners.some(owner => sameOwner(owner, item.owner))) continue;
    if (filters.hide_later && later.has(id)) continue;
    // The canonical conversation index excludes shared activity, raw provider
    // observations and unrelated operation backlinks.
    const text = normalizeSearch([item.question, item.outcome, item.why, session.topics[item.topic_id]!.name,
      ...(indexes.messagesByItem.get(id) ?? []).map(message => message.body)].filter(Boolean).join('\n'));
    if (tokens.every(token => text.includes(token))) matching.add(id);
  }
  const included = new Set(matching), expanded = new Set([...view.expanded_item_ids, ...temporaryAncestors]);
  const addAncestors = (id: string, open: boolean): void => {
    let parent = session.items[id]?.parent;
    while (parent) { included.add(parent); if (open) expanded.add(parent); parent = session.items[parent]?.parent; }
  };
  matching.forEach(id => addAncestors(id, filtering));
  if (revealedItemId && session.items[revealedItemId]) {
    included.add(revealedItemId); addAncestors(revealedItemId, true);
  }
  const topicOrder = new Map(Object.values(session.topics).filter(topic => !!topic).map(topic => [topic.id, topic.order]));
  const roots = [...indexes.childrenByParent.get(null) ?? []]
    .sort((a, b) => (topicOrder.get(a.topic_id) ?? 0) - (topicOrder.get(b.topic_id) ?? 0) || a.ordinal - b.ordinal);
  const pending = roots.map(item => ({ item, depth: 0 })).reverse(), rows: SentenceRow[] = [];
  while (pending.length) {
    const { item, depth } = pending.pop()!;
    if (!included.has(item.id)) continue;
    const children = indexes.childrenByParent.get(item.id) ?? [], open = expanded.has(item.id);
    rows.push(Object.freeze({ item, depth, context: !matching.has(item.id), outsideFilters: item.id === revealedItemId && !matching.has(item.id),
      expanded: open, childCount: children.length, activeDescendants: indexes.activeDescendants.get(item.id) ?? 0,
      replacement: item.replaced_by ? session.items[item.replaced_by] ?? null : null }));
    if (open) for (let i = children.length - 1; i >= 0; i--) pending.push({ item: children[i], depth: depth + 1 });
  }
  const value = Object.freeze({ rows: Object.freeze(rows), matchingTotal: matching.size, scopeTotal: inScope.size });
  selectedBySession.set(session, { key, value });
  return value;
}
