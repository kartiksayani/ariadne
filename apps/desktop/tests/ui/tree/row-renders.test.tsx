// The Map stops redrawing while idle (alpha.23 F6c, F6d). Every item row draws one status icon, so a mocked StatusBadge counts the
// item rows that rendered: it records its row after each render it commits, and a row that skipped rendering draws no icon.
//
// | Change                                     | Rows that redraw                                   | Shown after                         |
// |--------------------------------------------|----------------------------------------------------|-------------------------------------|
// | an unchanged session or navigation poll    | none                                               | the same rows                       |
// | new workspace callbacks only               | none                                               | the same rows                       |
// | a heartbeat that changes no row            | none                                               | the same rows                       |
// | selection                                  | the new selected row and the rows its thread runs  | aria-selected, the row's Ack        |
// |                                            | down (never another topic's)                       |                                     |
// | a click's view save, pending then settled  | the click's own rows only (alpha.26: no busy flip) | the tree's aria-busy, then clear     |
// | the keyboard moves focus                   | the row it left and the row it reached             | roving tabIndex                     |
// | an Ack held for its Undo                   | that row                                           | "Acked · Undo"                      |
// | the agent stops (same revision)            | every row (each row's hover bar greys)             | "…: the agent is not running"       |
// | the agent goes idle, busy (same revision)  | only the row with a queued message                 | its delivery line                   |
// | the presence drops (same revision)         | only the row stuck behind the busy agent           | its delivery line                   |
// | a search                                   | the rows that match                                | the hits                            |
// | a seen mark                                | the row whose marker clears                        | no marker                           |
// | an agent edit (a new revision)             | every row (items are new objects per revision)     | the new question                    |
// | Hide, then Unhide on the same row          | —                                                  | the second press unhides            |
// | a fold                                     | —                                                  | the children go                     |
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PresenceObservation, Session } from '../../../src/generated/domain/models';
import type { RevealedItem } from '../../../src/data/routes';
import { immutable, type Immutable } from '../../../src/data';
import { reuseRows, sameRow, type Row } from '../../../src/ui/tree/model';
import { shimTree, type ShimInput } from './shimTree';
import { createDesktopService } from '../../../src/data/service';
import { NavigationStore } from '../../../src/state/navigation/store';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { SessionActionControllers } from '../../../src/components/bindings/actions';
import { TreeView, type TreeViewProps } from '../../../src/ui/tree/TreeView';
import { notices } from '../../../src/ui/pages/notices';
import sessionsFixture from '../../../../../fixtures/domain/projections/sessions.json';
import { AppTransport, route } from '../app/transport';

const drawn = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/ui/shared/StatusBadge', async () => {
  const { useLayoutEffect, useRef } = await import('react');
  const { STATUS } = await import('../../../src/ui/shared/status');
  return {
    StatusBadge({ status, label, variant = 'pill' }: { status: keyof typeof STATUS; label?: string; variant?: 'pill' | 'text' | 'icon' }) {
      const self = useRef<HTMLElement>(null), text = label || STATUS[status].label;
      useLayoutEffect(() => {
        const id = variant === 'icon' ? self.current?.closest('[role="treeitem"][data-item-id]')?.getAttribute('data-item-id') : null;
        if (id) drawn.push(id);
      });
      return variant === 'icon' ? <i ref={self} role="img" aria-label={text} /> : <span className="status-badge"><span>{text}</span></span>;
    },
  };
});

const stores: NavigationStore[] = [];
afterEach(() => { cleanup(); stores.splice(0).forEach(store => store.stop()); notices.clear(); localStorage.clear(); drawn.length = 0; });

