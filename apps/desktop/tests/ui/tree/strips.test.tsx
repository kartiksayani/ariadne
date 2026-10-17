// Strips (ALPHA20-REPLAN §5.1): each run of consecutive omitted siblings is one strip, and its reason is the first that
// applies: focus, then filter, then hidden. Rows before and after a strip keep their order.
import { describe, expect, it } from 'vitest';
import { immutable } from '../../../src/data';
import type { Item } from '../../../src/generated/domain/models';
import { parentKey, stripKey, type Row, type StripRow } from '../../../src/ui/tree/model';
import { AppTransport, route } from '../app/transport';
import { shimTree, type ShimInput } from './shimTree';

// Roots 1, 3 and 6 are open and match an Open filter; the others are decided.
const STATUS: Record<string, Item['status']> = { 1: 'open', 2: 'decided', 3: 'open', 4: 'decided', 5: 'decided', 6: 'open', 7: 'decided', '1.1': 'decided' };

function fixture(hidden: string[] = []) {
  const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
  for (const [id, status] of Object.entries(STATUS)) session.items[id]!.status = status;
  const view = transport.view(); view.hidden_item_ids = hidden;
  const topic = session.items['1']!.topic_id;
  const input = (extra: Partial<ShimInput> = {}): ShimInput => ({ session: immutable(session), view, search: '', later: new Set(), collapsedTopics: new Set(),
    selectedId: null, revealId: null, temporaryExpanded: [], presence: null, summaries: [], now: Date.parse('2026-10-07T12:00:00Z'), ...extra });
  const model = (extra: Partial<ShimInput> = {}) => shimTree(input(extra));
  const strips = (rows: readonly Row[], depth = 1) => rows.filter((row): row is StripRow => row.kind === 'strip' && row.depth === depth);
  /** The first topic's top-level rows, in order. */
  const order = (rows: readonly Row[]) => rows.filter(row => row.depth === 1 && (row.kind === 'strip' ? row.topicId : row.kind === 'item' ? row.item.topic_id : '') === topic)
    .map(row => row.key);
  return { session, view, topic, model, strips, order };
}

