import { describe, expect, it } from 'vitest';
import { immutable } from '../../../src/data';
import { hiddenGroupKey, hiddenItems, hiddenParentSource, hiddenSource } from '../../../src/ui/tree/hidden';
import { stripKey } from '../../../src/ui/tree/model';
import { shimTree, type ShimInput } from './shimTree';
import { AppTransport, route } from '../app/transport';
import { FILTER_STATUSES } from '../../../src/selectors/tree/folds';
import { chipCounts, summaryCounts } from '../../../src/selectors/tree/filter';

function fixture(hidden: string[] = []) {
  const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
  const view = transport.view(); view.hidden_item_ids = hidden;
  const input: ShimInput = { session: immutable(session), view, search: '', later: new Set(), collapsedTopics: new Set(),
    selectedId: null, revealId: null, temporaryExpanded: [], presence: null, summaries: [], now: Date.parse('2026-10-07T12:00:00Z') };
  return { session, view, input, model: (extra: Partial<ShimInput> = {}) => shimTree({ ...input, ...extra }) };
}

describe('hidden item tree projection', () => {
  it('explains direct and inherited hiding, and keeps topic archive separate', () => {
    const { session } = fixture();
    session.items['1.1.1'] = { ...session.items['1.1']!, id: '1.1.1', parent: '1.1' };
    const current = immutable(session);
    expect(hiddenSource(current, new Set(['1.1']), '1.1')).toBe('1.1');
    expect(hiddenSource(current, new Set(['1']), '1.1.1')).toBe('1');
    expect(hiddenSource(current, new Set(['1', '1.1']), '1.1.1')).toBe('1.1');
    expect(hiddenParentSource(current, new Set(['1', '1.1']), '1.1')).toBe('1');
    expect(hiddenParentSource(current, new Set(['1', '1.1', '1.1.1']), '1.1.1')).toBe('1.1');
    expect(hiddenParentSource(current, new Set(['1.1']), '1.1')).toBeNull();
    expect(hiddenParentSource(current, new Set(['1']), '1')).toBeNull();
    expect(hiddenParentSource(current, new Set(['1']), 'missing')).toBeNull();
    expect(hiddenSource(current, new Set([session.items['1']!.topic_id]), '1.1')).toBeNull();
    session.topics[session.items['1']!.topic_id]!.archived_at = '2026-10-07T12:00:00Z';
    expect(hiddenSource(immutable(session), new Set(), '1.1')).toBeNull();
  });

  it('does not mistake the selected item for its own hidden parent in a malformed cycle', () => {
    const { session } = fixture();
    session.items['1']!.parent = '1.1';
    expect(hiddenParentSource(immutable(session), new Set(['1.1']), '1.1')).toBeNull();
    expect(hiddenParentSource(immutable(session), new Set(), '1.1')).toBeNull();
  });

  it('retains saved item and topic folds when a full status set means All', () => {
    const { session, view, model } = fixture();
    view.filters.statuses = [...FILTER_STATUSES, 'open'];
    view.expanded_item_ids = [];
    const normal = model();
    expect(normal.filtering).toBe(false);
    expect(normal.rows.some(row => row.key === '1.1')).toBe(false);
    const topic = session.items['1']!.topic_id;
    expect(model({ collapsedTopics: new Set([topic]) }).rows.some(row => row.key === '1')).toBe(false);
  });
  it('ignores saved topic scope and autoopens filter ancestors while honoring explicit filter folds', () => {
    const { session, view, model } = fixture();
    const normal = model();
    view.filters.topic_id = 'retired-topic-filter';
    expect(model()).toEqual(normal);
    view.expanded_item_ids = [];
    const topicId = session.items['1']!.topic_id;
    const inTopic = (rows: ReturnType<typeof model>['rows']) => rows.filter(row => row.kind === 'topic' ? row.key === topicId
      : row.kind === 'strip' ? row.topicId === topicId : row.item.topic_id === topicId).map(row => row.key);
    // A search neither filters nor opens anything: the folded topic stays folded.
    expect(inTopic(model({ search: session.items['1.1']!.question, collapsedTopics: new Set([topicId]) }).rows)).toEqual([topicId]);
    // A status filter opens the way to its matches, until the owner folds them under it.
    view.filters.statuses = ['open'];
    const input = { collapsedTopics: new Set([topicId]) };
    expect(model(input).rows.find(row => row.key === '1.1')).toBeDefined();
    expect(model({ ...input, filterCollapsedItemIds: new Set(['1']) }).rows.some(row => row.key === '1.1')).toBe(false);
    expect(inTopic(model({ ...input, filterCollapsedTopicIds: new Set([topicId]) }).rows)).toEqual([topicId]);
    expect(model({ ...input, filterCollapsedItemIds: new Set(['1']), filterCollapsedTopicIds: new Set([topicId]), revealId: '1.1' })
      .rows.find(row => row.key === '1.1')).toBeDefined();
    expect(view.expanded_item_ids).toEqual([]);
  });
  it('hides a parent and its subtree without changing session data or its saved expansion', () => {
    const { session, view, model } = fixture(['1']), before = JSON.stringify(session);
    expect([...hiddenItems(immutable(session), new Set(['1']))]).toEqual(['1', '1.1']);
    expect(model().rows.filter(row => row.kind === 'item').map(row => row.key)).not.toContain('1.1');
    expect(model().rows.find(row => row.kind === 'strip')).toMatchObject({ reason: 'hidden', count: 1, depth: 1, parent: null, expanded: false });
    expect(JSON.stringify(session)).toBe(before); expect(view.expanded_item_ids).toContain('1');
    view.hidden_item_ids = [];
    expect(model().rows.filter(row => row.kind === 'item').map(row => row.key)).toContain('1.1');
  });

  it.each([false, true])('groups hidden siblings after visible siblings at every level (expanded: %s)', expanded => {
    const { session, view, input } = fixture(['2', '4', '1.1', '1.3']);
    session.items['1.2'] = { ...session.items['1.1']!, id: '1.2', ordinal: 2 };
    session.items['1.3'] = { ...session.items['1.1']!, id: '1.3', ordinal: 3 };
    session.items['1.1.1'] = { ...session.items['1.1']!, id: '1.1.1', parent: '1.1', ordinal: 1 };
    session.items['1.3.1'] = { ...session.items['1.1']!, id: '1.3.1', parent: '1.3', ordinal: 1 };
    view.expanded_item_ids.push('1.1', '1.3');
    const topic = session.items['1']!.topic_id, nestedKey = hiddenGroupKey(topic, '1'), rootKey = hiddenGroupKey(topic, null);
    const model = shimTree({ ...input, session: immutable(session), view, expandedHiddenGroups: new Set(expanded ? [nestedKey, rootKey] : []) });
    const groups = model.rows.filter(row => row.kind === 'strip');
    expect(groups.every(row => row.reason === 'hidden')).toBe(true);
    const nestedStrip = stripKey(topic, '1', 'hidden', '1.1'), rootStrip = stripKey(topic, null, 'hidden', '2');
    expect(groups.map(row => [row.parent, row.count, row.depth])).toEqual([['1', 2, 2], [null, 2, 1]]);
    expect(groups.every(row => row.expanded === expanded)).toBe(true);
    expect(model.rows.filter(row => row.kind === 'topic' ? row.key === topic : row.kind === 'strip' ? row.topicId === topic : row.item.topic_id === topic)
      .map(row => row.key)).toEqual([topic, '1', '1.2', nestedStrip, ...(expanded ? ['1.1', '1.1.1', '1.3', '1.3.1'] : []),
      '3', '5', '6', '7', rootStrip, ...(expanded ? ['2', '4'] : [])]);
    if (expanded) {
      expect(model.rows.find(row => row.key === '1.1')).toMatchObject({ depth: 2, hidden: true });
      expect(model.rows.find(row => row.key === '1.3.1')).toMatchObject({ depth: 3, hidden: true });
      expect(model.rows.find(row => row.key === '2')).toMatchObject({ depth: 1, hidden: true });
    }
    expect(model.rows.find(row => row.key === '1' && row.kind === 'item')).toMatchObject({ hidden: false });
  });

  it('opens hidden siblings together with their subtrees and dims inherited descendants', () => {
    const { session, model } = fixture(['1', '3']), topic = session.items['1']!.topic_id;
    const opened = model({ expandedHiddenGroups: new Set([hiddenGroupKey(topic, null)]) }), key = stripKey(topic, null, 'hidden', '1');
    expect(opened.rows.slice(0, 10).map(row => row.key)).toEqual([session.items['1']!.topic_id, '2', '4', '5', '6', '7', key, '1', '1.1', '3']);
    for (const id of ['1', '1.1', '3']) expect(opened.rows.find(row => row.key === id)).toMatchObject({ hidden: true });
    expect(opened.rows.find(row => row.key === '2')).toMatchObject({ hidden: false });
    expect(model().rows.some(row => row.key === '1.1')).toBe(false);
  });

  it('preserves an independently hidden child when its parent is restored', () => {
    const { session, view, model } = fixture(['1', '1.1']);
    view.hidden_item_ids = ['1.1'];
    expect(model().rows.find(row => row.key === '1')).toMatchObject({ hidden: false });
    expect(model().rows.find(row => row.key === stripKey(session.items['1']!.topic_id, '1', 'hidden', '1.1'))).toMatchObject({ count: 1 });
    expect(model().rows.some(row => row.key === '1.1')).toBe(false);
    view.hidden_item_ids = [];
    expect(model().rows.find(row => row.key === '1.1')).toMatchObject({ hidden: false });
  });

  it('flags a waiting descendant under a hidden parent and retains the waiting chip count', () => {
    const { session, input } = fixture(['1']); session.items['1.1']!.status = 'waiting_on_me';
    const hidden = shimTree({ ...input, session: immutable(session) });
    expect(hidden.rows.find(row => row.kind === 'strip')).toMatchObject({ reason: 'hidden', waiting: 1 });
    const scopeOf = (view: typeof input.view) => ({ session: immutable(session), view, later: new Set<string>(), local: [] });
    expect(chipCounts(scopeOf(input.view)).waiting).toBe(chipCounts(scopeOf({ ...input.view, hidden_item_ids: [] })).waiting);
    expect(summaryCounts(scopeOf(input.view)).total).toBe(summaryCounts(scopeOf({ ...input.view, hidden_item_ids: [] })).total - 2);
  });

  it('reveals nested hidden groups from outside the tree without removing hidden preferences', () => {
    const { session, view, model } = fixture(['1', '1.1']);
    const revealed = model({ revealId: '1.1', temporaryExpanded: [] });
    expect(revealed.rows.filter(row => row.kind === 'strip').every(row => row.expanded)).toBe(true);
    const topic = session.items['1']!.topic_id;
    expect(revealed.rows.slice(0, 11).map(row => row.key)).toEqual([topic, '2', '3', '4', '5', '6', '7', stripKey(topic, null, 'hidden', '1'),
      '1', stripKey(topic, '1', 'hidden', '1.1'), '1.1']);
    expect(revealed.rows.find(row => row.key === '1.1')).toMatchObject({ hidden: true });
    expect(view.hidden_item_ids).toEqual(['1', '1.1']);
  });

  it('keeps the status chip counts under a search and reports matches in hidden items apart', () => {
    const { model } = fixture(['1.1']);
    const plain = model(), searched = model({ search: 'receipt' });
    // The search changes no count and no row; the hidden 1.1 ("Add the receipt lookup test") is named in the note.
    expect(searched.rows.map(row => row.key)).toEqual(plain.rows.map(row => row.key));
    expect(searched.shownCount).toBe(plain.shownCount); expect(searched.itemCount).toBe(8); expect(searched.hiddenCount).toBe(1);
    expect(searched.rows.find(row => row.key === '3')).toMatchObject({ matches: ['question'] });
    expect(searched.search).toMatchObject({ hidden: 1, collapsed: 0 });
    expect(model({ search: 'unmatched' }).search).toMatchObject({ hidden: 0, collapsed: 0 });
  });

  it('counts hidden matches only for the selected statuses without search text', () => {
    const { session, view, model } = fixture(['1.1']); view.filters.statuses = ['open'];
    const filtered = model();
    expect(filtered.shownCount).toBe(2); expect(filtered.itemCount).toBe(8); expect(filtered.hiddenCount).toBe(1);
    expect(chipCounts({ session: immutable(session), view, later: new Set(), local: [] }).open).toBe(2);
    view.filters.statuses = ['in_progress'];
    expect(model().hiddenCount).toBe(0);
  });
});
