import { describe, expect, it } from 'vitest';
import { applyChange, descendantCount, edgePath, graphMetrics, graphStatus, isClosed, isFiltering, mergeChange,
  sessionChip, sessionGraph, topicCounts, type GraphInput } from '../../../src/ui/graph/model';
import { shortLabel } from '../../../src/ui/shared/short';
import { graphSession, preferences, topicA, topicB } from './fixture';

const build = (overrides: Partial<GraphInput> = {}) =>
  sessionGraph({ session: graphSession(), view: preferences(), later: new Set(), selectedId: null, tight: false, ...overrides });

describe('graph model', () => {
  it('keeps hidden parents and descendants reachable and marks them faded, including the selected node', () => {
    const graph = build({ view: preferences({ hidden_item_ids: ['1'] }), selectedId: '1.1.1' });
    expect(graph.order).toEqual(['1', '1.1', '1.1.1', '1.2', '2', '3', '8']);
    for (const id of ['1', '1.1', '1.1.1', '1.2']) expect(graph.nodes.get(id)!.hidden).toBe(true);
    expect(graph.nodes.get('1.1.1')!.selected).toBe(true);
    expect(graph.nodes.get('2')!.hidden).toBe(false);
    expect(graph.topics[0].counts).toContain('1 waiting on you');
  });

  it('keeps a child hidden independently when its parent is unhidden', () => {
    const both = build({ view: preferences({ hidden_item_ids: ['1', '1.1'] }) });
    expect(both.nodes.get('1.2')!.hidden).toBe(true);
    const child = build({ view: preferences({ hidden_item_ids: ['1.1'] }) });
    expect(child.nodes.get('1')!.hidden).toBe(false);
    expect(child.nodes.get('1.2')!.hidden).toBe(false);
    expect(child.nodes.get('1.1')!.hidden).toBe(true);
    expect(child.nodes.get('1.1.1')!.hidden).toBe(true);
    const clear = build({ view: preferences({ hidden_item_ids: [] }) });
    expect([...clear.nodes.values()].some(node => node.hidden)).toBe(false);
  });

  it('lays out one graph per topic left to right as the prototype does', () => {
    const graph = build(), [a, b] = graph.topics;
    expect(graph.topics.map(topic => topic.topic.id)).toEqual([topicA, topicB]);
    expect(graph.order).toEqual(['1', '1.1', '1.1.1', '1.2', '2', '3', '8']);
    const at = (id: string) => { const node = graph.nodes.get(id)!; return [node.x, node.y]; };
    // colX(d) = 20 + 26 + (d − 1)(190 + 26); leaves stack 84 apart from y = 20; parents centre on their children.
    expect([at('1.1.1'), at('1.1'), at('1.2'), at('1'), at('2'), at('3')]).toEqual([[478, 20], [262, 20], [262, 104], [46, 62], [46, 188], [46, 272]]);
    expect([a.width, a.height]).toEqual([688, 376]);
    expect([b.width, b.height, at('8')]).toEqual([256, 124, [46, 20]]);
    expect(a.edges.find(edge => edge.id === 'topic:1')!.d).toBe(edgePath(2, 167 + 33, 46, 62 + 33));
    expect(a.edges.find(edge => edge.id === 'parent:1:1.2')!.d).toBe('M236 95 C249 95 249 137 262 137');
    expect(a.counts).toBe('1 waiting on you · 2 open · 1 in progress · 2 closed');
    expect(b.counts).toBe('1 open');
  });

  it('uses the tighter grid when detail or the rail is open', () => {
    expect(graphMetrics(true)).toEqual({ pad: 14, gap: 18 });
    const graph = build({ tight: true });
    expect(graph.nodes.get('1.1')!.x).toBe(14 + 18 + 190 + 18);
    expect(graph.topics[0].width).toBe(14 + 18 + 2 * (190 + 18) + 190 + 14);
  });

  it('draws "+N" for collapsed nodes and "−" for expanded ones', () => {
    const closed = build({ view: preferences({ expanded_item_ids: [] }) });
    expect(closed.order).toEqual(['1', '2', '3', '8']);
    expect(closed.nodes.get('1')).toMatchObject({ below: 3, collapsed: true, canCollapse: false });
    expect(closed.nodes.get('2')).toMatchObject({ below: 0, collapsed: false, canCollapse: false });
    const open = build({ view: preferences({ expanded_item_ids: ['1'] }) });
    expect(open.nodes.get('1')).toMatchObject({ below: 3, collapsed: false, canCollapse: true });
    expect(open.nodes.get('1.1')).toMatchObject({ below: 1, collapsed: true, canCollapse: false });
    expect(open.children.get('1')).toEqual(['1.1', '1.2']);
  });

  it('marks the thread to the selected item and its edges', () => {
    const graph = build({ selectedId: '1.1.1' });
    expect(['1', '1.1', '1.1.1', '1.2'].map(id => [graph.nodes.get(id)!.onThread, graph.nodes.get(id)!.selected]))
      .toEqual([[true, false], [true, false], [false, true], [false, false]]);
    const on = graph.topics[0].edges.filter(edge => edge.on).map(edge => edge.id).sort();
    expect(on).toEqual(['parent:1.1:1.1.1', 'parent:1:1.1', 'topic:1']);
    expect(graph.nodes.get('1.1.1')!.status).toBe('waiting');
  });

  it('draws a replacement arc between visible nodes', () => {
    const [a] = build().topics;
    expect(a.replacements).toEqual([{ id: 'replacement:3:2', labelX: 141, labelY: 272 + 66 + 30,
      d: 'M141 340 C141 382 141 298 141 260' }]);
    expect(build({ view: preferences({ filters: { ...preferences().filters, search: 'receipt' } }) }).topics[0].replacements).toEqual([]);
  });

  it('keeps context nodes dimmed and hides "−" while a filter is active', () => {
    const view = preferences({ expanded_item_ids: [], filters: { ...preferences().filters, search: 'morning or evening' } });
    const graph = build({ view, selectedId: null });
    expect(graph.filtering).toBe(true);
    expect(graph.order).toEqual(['1', '1.1', '1.1.1']);
    expect(graph.nodes.get('1')).toMatchObject({ dimmed: true, canCollapse: false, collapsed: false });
    expect(graph.nodes.get('1.1.1')!.dimmed).toBe(false);
    expect(build({ view, selectedId: '1' }).nodes.get('1')!.dimmed).toBe(false);
  });

  it('shows temporary reveal ancestors without saving them', () => {
    const graph = build({ view: preferences({ expanded_item_ids: [] }), temporaryExpandedItemIds: ['1', '1.1'], revealedItemId: '1.1.1' });
    expect(graph.order).toContain('1.1.1');
  });

  it('reads statuses, counts and filters', () => {
    expect([graphStatus('waiting_on_me'), graphStatus('in_progress'), graphStatus('dropped')]).toEqual(['waiting', 'progress', 'dropped']);
    expect([isClosed('done'), isClosed('replaced'), isClosed('open')]).toEqual([true, true, false]);
    expect(topicCounts([])).toBe('');
    const session = graphSession();
    expect([descendantCount(session, '1'), descendantCount(session, '1'), descendantCount(session, '8')]).toEqual([3, 3, 0]);
    const filters = preferences().filters;
    expect([isFiltering(filters), isFiltering({ ...filters, statuses: ['open'] }), isFiltering({ ...filters, owners: [{ kind: 'me' }] }),
      isFiltering({ ...filters, hide_later: true }), isFiltering({ ...filters, search: '   ' })]).toEqual([false, true, true, true, false]);
  });

  it('titles nodes with the shared short label', () => {
    const session = graphSession();
    session.items['1.1'] = { ...session.items['1.1']!, short: 'Receipt test' };
    const nodes = sessionGraph({ session, view: preferences(), later: new Set(), selectedId: null, tight: false }).nodes;
    expect(nodes.get('1.1')!.short).toBe('Receipt test');
    expect(nodes.get('1.1.1')!.short).toBe(shortLabel(session.items['1.1.1']!));
  });

  it('labels a topic card with the session agent and day unless it is today', () => {
    expect(sessionChip('codex', 'Yesterday')).toBe('codex · yesterday');
    expect(sessionChip('codex', 'Today, 09:12')).toBeNull();
    expect(sessionChip(null, 'Yesterday')).toBeNull();
  });

  it('merges and applies view changes, keeping the same view when nothing changes', () => {
    const view = preferences({ selected_item_id: '1', expanded_item_ids: ['1'] });
    expect(applyChange(view, null)).toBe(view);
    expect(applyChange(view, { selected: '1', expansion: [{ kind: 'expand', id: '1' }] })).toBe(view);
    const merged = mergeChange(mergeChange(null, { selected: '2', expansion: [{ kind: 'expand', id: '1.1' }] }),
      { expansion: [{ kind: 'collapse', id: '1' }] });
    expect(merged).toEqual({ selected: '2', expansion: [{ kind: 'expand', id: '1.1' }, { kind: 'collapse', id: '1' }] });
    expect(applyChange(view, merged)).toMatchObject({ selected_item_id: '2', expanded_item_ids: ['1.1'] });
    expect(applyChange(view, { expansion: [{ kind: 'collapse', id: '1' }, { kind: 'expand', id: '2' }] }).expanded_item_ids).toEqual(['2']);
  });
});
