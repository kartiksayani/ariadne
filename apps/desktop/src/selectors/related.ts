import type { Item, Session } from '../generated/domain/models';
import type { Immutable } from '../data/session-store';

const indexes = new WeakMap<Immutable<Session>, ReadonlyMap<string, readonly Immutable<Item>[]>>();
const empty: readonly Immutable<Item>[] = Object.freeze([]);

/** Declarations stay directional in storage; navigation treats each declaration as a connection. */
export function relatedItems(session: Immutable<Session>, itemId: string): readonly Immutable<Item>[] {
  let index = indexes.get(session);
  if (!index) {
    const connected = new Map<string, Set<string>>();
    const add = (from: string, to: string) => {
      const targets = connected.get(from) ?? new Set<string>();
      targets.add(to); connected.set(from, targets);
    };
    for (const item of Object.values(session.items)) {
      if (!item) continue;
      for (const target of item.related ?? []) {
        if (target === item.id || !session.items[target]) continue;
        add(item.id, target); add(target, item.id);
      }
    }
    index = new Map([...connected].map(([id, targets]) => [id,
      Object.freeze([...targets].map(target => session.items[target]!))]));
    indexes.set(session, index);
  }
  return index.get(itemId) ?? empty;
}