async function mount(configure?: (transport: AppTransport) => void) {
  const transport = new AppTransport();
  configure?.(transport);
  const service = createDesktopService(transport), navigation = new NavigationStore(service); stores.push(navigation);
  await navigation.start();
  const store = navigation.opened.open(route);
  await store.refresh();
  const actions = new SessionActionControllers(service).forSession(store), drafts = new OwnerDraftStore(service);
  function Harness(extra: Partial<TreeViewProps>) {
    const [selected, setSelected] = useState<string | null>(null);
    return <TreeView navigation={navigation} store={store} actions={actions} drafts={drafts} query="" reveal={null} selectedId={selected}
      detailOpen={false} summaries={[]} now={() => Date.parse('2026-10-07T12:00:00Z')}
      onSelected={(result: RevealedItem) => { if (result.kind === 'item') setSelected(result.route.item_id); }}
      onDismissReveal={() => {}} onResume={() => {}} onAct={() => {}} onClearFilters={() => {}} onShowArchive={() => {}} onRemove={() => {}} {...extra} />;
  }
  const view = render(<Harness />);
  await waitFor(() => expect(row('1')).toBeTruthy());
  await settle();
  return { transport, navigation, store, rerender: (extra: Partial<TreeViewProps>) => view.rerender(<Harness {...extra} />) };
}
const row = (id: string) => document.querySelector<HTMLElement>(`[role="treeitem"][data-item-id="${id}"]`)!;
const shownRows = () => [...document.querySelectorAll('[role="treeitem"][data-item-id]')].map(element => element.getAttribute('data-item-id')!);
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
/** The item rows that rendered while `change` ran and settled, each once, in Map order. */
async function redrawn(change: () => unknown): Promise<string[]> {
  drawn.length = 0;
  await act(async () => { await change(); });
  await settle();
  const once = new Set(drawn);
  return shownRows().filter(id => once.has(id)).concat([...once].filter(id => !shownRows().includes(id)));
}
function presence(transport: AppTransport, change: Partial<PresenceObservation>) {
  const session = transport.sessions.get(route.session_id)!, binding = session.bindings[session.active_binding_id!]!;
  const observation = { ...structuredClone(sessionsFixture.items[0].active_binding.presence), generation: binding.generation, freshness: 'fresh',
    connection_state: 'connected', execution_state: 'idle', last_seen_at: new Date().toISOString(), ...change } as PresenceObservation;
  transport.emit('ariadne://presence_changed', { binding_id: binding.id, generation: binding.generation, observation });
}

describe('an idle Map redraws no row (F6)', () => {
  it('an unchanged session poll and an unchanged navigation poll redraw nothing', async () => {
    const { store, navigation } = await mount();
    expect(await redrawn(() => store.refresh())).toEqual([]);
    expect(await redrawn(() => navigation.refresh())).toEqual([]);
    expect(shownRows()).toContain('1.1');
  });

  it('new workspace callbacks alone redraw nothing', async () => {
    const { rerender } = await mount();
    expect(await redrawn(() => rerender({ onAct: () => {}, onSelected: () => {}, onDismissReveal: () => {}, onRemove: () => {},
      onResume: () => {}, onClearFilters: () => {}, onShowArchive: () => {}, notices: <p>notice</p> }))).toEqual([]);
  });

  it('a heartbeat that changes nothing on a row redraws nothing', async () => {
    const { transport } = await mount();
    await act(async () => { presence(transport, {}); });
    await settle();
    expect(await redrawn(() => presence(transport, { last_seen_at: new Date(Date.now() + 1000).toISOString() }))).toEqual([]);
  });
});

