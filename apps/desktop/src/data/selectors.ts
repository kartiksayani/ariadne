import type { Item, Message, Round, Session, SessionSummary, SummaryCounts } from '../generated/domain/models';
import type { ItemRoute } from '../generated/core';
import type { Immutable } from './session-store';
import { itemRemoved } from '../selectors/removed';

export interface SessionIndexes {
  readonly itemById: Immutable<Session['items']>;
  readonly childrenByParent: ReadonlyMap<string | null, readonly Immutable<Item>[]>;
  readonly messagesByItem: ReadonlyMap<string, readonly Immutable<Message>[]>;
  readonly roundsByItem: ReadonlyMap<string, readonly Immutable<Round>[]>;
  readonly activeDescendants: ReadonlyMap<string, number>;
}
const terminal = new Set<Item['status']>(['decided', 'done', 'dropped', 'replaced']);
const indexesBySession = new WeakMap<Immutable<Session>, SessionIndexes>();
function append<T>(map: Map<string | null, T[]>, key: string | null, value: T): void {
  const group = map.get(key);
  if (group) group.push(value);
  else map.set(key, [value]);
}
export function indexSession(session: Immutable<Session>): SessionIndexes {
  const cached = indexesBySession.get(session);
  if (cached) return cached;
  const children = new Map<string | null, Immutable<Item>[]>();
  const messages = new Map<string, Immutable<Message>[]>();
  const rounds = new Map<string, Immutable<Round>[]>();
  for (const item of Object.values(session.items)) {
    if (!item || itemRemoved(session, item.id)) continue;
    if (item.parent !== null && !session.items[item.parent]) throw new Error('Item parent is unavailable.');
    append(children, item.parent, item);
  }
  children.forEach((items) => items.sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id)));
  for (const message of session.messages) {
    // Operation backlinks supply timeline provenance, not conversation targets.
    // Shared activity can also name a round without being one of its replies.
    if (message.kind !== 'owner_input' && message.kind !== 'reply') continue;
    if (message.item_id !== null) append(messages, message.item_id, message);
  }
  messages.forEach((values) => values.sort((a, b) => a.number - b.number));
  Object.values(session.rounds).forEach((round) => { if (round) append(rounds, round.item_id, round); });
  rounds.forEach((values) => values.sort((a, b) => a.ordinal - b.ordinal));
  const active = new Map<string, number>();
  const visiting = new Set<string>();
  function count(id: string): number {
    const known = active.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) throw new Error('Item parent cycle is invalid.');
    visiting.add(id);
    let total = 0;
    for (const child of children.get(id) ?? []) total += (terminal.has(child.status) ? 0 : 1) + count(child.id);
    visiting.delete(id);
    active.set(id, total);
    return total;
  }
  Object.keys(session.items).forEach(count);
  for (const map of [children, messages, rounds]) map.forEach((values) => Object.freeze(values));
  const indexes = Object.freeze({ itemById: session.items, childrenByParent: children, messagesByItem: messages, roundsByItem: rounds, activeDescendants: active });
  indexesBySession.set(session, indexes);
  return indexes;
}
export function revealAncestors(session: Immutable<Session>, route: ItemRoute): readonly string[] {
  const item = session.items[route.item_id];
  if (session.project_id !== route.project_id || session.id !== route.session_id || !item || itemRemoved(session, item.id)) {
    throw new Error('The registered item is unavailable in this session.');
  }
  const ancestors: string[] = [];
  const seen = new Set([route.item_id]);
  let parent = item.parent;
  while (parent !== null) {
    const ancestor = session.items[parent];
    if (seen.has(parent) || !ancestor) throw new Error('Item ancestry is invalid.');
    seen.add(parent);
    ancestors.unshift(parent);
    parent = ancestor.parent;
  }
  return Object.freeze(ancestors);
}
// Counts are backend projections and retain incomplete/unavailable information.
// Passing a summary prevents totals from depending on local visible rows.
export function summaryCounts(summary: Immutable<SessionSummary>): Immutable<SummaryCounts> {
  return summary.counts;
}
