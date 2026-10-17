// Search in place (SPEC §5.8 8.1, §6.9): searching highlights matches and steps between them. It never hides a row, never
// selects, never marks an item seen and never saves a fold. One table row per search trigger, each checked against the
// same promises over the real navigation, session and action stores.
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createDesktopService } from '../../../src/data/service';
import type { RevealedItem } from '../../../src/data/routes';
import { NavigationStore } from '../../../src/state/navigation/store';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { SessionActionControllers } from '../../../src/components/bindings/actions';
import { TreeView } from '../../../src/ui/tree/TreeView';
import { shimTree } from './shimTree';
import { useMapSearch, type MapSearch, type MapSearchStatus } from '../../../src/ui/tree/mapSearch';
import { notices } from '../../../src/ui/pages/notices';
import { immutable } from '../../../src/data';
import { AppTransport, route } from '../app/transport';

const stores: NavigationStore[] = [];
afterEach(() => { cleanup(); stores.splice(0).forEach(store => store.stop()); notices.clear(); vi.restoreAllMocks(); });
const now = () => Date.parse('2026-10-07T12:00:00Z');
const ids = () => [...document.querySelectorAll('[role="treeitem"][data-row]')].map(element => element.getAttribute('data-row')!);
const patches = (transport: AppTransport) => transport.mutations.filter(request => request.command.command === 'preferences_patch');

/** Item 1 is folded (its child 1.1 sits inside it) and item 4 is hidden; everything else shows. */
function configure(transport: AppTransport) {
  const view = transport.preferences.sessions.find(value => value.session.session_id === route.session_id)!;
  view.expanded_item_ids = ['2', '3'];
  view.hidden_item_ids = ['4'];
  view.tab_open = true;
}

async function mount() {
  const transport = new AppTransport();
  configure(transport);
  const service = createDesktopService(transport), navigation = new NavigationStore(service); stores.push(navigation);
  await navigation.start();
  const store = navigation.opened.open(route);
  await store.refresh();
  const actions = new SessionActionControllers(service).forSession(store), drafts = new OwnerDraftStore(service);
  const selected: RevealedItem[] = [], seen = vi.spyOn(navigation, 'markItemSeen');
  let status: MapSearchStatus | null = null, search: MapSearch | null = null;
  // The notices render inside the Map, under the search provider the Graph reads too.
  function Probe() { search = useMapSearch(); return null; }
  function Harness({ query }: { readonly query: string }) {
    const [selectedId, setSelectedId] = useState<string | null>(null);
    return <TreeView navigation={navigation} store={store} actions={actions} drafts={drafts} query={query} reveal={null} selectedId={selectedId}
      detailOpen={false} summaries={[]} now={now} notices={<Probe />}
      onSearchStatus={value => { status = value; }}
      onSelected={result => { selected.push(result); if (result.kind === 'item') setSelectedId(result.route.item_id); }}
      onDismissReveal={() => {}} onResume={() => {}} onAct={() => {}} onClearFilters={() => {}} onShowArchive={() => {}} onRemove={() => {}} />;
  }
  const view = render(<Harness query="" />);
  return { transport, selected, seen, status: () => status, search: () => search, type: (query: string) => view.rerender(<Harness query={query} />) };
}

type Mounted = Awaited<ReturnType<typeof mount>>;
// Each trigger runs from the plain Map; `before` reaches its starting point (not measured).
const triggers: ReadonlyArray<readonly [name: string, before: (tree: Mounted) => void, trigger: (tree: Mounted) => void]> = [
  ['typing a word that matches a visible and a folded item', () => {}, tree => tree.type('receipt')],
  ['typing a word that matches a visible and a hidden item', () => {}, tree => tree.type('retry')],
  ['typing a word that matches nothing', () => {}, tree => tree.type('zzz')],
  ['typing a word that matches outcomes', () => {}, tree => tree.type('decision')],
  ['stepping to the next match', tree => tree.type('decision'), tree => act(() => tree.status()!.onNext())],
  ['stepping back past the first match', tree => tree.type('decision'), tree => act(() => tree.status()!.onPrev())],
  ['Show them', tree => tree.type('receipt'), tree => act(() => tree.status()!.note!.onAction())],
  ['clearing the search after Show them', tree => { tree.type('receipt'); act(() => tree.status()!.note!.onAction()); }, tree => tree.type('')],
];