describe('each change redraws the rows it changed, and they show it (F6 risk table)', () => {
  it('selection redraws the selected row and the rows its thread runs down, not another topic', async () => {
    const { rerender } = await mount();
    const rows = await redrawn(() => rerender({ selectedId: '3' }));
    expect(rows).toContain('3');
    expect(rows).not.toContain('8');
    expect(row('3').getAttribute('aria-selected')).toBe('true');
    const back = await redrawn(() => rerender({ selectedId: '8' }));
    expect(back).toEqual(expect.arrayContaining(['3', '8']));
    expect(row('3').getAttribute('aria-selected')).toBe('false');
    expect(row('8').getAttribute('aria-selected')).toBe('true');
  });

  it('the keyboard moving focus redraws the row it left and the row it reached', async () => {
    await mount();
    fireEvent.focus(row('2'));
    await settle();
    expect(await redrawn(() => { fireEvent.keyDown(row('2'), { key: 'ArrowDown' }); })).toEqual(['2', '3']);
    expect(row('3').tabIndex).toBe(0);
    expect(row('2').tabIndex).toBe(-1);
  });

  it('an Ack held for its Undo redraws that row, which shows it', async () => {
    await mount(transport => Object.assign(transport.sessions.get(route.session_id)!.items['8']!, { ack_to: 'done', ask: null }));
    const ack = within(row('8')).getByRole('button', { name: /^Ack/ });
    expect(await redrawn(() => { fireEvent.click(ack); })).toEqual(['8']);
    expect(within(row('8')).getByRole('status').textContent).toBe('Acked·Undo');
  });

  it('the agent stopping redraws every row, and each greys its hover bar', async () => {
    const { transport } = await mount();
    expect(within(row('8')).getByRole('button', { name: 'Drop (d)' })).toBeTruthy();
    const rows = await redrawn(() => presence(transport, { connection_state: 'disconnected' }));
    expect(rows).toEqual(shownRows());
    expect(within(row('8')).getByRole('button', { name: 'Drop: the agent is not running' })).toBeTruthy();
  });

  it('a same-revision presence change redraws only the row whose delivery line it changes, which shows it', async () => {
    const { transport } = await mount();
    // The row's text changes only by its delivery line here.
    const line = () => row('4').textContent;
    // The opening presence has the agent busy, so item 4's message waits behind it.
    const busy = line();
    expect(busy).toContain('Queued for');
    expect(await redrawn(() => presence(transport, { execution_state: 'idle' }))).toEqual(['4']);
    const idle = line();
    expect(idle).not.toBe(busy);
    expect(await redrawn(() => presence(transport, { execution_state: 'running' }))).toEqual(['4']);
    expect(line()).toBe(busy);
    // The presence drops while the agent works: the message stuck behind it is no longer held for it, and only its row redraws.
    expect(await redrawn(() => presence(transport, { connection_state: 'reconnecting', execution_state: 'running' }))).toEqual(['4']);
    expect(line()).toBe(idle);
  });

  it('a search redraws the rows that match, which mark their hits', async () => {
    const { rerender, transport } = await mount();
    const question = transport.sessions.get(route.session_id)!.items['4']!.question, word = question.split(' ').find(value => value.length > 5)!;
    const rows = await redrawn(() => rerender({ query: word }));
    // Only rows holding the word redraw; item 4's question marks it as its own piece.
    const holding = shownRows().filter(id => row(id).textContent!.toLowerCase().includes(word.toLowerCase()));
    expect(rows).toContain('4');
    expect(holding).toEqual(expect.arrayContaining(rows));
    expect(holding.length).toBeLessThan(shownRows().length);
    expect(within(row('4')).getByText(word, { selector: 'span' })).toBeTruthy();
  });

  it('a seen mark redraws the row whose marker clears', async () => {
    const { navigation } = await mount(transport => {
      transport.preferences.seen = [{ session: route, since: '2026-10-01T00:00:00.000Z', items: [], topics: [] }];
    });
    const marked = shownRows().filter(id => within(row(id)).queryByTestId('change-marker'));
    expect(marked.length).toBeGreaterThan(1);
    const [first] = marked;
    expect(await redrawn(async () => { navigation.markItemSeen(route, first!); await new Promise(resolve => setTimeout(resolve, 30)); })).toEqual([first]);
    expect(within(row(first!)).queryByTestId('change-marker')).toBeNull();
  });

  it('an agent edit redraws the rows and shows the new question', async () => {
    const { transport, store } = await mount();
    const session = transport.sessions.get(route.session_id)!;
    session.items['4']!.question = 'A question the agent rewrote'; ++session.items['4']!.revision; ++session.revision;
    const rows = await redrawn(() => store.refresh());
    expect(rows).toContain('4');
    expect(row('4').textContent).toContain('A question the agent rewrote');
  });
});

