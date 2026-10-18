import { describe, expect, it } from 'vitest';
import { filterOf, type LocalChip } from '../../../src/selectors/tree/filter';
import { applyChange, elbowPath, graphColumn, graphStatus, isClosed, mergeChange, nodeWidth, relatedLines, relatedPath,
  sessionGraph, type GraphInput } from '../../../src/ui/graph/model';
import { shortLabel } from '../../../src/ui/shared/short';
import { graphSession, preferences, topicA, topicB } from './fixture';
import { FILTER_STATUSES } from '../../../src/selectors/tree/folds';

const build = (overrides: Partial<GraphInput> = {}) =>
  sessionGraph({ session: graphSession(), view: preferences(), later: new Set(), selectedId: null, ...overrides });
const at = (graph: ReturnType<typeof build>, id: string) => { const node = graph.nodes.get(id)!; return [node.x, node.y]; };

describe('graph model', () => {
  it('fits SPEC 1.3’s column to a Map width: clamp(150, floor((w − 56) / 5), 196), nodes 26 narrower', () => {
    expect([0, 700, 900, 1000, 1244, 2000].map(graphColumn)).toEqual([150, 150, 168, 188, 196, 196]);
    expect(nodeWidth(196)).toBe(170);
    expect(build().column).toBe(150);
    expect(build({ column: 188 }).nodeWidth).toBe(162);
  });

  it('lays topics down one canvas: 40px nodes on 50px lanes from 50, depth d at 36 + (d − 1) × col, parents on their first child’s lane', () => {
    const graph = build(), [a, b] = graph.topics;
    expect(graph.topics.map(topic => topic.topic.id)).toEqual([topicA, topicB]);
    expect(graph.order).toEqual(['1', '1.1', '1.1.1', '1.2', '2', '3', '8']);
    expect(['1', '1.1', '1.1.1', '1.2', '2', '3'].map(id => at(graph, id)))
      .toEqual([[36, 50], [186, 50], [336, 50], [186, 100], [36, 150], [36, 200]]);
    expect([a!.top, a!.height, b!.top, b!.height, at(graph, '8')]).toEqual([0, 250, 266, 100, [36, 50]]);
    expect([graph.width, graph.height]).toEqual([36 + 2 * 150 + 124 + 24, 366]);
    const wide = build({ column: 196 });
    expect(at(wide, '1.1.1')).toEqual([36 + 2 * 196, 50]);
  });

  it('draws the trunk at x 16 from y 36 to the last top item, a branch into each top item, and orthogonal elbows', () => {
    const [a, b] = build().topics, edge = (topic: typeof a, id: string) => topic!.edges.find(value => value.id === id)!.d;
    expect(edge(a, `trunk:${topicA}`)).toBe('M16 36 V220');
    expect(['topic:1', 'topic:2', 'topic:3'].map(id => edge(a, id))).toEqual(['M16 70 H36', 'M16 170 H36', 'M16 220 H36']);
    expect(edge(a, 'parent:1:1.1')).toBe(elbowPath(160, 70, 186, 70));
    expect(elbowPath(160, 70, 186, 120)).toBe('M160 70 H173 V120 H186');
    // A later sibling continues the shared vertical from the one before it, so siblings never redraw the same line.
    expect(edge(a, 'parent:1:1.2')).toBe('M173 70 V120 H186');
    expect(edge(a, 'parent:1.1:1.1.1')).toBe('M310 70 H323 V70 H336');
    expect(a!.edges).toHaveLength(1 + 3 + 3);
    expect(b!.edges.map(value => value.id)).toEqual([`trunk:${topicB}`, 'topic:8']);
  });

  it('draws the selected path from the trunk’s top into the first ancestor, then elbow by elbow, in canvas coordinates', () => {
    const graph = build({ selectedId: '1.1.1' });
    expect(graph.path).toBe('M16 36 V70 H36 M160 70 H173 V70 H186 M310 70 H323 V70 H336');
    expect(['1', '1.1', '1.1.1', '1.2'].map(id => [graph.nodes.get(id)!.onPath, graph.nodes.get(id)!.selected]))
      .toEqual([[true, false], [true, false], [false, true], [false, false]]);
    expect(build({ selectedId: '8' }).path).toBe('M16 302 V336 H36');
    expect(build().path).toBeNull();
    expect(build({ selectedId: 'missing' }).path).toBeNull();
  });

  it('draws related lines once per pair for the given nodes, including backlinks, typed links and other topics', () => {
    const session = graphSession();
    session.items['1']!.related = ['2', '2', '8', 'missing'];
    session.items['2']!.related = ['1'];
    session.items['1.1']!.depends_on = ['1'];
    session.items['3']!.affects = ['1.2'];
    const graph = build({ session, selectedId: '1' });
    const lines = relatedLines(graph, session, ['1', null]);
    expect(lines.paths.map(path => path.id).sort()).toEqual(['related:1:1.1', 'related:1:2', 'related:1:8']);
    expect([...lines.related].sort()).toEqual(['1.1', '2', '8']);
    expect(lines.paths.find(path => path.id === 'related:1:1.1')!.d).toBe(relatedPath({ x: 36, y: 50 }, { x: 186, y: 50 }, 124));
    // Across topics, in canvas coordinates: 8 sits in the second topic's block.
    expect(lines.paths.find(path => path.id === 'related:1:8')!.d).toBe(relatedPath({ x: 36, y: 50 }, { x: 36, y: 266 + 50 }, 124));
    // The selected and the hovered node together, a shared pair once.
    const both = relatedLines(graph, session, ['1', '3']);
    expect(both.paths.map(path => path.id).sort()).toEqual(['related:1:1.1', 'related:1:2', 'related:1:8', 'related:3:1.2']);
    expect(relatedLines(graph, session, ['2', '1']).paths.filter(path => path.id.includes('1:2') || path.id.includes('2:1'))).toHaveLength(1);
    expect(relatedLines(graph, session, [null, 'missing']).paths).toEqual([]);
    // An undrawn end (folded or hidden) has no line.
    expect(relatedLines(build({ session, view: preferences({ expanded_item_ids: [] }) }), session, ['1']).paths.map(path => path.id).sort())
      .toEqual(['related:1:2', 'related:1:8']);
  });

  it('bows a related line out to the right between two nodes in one column, and runs a cubic between columns', () => {
    expect(relatedPath({ x: 36, y: 50 }, { x: 186, y: 100 }, 124)).toBe('M160 70 C173 70 173 120 186 120');
    expect(relatedPath({ x: 186, y: 100 }, { x: 36, y: 50 }, 124)).toBe('M160 70 C173 70 173 120 186 120');
    expect(relatedPath({ x: 36, y: 50 }, { x: 36, y: 170 }, 124)).toBe('M160 70 C198 70 198 190 160 190');
  });

  it('does not draw hidden items, nor anything below them', () => {
    const graph = build({ view: preferences({ hidden_item_ids: ['1'] }) });
    expect(graph.order).toEqual(['2', '3', '8']);
    expect(graph.topics[0]!.edges.map(edge => edge.id)).toEqual([`trunk:${topicA}`, 'topic:2', 'topic:3']);
    expect(build({ view: preferences({ hidden_item_ids: ['1.1'] }) }).order).toEqual(['1', '1.2', '2', '3', '8']);
  });

  it.each([['selected', { selectedId: '1.1.1' }], ['revealed', { revealedItemId: '1.1.1' }]] as const)(
    'draws a %s hidden route, dimmed, and only that route', (_name, input) => {
      const graph = build({ view: preferences({ hidden_item_ids: ['1'] }), ...input });
      expect(graph.order).toEqual(['1', '1.1', '1.1.1', '2', '3', '8']);
      for (const id of ['1', '1.1', '1.1.1']) expect(graph.nodes.get(id)!.hidden).toBe(true);
      expect(graph.nodes.get('2')!.hidden).toBe(false);
    });

  it('opens a hidden selection’s folded ancestors without saving them', () => {
    const view = preferences({ hidden_item_ids: ['1', '1.1'], expanded_item_ids: [] });
    expect(build({ view, selectedId: '1.1.1' }).order).toEqual(['1', '1.1', '1.1.1', '2', '3', '8']);
    expect(view.expanded_item_ids).toEqual([]);
    // A visible selection inside a folded branch is not opened by selecting it: that is a reveal's job.
    expect(build({ view: preferences({ expanded_item_ids: [] }), selectedId: '1.1.1' }).order).toEqual(['1', '2', '3', '8']);
  });

  it('marks a folded node with what unfolding brings back, and what of it waits on the owner', () => {
    const closed = build({ view: preferences({ expanded_item_ids: [] }) });
    expect(closed.nodes.get('1')).toMatchObject({ folded: true, canFold: false, inside: 3, waitingInside: 1 });
    expect(closed.nodes.get('2')).toMatchObject({ folded: false, canFold: false, inside: 0, waitingInside: 0 });
    const open = build({ view: preferences({ expanded_item_ids: ['1'] }) });
    expect(open.nodes.get('1')).toMatchObject({ folded: false, canFold: true });
    expect(open.nodes.get('1.1')).toMatchObject({ folded: true, inside: 1, waitingInside: 1 });
    expect(open.children.get('1')).toEqual(['1.1', '1.2']);
    // Hidden branches are not drawn when unfolded, so they are not counted either; all-hidden children leave no chip.
    expect(build({ view: preferences({ expanded_item_ids: [], hidden_item_ids: ['1.1'] }) }).nodes.get('1'))
      .toMatchObject({ folded: true, inside: 1, waitingInside: 0 });
    expect(build({ view: preferences({ expanded_item_ids: [], hidden_item_ids: ['1.1', '1.2'] }) }).nodes.get('1'))
      .toMatchObject({ folded: false, inside: 0 });
  });

  it('never filters by search: a query leaves every node drawn (the view tints matches)', () => {
    const view = preferences({ filters: { ...preferences().filters, search: 'morning or evening' } });
    const graph = build({ view });
    expect(graph.filtering).toBe(false);
    expect(graph.order).toEqual(build().order);
    expect([...graph.nodes.values()].some(node => node.dimmed)).toBe(false);
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

  it('keeps status-filter context dimmed, honours the filter’s own folds and a reveal through them', () => {
    const view = preferences({ expanded_item_ids: [], filters: { ...preferences().filters, statuses: ['waiting_on_me'], topic_id: 'retired-topic-filter' } });
    const graph = build({ view });
    expect(graph.filtering).toBe(true);
    expect(graph.order).toEqual(['1', '1.1', '1.1.1']);
    expect(graph.nodes.get('1')).toMatchObject({ dimmed: true, canFold: true, folded: false });
    expect(graph.nodes.get('1.1.1')!.dimmed).toBe(false);
    expect(build({ view, selectedId: '1' }).nodes.get('1')!.dimmed).toBe(false);
    const folded = build({ view, filterCollapsedItemIds: new Set(['1']) });
    expect(folded.order).toEqual(['1']);
    expect(folded.nodes.get('1')).toMatchObject({ folded: true, canFold: false });
    expect(build({ view, filterCollapsedItemIds: new Set(['1']), revealedItemId: '1.1.1' }).order).toEqual(['1', '1.1', '1.1.1']);
    expect(view.expanded_item_ids).toEqual([]);
  });

  it('shows temporary reveal ancestors without saving them', () => {
    const graph = build({ view: preferences({ expanded_item_ids: [] }), temporaryExpandedItemIds: ['1', '1.1'], revealedItemId: '1.1.1' });
    expect(graph.order).toContain('1.1.1');
  });

  it('reads statuses and filters; search is not a filter', () => {
    expect([graphStatus('waiting_on_me'), graphStatus('in_progress'), graphStatus('dropped')]).toEqual(['waiting', 'progress', 'dropped']);
    expect([isClosed('done'), isClosed('replaced'), isClosed('open')]).toEqual([true, true, false]);
    const filters = preferences().filters, session = graphSession();
    const filtering = (next: typeof filters, local: LocalChip[] = []) =>
      filterOf({ session, view: { ...preferences(), filters: next }, later: new Set(), local }).active;
    expect([filtering(filters), filtering({ ...filters, statuses: ['open'] }), filtering({ ...filters, owners: [{ kind: 'me' }] }),
      filtering({ ...filters, hide_later: true }), filtering({ ...filters, search: 'receipt' }), filtering(filters, ['blocked'])]).toEqual([false, true, true, true, false, true]);
    expect(build().nodes.get('1')!.closed).toBe(true);
  });

  it('titles nodes with the shared short label', () => {
    const session = graphSession();
    session.items['1.1'] = { ...session.items['1.1']!, short: 'Receipt test' };
    const nodes = build({ session }).nodes;
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
    // A hidden peer is not drawn, so it does not take part either.
    expect(build({ session, view: preferences({ hidden_item_ids: ['1.1'] }) }).nodes.get(first.id)!.short).toBe('Count cache reads');
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
