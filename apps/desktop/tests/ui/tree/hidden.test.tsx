import { describe, expect, it } from 'vitest';
import { immutable } from '../../../src/data';
import { hiddenGroupKey, hiddenItems } from '../../../src/ui/tree/hidden';
import { treeModel, type TreeInput } from '../../../src/ui/tree/model';
import { AppTransport, route } from '../app/transport';

function fixture(hidden: string[] = []) {
  const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
  const view = transport.view(); view.hidden_item_ids = hidden;
  const input: TreeInput = { session: immutable(session), view, search: '', later: new Set(), collapsedTopics: new Set(),
    selectedId: null, revealId: null, temporaryExpanded: [], presence: null, summaries: [], now: Date.parse('2026-10-07T12:00:00Z') };
  return { session, view, input, model: (extra: Partial<TreeInput> = {}) => treeModel({ ...input, ...extra }) };
}

describe('hidden item tree projection', () => {
  it('hides a parent and its subtree without changing session data or its saved expansion', () => {
    const { session, view, model } = fixture(['1']), before = JSON.stringify(session);
    expect([...hiddenItems(immutable(session), new Set(['1']))]).toEqual(['1', '1.1']);
    expect(model().rows.filter(row => row.kind === 'item').map(row => row.key)).not.toContain('1.1');
    expect(model().rows.find(row => row.kind === 'hidden')).toMatchObject({ count: 1, depth: 1, parent: null, expanded: false });
    expect(JSON.stringify(session)).toBe(before); expect(view.expanded_item_ids).toContain('1');
    view.hidden_item_ids = [];
    expect(model().rows.filter(row => row.kind === 'item').map(row => row.key)).toContain('1.1');
  });

  it('places one group at the first hidden sibling and counts roots separately from child siblings', () => {
    const { session, view, input } = fixture(['2', '4', '1.1', '1.3']);
    session.items['1.2'] = { ...session.items['1.1']!, id: '1.2', ordinal: 2 };
    session.items['1.3'] = { ...session.items['1.1']!, id: '1.3', ordinal: 3 };
    const model = treeModel({ ...input, session: immutable(session), view });
    const groups = model.rows.filter(row => row.kind === 'hidden');
    expect(groups.map(row => [row.parent, row.count, row.depth])).toEqual([['1', 2, 2], [null, 2, 1]]);
    const topic = session.items['1']!.topic_id;
    expect(model.rows.slice(0, 7).map(row => row.key)).toEqual([topic, '1', hiddenGroupKey(topic, '1'), '1.2', hiddenGroupKey(topic, null), '3', '5']);
    expect(model.rows.find(row => row.key === '1' && row.kind === 'item')).toMatchObject({ hidden: false });
  });

  it('opens hidden siblings in their original places and dims inherited descendants', () => {
    const { session, model } = fixture(['1', '3']), key = hiddenGroupKey(session.items['1']!.topic_id, null);
    const opened = model({ expandedHiddenGroups: new Set([key]) });
    expect(opened.rows.filter(row => row.kind === 'item').map(row => row.key).slice(0, 4)).toEqual(['1', '1.1', '2', '3']);
    for (const id of ['1', '1.1', '3']) expect(opened.rows.find(row => row.key === id)).toMatchObject({ hidden: true });
    expect(opened.rows.find(row => row.key === '2')).toMatchObject({ hidden: false });
    expect(model().rows.some(row => row.key === '1.1')).toBe(false);
  });

  it('preserves an independently hidden child when its parent is restored', () => {
    const { session, view, model } = fixture(['1', '1.1']);
    view.hidden_item_ids = ['1.1'];
    expect(model().rows.find(row => row.key === '1')).toMatchObject({ hidden: false });
    expect(model().rows.find(row => row.key === hiddenGroupKey(session.items['1']!.topic_id, '1'))).toMatchObject({ count: 1 });
    expect(model().rows.some(row => row.key === '1.1')).toBe(false);
    view.hidden_item_ids = [];
    expect(model().rows.find(row => row.key === '1.1')).toMatchObject({ hidden: false });
  });

  it('flags a waiting descendant under a hidden parent and retains the waiting chip count', () => {
    const { session, input } = fixture(['1']); session.items['1.1']!.status = 'waiting_on_me';
    const hidden = treeModel({ ...input, session: immutable(session) });
    const visible = treeModel({ ...input, session: immutable(session), view: { ...input.view, hidden_item_ids: [] } });
    expect(hidden.rows.find(row => row.kind === 'hidden')).toMatchObject({ waiting: true });
    expect(hidden.counts.waiting).toBe(visible.counts.waiting);
    expect(hidden.counts.all).toBe(visible.counts.all - 2);
  });

  it('reveals nested hidden groups from outside the tree without removing hidden preferences', () => {
    const { view, model } = fixture(['1', '1.1']);
    const revealed = model({ revealId: '1.1', temporaryExpanded: [] });
    expect(revealed.rows.filter(row => row.kind === 'hidden').every(row => row.expanded)).toBe(true);
    expect(revealed.rows.find(row => row.key === '1.1')).toMatchObject({ hidden: true });
    expect(view.hidden_item_ids).toEqual(['1', '1.1']);
  });

  it('counts search matches and status chips without hidden rows while reporting hidden matches', () => {
    const { model } = fixture(['1.1']);
    const searched = model({ search: 'receipt' });
    expect(searched.searchCount).toBe(1); expect(searched.itemCount).toBe(8); expect(searched.hiddenCount).toBe(1);
    expect(searched.counts.open).toBe(0); expect(searched.counts.progress).toBe(1); expect(searched.counts.all).toBe(1);
    expect(model({ search: 'unmatched' }).hiddenCount).toBe(0);
  });
});