describe('a click does not redraw every row (alpha.26 R1)', () => {
  /**
   * Holds the owner's view save of a row click (the `set_session_view` that selects `id`) until `release()`; `entered()` says it is in
   * flight. The click also queues an automatic Recent write, which the owner never waits on, so that one is let through.
   */
  function holdViewSave(transport: AppTransport, id: string) {
    let release!: () => void, entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; }), invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('command' in args.request && args.request.command.command === 'preferences_patch'
        && args.request.command.params.entries.some(entry => entry.kind === 'set_session_view' && entry.preferences.selected_item_id === id)) { entered = true; await gate; }
      return invoke(name, args);
    });
    return { release: () => release(), entered: () => entered };
  }
  const hasAck = (id: string) => !!within(row(id)).queryByRole('button', { name: /^Ack/ });

  it('draws no row for the busy flip: rows the click did not touch render 0 times through the whole click, and no row without an Ack slot renders while the save is pending or after it settles', async () => {
    const { transport } = await mount();
    const held = holdViewSave(transport, '3');
    const ids = shownRows(), withAck = ids.filter(hasAck);
    // The rows a selection of 3 changes (the new selection and its thread), from the model, so the test does not guess them.
    const session = immutable(transport.sessions.get(route.session_id)!), view = { ...new AppTransport().preferences.sessions[0]!, expanded_item_ids: ['1'] };
    const input = { session, view, search: '', later: new Set<string>(), collapsedTopics: new Set<string>(), selectedId: null, revealId: null, temporaryExpanded: [],
      presence: null, summaries: [], now: Date.parse('2026-10-07T12:00:00Z') };
    const first = shimTree(input).rows, selected = shimTree({ ...input, selectedId: '3', previous: first }).rows;
    const touched = new Set(selected.filter((value, at) => !sameRow(value, first[at]!)).map(value => value.key));
    const untouched = ids.filter(id => !touched.has(id) && !withAck.includes(id));
    expect(untouched).toContain('8');
    expect(touched.has('3')).toBe(true);

    drawn.length = 0;
    fireEvent.click(row('3'));
    await waitFor(() => expect(held.entered()).toBe(true));
    await settle();
    expect(row('3').getAttribute('aria-selected')).toBe('true');
    const pendingFrom = drawn.length;
    await act(async () => { held.release(); });
    await settle();
    // (a) Across the whole click, through busy and settle, an untouched row never renders.
    expect(drawn.filter(id => untouched.includes(id))).toEqual([]);
    // (b) From the moment the save is pending until after it settles, no row without an Ack slot renders at all.
    expect(drawn.slice(pendingFrom).filter(id => !withAck.includes(id))).toEqual([]);
  });

  it('the tree, not each row, says a view save is pending, and clears when it settles', async () => {
    const { transport } = await mount();
    const held = holdViewSave(transport, '3');
    const ids = shownRows();
    expect(screen.getByRole('tree').getAttribute('aria-busy')).toBe('false');
    fireEvent.click(row('3'));
    await waitFor(() => expect(held.entered()).toBe(true));
    await settle();
    expect(screen.getByRole('tree').getAttribute('aria-busy')).toBe('true');
    for (const id of ids) expect(row(id).getAttribute('aria-disabled')).toBeNull();
    await act(async () => { held.release(); });
    await settle();
    expect(screen.getByRole('tree').getAttribute('aria-busy')).toBe('false');
  });

  it('refuses a second click while the save is pending, as before', async () => {
    const { transport } = await mount();
    const held = holdViewSave(transport, '3');
    fireEvent.click(row('3'));
    await waitFor(() => expect(held.entered()).toBe(true));
    const reads = transport.queries.length, saves = transport.mutations.length;
    fireEvent.click(row('8'));
    await settle();
    expect(row('8').getAttribute('aria-selected')).toBe('false');
    expect(transport.queries).toHaveLength(reads);
    expect(transport.mutations).toHaveLength(saves);
    await act(async () => { held.release(); });
    await settle();
    expect(screen.getByRole('tree').getAttribute('aria-busy')).toBe('false');
  });
});

