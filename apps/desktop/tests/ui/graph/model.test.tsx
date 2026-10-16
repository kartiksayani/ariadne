import { describe, expect, it } from 'vitest';
import { applyChange, edgePath, graphMetrics, graphStatus, isClosed, isFiltering, mergeChange, NODE_HEIGHT, STUB_HEIGHT,
  sessionChip, sessionGraph, topicCounts, type GraphInput } from '../../../src/ui/graph/model';
import { hiddenGroupKey } from '../../../src/ui/tree/hidden';
import { shortLabel } from '../../../src/ui/shared/short';
import { graphSession, preferences, topicA, topicB } from './fixture';
import { FILTER_STATUSES } from '../../../src/selectors/tree/folds';

const build = (overrides: Partial<GraphInput> = {}) =>
  sessionGraph({ session: graphSession(), view: preferences(), later: new Set(), selectedId: null, tight: false, ...overrides });

describe('graph model', () => {
  it.each(['closed', 'archived'] as const)('excludes %s sessions from graph waiting counts while keeping stored statuses', ended => {
    const session = graphSession(), item = session.items['1.1.1']!;
    session.answers = []; session.inputs = {};
    expect(topicCounts([item], session)).toBe('1 waiting on you');
    if (ended === 'closed') session.state = 'closed';
    else session.archived_at = session.updated_at;
    expect(topicCounts([item], session)).toBe('');
    expect(item.status).toBe('waiting_on_me');
  });
  it('treats a complete saved status set as All without opening saved folds', () => {
    const view = preferences({ expanded_item_ids: [], filters: { ...preferences().filters, statuses: [...FILTER_STATUSES, 'open'] } });
    const graph = build({ view });
    expect(graph.filtering).toBe(false);
    expect(graph.order).toEqual(['1', '2', '3', '8']);
  });
  it('matches a Queued reply under In progress rather than Waiting on me', () => {
    const session = graphSession(), item = session.items['1.1.1']!;
    const input = structuredClone(Object.values(session.inputs).find(input => input)!);
    session.answers = []; session.inputs = {};
    input.target.item_id = item.id; input.state = 'queued'; input.answer_id = null;
    input.payload.target_snapshot.question_revision = item.question_revision;
    session.inputs[input.id] = input;
    const waiting = preferences({ filters: { ...preferences().filters, statuses: ['waiting_on_me'] } });
    expect(build({ session, view: waiting }).nodes.has(item.id)).toBe(false);
    const progress = preferences({ filters: { ...preferences().filters, statuses: ['in_progress'] } });
    expect(build({ session, view: progress }).nodes.get(item.id)).toMatchObject({ status: 'queued', dimmed: false });
  });
  it('ignores a saved topic filter and honors explicit folds of matching ancestors', () => {
    const view = preferences({ expanded_item_ids: [], filters: { ...preferences().filters, topic_id: 'retired-topic-filter' } });
    expect(build({ view }).order).toEqual(['1', '2', '3', '8']);
    view.filters.search = 'morning or evening';
    expect(build({ view }).order).toEqual(['1', '1.1', '1.1.1']);
    const folded = build({ view, filterCollapsedItemIds: new Set(['1']) });
    expect(folded.order).toEqual(['1']);
    expect(folded.nodes.get('1')).toMatchObject({ collapsed: true, canCollapse: false });
    expect(build({ view, filterCollapsedItemIds: new Set(['1']), revealedItemId: '1.1.1' }).order).toEqual(['1', '1.1', '1.1.1']);
    expect(view.expanded_item_ids).toEqual([]);
  });
  it('draws only the selection’s deduplicated connections, including backlinks and cross-topic targets', () => {
    const session = graphSession();
    session.items['1']!.related = ['2', '2', '8', 'missing'];
    session.items['2']!.related = ['1'];
    session.items['1.1']!.related = ['1'];
    session.items['3']!.related = ['2'];
    const graph = build({ session, selectedId: '1' });
    expect(graph.topics[0].related.map(edge => edge.id)).toEqual(['related:1:2', 'related:1:1.1']);
    expect(graph.topics[0].related.find(edge => edge.id === 'related:1:1.1')!.d).toBe('M236 95 L262 53');
    expect(graph.crossTopicRelated).toEqual([{ id: 'related:1:8', from: '1', to: '8' }]);
    expect(graph.topics[0].edges.map(edge => edge.id)).toContain('parent:1:1.1');
    const reverse = build({ session, selectedId: '8' });
    expect(reverse.crossTopicRelated).toEqual([{ id: 'related:8:1', from: '8', to: '1' }]);
    for (const selectedId of [null, 'missing']) {
      const empty = build({ session, selectedId });
      expect(empty.topics.every(topic => topic.related.length === 0)).toBe(true);
      expect(empty.crossTopicRelated).toEqual([]);
    }
  });

  it.each(['affects', 'depends_on'] as const)('draws $field in both directions with the existing related edges and no duplicate targets', field => {
    const session = graphSession();
    session.items['1']![field] = ['2', '8', '1', 'missing'];
    session.items['1.1']![field] = ['1'];
    // Opposite declarations can connect the same pair; the graph still draws one edge.
    session.items['2']!.related = ['1'];
    const graph = build({ session, selectedId: '1' });
    expect(graph.topics[0].related.map(edge => edge.id)).toEqual(['related:1:2', 'related:1:1.1']);
    expect(graph.topics[0].related.find(edge => edge.id === 'related:1:1.1')!.d).toBe('M236 95 L262 53');
    expect(graph.crossTopicRelated).toEqual([{ id: 'related:1:8', from: '1', to: '8' }]);
    expect(build({ session, selectedId: '8' }).crossTopicRelated).toEqual([{ id: 'related:8:1', from: '8', to: '1' }]);
    // A hidden item is not drawn, so no related line leads to it.
    const hidden = build({ session, selectedId: '1', view: preferences({ hidden_item_ids: ['1.1'] }) });
    expect(hidden.nodes.has('1.1')).toBe(false);
    expect(hidden.topics[0].related.map(edge => edge.id)).toEqual(['related:1:2']);
    const collapsed = build({ session, selectedId: '1', view: preferences({ expanded_item_ids: [] }) });
    expect(collapsed.topics[0].related.map(edge => edge.id)).toEqual(['related:1:2']);
    expect(collapsed.crossTopicRelated).toEqual(graph.crossTopicRelated);
  });

  it('skips collapsed or filtered endpoints without changing expansion or filters', () => {
    const session = graphSession();
    session.items['1']!.related = ['1.1.1', '8'];
    const view = preferences({ expanded_item_ids: [], filters: { ...preferences().filters, search: 'full reply' } });
    const graph = build({ session, view, selectedId: '1' });
    expect(graph.topics[0].related).toEqual([]);
    expect(graph.crossTopicRelated).toEqual([]);
    expect(view.expanded_item_ids).toEqual([]);
    expect(view.filters.search).toBe('full reply');
    const collapsed = build({ session, view: preferences({ expanded_item_ids: [] }), selectedId: '1' });
    expect(collapsed.topics[0].related).toEqual([]);
    expect(collapsed.crossTopicRelated).toHaveLength(1);
  });

  it('places Ack counts after both waiting counts and before other statuses', () => {
    const session = graphSession(), input = structuredClone(Object.values(session.inputs).find(input => input)!);
    session.answers = []; session.inputs = {};
    const ack = session.items['1.1']!, waitingOnAgent = session.items['2']!;
    ack.ack_to = 'done'; ack.ask = null; ack.options = [];
    waitingOnAgent.status = 'waiting_on_me';
    input.target.item_id = waitingOnAgent.id; input.state = 'queued'; input.answer_id = null;
    input.payload.target_snapshot.question_revision = waitingOnAgent.question_revision;
    session.inputs[input.id] = input;
    const counts = build({ session }).topics[0].counts;
    expect(counts).toBe('1 waiting on you · 1 queued · 1 to ack · 1 open · 1 in progress · 2 closed');
    session.archived_at = session.updated_at;
    expect(build({ session }).topics[0].counts).not.toContain('to ack');
    expect(build({ session }).nodes.get(ack.id)!.ack).toBeNull();
    session.archived_at = null;
    expect(build({ session }).topics[0].counts).toContain('1 to ack');
    ack.ack_to = null;
    expect(build({ session }).topics[0].counts).not.toContain('to ack');
  });
  it('marks hidden parents and descendants faded once their stub is open, including the revealed node', () => {
    const open = new Set([hiddenGroupKey(topicA, null)]);
    const graph = build({ view: preferences({ hidden_item_ids: ['1'] }), selectedId: '1.1.1', expandedHiddenGroups: open });
    // Visible siblings first, then the stub's items, as in the Tree.
    expect(graph.order).toEqual(['2', '3', hiddenGroupKey(topicA, null), '1', '1.1', '1.1.1', '1.2', '8']);
    for (const id of ['1', '1.1', '1.1.1', '1.2']) expect(graph.nodes.get(id)!.hidden).toBe(true);
    expect(graph.nodes.get('1.1.1')!.selected).toBe(true);
    expect(graph.nodes.get('2')!.hidden).toBe(false);
    expect(graph.topics[0].counts).toContain('1 waiting on you');
  });

  it('keeps a child hidden independently when its parent is unhidden', () => {
    const groups = new Set([hiddenGroupKey(topicA, null), hiddenGroupKey(topicA, '1')]);
    const both = build({ view: preferences({ hidden_item_ids: ['1', '1.1'] }), expandedHiddenGroups: groups });
    expect(both.nodes.get('1.2')!.hidden).toBe(true);
    const child = build({ view: preferences({ hidden_item_ids: ['1.1'] }), expandedHiddenGroups: groups });
    expect(child.nodes.get('1')!.hidden).toBe(false);
    expect(child.nodes.get('1.2')!.hidden).toBe(false);
    expect(child.nodes.get('1.1')!.hidden).toBe(true);
    expect(child.nodes.get('1.1.1')!.hidden).toBe(true);
    const clear = build({ view: preferences({ hidden_item_ids: [] }) });
    expect([...clear.nodes.values()].some(node => node.hidden)).toBe(false);
    expect(clear.stubs.size).toBe(0);
  });

  describe('hidden items fold into a stub, as in the Tree', () => {
    const rootGroup = hiddenGroupKey(topicA, null), kidsOfOne = hiddenGroupKey(topicA, '1');
    const edgeIds = (graph: ReturnType<typeof build>) => graph.topics.flatMap(topic => [...topic.edges.map(edge => edge.id), ...topic.related.map(edge => edge.id), ...topic.replacements.map(arc => arc.id)]);
    it('draws a hidden item that is not selected with no parent, related or replacement line', () => {
      const session = graphSession();
      session.items['1']!.related = ['2']; session.items['1.1']!.parent = '1';
      const graph = build({ session, selectedId: '1', view: preferences({ hidden_item_ids: ['2'] }) });
      expect(graph.nodes.has('2')).toBe(false);
      expect(graph.order).not.toContain('2');
      // Item 3 is replaced by 2: the arc would end on a card that is not drawn.
      expect(edgeIds(graph).filter(id => /(^|:)2($|:)/.test(id))).toEqual([]);
      expect(graph.stubs.get(rootGroup)).toMatchObject({ count: 1, parent: null, topicId: topicA, expanded: false });
    });
    it('does not draw the children of an unselected hidden item either', () => {
      const graph = build({ view: preferences({ hidden_item_ids: ['1'] }), selectedId: null });
      expect(graph.order).toEqual(['2', '3', rootGroup, '8']);
      const parts = edgeIds(graph).flatMap(id => id.split(':'));
      for (const id of ['1', '1.1', '1.1.1', '1.2']) expect(parts).not.toContain(id);
      expect(edgeIds(graph)).toContain(`topic:${rootGroup}`);
      expect(graph.nodes.get('2')).toMatchObject({ hidden: false });
    });
    it('puts one small stub after the visible siblings, and counts what waits on the owner', () => {
      const none = build({ view: preferences({ hidden_item_ids: ['1.2'] }) });
      const stub = none.stubs.get(kidsOfOne)!;
      expect(stub).toMatchObject({ count: 1, parent: '1', waiting: false });
      expect(stub.x).toBe(none.nodes.get('1.1')!.x);
      expect(stub.y).toBeGreaterThan(none.nodes.get('1.1.1')!.y);
      expect(STUB_HEIGHT).toBeLessThan(NODE_HEIGHT / 2);
      expect(none.children.get('1')).toEqual(['1.1']);
      expect(none.topics[0].edges.map(edge => edge.id)).toContain(`parent:1:${kidsOfOne}`);
      // 1.1.1 waits on the owner, so the stub for 1.1 says so, like the Tree's row.
      const waiting = build({ view: preferences({ hidden_item_ids: ['1.1'] }) });
      expect(waiting.stubs.get(kidsOfOne)).toMatchObject({ count: 1, waiting: true });
      expect(waiting.order).toEqual(['1', '1.2', kidsOfOne, '2', '3', '8']);
    });
    it('shows the hidden items, faded, after the stub while the owner has it open', () => {
      const graph = build({ view: preferences({ hidden_item_ids: ['1.1'] }), expandedHiddenGroups: new Set([kidsOfOne]) });
      expect(graph.order).toEqual(['1', '1.2', kidsOfOne, '1.1', '1.1.1', '2', '3', '8']);
      expect(graph.stubs.get(kidsOfOne)).toMatchObject({ expanded: true });
      expect(graph.children.get('1')).toEqual(['1.2', '1.1']);
      expect(graph.nodes.get('1.1')!.hidden).toBe(true);
    });
    it('opens the selected hidden route on the first model pass, including saved folded ancestors', () => {
      const view = preferences({ hidden_item_ids: ['1'], expanded_item_ids: [] });
      const revealed = build({ view, selectedId: '1.1.1', revealedItemId: '1.1.1', temporaryExpandedItemIds: ['1', '1.1'] });
      expect(revealed.order).toContain('1.1.1');
      expect(revealed.stubs.get(rootGroup)!.expanded).toBe(true);
      const selectedOnly = build({ view, selectedId: '1.1.1' });
      expect(selectedOnly.order).toContain('1.1.1');
      expect(selectedOnly.stubs.get(rootGroup)!.expanded).toBe(true);
      expect(selectedOnly.nodes.get('1.1.1')).toMatchObject({ selected: true, hidden: true });
      expect(view.expanded_item_ids).toEqual([]);
    });
    it.each(['search', 'status'] as const)('keeps selected hidden items subject to %s filters, just like visible selections', filter => {
      const filters = { ...preferences().filters, ...(filter === 'search' ? { search: 'Record retry limits' } : { statuses: ['open' as const] }) };
      for (const hidden_item_ids of [[], ['1', '1.1']]) {
        const graph = build({ view: preferences({ hidden_item_ids, filters }), selectedId: '1.1.1' });
        expect(graph.nodes.has('1.1.1')).toBe(false);
      }
    });
    it.each(['search', 'status'] as const)('forces a live revealed hidden item through %s filters', filter => {
      const filters = { ...preferences().filters, ...(filter === 'search' ? { search: 'Record retry limits' } : { statuses: ['open' as const] }) };
      const graph = build({ view: preferences({ hidden_item_ids: ['1', '1.1'], filters }), selectedId: '1.1.1', revealedItemId: '1.1.1' });
      expect(graph.nodes.get('1.1.1')).toMatchObject({ selected: true, hidden: true });
    });
    it('keeps a topic whose top items are all hidden, with only its stub', () => {
      const graph = build({ view: preferences({ hidden_item_ids: ['8'] }) });
      const topic = graph.topics.find(value => value.topic.id === topicB)!;
      expect(topic.nodes).toEqual([]);
      expect(topic.stubs).toHaveLength(1);
      expect(topic.stubs[0]).toMatchObject({ count: 1, parent: null, topicId: topicB });
      expect(topic.edges.map(edge => edge.id)).toEqual([`topic:${hiddenGroupKey(topicB, null)}`]);
      expect(topic.height).toBeLessThan(120);
      expect(graph.order).not.toContain('8');
    });
    it('counts the visible subtree and names hidden-only branches', () => {
      const folded = preferences({ expanded_item_ids: [], hidden_item_ids: ['1.1'] });
      const closed = build({ view: folded });
      expect(closed.nodes.get('1')).toMatchObject({ collapsed: true, below: 1, hiddenBelow: 1 });
      // Expanding it draws that one card and the stub.
      const open = build({ view: { ...folded, expanded_item_ids: ['1'] } });
      expect(open.children.get('1')!.length).toBe(closed.nodes.get('1')!.below);
      expect(open.stubs.get(kidsOfOne)!.count).toBe(closed.nodes.get('1')!.hiddenBelow);
      const only = build({ view: preferences({ expanded_item_ids: [], hidden_item_ids: ['1.1', '1.2'] }) });
      expect(only.nodes.get('1')).toMatchObject({ collapsed: true, below: 0, hiddenBelow: 2 });
      const onlyOpen = build({ view: preferences({ expanded_item_ids: ['1'], hidden_item_ids: ['1.1', '1.2'] }) });
      expect(onlyOpen.nodes.get('1')).toMatchObject({ collapsed: false, canCollapse: true });
      expect(onlyOpen.stubs.get(kidsOfOne)!.count).toBe(2);
    });
    it('counts all visible tiers but counts each hidden branch once, separately from sibling stub counts', () => {
      const session = graphSession();
      session.items['1.2.1'] = { ...session.items['1.2']!, id: '1.2.1', parent: '1.2', ordinal: 1 };
      session.items['1.2.1.1'] = { ...session.items['1.2']!, id: '1.2.1.1', parent: '1.2.1', ordinal: 1 };
      session.items['1.2.1.2'] = { ...session.items['1.2']!, id: '1.2.1.2', parent: '1.2.1', ordinal: 2 };
      session.items['1.2.1.2.1'] = { ...session.items['1.2']!, id: '1.2.1.2.1', parent: '1.2.1.2', ordinal: 1 };
      const view = preferences({ expanded_item_ids: [], hidden_item_ids: ['1.1', '1.2.1.2'] });
      const closed = build({ session, view });
      expect(closed.nodes.get('1')).toMatchObject({ below: 3, hiddenBelow: 2, collapsed: true });
      const nextTier = build({ session, view: { ...view, expanded_item_ids: ['1'] } });
      expect(nextTier.children.get('1')).toEqual(['1.2']);
      expect(nextTier.stubs.get(kidsOfOne)!.count).toBe(1);
      expect(nextTier.nodes.get('1.2')).toMatchObject({ below: 2, hiddenBelow: 1, collapsed: true });
      const open = build({ session, view: { ...view, expanded_item_ids: ['1', '1.2', '1.2.1'] } });
      expect(open.stubs.get(kidsOfOne)!.count).toBe(1);
      expect(open.stubs.get(hiddenGroupKey(topicA, '1.2.1'))!.count).toBe(1);
      expect(open.nodes.has('1.2.1.2.1')).toBe(false);
    });
    it('treats search and status filters as the Tree does: hidden matches fold into the stub', () => {
      const search = build({ view: preferences({ hidden_item_ids: ['1.2'], filters: { ...preferences().filters, search: 'receipt' } }) });
      expect(search.order).toEqual(['1', '1.1', kidsOfOne]);
      expect(search.stubs.get(kidsOfOne)).toMatchObject({ count: 1 });
      const status = build({ view: preferences({ hidden_item_ids: ['1.2'], filters: { ...preferences().filters, statuses: ['in_progress'] } }) });
      expect(status.order).toEqual(['1', kidsOfOne]);
      expect(status.nodes.get('1')).toMatchObject({ dimmed: true });
      expect(status.stubs.get(kidsOfOne)).toMatchObject({ count: 1 });
      // Nothing hidden matches: no stub.
      expect(build({ view: preferences({ hidden_item_ids: ['2'], filters: { ...preferences().filters, search: 'receipt' } }) }).stubs.size).toBe(0);
    });
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

  it('uses the tighter grid when detail is open', () => {
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

  it('keeps context nodes dimmed and allows folding while a filter is active', () => {
    const view = preferences({ expanded_item_ids: [], filters: { ...preferences().filters, search: 'morning or evening' } });
    const graph = build({ view, selectedId: null });
    expect(graph.filtering).toBe(true);
    expect(graph.order).toEqual(['1', '1.1', '1.1.1']);
    expect(graph.nodes.get('1')).toMatchObject({ dimmed: true, canCollapse: true, collapsed: false });
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
    const counted = build();
    expect([counted.nodes.get('1')!.below, counted.nodes.get('8')!.below]).toEqual([3, 0]);
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

  it('distinguishes colliding visible node labels and restores the short label when its peer is folded', () => {
    const session = graphSession();
    const first = session.items['1']!, second = session.items['1.1']!;
    first.short = second.short = 'Count cache reads';
    first.question = 'Count cache reads using Redis for this rollout?';
    second.question = 'Count cache reads using Postgres for this rollout?';
    const graph = build({ session });
    expect(graph.nodes.get(first.id)!.short).toBe('Redis · Count cache reads');
    expect(graph.nodes.get(second.id)!.short).toBe('Postgres · Count cache reads');
    const folded = build({ session, view: preferences({ expanded_item_ids: [] }) });
    expect(folded.nodes.has(second.id)).toBe(false);
    expect(folded.nodes.get(first.id)!.short).toBe('Count cache reads');
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