describe('strips', () => {
  it('omits nothing without a filter, a focus or hidden items', () => {
    const { model, strips } = fixture();
    expect(model().rows.some(row => row.kind === 'strip')).toBe(false);
    expect(strips(model({ focusRootId: null }).rows)).toEqual([]);
  });

  it('turns each run of non-matching siblings into one filter strip, in place', () => {
    const { view, topic, model, strips, order } = fixture();
    view.filters.statuses = ['open'];
    const rows = model().rows;
    expect(strips(rows).filter(row => row.topicId === topic).map(row => [row.key, row.reason, row.count, row.parent, row.expanded]))
      .toEqual([[stripKey(topic, null, 'filter', '2'), 'filter', 1, null, false], [stripKey(topic, null, 'filter', '4'), 'filter', 2, null, false],
        [stripKey(topic, null, 'filter', '7'), 'filter', 1, null, false]]);
    expect(order(rows)).toEqual(['1', stripKey(topic, null, 'filter', '2'), '3', stripKey(topic, null, 'filter', '4'), '6', stripKey(topic, null, 'filter', '7')]);
    expect(strips(rows)[0]).toMatchObject({ depth: 1, delivery: null, waiting: 0 });
    // 1.1 does not match either: its run under 1 is a strip one level down.
    expect(strips(rows, 2).map(row => [row.key, row.parent, row.count])).toEqual([[stripKey(topic, '1', 'filter', '1.1'), '1', 1]]);
  });

  it('counts the questions waiting inside a run', () => {
    const { session, view, model, strips } = fixture();
    session.items['5']!.status = 'waiting_on_me';
    view.filters.statuses = ['open'];
    expect(strips(model().rows).filter(row => row.topicId === session.items['1']!.topic_id).map(row => row.waiting)).toEqual([0, 1, 0]);
  });

  it('keeps one top item for a focus and folds the other top items into focus strips', () => {
    const { topic, model, strips, order } = fixture();
    const rows = model({ focusRootId: '3' }).rows;
    expect(strips(rows).map(row => [row.key, row.reason, row.count])).toEqual([[stripKey(topic, null, 'focus', '1'), 'focus', 2], [stripKey(topic, null, 'focus', '4'), 'focus', 4]]);
    expect(order(rows)).toEqual([stripKey(topic, null, 'focus', '1'), '3', stripKey(topic, null, 'focus', '4')]);
    expect(rows.some(row => row.kind === 'item' && row.item.parent === '1')).toBe(false);
  });

  it('puts focus ahead of filter and hidden for the same item', () => {
    const { view, topic, model, strips } = fixture(['2']);
    view.filters.statuses = ['open'];
    const rows = model({ focusRootId: '3' }).rows;
    expect(strips(rows).map(row => [row.key, row.reason, row.count])).toEqual([[stripKey(topic, null, 'focus', '1'), 'focus', 2], [stripKey(topic, null, 'focus', '4'), 'focus', 4]]);
  });

  it('splits a run when its reason changes: a focused root the filter excludes is its own "not matching" strip', () => {
    const { view, topic, model, strips, order } = fixture();
    // The filter matches roots 2 and 4 (decided) but not the focused root 3 (open).
    view.filters.statuses = ['decided'];
    const rows = model({ focusRootId: '3' }).rows;
    expect(strips(rows).map(row => [row.key, row.reason, row.count])).toEqual([[stripKey(topic, null, 'focus', '1'), 'focus', 2],
      [stripKey(topic, null, 'filter', '3'), 'filter', 1], [stripKey(topic, null, 'focus', '4'), 'focus', 4]]);
    expect(order(rows)).toEqual([stripKey(topic, null, 'focus', '1'), stripKey(topic, null, 'filter', '3'), stripKey(topic, null, 'focus', '4')]);
  });

  it('puts filter ahead of hidden, and leaves matching hidden siblings in the hidden group after the rest', () => {
    const { view, topic, model, strips, order } = fixture(['2', '3']);
    view.filters.statuses = ['open'];
    const rows = model().rows;
    // 2 is hidden and not matching: a filter strip. 3 is hidden and matching: the hidden group, last. A hidden sibling
    // is not in the walk's place, so it does not break a run: 2, 4 and 5 are one run.
    expect(strips(rows).filter(row => row.topicId === topic).map(row => [row.key, row.reason, row.count])).toEqual([[stripKey(topic, null, 'filter', '2'), 'filter', 3],
      [stripKey(topic, null, 'filter', '7'), 'filter', 1], [stripKey(topic, null, 'hidden', '3'), 'hidden', 1]]);
    expect(order(rows).at(-1)).toBe(stripKey(topic, null, 'hidden', '3'));
  });

  it('ignores a focus that is not a top item', () => {
    const { model } = fixture();
    const plain = model().rows.map(row => row.key);
    expect(model({ focusRootId: '1.1' }).rows.map(row => row.key)).toEqual(plain);
    expect(model({ focusRootId: 'missing' }).rows.map(row => row.key)).toEqual(plain);
  });

  it('opens only hidden strips, under their parent', () => {
    const { topic, model, strips } = fixture(['2', '4']);
    const closed = strips(model().rows)[0]!;
    expect(closed).toMatchObject({ reason: 'hidden', count: 2, expanded: false, key: stripKey(topic, null, 'hidden', '2') });
    const opened = model({ expandedHiddenGroups: new Set([`hidden:${topic}:`]) }).rows;
    expect(strips(opened)[0]).toMatchObject({ reason: 'hidden', expanded: true });
    expect(opened.some(row => row.key === '2')).toBe(true);
  });

  it('moves left from a strip to its parent item, or to the topic for a top-level run', () => {
    const { session, view, topic, model } = fixture();
    view.filters.statuses = ['open'];
    const rows = model().rows;
    const top = rows.find((row): row is StripRow => row.kind === 'strip' && row.parent === null)!;
    expect(parentKey(top)).toBe(topic);
    view.expanded_item_ids = ['1']; session.items['1.1']!.status = 'decided';
    const nested = model().rows.find((row): row is StripRow => row.kind === 'strip' && row.parent === '1');
    expect(nested && parentKey(nested)).toBe('1');
  });
});