describe('search in place', () => {
  it.each(triggers)('%s hides no row, selects nothing, marks nothing seen and saves no fold', async (_name, before, trigger) => {
    const tree = await mount();
    before(tree);
    const rows = ids(), writes = patches(tree.transport).length;
    trigger(tree);
    // Only "Show them" adds rows, and clearing takes back only the rows it added (1.1 and 4).
    for (const id of rows) if (!['1.1', '4'].includes(id)) expect(ids()).toContain(id);
    expect(ids()).toEqual(expect.arrayContaining(['1', '2', '3', '5', '6', '7', '8']));
    expect(tree.selected).toEqual([]);
    expect(tree.seen).not.toHaveBeenCalled();
    expect(patches(tree.transport)).toHaveLength(writes);
    expect(document.querySelector('.tree-no-match')).toBeNull();
    expect(document.querySelector('[aria-selected="true"]')).toBeNull();
  });

  it('counts visible matches field by field in Map order and names the rest in the note', async () => {
    const tree = await mount();
    tree.type('decision');
    // "Recorded final decision." is the outcome of 1, 5 and 6.
    expect(tree.status()!.count).toBe('1 of 3');
    expect(tree.search()!.matches).toEqual([{ id: '1', field: 'outcome' }, { id: '5', field: 'outcome' }, { id: '6', field: 'outcome' }]);
    expect(tree.search()!.current).toEqual({ id: '1', field: 'outcome' });
    expect(tree.search()!.stepped).toBe(0);
    act(() => tree.status()!.onNext());
    expect(tree.status()!.count).toBe('2 of 3');
    expect(tree.search()!.current).toEqual({ id: '5', field: 'outcome' });
    expect(tree.search()!.stepped).toBe(1);
    act(() => tree.status()!.onPrev()); act(() => tree.status()!.onPrev());
    expect(tree.status()!.count).toBe('3 of 3');
    // Typing starts again at the first match.
    tree.type('receipt');
    expect(tree.status()!.count).toBe('1 of 1');
    expect(tree.search()!.ids).toEqual(new Set(['3']));
    expect(tree.status()!.note).toMatchObject({ text: 'Also matching: 1 inside a collapsed item.', action: 'Show them' });
    // 7's outcome is not on its row (a replaced item shows what replaced it), so only its question counts.
    tree.type('retry');
    expect(tree.status()!.count).toBe('1 of 1');
    expect(tree.status()!.note?.text).toBe('Also matching: 1 in a hidden item.');
    tree.type('zzz');
    expect(tree.status()!.count).toBe('No matches');
    expect(tree.status()!.note).toBeNull();
  });

  it('shows folded and hidden matches without saving a fold, and hides them again when the search clears', async () => {
    const tree = await mount();
    tree.type('receipt');
    act(() => tree.status()!.note!.onAction());
    expect(ids()).toContain('1.1');
    // The current match stays the one the owner had.
    expect(tree.status()!.count).toBe('2 of 2');
    expect(tree.status()!.note).toBeNull();
    tree.type('retry');
    act(() => tree.status()!.note!.onAction());
    expect(ids()).toContain('4');
    tree.type('');
    expect(ids()).not.toContain('1.1');
    expect(ids()).not.toContain('4');
    expect(patches(tree.transport)).toHaveLength(0);
    expect(tree.status()).toBeNull();
  });

  it('marks the current match apart from the other matches', async () => {
    const tree = await mount();
    tree.type('decision');
    const hits = () => [...document.querySelectorAll('.tree-hit')].map(hit => [hit.closest('[data-row]')!.getAttribute('data-row'), hit.hasAttribute('data-current')]);
    expect(hits()).toEqual([['1', true], ['5', false], ['6', false]]);
    act(() => tree.status()!.onNext());
    expect(hits()).toEqual([['1', false], ['5', true], ['6', false]]);
  });
});

describe('the model under a search', () => {
  it('builds the same rows with and without a search', () => {
    const transport = new AppTransport();
    configure(transport);
    const session = immutable(transport.sessions.get(route.session_id)!);
    const view = immutable(transport.preferences.sessions.find(value => value.session.session_id === route.session_id)!);
    const model = (search: string) => shimTree({ session, view, search, later: new Set(), collapsedTopics: new Set(), selectedId: null, revealId: null,
      temporaryExpanded: [], presence: null, summaries: [], now: now() });
    const keys = (search: string) => model(search).rows.map(row => row.key);
    for (const search of ['receipt', 'decision', 'zzz', 'retry limits']) {
      expect(keys(search)).toEqual(keys(''));
      expect(model(search).filtering).toBe(false);
      expect(model(search).noMatch).toBe(false);
    }
  });
});