describe('treeModel keeps a row that draws the same (F6c)', () => {
  const demoSession = () => new AppTransport().sessions.get(route.session_id)!;
  const build = (session: Immutable<Session>, change: Partial<ShimInput> = {}) => {
    const view = new AppTransport().preferences.sessions[0]!;
    return shimTree({ session, view: { ...view, expanded_item_ids: ['1'] }, search: '', later: new Set(), collapsedTopics: new Set(),
      selectedId: null, revealId: null, temporaryExpanded: [], presence: null, summaries: [], now: Date.parse('2026-10-07T12:00:00Z'), ...change });
  };
  it('is the same list of the same rows when nothing changed, and the same rows for an equal rebuild of every nested value', () => {
    const session = immutable(demoSession()), first = build(session);
    const again = build(session, { previous: first.rows });
    expect(again.rows).toBe(first.rows);
    // A new minute, new empty sets: every row is rebuilt equal, and kept.
    expect(build(session, { previous: first.rows, now: Date.parse('2026-10-07T12:01:00Z'), later: new Set(), collapsedTopics: new Set() }).rows).toBe(first.rows);
  });
  it('replaces only the rows a selection changes: the selected row and the rows its thread runs down', () => {
    const session = immutable(demoSession()), first = build(session);
    const selected = build(session, { previous: first.rows, selectedId: '3' }).rows;
    const changed = selected.filter((value, at) => value !== first.rows[at]).map(value => value.key);
    expect(changed).toContain('3');
    expect(changed).not.toContain('8');
    expect(changed.length).toBeLessThan(selected.length);
  });
  it('replaces a row whose item is a new object, even with the same values, and keeps a strip that is equal by value', () => {
    const session = immutable(demoSession()), first = build(session);
    const copy = immutable(structuredClone(demoSession()));
    const next = build(copy, { previous: first.rows }).rows;
    expect(next.filter(value => value.kind === 'item').every(value => !first.rows.includes(value))).toBe(true);
    expect(sameRow(first.rows[0]!, { ...first.rows[0]! })).toBe(true);
    const strip: Row = { kind: 'strip', key: 's', reason: 'removed', topicId: 't', parent: null, depth: 1, count: 1, waiting: 0, expanded: false, guides: [], boxes: [],
      branch: null, delivery: null, place: { reason: 'removed', topicId: 't', itemId: 'i', parent: null, order: 1, name: 'n', count: 1, covers: ['i'] } };
    expect(reuseRows([strip], [structuredClone(strip)])[0]).toBe(strip);
    expect(reuseRows([strip], [{ ...strip, place: { ...strip.place!, covers: ['i', 'j'] } }])[0]).not.toBe(strip);
  });
  it.each([
    ['Dates', () => new Date(1), () => new Date(2)],
    ['Sets', () => new Set(['a']), () => new Set(['b'])],
    ['Maps', () => new Map([['a', 1]]), () => new Map([['a', 2]])],
  ] as const)('is not the same for a field holding two different %s, and is the same for the same instance (alpha.26 R2)', (_name, make, other) => {
    const base = build(immutable(demoSession())).rows[0]!, value = make();
    const withField = (field: unknown) => ({ ...base, extra: field }) as unknown as Row;
    expect(sameRow(withField(value), withField(other()))).toBe(false);
    expect(sameRow(withField(value), withField(value))).toBe(true);
    // The same holds one level down, inside a plain object or an array.
    expect(sameRow(withField({ inner: value }), withField({ inner: other() }))).toBe(false);
    expect(sameRow(withField([value]), withField([other()]))).toBe(false);
    expect(sameRow(withField({ inner: value }), withField({ inner: value }))).toBe(true);
  });
  it('still compares plain objects, null-prototype objects and arrays by their members', () => {
    const base = build(immutable(demoSession())).rows[0]!;
    const withField = (field: unknown) => ({ ...base, extra: field }) as unknown as Row;
    const bare = (entries: Record<string, unknown>) => Object.assign(Object.create(null) as Record<string, unknown>, entries);
    expect(sameRow(withField({ a: [1, 2] }), withField({ a: [1, 2] }))).toBe(true);
    expect(sameRow(withField({ a: [1, 2] }), withField({ a: [1, 3] }))).toBe(false);
    expect(sameRow(withField(bare({ a: 1 })), withField(bare({ a: 1 })))).toBe(true);
    expect(sameRow(withField(bare({ a: 1 })), withField(bare({ a: 2 })))).toBe(false);
    expect(sameRow(withField(bare({ a: 1 })), withField({ a: 1 }))).toBe(true);
  });
});

describe('a row acts on what it shows now', () => {
  it('Hide then Unhide on the same row: the second press unhides it', async () => {
    const { transport, navigation, rerender } = await mount();
    const hidden = () => transport.preferences.sessions.find(view => view.session.session_id === route.session_id)!.hidden_item_ids ?? [];
    // The row asks the App, which flips what the saved view holds (App `toggleHidden`); this stands in for it.
    rerender({ onAct: (intent, target) => {
      if (intent === 'hide') void navigation.setHidden(target, !hidden().includes(target.item_id), navigation.getSnapshot().preferences!.revision);
    } });
    fireEvent.click(within(row('4')).getByRole('button', { name: 'Hide (x)' }));
    await waitFor(() => expect(hidden()).toContain('4'));
    // The hidden strip opens, and the row is back with its Unhide.
    await waitFor(() => expect(screen.getByRole('treeitem', { name: /hidden/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('treeitem', { name: /hidden/i }));
    const unhide = await waitFor(() => within(row('4')).getByRole('button', { name: 'Unhide (x)' }));
    fireEvent.click(unhide);
    await waitFor(() => expect(hidden()).not.toContain('4'));
    await waitFor(() => expect(within(row('4')).getByRole('button', { name: 'Hide (x)' })).toBeTruthy());
  });

  it('a fold takes the children away, and the unfold brings them back', async () => {
    await mount();
    expect(shownRows()).toContain('1.1');
    fireEvent.click(within(row('1')).getByRole('button', { name: 'Expand or collapse' }));
    await waitFor(() => expect(shownRows()).not.toContain('1.1'));
    expect(row('1').getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(within(row('1')).getByRole('button', { name: 'Expand or collapse' }));
    await waitFor(() => expect(shownRows()).toContain('1.1'));
  });
});
