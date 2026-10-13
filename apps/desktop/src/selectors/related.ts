import type { Item, Session } from '../generated/domain/models';
import type { Immutable } from '../data/session-store';
import { itemRemoved } from './removed';

export type LinkDirection = 'related' | 'affects' | 'affected_by' | 'depends_on' | 'needed_by';
type ConnectionKind = LinkDirection | 'all';
type ConnectionIndex = ReadonlyMap<ConnectionKind, ReadonlyMap<string, readonly Immutable<Item>[]>>;
const indexes = new WeakMap<Immutable<Session>, ConnectionIndex>();
const empty: readonly Immutable<Item>[] = Object.freeze([]);

function connectionIndex(session: Immutable<Session>): ConnectionIndex {
  let index = indexes.get(session);
  if (!index) {
    const connected = new Map<ConnectionKind, Map<string, Set<string>>>();
    const add = (direction: LinkDirection, from: string, to: string) => {
      for (const kind of [direction, 'all'] as const) {
        const connections = connected.get(kind) ?? new Map<string, Set<string>>();
        const targets = connections.get(from) ?? new Set<string>();
        targets.add(to); connections.set(from, targets); connected.set(kind, connections);
      }
    };
    for (const item of Object.values(session.items)) {
      if (!item || itemRemoved(session, item.id)) continue;
      for (const [field, reverse] of [['related', 'related'], ['affects', 'affected_by'], ['depends_on', 'needed_by']] as const) {
        for (const target of item[field] ?? []) {
          if (target === item.id || !session.items[target] || itemRemoved(session, target)) continue;
          add(field, item.id, target); add(reverse, target, item.id);
        }
      }
    }
    index = new Map([...connected].map(([kind, connections]) => [kind,
      new Map([...connections].map(([id, targets]) => [id, Object.freeze([...targets].map(target => session.items[target]!))]))]));
    indexes.set(session, index);
  }
  return index;
}

/** Typed declarations retain their direction; generic related declarations include backlinks. */
export function relatedItems(session: Immutable<Session>, itemId: string, direction: LinkDirection = 'related'): readonly Immutable<Item>[] {
  return connectionIndex(session).get(direction)?.get(itemId) ?? empty;
}

/** The graph draws every kind as the same undirected connection, once per target. */
export function connectedItems(session: Immutable<Session>, itemId: string): readonly Immutable<Item>[] {
  return connectionIndex(session).get('all')?.get(itemId) ?? empty;
}
