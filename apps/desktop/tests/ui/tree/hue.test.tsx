import { describe, expect, it } from 'vitest';
import { immutable } from '../../../src/data';
import type { Item, Session } from '../../../src/generated/domain/models';
import { BRANCH_HUES, branchSlot } from '../../../src/ui/tree/branch';
import { graphSession, preferences } from '../graph/fixture';
import { shimTree } from './shimTree';

// A branch's hue stays put (alpha.20 plan, "Hue"), in the Tree as in the Graph (tests/ui/graph/hue.test.tsx): the slot comes
// from the top item's ordinal, which core hands out from the session's `next_root` counter and never reuses, so adding,
// removing, emptying the bin and reloading never shift another branch's slot. Children and strips take their top item's slot.

/** Branch slot of every item row, by id. */
const slots = (session: Session) => new Map(shimTree({ session: immutable(session), view: preferences({ expanded_item_ids: ['1', '1.1', '2', '4'] }),
  search: '', later: new Set(), collapsedTopics: new Set(), selectedId: null, revealId: null, temporaryExpanded: [], presence: null, summaries: [],
  now: Date.parse(session.updated_at) }).rows.flatMap(row => row.kind === 'item' ? [[row.item.id, row.branch] as const] : []));

function withRoots(): Session {
  const session = graphSession(), template = session.items['2']!;
  const add = (id: string, parent: string | null, ordinal: number) => { session.items[id] = { ...structuredClone(template), id, parent, ordinal } as Item; };
  add('4', null, 4); add('4.1', '4', 1); add('5', null, 5); add('6', null, 6); add('7', null, 7);
  session.counters.next_root = 9;
  return session;
}

describe('Tree branch slot', () => {
  it('is the top item’s ordinal, counted from one, round the five hues', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 11].map(branchSlot)).toEqual([0, 1, 2, 3, 4, 0, 1, 0]);
    expect(BRANCH_HUES).toHaveLength(5);
  });

  it('gives children their top item’s slot', () => {
    const map = slots(withRoots());
    expect(['1', '1.1', '1.1.1', '1.2'].map(id => map.get(id))).toEqual([0, 0, 0, 0]);
    expect([map.get('4'), map.get('4.1')]).toEqual([3, 3]);
  });

  it('gives a strip inside a branch that branch’s slot, and none to a top-level strip', () => {
    const session = withRoots(), view = preferences({ expanded_item_ids: ['1'], hidden_item_ids: ['1.2', '5'] });
    const strips = shimTree({ session: immutable(session), view, search: '', later: new Set(), collapsedTopics: new Set(), selectedId: null, revealId: null,
      temporaryExpanded: [], presence: null, summaries: [], now: Date.parse(session.updated_at) }).rows.filter(row => row.kind === 'strip');
    expect(strips.map(row => [row.parent, row.branch])).toEqual([['1', 0], [null, null]]);
  });

  const triggers: ReadonlyArray<readonly [string, (session: Session) => void]> = [
    ['an agent adds a top item', session => {
      session.items['9'] = { ...structuredClone(session.items['2']!), id: '9', ordinal: 9 }; session.counters.next_root = 10;
    }],
    ['an agent adds a child', session => { session.items['2.1'] = { ...structuredClone(session.items['2']!), id: '2.1', parent: '2', ordinal: 1 }; }],
    ['a top item is removed to the bin', session => { session.items['2'] = { ...session.items['2']!, removed_at: session.updated_at }; }],
    ['the bin is emptied', session => { delete session.items['2']; delete session.items['3']; }],
    ['another topic is emptied from the bin', session => {
      const topic = session.items['8']!.topic_id;
      for (const item of Object.values(session.items)) if (item && item.topic_id === topic) delete session.items[item.id];
    }],
    ['the session reloads', session => { Object.assign(session, structuredClone(session)); }],
  ];
  it.each(triggers)('keeps every remaining branch’s slot when %s', (_name, change) => {
    const before = slots(withRoots()), session = withRoots();
    change(session);
    const after = slots(session);
    for (const [id, slot] of after) {
      expect([id, typeof slot]).toEqual([id, 'number']);
      if (before.has(id)) expect([id, slot]).toEqual([id, before.get(id)]);
    }
    expect(after.size).toBeGreaterThan(0);
  });
});
