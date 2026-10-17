// The Paperwhite session tree (ui/tree) over the real navigation, session,
// draft and action stores. The workspace props (reveal, selection, intents) are
// recorded instead of composed; App.test.tsx covers the composed workspace.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { routeWindowKey } from '../../../src/ui/shell/windowKeys';
import type { ItemRoute, SessionPreferences } from '../../../src/generated/core';
import { createDesktopService } from '../../../src/data/service';
import type { RevealedItem } from '../../../src/data/routes';
import { NavigationStore } from '../../../src/state/navigation/store';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { SessionActionControllers } from '../../../src/components/bindings/actions';
import { TreeView, type RowIntent, type TreeViewProps } from '../../../src/ui/tree/TreeView';
import { AppTransport, route } from '../app/transport';
import { HistoryTransport } from '../history-actions/fixture';
import { LinkOpener } from '../../../src/ui/shared/MarkdownText';
import { RecoveryPanel } from '../../../src/components/recovery/RecoveryPanel';
import { Notices, notices } from '../../../src/ui/pages/notices';
import { NavigationGraph } from '../../../src/ui/graph/NavigationGraph';
import { sessionClosedReason } from '../../../src/selectors/sessionClosed';
import { shortLabel } from '../../../src/ui/shared/short';
import { peekNames } from '../../../src/ui/peek/names';
import { RemovalContext, RemovalQueue, UNDO_MS } from '../../../src/ui/remove/queue';
import { removeSubject } from '../../../src/ui/remove/model';
import { ackAllFor } from '../../../src/ui/navigation/ackAllController';
import { SessionRowAction } from '../../../src/ui/pages/SessionRowAction';
import { dispatchIntent } from '../../../src/ui/intents';

const stores: NavigationStore[] = [];
const removals = new Set<RemovalQueue>();
async function disposeTrees() {
  cleanup();
  // Confirmed removals outlive TreeView. Cancel pending fixture work and wait
  // for commands already sending before clearing their notices and timers.
  removals.forEach(queue => queue.pending().forEach(operation => queue.undo(operation)));
  await Promise.all([...removals].map(queue => queue.flush()));
  removals.clear();
  stores.splice(0).forEach(store => store.stop());
  notices.clear();
}
afterEach(async () => {
  await disposeTrees();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  if (vi.isFakeTimers()) vi.clearAllTimers();
  vi.useRealTimers();
});
const now = () => Date.parse('2026-10-07T12:00:00Z');

interface Recorded {
  selected: RevealedItem[]; acts: [RowIntent, ItemRoute][];
  openedDetail: boolean[];
  dismissed: number; resumed: number; cleared: number; archive: number; removed: number;
}
async function mount({ transport = new AppTransport(), configure, props = {}, load = true, removal = null }: {
  transport?: AppTransport; configure?: (transport: AppTransport) => void; props?: Partial<TreeViewProps>; load?: boolean; removal?: RemovalQueue | null;
} = {}) {
  if (removal) removals.add(removal);
  configure?.(transport);
  transport.preferences.sessions = transport.preferences.sessions.map(view => ({ ...view, tab_open: true }));
  const service = createDesktopService(transport), navigation = new NavigationStore(service); stores.push(navigation);
  await navigation.start();
  const store = navigation.opened.open(route);
  if (load) await store.refresh();
  const actions = new SessionActionControllers(service).forSession(store), drafts = new OwnerDraftStore(service);
  const calls: Recorded = { selected: [], openedDetail: [], acts: [], dismissed: 0, resumed: 0, cleared: 0, archive: 0, removed: 0 };
  const openLink = vi.fn();
  function Harness(extra: Partial<TreeViewProps>) {
    const [selected, setSelected] = useState<string | null>(null);
    return <RemovalContext.Provider value={removal}><LinkOpener.Provider value={openLink}><TreeView navigation={navigation} store={store} actions={actions} drafts={drafts} query="" reveal={null} selectedId={selected}
      detailOpen={false} summaries={[]} now={now}
      onSelected={(result, openDetail = true) => { calls.selected.push(result); calls.openedDetail.push(openDetail); if (result.kind === 'item') setSelected(result.route.item_id); }}
      onDismissReveal={() => { calls.dismissed++; }} onResume={() => { calls.resumed++; }} onAct={(intent, target) => { calls.acts.push([intent, target]); }}
      onClearFilters={() => { calls.cleared++; }} onShowArchive={() => { calls.archive++; }}
      onRemove={() => { calls.removed++; }} {...props} {...extra} /></LinkOpener.Provider></RemovalContext.Provider>;
  }
  const view = render(<Harness />);
  return { transport, navigation, store, actions, drafts, calls, openLink, rerender: (extra: Partial<TreeViewProps>) => view.rerender(<Harness {...extra} />) };
}
const row = (id: string) => document.querySelector<HTMLElement>(`[role="treeitem"][data-item-id="${id}"]`)!;
const topicRow = (name: string) => screen.getByRole('treeitem', { name });
const ids = () => [...document.querySelectorAll('[role="treeitem"][data-item-id]')].map(element => element.getAttribute('data-item-id'));
const viewOf = (transport: AppTransport) => transport.preferences.sessions.find(value => value.session.session_id === route.session_id)!;
const patches = (transport: AppTransport) => transport.mutations.filter(request => request.command.command === 'preferences_patch');
// The chip row (SPEC §6.10) sits above the Map: one toggle button per status, "<label> <count>", and a Clear while any is picked.
const filterRow = () => screen.getByRole('group', { name: 'Filter items' });
const chip = (label: string) => within(filterRow()).getByRole('button', { name: new RegExp(`^${label}\\s*\\d+$`) });
const chipShown = (label: string) => within(filterRow()).queryByRole('button', { name: new RegExp(`^${label}\\s*\\d+$`) }) !== null;
const chipPicked = (label: string) => chip(label).getAttribute('aria-pressed') === 'true';
const chipCount = (label: string) => Number(chip(label).getAttribute('aria-label')!.replace(`${label} `, ''));
const clearChips = () => fireEvent.click(within(filterRow()).getByRole('button', { name: 'Clear' }));
// The tree has no session menu any more (SPEC §2.1): a session is renamed from its All sessions row, which mounts
// SessionRowAction on the session's own actions. These tests mount that same action beside the tree.
function RenameHost({ actions }: { readonly actions: ReturnType<SessionActionControllers['forSession']> }) {
  const [open, setOpen] = useState(true);
  return open ? <SessionRowAction actions={actions} act="rename" naming={{ name: '', description: '', unnamedAs: 'demo.local · iTerm window 1' }}
    onDone={() => setOpen(false)} /> : null;
}
function CloseHost({ actions }: { readonly actions: ReturnType<SessionActionControllers['forSession']> }) {
  return <SessionRowAction actions={actions} act="close" onDone={() => {}} />;
}
// `.` (SPEC 6.1) is Back to the selected item; the key asks the Map for this intent. (⌘J, which also worked
// inside text fields, is gone: single-letter keys never act while a text box has focus.)
const backToSelected = () => { act(() => { dispatchIntent('map.backToSelected'); }); };
// The Back-to pill (SPEC §5.8): "↑/↓ Back to “name” ." floats over the Map, by the edge the selected row went past.
const BACK = /^Back to “/;
const backPill = (edge: 'above' | 'below') => {
  const pill = screen.getByRole('button', { name: BACK });
  expect(pill.getAttribute('data-edge')).toBe(edge);
  return pill;
};
const noBackPill = () => expect(screen.queryByRole('button', { name: BACK })).toBeNull();
const startRename = (actions: ReturnType<SessionActionControllers['forSession']>) => render(<RenameHost actions={actions} />);
const renameDialog = () => screen.getByRole('dialog', { name: 'Name this session' });
// While it saves the button reads "Saving…" and is disabled, so a second press cannot send twice.
const saveName = () => within(renameDialog()).getByRole('button', { name: /^(Save name|Saving…)/ });
const cancelName = () => within(renameDialog()).getByRole('button', { name: /^Cancel/ });
async function staleTree(value: Awaited<ReturnType<typeof mount>>) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const invoke = value.transport.invoke.bind(value.transport);
  const spy = vi.spyOn(value.transport, 'invoke').mockImplementation(async (name, args) => {
    if (name === 'session_get') await gate;
    return invoke(name, args);
  });
  const session = value.transport.sessions.get(route.session_id)!;
  ++session.revision;
  act(() => { value.transport.emit('ariadne://session_changed', { session_id: route.session_id, revision: session.revision }); });
  expect(value.store.getSnapshot().status).toBe('stale');
  return { release, spy, session };
}

describe('session tree rows', () => {
  it('preserves Focus before a cold session refresh and again after restart', async () => {
    const transport = new AppTransport(); viewOf(transport).focused_item_id = '1';
    for (let opening = 0; opening < 2; opening++) {
      const view = await mount({ transport, load: false });
      expect(view.store.getSnapshot().snapshot).toBeNull();
      await act(async () => {});
      expect(viewOf(transport).focused_item_id).toBe('1');
      await act(async () => { await view.store.refresh(); });
      expect(ids()).toEqual(['1', '1.1']);
      expect(viewOf(transport).focused_item_id).toBe('1');
      cleanup(); view.navigation.stop();
    }
  });

  it('keeps a sticky Focus exit before the cold session has loaded', async () => {
    const view = await mount({ load: false, configure: transport => { viewOf(transport).focused_item_id = '1'; } });
    expect(view.store.getSnapshot().snapshot).toBeNull();
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Map ancestors' })).getByRole('button', { name: 'Unfocus 1' }));
    await waitFor(() => expect(viewOf(view.transport).focused_item_id).toBeUndefined());
    await act(async () => { await view.store.refresh(); });
    expect(viewOf(view.transport).focused_item_id).toBeUndefined();
  });

  it('preserves Focus through pending root removal and Undo', async () => {
    const transport = new AppTransport(); viewOf(transport).focused_item_id = '1';
    const session = transport.sessions.get(route.session_id)!;
    const removal = new RemovalQueue({ service: createDesktopService(transport), notices, read: async () => session });
    await mount({ transport, removal });
    const target = { kind: 'item' as const, item: { ...route, item_id: '1' } };
    let operation = '';
    act(() => { operation = removal.schedule(target, removeSubject(session, target)!); });
    expect(row('1')).toBeNull();
    await act(async () => {});
    expect(viewOf(transport).focused_item_id).toBe('1');
    act(() => { removal.undo(operation); });
    expect(ids()).toEqual(['1', '1.1']);
    expect(viewOf(transport).focused_item_id).toBe('1');
  });

  it('excludes pending removal from Ack all, restores its count on Undo and acknowledges only the visible finding', async () => {
    const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
    Object.values(session.items).forEach(item => { if (item) item.ack_to = null; });
    for (const id of ['1', '2']) Object.assign(session.items[id]!, {
      type: 'finding', parent: null, topic_id: session.items['1']!.topic_id,
      status: 'open', ack_to: 'done', ask: null, question: id === '1' ? 'Finding A' : 'Finding B',
    });
    const removal = new RemovalQueue({ service: createDesktopService(transport), notices, read: async () => session });
    const value = await mount({ transport, removal });
    vi.useFakeTimers();
    const target = { kind: 'item' as const, item: { ...route, item_id: '1' } };
    let operation = '';
    expect(screen.getByRole('button', { name: 'Ack all (2)' })).toBeTruthy();
    act(() => { operation = removal.schedule(target, removeSubject(session, target)!); });
    expect(row('1')).toBeNull(); expect(row('2')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ack all (1)' })).toBeTruthy();
    expect(screen.queryByText(/to ack one by one/)).toBeNull();
    act(() => { removal.undo(operation); });
    expect(row('1')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ack all (2)' })).toBeTruthy();
    act(() => { operation = removal.schedule(target, removeSubject(session, target)!); });
    const execute = vi.spyOn(value.actions, 'execute').mockImplementation(async command => {
      if (command.command !== 'ack') throw new Error('Expected an acknowledgment');
      const item = session.items[command.params.item_id]!;
      item.status = item.ack_to!; item.ack_to = null; item.revision++; session.revision++;
      await value.store.refresh(true);
      return true;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ack all (1)' }));
    expect(screen.getByRole('heading', { name: /Ack 1 results/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ack all' }));
    await act(async () => { await ackAllFor(value.actions).flush(); });
    expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ command: 'ack', params: {
      item_id: '2', expected_revision: session.items['2']!.revision - 1,
    } }), session.revision - 1);
    expect(session.items['1']).toMatchObject({ status: 'open', ack_to: 'done' });
    expect(session.items['2']).toMatchObject({ status: 'done', ack_to: null });
    act(() => { removal.undo(operation); });
  });

  it('uses shared active-item names for Selected, breadcrumbs and Focus', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = document.querySelector<HTMLElement>('.tree-scroll');
      if (this === box) return new DOMRect(0, 0, 300, 400);
      if (this.matches('.tree-topic')) return new DOMRect(0, 0, 300, 60);
      const id = this.getAttribute('data-item-id');
      return id && this.getAttribute('role') === 'treeitem' ? new DOMRect(0, ids().indexOf(id) * 200 - (box?.scrollTop ?? 0), 300, 100) : new DOMRect();
    });
    const view = await mount({ configure: transport => {
      const session = transport.sessions.get(route.session_id)!;
      session.items['1']!.short = 'Shared name';
      session.items['8']!.short = 'Shared name'; session.items['8']!.removed_at = session.updated_at;
    }, props: { selectedId: '1' } });
    const name = peekNames(view.store.getSnapshot().snapshot!.session).get('1')!;
    expect(name).toBe('Shared name');
    fireEvent.click(within(row('1')).getByRole('button', { name: `Focus on ${name}` }));
    // One place to leave: the focused item's own button, which has taken over from Focus. No banner.
    expect(screen.queryByText(/^Focused:/)).toBeNull();
    expect(within(row('1')).getByRole('button', { name: `Unfocus ${name}` }).textContent).toBe('Unfocus');
    expect(within(row('1')).queryByRole('button', { name: /^Focus on / })).toBeNull();
    const box = document.querySelector<HTMLElement>('.tree-scroll')!; box.scrollTop = 100; fireEvent.scroll(box);
    expect(backPill('above').querySelector('.tree-back-label')!.textContent).toBe(`Back to “${name}”`);
    const crumbs = within(screen.getByRole('navigation', { name: 'Map ancestors' }));
    expect(crumbs.getByRole('button', { name }).textContent).toBe(name);
    // Scrolled under the sticky band, the focused item's sticky copy carries Unfocus too.
    expect(crumbs.getByRole('button', { name: `Unfocus ${name}` }).textContent).toBe('Unfocus');
  });

  it('keeps Focus discoverable without a tab stop on every top-level row', async () => {
    await mount();
    for (const button of screen.getAllByRole('button', { name: /^Focus on / })) expect(button.tabIndex).toBe(-1);
    expect(within(row('1')).getByRole('button', { name: /^Focus on / }).textContent).toBe('Focus');
  });

  it('updates Recent Changed only immediately while a seen save is still pending', async () => {
    const view = await mount({ configure: transport => {
      const session = transport.sessions.get(route.session_id)!;
      const baseline = '2026-10-01T00:00:00.000Z';
      session.items['1.1']!.created_at = '2026-10-13T00:00:00.000Z';
      transport.preferences.seen = [{ session: route, since: baseline, items: [], topics: [] }];
      viewOf(transport).recent_items = [{ item_id: '1.1', action: 'viewed', visited_at: '2026-10-13T01:00:00.000Z' }];
    } });
    let release!: () => void, entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; }), invoke = view.transport.invoke.bind(view.transport);
    vi.spyOn(view.transport, 'invoke').mockImplementation(async (name, args) => {
      if ('command' in args.request && args.request.command.command === 'preferences_patch'
        && args.request.command.params.entries.some(entry => entry.kind === 'mark_seen')) { entered = true; await gate; }
      return invoke(name, args);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recent' }));
    const dialog = screen.getByRole('dialog', { name: 'Recent items' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Changed only' }));
    expect(within(dialog).getByRole('button', { name: / · viewed/ })).toBeTruthy();
    act(() => { view.navigation.markItemSeen(route, '1.1'); });
    expect(within(dialog).getByText('No changed items in your recent visits.')).toBeTruthy();
    await waitFor(() => expect(entered).toBe(true));
    expect(view.transport.preferences.seen![0]!.items).toEqual([]);
    await act(async () => { release(); await gate; });
  });
  it('enters Focus by visible action, remembers it on remount, and leaves by the same button, now reading Unfocus', async () => {
    const view = await mount();
    fireEvent.click(within(row('1')).getByRole('button', { name: /^Focus on /  }));
    await waitFor(() => expect(viewOf(view.transport).focused_item_id).toBe('1'));
    expect(ids()).toEqual(['1', '1.1']);
    const label = shortLabel(view.transport.sessions.get(route.session_id)!.items['1']!);
    expect(screen.queryByText(/^Focused:/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Leave Focus' })).toBeNull();
    cleanup(); await mount({ transport: view.transport });
    expect(ids()).toEqual(['1', '1.1']);
    const leave = within(row('1')).getByRole('button', { name: `Unfocus ${label}` });
    expect(leave.textContent).toBe('Unfocus');
    expect(leave.tabIndex).toBe(-1);
    fireEvent.click(leave);
    await waitFor(() => expect(viewOf(view.transport).focused_item_id).toBeUndefined());
    expect(ids()).toContain('8');
    expect(within(row('1')).getByRole('button', { name: /^Focus on / }).textContent).toBe('Focus');
  });

  it('leaves Focus by double click on the focused item’s icon', async () => {
    const view = await mount();
    fireEvent.doubleClick(row('1').querySelector('.tree-icon')!);
    await waitFor(() => expect(viewOf(view.transport).focused_item_id).toBe('1'));
    fireEvent.doubleClick(row('1').querySelector('.tree-icon')!);
    await waitFor(() => expect(viewOf(view.transport).focused_item_id).toBeUndefined());
    expect(ids()).toContain('8');
  });

  it.each(['row Unfocus button', 'disabled item icon', 'sticky Unfocus button'] as const)('ignores the %s while the view is busy', async control => {
    const view = await mount({ configure: transport => { viewOf(transport).focused_item_id = '1'; } });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), invoke = view.transport.invoke.bind(view.transport);
    vi.spyOn(view.transport, 'invoke').mockImplementation(async (name, args) => {
      if (name === 'preferences_patch') await gate;
      return invoke(name, args);
    });
    let saving!: Promise<boolean>;
    act(() => { saving = view.navigation.saveSessionView(structuredClone(viewOf(view.transport)), view.transport.preferences.revision); });
    await waitFor(() => expect(view.navigation.getSnapshot().writing).toBe(true));
    expect(view.navigation.isWritingRecent()).toBe(false);
    const leave = control === 'sticky Unfocus button' ? within(screen.getByRole('navigation', { name: 'Map ancestors' })).getByRole('button', { name: /^Unfocus / })
      : within(row('1')).getByRole('button', { name: /^Unfocus / });
    expect((leave as HTMLButtonElement).disabled).toBe(true);
    if (control === 'disabled item icon') fireEvent.doubleClick(row('1').querySelector('.tree-icon')!); else fireEvent.click(leave);
    expect(within(row('1')).getByRole('button', { name: /^Unfocus / })).toBeTruthy();
    await act(async () => { release(); await saving; });
    expect(viewOf(view.transport).focused_item_id).toBe('1');
    expect(within(row('1')).getByRole('button', { name: /^Unfocus / })).toBeTruthy();
  });

  it.each(['row', 'icon', 'sticky'] as const)('allows %s Unfocus through a busy automatic Recent save', async control => {
    const view = await mount({ configure: transport => { viewOf(transport).focused_item_id = '1'; } });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), invoke = view.transport.invoke.bind(view.transport);
    vi.spyOn(view.transport, 'invoke').mockImplementation(async (name, args) => {
      if (name === 'preferences_patch') await gate;
      return invoke(name, args);
    });
    let saving!: Promise<boolean>;
    act(() => { saving = view.navigation.saveRecentItems(route, [{ item_id: '1', action: 'peeked', visited_at: '2026-10-13T12:00:00.000Z' }], view.transport.preferences.revision); });
    await waitFor(() => expect(view.navigation.isWritingRecent()).toBe(true));
    expect(view.navigation.getSnapshot().writing).toBe(true);
    const leave = control === 'sticky' ? within(screen.getByRole('navigation', { name: 'Map ancestors' })).getByRole('button', { name: /^Unfocus / })
      : within(row('1')).getByRole('button', { name: /^Unfocus / });
    expect((leave as HTMLButtonElement).disabled).toBe(false);
    if (control === 'icon') fireEvent.doubleClick(row('1').querySelector('.tree-icon')!); else fireEvent.click(leave);
    expect(within(row('1')).queryByRole('button', { name: /^Unfocus / })).toBeNull();
    await act(async () => { release(); await saving; });
    await waitFor(() => expect(viewOf(view.transport).focused_item_id).toBeUndefined());
  });

  it.each(['row Hide', 'detail Hide'] as const)('ends Focus on %s and does not restore it on Unhide', async source => {
    const view = await mount({ configure: transport => { viewOf(transport).focused_item_id = '1'; } });
    if (source === 'row Hide') fireEvent.click(within(row('1')).getByRole('button', { name: 'Hide (h)' }));
    else await act(async () => { await view.navigation.saveSessionView({ ...structuredClone(viewOf(view.transport)), hidden_item_ids: ['1'] }, view.transport.preferences.revision); });
    await waitFor(() => expect(viewOf(view.transport).focused_item_id).toBeUndefined());
    expect(viewOf(view.transport).hidden_item_ids).toContain('1');
    await act(async () => { await view.navigation.saveSessionView({ ...structuredClone(viewOf(view.transport)), hidden_item_ids: [] }, view.transport.preferences.revision); });
    expect(viewOf(view.transport).focused_item_id).toBeUndefined();
    expect(row('1')).toBeTruthy(); expect(row('8')).toBeTruthy();
  });

  it('keeps the focused row and its own Focus exit under a search that matches nothing, since a search unmounts no row', async () => {
    const view = await mount({ configure: transport => { viewOf(transport).focused_item_id = '1'; } });
    const band = within(screen.getByRole('navigation', { name: 'Map ancestors' }));
    view.rerender({ query: 'no matching item anywhere' });
    expect(ids()).toEqual(['1', '1.1']);
    fireEvent.click(within(row('1')).getByRole('button', { name: /^Unfocus / }));
    expect(band.queryByRole('button', { name: /^Unfocus / })).toBeNull();
    await waitFor(() => expect(viewOf(view.transport).focused_item_id).toBeUndefined());
  });

  it.each(['filter', 'folded topic', 'pending removal'] as const)('keeps a sticky Focus exit when %s unmounts the row', async exclusion => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.matches('.tree-scroll')) return new DOMRect(0, 0, 300, 400);
      if (this.matches('.tree-topic')) return new DOMRect(0, 0, 300, 60);
      if (this.matches('.tree-item .tree-focus-action')) return new DOMRect(0, 100, 60, 20);
      return new DOMRect(0, 100, 300, 100);
    });
    const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
    viewOf(transport).focused_item_id = '1';
    const removal = new RemovalQueue({ service: createDesktopService(transport), notices, read: async () => session });
    await mount({ transport, removal });
    const band = within(screen.getByRole('navigation', { name: 'Map ancestors' }));
    expect(within(row('1')).getByRole('button', { name: /^Unfocus / })).toBeTruthy();
    expect(band.queryByRole('button', { name: /^Unfocus / })).toBeNull();
    if (exclusion === 'filter') fireEvent.click(chip('In progress'));
    else if (exclusion === 'folded topic') fireEvent.click(within(topicRow('Delivery decisions')).getByRole('button', { name: 'Expand or collapse topic' }));
    else {
      const target = { kind: 'item' as const, item: { ...route, item_id: '1' } };
      act(() => { removal.schedule(target, removeSubject(session, target)!); });
    }
    expect(row('1')).toBeNull();
    const leave = band.getByRole('button', { name: /^Unfocus / });
    await waitFor(() => expect((leave as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(leave);
    await waitFor(() => expect(viewOf(transport).focused_item_id).toBeUndefined());
  });

  it('ends Focus when hidden ids change for the focused top-level item', async () => {
    const view = await mount({ configure: transport => { viewOf(transport).focused_item_id = '1'; } });
    const session = view.store.getSnapshot().snapshot!.session;
    expect(session.items['1']!.parent).toBeNull();
    expect(viewOf(view.transport).hidden_item_ids ?? []).not.toContain('1');
    expect(within(row('1')).getByRole('button', { name: /^Unfocus / })).toBeTruthy();
    await act(async () => { await view.navigation.saveSessionView({ ...structuredClone(viewOf(view.transport)), hidden_item_ids: ['1'] }, view.transport.preferences.revision); });
    await waitFor(() => expect(viewOf(view.transport).focused_item_id).toBeUndefined());
    expect(viewOf(view.transport).hidden_item_ids).toContain('1');
    expect(view.store.getSnapshot().snapshot!.session).toBe(session);
    await act(async () => { await view.navigation.saveSessionView({ ...structuredClone(viewOf(view.transport)), hidden_item_ids: [] }, view.transport.preferences.revision); });
    expect(viewOf(view.transport).focused_item_id).toBeUndefined();
    expect(row('1')).toBeTruthy();
  });

  it.each(['above', 'below'] as const)('keeps a sticky Focus exit when its button is %s the viewport', async edge => {
    let buttonTop = 100;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.matches('.tree-scroll')) return new DOMRect(0, 0, 300, 400);
      if (this.matches('.tree-topic')) return new DOMRect(0, 0, 300, 60);
      if (this.matches('.tree-item .tree-focus-action')) return new DOMRect(0, buttonTop, 60, 20);
      return new DOMRect(0, 100, 300, 100);
    });
    const view = await mount({ configure: transport => { viewOf(transport).focused_item_id = '1'; } });
    const band = within(screen.getByRole('navigation', { name: 'Map ancestors' }));
    expect(band.queryByRole('button', { name: /^Unfocus / })).toBeNull();
    buttonTop = edge === 'above' ? 40 : 450;
    fireEvent.scroll(document.querySelector('.tree-scroll')!);
    fireEvent.click(band.getByRole('button', { name: /^Unfocus / }));
    await waitFor(() => expect(viewOf(view.transport).focused_item_id).toBeUndefined());
  });

  it.each(['removed', 'no longer top-level', 'reparented beneath a hidden ancestor'] as const)('ends invalid Focus when the item is %s', async invalid => {
    const view = await mount({ configure: transport => { viewOf(transport).focused_item_id = '1'; } });
    if (invalid === 'reparented beneath a hidden ancestor') await act(async () => { await view.navigation.saveSessionView({ ...structuredClone(viewOf(view.transport)), hidden_item_ids: ['2'] }, view.transport.preferences.revision); });
    expect(viewOf(view.transport).focused_item_id).toBe('1');
    const session = view.transport.sessions.get(route.session_id)!;
    if (invalid === 'removed') session.items['1']!.removed_at = session.updated_at;
    else session.items['1']!.parent = '2';
    session.revision++;
    await act(async () => { await view.store.refresh(true); });
    await waitFor(() => expect(viewOf(view.transport).focused_item_id).toBeUndefined());
    if (invalid === 'reparented beneath a hidden ancestor') {
      await act(async () => { await view.navigation.saveSessionView({ ...structuredClone(viewOf(view.transport)), hidden_item_ids: [] }, view.transport.preferences.revision); });
      expect(viewOf(view.transport).focused_item_id).toBeUndefined();
    }
  });

  it('focuses a top-level bullet on double click and focuses the mounted target when an external reveal exits Focus', async () => {
    const view = await mount();
    fireEvent.doubleClick(row('1').querySelector('.tree-icon')!);
    await waitFor(() => expect(viewOf(view.transport).focused_item_id).toBe('1'));
    const target: RevealedItem = { kind: 'item', route: { ...route, item_id: '8' }, store: view.store, temporaryExpandedItemIds: [] };
    view.rerender({ selectedId: '8', reveal: target });
    await waitFor(() => expect(viewOf(view.transport).focused_item_id).toBeUndefined());
    expect(row('8')).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(row('8')));
  });

  it('expires a Go to focus request after a failed Focus exit and a different selection', async () => {
    const view = await mount();
    fireEvent.doubleClick(row('1').querySelector('.tree-icon')!);
    await waitFor(() => expect(viewOf(view.transport).focused_item_id).toBe('1'));
    const exit = structuredClone(viewOf(view.transport));
    delete exit.focused_item_id;
    view.transport.failNext = 'preferences_patch';
    await act(async () => { expect(await view.navigation.saveSessionView(exit, view.transport.preferences.revision)).toBe(false); });
    expect(view.navigation.getSnapshot().pendingOperationId).not.toBeNull();
    const target: RevealedItem = { kind: 'item', route: { ...route, item_id: '8' }, store: view.store, temporaryExpandedItemIds: [] };
    view.rerender({ selectedId: '8', reveal: target });
    expect(viewOf(view.transport).focused_item_id).toBe('1');
    expect(row('8')).toBeNull();
    // A different workspace selection supersedes Go to while its target is still outside Focus.
    view.rerender({ selectedId: '1', reveal: null });
    act(() => { row('1').focus(); });
    expect(document.activeElement).toBe(row('1'));
    // Retrying the failed view save leaves Focus and finally mounts the old Go to target.
    await act(async () => { expect(await view.navigation.retryMutation()).toBe(true); });
    await waitFor(() => expect(viewOf(view.transport).focused_item_id).toBeUndefined());
    expect(row('8')).not.toBeNull();
    expect(row('1').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(row('1'));
  });

  it('keeps newly entered Focus after an earlier external reveal', async () => {
    const view = await mount();
    const target: RevealedItem = { kind: 'item', route: { ...route, item_id: '8' }, store: view.store, temporaryExpandedItemIds: [] };
    view.rerender({ selectedId: '8', reveal: target });
    fireEvent.click(within(row('1')).getByRole('button', { name: /^Focus on /  }));
    await waitFor(() => expect(viewOf(view.transport).focused_item_id).toBe('1'));
    expect(ids()).toEqual(['1', '1.1']);
    expect(backPill('below')).toBeTruthy();
  });

  it('returns Selected keyboard focus after revealing a row outside Focus', async () => {
    const view = await mount({ props: { selectedId: '8' } });
    fireEvent.click(within(row('1')).getByRole('button', { name: /^Focus on /  }));
    await waitFor(() => expect(viewOf(view.transport).focused_item_id).toBe('1'));
    const tag = backPill('below');
    tag.focus(); await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(view.calls.selected.at(-1)).toMatchObject({ kind: 'item', route: { item_id: '8' } }));
    await waitFor(() => expect(document.activeElement).toBe(row('8')));
    expect(viewOf(view.transport).focused_item_id).toBeUndefined();
  });

  it.each(['row', 'Recent', 'Selected'] as const)('keeps a %s navigation request through a held automatic Recent save', async surface => {
    const view = await mount({ props: { selectedId: '8' }, configure: transport => {
      if (surface === 'Selected') viewOf(transport).focused_item_id = '1';
      viewOf(transport).recent_items = [{ item_id: '2', action: 'viewed', visited_at: '2026-10-13T11:00:00.000Z' }];
    } });
    if (surface === 'Selected') await waitFor(() => expect(view.calls.selected).toHaveLength(1));
    let release!: () => void, entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; }), invoke = view.transport.invoke.bind(view.transport);
    vi.spyOn(view.transport, 'invoke').mockImplementation(async (name, args) => {
      if ('command' in args.request && args.request.command.command === 'preferences_patch'
        && args.request.command.params.entries.some(entry => entry.kind === 'set_session_view' && entry.preferences.recent_items?.[0]?.item_id === '1')) {
        entered = true; await gate;
      }
      return invoke(name, args);
    });
    const selectionsBefore = view.calls.selected.length;
    const saving = view.navigation.saveRecentItems(route, [{ item_id: '1', action: 'peeked', visited_at: '2026-10-13T12:00:00.000Z' }], view.transport.preferences.revision);
    await waitFor(() => expect(entered).toBe(true));
    expect(view.navigation.isWritingRecent()).toBe(true);
    if (surface === 'row') fireEvent.click(row('3'));
    else if (surface === 'Recent') {
      fireEvent.click(screen.getByRole('button', { name: 'Recent' }));
      fireEvent.click(within(screen.getByRole('dialog', { name: 'Recent items' })).getByRole('button', { name: / · viewed/ }));
    } else {
      const tag = backPill('below');
      tag.focus(); await userEvent.keyboard('{Enter}');
    }
    expect(view.calls.selected).toHaveLength(selectionsBefore);
    await act(async () => { release(); await saving; });
    if (surface === 'Selected') {
      await waitFor(() => expect(viewOf(view.transport).focused_item_id).toBeUndefined());
      await waitFor(() => expect(document.activeElement).toBe(row('8')));
    } else await waitFor(() => expect(view.calls.selected.at(-1)).toMatchObject({ kind: 'item', route: { item_id: surface === 'row' ? '3' : '2' } }));
  });

  it('subscribes to font loading once for the whole Map, including after row rerenders', async () => {
    const previous = Object.getOwnPropertyDescriptor(document, 'fonts');
    const fonts = new EventTarget();
    Object.defineProperty(fonts, 'ready', { value: Promise.resolve() });
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
    const add = vi.spyOn(fonts, 'addEventListener'), remove = vi.spyOn(fonts, 'removeEventListener');
    try {
      const view = await mount();
      expect(add.mock.calls.filter(([event]) => event === 'loadingdone')).toHaveLength(1);
      view.rerender({ selectedId: '3' });
      act(() => fonts.dispatchEvent(new Event('loadingdone')));
      expect(add.mock.calls.filter(([event]) => event === 'loadingdone')).toHaveLength(1);
      cleanup();
      expect(remove.mock.calls.filter(([event]) => event === 'loadingdone')).toHaveLength(1);
    } finally {
      if (previous) Object.defineProperty(document, 'fonts', previous); else Reflect.deleteProperty(document, 'fonts');
    }
  });

  it('keeps closed questions in the tree with their status and a quiet chip, excluding waiting counts', async () => {
    const closedSession = (transport: AppTransport) => { transport.sessions.get(route.session_id)!.state = 'closed'; };
    await mount({ configure: closedSession });
    const question = row('2');
    expect(within(question).getByText('Session closed').title).toBe(sessionClosedReason);
    expect(within(question).getByText('Waiting on me')).toBeTruthy();
    expect(screen.queryByText(/\d+ waiting on you/)).toBeNull();
    // Nothing counts as waiting once the session is closed, so the chip has no count to show.
    expect(chipShown('Waiting on me')).toBe(false);
    cleanup();
    // A saved Waiting on me filter still shows its chip, at zero, and matches nothing.
    await mount({ configure: transport => { closedSession(transport); viewOf(transport).filters.statuses = ['waiting_on_me']; } });
    expect(chipCount('Waiting on me')).toBe(0);
    expect(ids()).toEqual([]);
    expect(screen.getByText('No items match these filters.')).toBeTruthy();
  });
  it('counts declarations and backlinks once, with a visible muted marker that keeps its reserved room when selected or hovered', async () => {
    const view = await mount({ configure: transport => {
      const session = transport.sessions.get(route.session_id)!;
      session.items['4']!.related = ['2', '2', 'missing'];
      session.items['8']!.related = ['4'];
    } });
    expect(within(row('4')).getByRole('img', { name: '2 related items' }).textContent).toBe('2');
    expect(within(row('2')).getByRole('img', { name: '1 related item' }).textContent).toBe('1');
    expect(within(row('8')).getByRole('img', { name: '1 related item' }).textContent).toBe('1');
    expect(row('1').querySelector('.tree-related')).toBeNull();
    const css = readFileSync(resolve(__dirname, '../../../src/ui/tree/tree.css'), 'utf8');
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, selector]) => selector!.includes('.tree-related'));
    const rule = rules.find(([, selector]) => selector!.trim().endsWith('.tree-related'))![2];
    expect(rule).toMatch(/display:\s*inline-flex;/);
    expect(rule).toMatch(/opacity:\s*0\.55;/);
    expect(rule).toMatch(/min-width:\s*26px;/);
    const active = rules.find(([, selector]) => selector!.includes('.tree-item:hover'))!;
    expect(active[1]).toContain('.tree-item[aria-selected="true"] .tree-related');
    expect(active[2]!.trim()).toBe('opacity: 1;');
    const style = document.createElement('style'); style.textContent = css; document.head.append(style);
    try {
      const marker = within(row('4')).getByRole('img', { name: '2 related items' });
      const before = getComputedStyle(marker);
      expect(before.opacity).toBe('0.55');
      const reserved = { display: before.display, minWidth: before.minWidth, flex: before.flex, gap: before.gap };
      view.rerender({ selectedId: '4' });
      const selectedStyle = getComputedStyle(marker);
      expect(selectedStyle.opacity).toBe('1');
      expect({ display: selectedStyle.display, minWidth: selectedStyle.minWidth, flex: selectedStyle.flex, gap: selectedStyle.gap }).toEqual(reserved);
    } finally { style.remove(); }
  });

  it.each(['ready', 'failed'] as const)('waits for a stale session rename refresh that becomes %s, then saves or shows the loading error', async result => {
    const transport = new HistoryTransport();
    const { store, actions } = await mount({ transport });
    const execute = vi.spyOn(actions, 'execute');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if (name === 'session_get') {
        await gate;
        if (result === 'failed') throw new Error('Read failed');
      }
      return invoke(name, args);
    });
    ++transport.source.revision;
    act(() => { transport.emit('ariadne://session_changed', { session_id: route.session_id, revision: transport.source.revision }); });
    expect(store.getSnapshot().status).toBe('stale');
    startRename(actions);
    fireEvent.change(within(renameDialog()).getByRole('textbox', { name: 'Name' }), { target: { value: 'Fresh session name' } });
    fireEvent.click(saveName());
    fireEvent.click(saveName());
    expect(transport.mutations.filter(value => value.command.command === 'session_label_set')).toHaveLength(0);
    const revision = transport.source.revision;
    await act(async () => { release(); await store.refresh(); });
    const writes = transport.mutations.filter(value => value.command.command === 'session_label_set');
    if (result === 'failed') {
      expect(writes).toHaveLength(0);
      expect(execute).not.toHaveBeenCalled();
      expect(within(renameDialog()).getByRole('alert').textContent)
        .toBe("Ariadne is still loading this session's latest changes. Try again.");
      expect(screen.getAllByRole('alert')).toHaveLength(1);
      expect((saveName() as HTMLButtonElement).disabled).toBe(false);
      return;
    }
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ command: { params: { name: 'Fresh session name' } } });
    expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ command: 'session_label_set' }), revision);
    expect(screen.queryByRole('dialog', { name: 'Name this session' })).toBeNull();
    // The new name is the session's own (the top bar and the rows read it from there).
    expect(store.getSnapshot().snapshot!.session.name).toBe('Fresh session name');
  });
  it('keeps a rename timeout in the editor and clears it on Cancel without a column banner or late save', async () => {
    const value = await mount({ transport: new HistoryTransport() });
    const { release } = await staleTree(value);
    startRename(value.actions);
    fireEvent.change(within(renameDialog()).getByRole('textbox', { name: 'Name' }), { target: { value: 'Timed out name' } });
    vi.useFakeTimers();
    fireEvent.click(saveName());
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(within(renameDialog()).getByRole('alert').textContent)
      .toBe("Ariadne is still loading this session's latest changes. Try again.");
    fireEvent.click(cancelName());
expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => { release(); await value.store.refresh(); });
    expect(value.transport.mutations.some(request => request.command.command === 'session_label_set')).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('explains an uncertain change that appeared while Rename waited for the ready session', async () => {
    const value = await mount();
    const { release } = await staleTree(value);
    startRename(value.actions);
    fireEvent.change(within(renameDialog()).getByLabelText('Name'), { target: { value: 'Keep this pending name' } });
    fireEvent.click(saveName());
    const state = value.actions.getSnapshot();
    vi.spyOn(value.actions, 'getSnapshot').mockReturnValue({ ...state, pending: { session: route, command: {
      command: 'session_label_set', api_version: 1, op_id: crypto.randomUUID(), params: { name: 'Earlier name', description: null },
    } } });
    await act(async () => { release(); await value.store.refresh(); });
    expect(within(renameDialog()).getByRole('alert').textContent)
      .toBe('Ariadne isn’t sure your last change was saved. Check again before renaming this session.');
    expect(screen.queryByText('Ariadne isn’t sure your last change was saved. Check again before making another change.')).toBeNull();
    expect(value.transport.mutations.some(value => value.command.command === 'session_label_set')).toBe(false);
    expect((within(renameDialog()).getByLabelText('Name') as HTMLInputElement).value).toBe('Keep this pending name');
    fireEvent.click(cancelName());
expect(screen.queryByRole('dialog', { name: 'Name this session' })).toBeNull();
    expect(screen.queryByText('Ariadne isn’t sure your last change was saved. Check again before making another change.')).toBeNull();
  });
  it.each([
    ['not_found', 'Ariadne can’t find that any more. It may have been removed.'],
    ['invalid_argument', 'Something in that isn’t valid. Check it and try again.'],
  ] as const)('uses specific plain words for a %s rename refusal', async (code, words) => {
    const transport = new HistoryTransport(); const { actions } = await mount({ transport });
    transport.replies.push({ api_version: 1, ok: false, error: { code, message: `Rejected ${code}`, hint: 'Internal details', retryable: false, field_errors: [] } });
    startRename(actions);
    fireEvent.change(within(renameDialog()).getByRole('textbox', { name: 'Name' }), { target: { value: 'Refused name' } });
    await act(async () => { fireEvent.click(saveName()); });
    expect(screen.getByRole('alert').textContent).toBe(words);
    expect(screen.getByRole('alert').textContent).not.toContain('loading');
  });
  it('does not leak a pending removal into a later stale selection', async () => {
    vi.useFakeTimers();
    const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
    const removal = new RemovalQueue({ service: createDesktopService(transport), notices, read: async () => session });
    await mount({ transport, removal });
    const target = { kind: 'item' as const, item: { ...route, item_id: '1' } };
    act(() => { removal.schedule(target, removeSubject(session, target)!); });
    expect(removal.pending()).toHaveLength(1);
    // Exercise the same teardown as afterEach, then put its five-second
    // deadline inside the next fixture's successful stale-selection flow.
    await disposeTrees();
    const value = await mount(), { release } = await staleTree(value);
    fireEvent.click(row('3'));
    await act(async () => { release(); await value.store.refresh(); });
    expect(value.calls.selected).toHaveLength(1);
    expect(viewOf(value.transport).selected_item_id).toBe('3');
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS); });
    expect(notices.getSnapshot()).toEqual([]);
    expect(transport.mutations.some(request => request.command.command === 'item_remove')).toBe(false);
    expect(removal.pending()).toEqual([]);
  });

  it('waits for a sending removal before teardown clears its notices and timers', async () => {
    vi.useFakeTimers();
    const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
    const removal = new RemovalQueue({ service: createDesktopService(transport), notices, read: async () => session });
    await mount({ transport, removal });
    let release!: () => void, entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; }), invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('command' in args.request && args.request.command.command === 'item_remove') { entered = true; await gate; }
      return invoke(name, args);
    });
    const target = { kind: 'item' as const, item: { ...route, item_id: '1' } };
    act(() => { removal.schedule(target, removeSubject(session, target)!); });
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS); });
    const sending = removal.flush();
    let disposed = false;
    const disposal = disposeTrees().then(() => { disposed = true; });
    try {
      await act(async () => {});
      expect(entered).toBe(true);
      expect(removal.pending()).toEqual([]);
      expect(disposed).toBe(false);
      expect(notices.getSnapshot()[0]?.text).toContain('Telling demo.local');
      await act(async () => { release(); await sending; await disposal; });
      expect(disposed).toBe(true);
      expect(transport.mutations.filter(request => request.command.command === 'item_remove')).toHaveLength(1);
      expect(notices.getSnapshot()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      // A failed assertion must still release the command before afterEach.
      await act(async () => { release(); await sending; await disposal; });
      notices.clear();
    }
  });

  it.each(['click', 'Enter'] as const)('waits for a stale session before selecting with %s', async method => {
    const value = await mount(), { release } = await staleTree(value);
    expect(row('3').getAttribute('aria-disabled')).toBeNull();
    if (method === 'click') fireEvent.click(row('3'));
    else { row('3').focus(); fireEvent.keyDown(row('3'), { key: 'Enter' }); }
    expect(value.calls.selected).toHaveLength(0);
    await act(async () => { release(); await value.store.refresh(); });
    await waitFor(() => expect(value.calls.selected).toHaveLength(1));
    expect(value.calls.selected[0]).toMatchObject({ kind: 'item', route: { item_id: '3' } });
    await waitFor(() => expect(viewOf(value.transport).selected_item_id).toBe('3'));
    expect(notices.getSnapshot()).toHaveLength(0);
  });
  it.each(['click', 'a'] as const)('lets a stale tree Ack reach the readiness wait with %s', async method => {
    // `a` acts on the selected item, so the item is the selection.
    const value = await mount({ props: { selectedId: '1.1' }, configure: transport => { transport.sessions.get(route.session_id)!.items['1.1']!.ack_to = 'done'; } });
    const execute = vi.spyOn(value.actions, 'execute').mockResolvedValue(true);
    const { release, session } = await staleTree(value);
    const ack = within(row('1.1')).getByRole('button', { name: 'Ack → Done' });
    expect(ack.hasAttribute('disabled')).toBe(false);
    if (method === 'click') fireEvent.click(ack);
    else { row('1.1').focus(); fireEvent.keyDown(row('1.1'), { key: 'a' }); }
    expect(execute).not.toHaveBeenCalled();
    expect(ack.hasAttribute('disabled')).toBe(true);
    await act(async () => { release(); await value.store.refresh(); });
    await waitFor(() => expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ command: 'ack', params: {
      item_id: '1.1', expected_revision: session.items['1.1']!.revision,
    } }), session.revision));
  });
  it('selects only the latest clicked row after a stale refresh', async () => {
    const value = await mount(), { release } = await staleTree(value);
    fireEvent.click(row('3')); fireEvent.click(row('4'));
    await act(async () => { release(); await value.store.refresh(); });
    await waitFor(() => expect(value.calls.selected).toHaveLength(1));
    expect(value.calls.selected[0]).toMatchObject({ kind: 'item', route: { item_id: '4' } });
  });
  it('abandons a stale row selection when the tree leaves the workspace', async () => {
    const value = await mount(), { release } = await staleTree(value);
    fireEvent.click(row('3'));
    cleanup();
    await act(async () => { release(); await value.store.refresh(); });
    expect(value.calls.selected).toHaveLength(0);
    expect(value.transport.queries.some(query => query.request.command === 'reveal_item')).toBe(false);
    expect(notices.getSnapshot()).toHaveLength(0);
  });
  it.each(['stale', 'failed'] as const)('reports a plain selection error when the refresh remains %s', async result => {
    const value = await mount(), { release, spy, session } = await staleTree(value);
    fireEvent.click(row('3'));
    if (result === 'stale') --session.revision;
    else spy.mockRejectedValue(new Error('Read failed'));
    await act(async () => { release(); await value.store.refresh(); });
    await waitFor(() => expect(notices.getSnapshot()[0]?.text)
      .toBe("“Implement receipt lookup” could not be opened. Ariadne is still loading this session's latest changes. Try again."));
    expect(value.calls.selected).toHaveLength(0);
    expect(value.transport.queries.some(query => query.request.command === 'reveal_item')).toBe(false);
  });
  it('bounds stale selection at five seconds and ignores the late refresh', async () => {
    const value = await mount(), { release } = await staleTree(value);
    vi.useFakeTimers();
    fireEvent.click(row('3'));
    await act(async () => { await vi.advanceTimersByTimeAsync(4999); });
    expect(notices.getSnapshot()).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(notices.getSnapshot()[0]?.text).toContain("Ariadne is still loading this session's latest changes. Try again.");
    await act(async () => { release(); await value.store.refresh(); });
    expect(value.calls.selected).toHaveLength(0);
    expect(value.transport.queries.some(query => query.request.command === 'reveal_item')).toBe(false);
  });
  it('renders topic bands and item rows with one roving tab stop and no session bar', async () => {
    await mount();
    expect(screen.getByRole('tree', { name: 'Session items' })).toBeTruthy();
    expect(topicRow('Delivery decisions').getAttribute('aria-level')).toBe('1');
    expect(row('1').getAttribute('aria-level')).toBe('2'); expect(row('1.1').getAttribute('aria-level')).toBe('3');
    expect(ids()).toEqual(['1', '1.1', '2', '3', '4', '5', '6', '7', '8']);
    expect(screen.getAllByRole('treeitem').filter(element => element.tabIndex === 0)).toHaveLength(1);
    // The session's name, run state, Pause and Close moved to the top bar and its connection card (SPEC 2.1, 5.12).
    expect(document.querySelector('.tree-session-title')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Session actions' })).toBeNull();
    expect(chipCount('Open')).toBe(3); expect(chipCount('Done') + chipCount('Decided') + chipCount('Replaced')).toBe(3);
    expect(within(filterRow()).getByText('Pick a status')).toBeTruthy();
    expect(row('1').querySelector('.tree-outcome')).not.toBeNull();
    expect(within(topicRow('Continued context')).getByText(/^Continued from/)).toBeTruthy();
  });
  it('moves focus with the keyboard without writing and selects on Enter or a click', async () => {
    const { transport, calls } = await mount(), writes = patches(transport).length;
    row('1').focus();
    fireEvent.keyDown(row('1'), { key: 'ArrowDown' }); expect(document.activeElement).toBe(row('1.1'));
    fireEvent.keyDown(row('1.1'), { key: 'j' }); expect(document.activeElement).toBe(row('2'));
    fireEvent.keyDown(row('2'), { key: 'k' }); expect(document.activeElement).toBe(row('1.1'));
    fireEvent.keyDown(row('1.1'), { key: 'End' }); expect(document.activeElement).toBe(row('8'));
    fireEvent.keyDown(row('8'), { key: 'Home' }); expect(document.activeElement).toBe(topicRow('Delivery decisions'));
    expect(patches(transport)).toHaveLength(writes); expect(calls.selected).toHaveLength(0);
    row('4').focus(); fireEvent.keyDown(row('4'), { key: 'Enter' });
    await waitFor(() => expect(viewOf(transport).selected_item_id).toBe('4'));
    expect(calls.selected.at(-1)).toMatchObject({ kind: 'item', route: { item_id: '4' } });
    await waitFor(() => expect(row('4').getAttribute('aria-selected')).toBe('true'));
    fireEvent.click(row('3'));
    await waitFor(() => expect(viewOf(transport).selected_item_id).toBe('3'));
  });
  it('folds items through the saved expansion and walks parents with the arrows', async () => {
    const { transport } = await mount();
    fireEvent.click(within(row('1')).getByRole('button', { name: 'Expand or collapse' }));
    await waitFor(() => expect(viewOf(transport).expanded_item_ids).not.toContain('1'));
    expect(ids()).not.toContain('1.1');
    expect(row('1').querySelector('.tree-collapsed')?.textContent).toBe('1 open inside');
    row('1').focus(); fireEvent.keyDown(row('1'), { key: 'ArrowRight' });
    await waitFor(() => expect(ids()).toContain('1.1'));
    expect(viewOf(transport).expanded_item_ids).toContain('1');
    fireEvent.keyDown(row('1'), { key: 'ArrowRight' }); expect(document.activeElement).toBe(row('1.1'));
    fireEvent.keyDown(row('1.1'), { key: 'ArrowLeft' }); expect(document.activeElement).toBe(row('1'));
    fireEvent.keyDown(row('1'), { key: 'ArrowLeft' });
    await waitFor(() => expect(ids()).not.toContain('1.1'));
  });
  it('folds a topic at once, saves the fold with the session view and drops a temporary reveal', async () => {
    const { transport, calls } = await mount();
    const topicId = topicRow('Delivery decisions').getAttribute('data-topic-id')!;
    const band = topicRow('Delivery decisions');
    fireEvent.click(within(band).getByRole('button', { name: 'Expand or collapse topic' }));
    expect(band.getAttribute('aria-expanded')).toBe('false'); expect(ids()).toEqual(['8']);
    expect(calls.dismissed).toBe(1);
    await waitFor(() => expect(viewOf(transport).collapsed_topic_ids).toEqual([topicId]));
    band.focus(); fireEvent.keyDown(band, { key: 'ArrowRight' });
    expect(band.getAttribute('aria-expanded')).toBe('true'); expect(ids()).toHaveLength(9);
    await waitFor(() => expect(viewOf(transport).collapsed_topic_ids ?? []).toEqual([]));
    fireEvent.keyDown(band, { key: 'ArrowLeft' }); expect(band.getAttribute('aria-expanded')).toBe('false');
    await waitFor(() => expect(viewOf(transport).collapsed_topic_ids).toEqual([topicId]));
    // The fold survives reopening the session.
    cleanup();
    await mount({ transport });
    expect(topicRow('Delivery decisions').getAttribute('aria-expanded')).toBe('false'); expect(ids()).toEqual(['8']);
  });
  it('keeps the band of a topic that has no items', async () => {
    await mount({ configure: transport => {
      const session = transport.sessions.get(route.session_id)!, topic = session.items['8']!.topic_id;
      for (const [id, item] of Object.entries(session.items)) if (item?.topic_id === topic) delete session.items[id];
    } });
    expect(topicRow('Continued context')).toBeTruthy();
    expect(topicRow('Delivery decisions')).toBeTruthy();
    expect(screen.queryByText('No items yet')).toBeNull();
  });
  it('offers Archive and Remove on a topic band while its delivery line shows', async () => {
    await mount({ configure: transport => {
      const session = transport.sessions.get(route.session_id)!, topic = session.items['8']!.topic_id;
      const input = Object.values(session.inputs).find(value => value?.target.topic_id === topic)!;
      input.state = 'in_flight'; input.kind = 'topic_reply'; input.target = { topic_id: topic, item_id: null };
    } });
    const band = topicRow('Continued context');
    expect(band.querySelector('.tree-topic-line')).not.toBeNull();
    expect(within(band).getByRole('button', { name: 'Remove' })).toBeTruthy();
    expect(within(band).getByRole('button', { name: 'Archive' })).toBeTruthy();
  });
  const text = 'Keep the retry limits as they are';
  // The first input on item 8's topic becomes a queued reply to the whole topic.
  const queuedReply = (transport: AppTransport) => {
    const session = transport.sessions.get(route.session_id)!, topic = session.items['8']!.topic_id;
    const input = Object.values(session.inputs).find(value => value?.target.topic_id === topic)!;
    input.state = 'queued'; input.kind = 'topic_reply'; input.target = { topic_id: topic, item_id: null }; input.attempts = []; input.active_attempt_id = null;
    input.binding_id = session.active_binding_id!; input.payload.text = text; input.payload.selected_option_id = null;
    input.payload.target_snapshot.question_revision = null; input.payload.target_snapshot.item_question = null;
    return input.id;
  };
  const cancels = (transport: AppTransport) => transport.mutations.filter(request => request.command.command === 'input_cancel');
  it('deletes a topic reply not sent yet from its band in one click', async () => {
    let id = '';
    const { transport } = await mount({ configure: value => { id = queuedReply(value); } });
    const band = topicRow('Continued context');
    expect(within(band).getByRole('button', { name: 'Archive' })).toBeTruthy();
    await act(async () => { fireEvent.click(within(band.parentElement!).getByRole('button', { name: 'Delete' })); });
    expect(cancels(transport).map(request => request.command.params)).toMatchObject([{ input_id: id }]);
    await waitFor(() => expect(within(topicRow('Continued context').parentElement!).queryByRole('button', { name: 'Delete' })).toBeNull());
    expect(transport.preferences.drafts.filter(draft => draft.target.item_id === null)).toHaveLength(0);
  });
  it('keeps topic delivery status sticky while its recovery controls remain in the topic flow', async () => {
    await mount({ configure: queuedReply });
    const band = topicRow('Continued context'), group = band.parentElement!;
    expect(band.querySelector('.tree-topic-status')).not.toBeNull();
    expect(band.querySelector('.stuck-note')).toBeNull();
    const content = group.querySelector('.tree-topic-content')!;
    expect(content.previousElementSibling).toBe(band);
    expect(content.querySelector('.stuck-note')).not.toBeNull();
    expect(group.contains(row('8'))).toBe(true);
  });
  it('edits a topic reply not sent yet: the queued reply is taken back first, then its text goes into the topic’s reply box', async () => {
    let id = '';
    const { transport } = await mount({ configure: value => { id = queuedReply(value); } });
    await act(async () => { fireEvent.click(within(topicRow('Continued context').parentElement!).getByRole('button', { name: 'Edit' })); });
    await waitFor(() => expect((screen.getByLabelText('Reply to this topic') as HTMLTextAreaElement).value).toBe(text));
    expect(transport.preferences.drafts.find(draft => draft.target.item_id === null)).toMatchObject({ intent: 'topic_reply', text });
    expect(cancels(transport).map(request => request.command.params)).toMatchObject([{ input_id: id, purpose: 'edit' }]);
    // No draft held the words before the cancel went out: they could have been sent twice.
    const cancelAt = transport.mutations.findIndex(request => request.command.command === 'input_cancel');
    expect(transport.mutations.slice(0, cancelAt).some(request => request.command.command === 'preferences_patch'
      && request.command.params.entries.some(entry => entry.kind === 'upsert_draft' && entry.draft.text === text))).toBe(false);
    expect(transport.mutations.slice(cancelAt).some(request => request.command.command === 'preferences_patch'
      && request.command.params.entries.some(entry => entry.kind === 'upsert_draft' && entry.draft.text === text))).toBe(true);
  });
  it('never overwrites a topic reply the owner already started: the queued one stays and its text is offered to copy', async () => {
    const { transport, drafts, store } = await mount({ configure: queuedReply });
    const session = store.getSnapshot().snapshot!.session, topic = session.items['8']!.topic_id;
    await act(async () => { await drafts.load(); });
    const started = drafts.beginTopic(session, topic)!;
    await act(async () => { await drafts.editSaved(started, { text: 'Something else' }); });
    await act(async () => { fireEvent.click(within(topicRow('Continued context').parentElement!).getByRole('button', { name: 'Edit' })); });
    expect((await screen.findByLabelText('Your earlier message') as HTMLTextAreaElement).value).toBe(text);
    expect(drafts.findTopic(route, topic)?.draft.text).toBe('Something else');
    expect(cancels(transport)).toHaveLength(0);
  });
  it('offers the row actions for the item status and routes them to the workspace', async () => {
    const { calls, transport } = await mount();
    fireEvent.click(within(row('1.1')).getByRole('button', { name: 'Bring it up (b)' }));
    fireEvent.click(within(row('1.1')).getByRole('button', { name: 'Later (z)' }));
    fireEvent.click(within(row('5')).getByRole('button', { name: 'Back to Open (o)' }));
    fireEvent.click(within(row('5')).getByRole('button', { name: 'Follow up (r)' }));
    fireEvent.click(within(row('1.1')).getByRole('button', { name: 'Remove (⌫)' }));
    expect(calls.acts.map(([intent, target]) => `${intent}:${target.item_id}`)).toEqual(['bring:1.1', 'later:1.1', 'reopen:5', 'followup:5']);
    expect(calls.removed).toBe(1);
    // A delivery on its way still permits owner-only Hide and Remove.
    expect(within(row('3')).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual([`Focus on ${shortLabel(transport.sessions.get(route.session_id)!.items['3']!)}`, 'Hide (h)', 'Remove (⌫)']);
    fireEvent.keyDown(row('1.1'), { key: 'b' }); expect(calls.acts).toHaveLength(4);
  });
});

describe('session tree filters', () => {
  it('preserves graph folds and both status edits when the composed writers contend', async () => {
    const value = await mount(), { transport, navigation, store } = value;
    value.rerender({ graph: <NavigationGraph navigation={navigation} store={store} onReveal={() => {}} /> });
    // ← folds the selected node (the Graph has no fold button), so select item 1 first and let that write finish.
    const parent = await waitFor(() => document.querySelector<HTMLElement>('.graph-node[data-item-id="1"]')!);
    fireEvent.click(parent);
    await waitFor(() => expect(viewOf(transport).selected_item_id).toBe('1'));
    await waitFor(() => expect(navigation.getSnapshot().writing).toBe(false));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if (name === 'preferences_patch') await gate;
      return invoke(name, args);
    });
    try {
      const open = chip('Open'), progress = chip('In progress');
      act(() => {
        fireEvent.keyDown(document.querySelector<HTMLElement>('.graph-node[data-item-id="1"]')!, { key: 'ArrowLeft' });
        fireEvent.click(open); fireEvent.click(progress);
      });
      await waitFor(() => expect(navigation.getSnapshot().writing).toBe(true));
      expect(chipPicked('Open')).toBe(true); expect(chipPicked('In progress')).toBe(true);
      expect(chip('Open').hasAttribute('disabled')).toBe(false);
      await act(async () => { release(); });
      await waitFor(() => expect(viewOf(transport).filters.statuses).toEqual(['open', 'in_progress']));
      await waitFor(() => expect(navigation.getSnapshot().writing).toBe(false));
      expect(viewOf(transport).expanded_item_ids).not.toContain('1');
      expect(chipPicked('Open')).toBe(true); expect(chipPicked('In progress')).toBe(true);
      expect(notices.getSnapshot().some(notice => notice.id === 'tree-view-save-failed')).toBe(false);
      expect(screen.queryByText('Ariadne isn’t sure that view change was saved. Try it again.')).toBeNull();
    } finally { release(); }
  });
  it('queues rapid status toggles while keeping the chips enabled and focused during writes', async () => {
    const { transport, navigation } = await mount();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if (name === 'preferences_patch') await gate;
      return invoke(name, args);
    });
    const open = chip('Open'); open.focus(); fireEvent.click(open);
    await waitFor(() => expect(navigation.getSnapshot().writing).toBe(true));
    expect(chip('In progress').hasAttribute('disabled')).toBe(false);
    expect(document.activeElement).toBe(open);
    fireEvent.click(chip('In progress'));
    expect(chipPicked('Open')).toBe(true);
    expect(chipPicked('In progress')).toBe(true);
    await act(async () => { release(); });
    await waitFor(() => expect(viewOf(transport).filters.statuses).toEqual(['open', 'in_progress']));
    await waitFor(() => expect(navigation.getSnapshot().writing).toBe(false));
    expect(chipPicked('Open')).toBe(true);
    expect(chipPicked('In progress')).toBe(true);
    expect(patches(transport)).toHaveLength(2);
  });
  // The search finds in place (SPEC §4): its count goes to the top bar through onSearchStatus, never to a Map banner.
  const searchCount = (status: ReturnType<typeof vi.fn>) => (status.mock.calls.at(-1)?.[0] as { count: string } | null)?.count ?? null;
  it('counts the matches themselves, excluding context and forced selections', async () => {
    const status = vi.fn(), { rerender } = await mount({ props: { query: 'receipt', selectedId: '4', onSearchStatus: status } });
    // "Implement receipt lookup" and "Add the receipt lookup test": not their parent 1, not the selected 4.
    expect(searchCount(status)).toBe('1 of 2');
    expect(ids()).toHaveLength(9);
    expect(screen.queryByText(/items matching/)).toBeNull();
    rerender({ query: '' });
    expect(status.mock.calls.at(-1)?.[0]).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
  });
  it('explains picked statuses without the search, and leaves clearing the search to the top bar', async () => {
    const status = vi.fn(), clear = vi.fn();
    const view = await mount({ configure: value => { viewOf(value).filters.statuses = ['open']; },
      props: { query: 'receipt', onClearSearch: clear, onSearchStatus: status } });
    expect(within(filterRow()).getByText('Showing 3 of 9 items')).toBeTruthy();
    // Only the open "Add the receipt lookup test" counts; the in-progress match is outside the statuses.
    expect(searchCount(status)).toBe('1 of 1');
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
    view.rerender({ query: '' });
    expect(clear).not.toHaveBeenCalled();
    expect(viewOf(view.transport).filters.statuses).toEqual(['open']);
    expect(chipPicked('Open')).toBe(true);
    expect(within(filterRow()).getByText('Showing 3 of 9 items')).toBeTruthy();
  });
  it('excludes archived sessions from Ack buttons and topic counts', async () => {
    await mount({ configure: transport => {
      const session = transport.sessions.get(route.session_id)!;
      session.items['1.1']!.ack_to = 'done';
      session.state = 'closed'; session.archived_at = session.updated_at;
    } });
    expect(screen.queryByRole('button', { name: 'Ack → Done' })).toBeNull();
    expect(screen.queryByText('Ack → Done')).toBeNull();
    expect(screen.queryByText(/to ack/)).toBeNull();
  });
  it('counts only matches in the current archive mode', async () => {
    const status = vi.fn(), view = await mount({ configure: value => {
      const session = value.sessions.get(route.session_id)!;
      session.topics[session.items['8']!.topic_id]!.archived_at = '2026-10-07T12:00:00Z';
    }, props: { query: 'receipt', onSearchStatus: status } });
    expect(searchCount(status)).toBe('1 of 2');
    viewOf(view.transport).filters.archived = true;
    await act(async () => { await view.navigation.refresh(); });
    expect(searchCount(status)).toBe('No matches');
  });
  it('reads a saved full status set, including duplicates, as All', async () => {
    const { transport } = await mount({ configure: value => {
      viewOf(value).filters.statuses = ['done', 'open', 'waiting_on_me', 'replaced', 'decided', 'in_progress', 'dropped', 'open', 'done'];
    } });
    // No chip is picked: the row asks for one, shows no summary and offers no Clear.
    for (const label of ['Waiting on me', 'Open', 'In progress', 'Done']) expect(chipPicked(label)).toBe(false);
    expect(within(filterRow()).getByText('Pick a status')).toBeTruthy();
    expect(within(filterRow()).queryByRole('button', { name: 'Clear' })).toBeNull();
    expect(ids()).toHaveLength(9);
    fireEvent.click(chip('Open'));
    await waitFor(() => expect(viewOf(transport).filters.statuses).toEqual(['open']));
    expect(chipPicked('Open')).toBe(true);
    expect(within(filterRow()).queryByText('Pick a status')).toBeNull();
    expect(ids()).toEqual(['1', '1.1', '4', '8']);
  });
  it('keeps a saved single Done chip narrow when another chip is added', async () => {
    const { transport } = await mount({ configure: value => { viewOf(value).filters.statuses = ['done']; } });
    expect(chipPicked('Done')).toBe(true);
    expect(chipPicked('Decided')).toBe(false);
    expect(ids()).toEqual(['1']);
    fireEvent.click(chip('Open'));
    await waitFor(() => expect(viewOf(transport).filters.statuses).toEqual(['open', 'done']));
    expect(ids()).toEqual(['1', '1.1', '4', '8']);
  });
  it('toggles multiple chips, keeps counts independent, and restores the saved combination', async () => {
    const { transport, navigation, rerender } = await mount();
    const labels = ['Waiting on me', 'Open', 'In progress', 'Done'];
    const counts = labels.map(label => chip(label).textContent);
    fireEvent.click(chip('Open'));
    await waitFor(() => expect(viewOf(transport).filters.statuses).toEqual(['open']));
    // Status buttons remain ordinary keyboard-reachable buttons.
    chip('In progress').focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(viewOf(transport).filters.statuses).toEqual(['open', 'in_progress']));
    expect(chipPicked('Open')).toBe(true);
    expect(chipPicked('In progress')).toBe(true);
    expect(chipPicked('Done')).toBe(false);
    expect(ids()).toEqual(['1', '1.1', '3', '4', '8']);
    expect(labels.map(label => chip(label).textContent)).toEqual(counts);
    // A search narrows neither the rows nor the chip counts.
    rerender({ query: 'receipt' });
    expect(ids()).toEqual(['1', '1.1', '3', '4', '8']);
    expect(labels.map(label => chip(label).textContent)).toEqual(counts);
    cleanup(); navigation.stop();
    await mount({ transport });
    expect(chipPicked('Open')).toBe(true);
    expect(chipPicked('In progress')).toBe(true);
    expect(ids()).toEqual(['1', '1.1', '3', '4', '8']);
    fireEvent.click(chip('Open'));
    await waitFor(() => expect(viewOf(transport).filters.statuses).toEqual(['in_progress']));
    expect(ids()).toEqual(['3']);
    fireEvent.click(chip('In progress'));
    await waitFor(() => expect(viewOf(transport).filters.statuses).toEqual([]));
    expect(within(filterRow()).getByText('Pick a status')).toBeTruthy();
    expect(ids()).toHaveLength(9);
  });
  it('picks chips one by one, combines them, and Clear empties the saved and the local chips and closes the row', async () => {
    const closeFilter = vi.fn(), { transport } = await mount({ props: { onCloseFilter: closeFilter },
      configure: value => { value.sessions.get(route.session_id)!.items['1.1']!.ack_to = 'done'; } });
    for (const [label, expected] of [
      ['Waiting on me', ['waiting_on_me']], ['Open', ['waiting_on_me', 'open']],
      ['In progress', ['waiting_on_me', 'open', 'in_progress']], ['Done', ['waiting_on_me', 'open', 'in_progress', 'done']],
    ] as const) {
      fireEvent.click(chip(label));
      await waitFor(() => expect(viewOf(transport).filters.statuses).toEqual(expected));
    }
    // A local chip joins the saved ones; it lives in this browser, never in the saved view.
    fireEvent.click(chip('To ack'));
    await waitFor(() => expect(chipPicked('To ack')).toBe(true));
    expect(JSON.parse(localStorage.getItem('ariadne.map.filter.v1')!)).toEqual({ [route.session_id]: ['toack'] });
    expect(viewOf(transport).filters.statuses).toEqual(['waiting_on_me', 'open', 'in_progress', 'done']);
    clearChips();
    await waitFor(() => expect(viewOf(transport).filters.statuses).toEqual([]));
    expect(localStorage.getItem('ariadne.map.filter.v1')).toBe('{}');
    expect(closeFilter).toHaveBeenCalledTimes(1);
    for (const label of ['Waiting on me', 'Open', 'In progress', 'Done', 'To ack']) if (chipShown(label)) expect(chipPicked(label)).toBe(false);
    expect(ids()).toHaveLength(9);
  });
  it('Clear also empties the saved owners and hide-later (no chip stands for them), and leaves the search and the archive alone', async () => {
    const { transport } = await mount({ configure: value => {
      const filters = viewOf(value).filters;
      filters.statuses = ['open']; filters.hide_later = true; filters.owners = [{ kind: 'me' }]; filters.search = 'receipt';
    } });
    clearChips();
    await waitFor(() => expect(viewOf(transport).filters.statuses).toEqual([]));
    expect(viewOf(transport).filters.hide_later).toBe(false);
    expect(viewOf(transport).filters.owners).toEqual([]);
    expect(viewOf(transport).filters.search).toBe('receipt');
    expect(viewOf(transport).filters.archived).toBe(false);
  });
  it.each<[string, (filters: ReturnType<typeof viewOf>['filters']) => void]>([
    ['a leftover saved Dropped', filters => { filters.statuses = ['dropped']; }],
    ['saved owners', filters => { filters.owners = [{ kind: 'me' }]; }],
    ['hide-later', filters => { filters.hide_later = true; }],
  ])('shows the summary and Clear when only %s filters the Map, and Clear lifts it', async (_name, set) => {
    const { transport } = await mount({ configure: value => { set(viewOf(value).filters); } });
    expect(within(filterRow()).queryByText('Pick a status')).toBeNull();
    expect(within(filterRow()).getByRole('status').textContent).toMatch(/Showing \d+ of \d+ items/);
    clearChips();
    await waitFor(() => expect(viewOf(transport).filters).toMatchObject({ statuses: [], owners: [], hide_later: false }));
    await waitFor(() => expect(within(filterRow()).getByText('Pick a status')).toBeTruthy());
    expect(ids()).toHaveLength(9);
  });
  it('keeps chip counts under a search, marks its hits in place and keeps the topic dropdown out of every layout', async () => {
    const { transport, rerender } = await mount();
    fireEvent.click(chip('Open'));
    await waitFor(() => expect(viewOf(transport).filters.statuses).toEqual(['open']));
    expect(ids()).toEqual(['1', '1.1', '4', '8']);
    const counts = ['Waiting on me', 'Open'].map(label => chip(label).textContent);
    rerender({ query: 'receipt' });
    expect(['Waiting on me', 'Open'].map(label => chip(label).textContent)).toEqual(counts);
    expect(ids()).toEqual(['1', '1.1', '4', '8']);
    expect(row('1.1').querySelector('.tree-hit')?.textContent?.toLowerCase()).toBe('receipt');
    for (const props of [{}, { detailOpen: true }]) {
      rerender(props);
      expect(screen.queryByRole('combobox', { name: 'Topic' })).toBeNull();
    }
  });
  it('names the picked statuses by pressed chips and a summary, and shows no menu', async () => {
    const { transport } = await mount();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(within(filterRow()).queryByText(/^Showing /)).toBeNull();
    fireEvent.click(chip('Open'));
    await waitFor(() => expect(viewOf(transport).filters.statuses).toEqual(['open']));
    fireEvent.click(chip('In progress'));
    await waitFor(() => expect(viewOf(transport).filters.statuses).toEqual(['open', 'in_progress']));
    expect(chipPicked('Open')).toBe(true); expect(chipPicked('In progress')).toBe(true);
    expect(within(filterRow()).getByText('Showing 4 of 9 items')).toBeTruthy();
    expect(ids()).toEqual(['1', '1.1', '3', '4', '8']);
    clearChips();
    await waitFor(() => expect(viewOf(transport).filters.statuses).toEqual([]));
    expect(chipPicked('Open')).toBe(false);
    expect(within(filterRow()).getByText('Pick a status')).toBeTruthy();
    expect(screen.queryByRole('menu')).toBeNull();
  });
  it.each(['status', 'search'] as const)('keeps item and topic folds shared with the normal view under %s filtering', async mode => {
    const { transport, rerender } = await mount();
    if (mode === 'status') {
      fireEvent.click(chip('Open'));
      await waitFor(() => expect(viewOf(transport).filters.statuses).toEqual(['open']));
    } else rerender({ query: 'receipt' });
    expect(ids()).toContain('1.1');
    row('1').focus(); fireEvent.keyDown(row('1'), { key: 'ArrowLeft' });
    await waitFor(() => expect(ids()).not.toContain('1.1'));
    expect(viewOf(transport).expanded_item_ids).not.toContain('1');
    fireEvent.click(within(row('1')).getByRole('button', { name: 'Expand or collapse' }));
    await waitFor(() => expect(ids()).toContain('1.1'));
    expect(viewOf(transport).expanded_item_ids).toContain('1');
    fireEvent.click(within(topicRow('Delivery decisions')).getByRole('button', { name: 'Expand or collapse topic' }));
    await waitFor(() => expect(ids()).not.toContain('1'));
    expect(viewOf(transport).collapsed_topic_ids).toContain(transport.sessions.get(route.session_id)!.items['1']!.topic_id);
    fireEvent.click(within(topicRow('Delivery decisions')).getByRole('button', { name: 'Expand or collapse topic' }));
    await waitFor(() => expect(ids()).toContain('1.1'));
    expect(viewOf(transport).collapsed_topic_ids).not.toContain(transport.sessions.get(route.session_id)!.items['1']!.topic_id);
    fireEvent.click(within(topicRow('Delivery decisions')).getByRole('button', { name: 'Expand or collapse topic' }));
    await waitFor(() => expect(ids()).not.toContain('1'));
    if (mode === 'status') {
      clearChips();
      await waitFor(() => expect(viewOf(transport).filters.statuses).toEqual([]));
    } else rerender({ query: '' });
    expect(ids()).not.toContain('1');
    fireEvent.click(within(topicRow('Delivery decisions')).getByRole('button', { name: 'Expand or collapse topic' }));
    await waitFor(() => expect(ids()).toContain('1.1'));
  });
  it('keeps the Map under a search that matches nothing, and offers one clear action when the filters match nothing', async () => {
    const status = vi.fn(), { calls, rerender } = await mount({ props: { onSearchStatus: status } });
    rerender({ query: 'zzz' });
    expect(searchCount(status)).toBe('No matches');
    expect(screen.queryByText(/Nothing matches/)).toBeNull(); expect(screen.getByRole('tree')).toBeTruthy();
    expect(ids()).toHaveLength(9);
    cleanup();
    const filtered = await mount({ configure: transport => { viewOf(transport).filters.statuses = ['in_progress']; transport.sessions.get(route.session_id)!.items['3']!.status = 'open'; } });
    expect(screen.getByText('No items match these filters.')).toBeTruthy(); expect(screen.queryByRole('tree')).toBeNull();
    fireEvent.click(within(document.querySelector<HTMLElement>('.tree-no-match')!).getByRole('button', { name: 'Clear filters' }));
    expect(filtered.calls.cleared).toBe(1); expect(calls.cleared).toBe(0);
  });
  it('says so when a saved status combination matches nothing', async () => {
    await mount({ configure: transport => {
      viewOf(transport).filters.statuses = ['waiting_on_me', 'in_progress'];
      const session = transport.sessions.get(route.session_id)!;
      session.items['2']!.status = 'open'; session.items['3']!.status = 'open';
    } });
    expect(screen.getByText('No items match these filters.')).toBeTruthy();
    expect(chipPicked('Waiting on me')).toBe(true);
    expect(chipPicked('In progress')).toBe(true);
  });
  it('shows a reveal outside the filters, keeps its ancestry open and resumes the filtered view', async () => {
    const { transport, store, calls, rerender } = await mount({ configure: transport => {
      viewOf(transport).filters.statuses = ['waiting_on_me']; viewOf(transport).expanded_item_ids = [];
    } });
    expect(ids()).toEqual(['2']);
    const reveal: RevealedItem = { kind: 'item', route: { ...route, item_id: '1.1' }, store, temporaryExpandedItemIds: ['1'] };
    rerender({ reveal, selectedId: '1.1' });
    expect(screen.getByText('Showing an item outside your current filters.')).toBeTruthy();
    expect(ids()).toEqual(['1', '1.1', '2']);
    expect(row('1').querySelector('.tree-question')?.getAttribute('style')).toContain('64%');
    fireEvent.click(screen.getByRole('button', { name: 'Resume filtered view' }));
    expect(calls.resumed).toBe(1);
    await waitFor(() => expect(viewOf(transport).selected_item_id).toBeNull());
    rerender({ reveal: null, selectedId: null });
    expect(screen.queryByText('Showing an item outside your current filters.')).toBeNull(); expect(ids()).toEqual(['2']);
  });
  it('holds the chips while a preference write is unconfirmed', async () => {
    const { transport } = await mount();
    transport.failNext = 'preferences_patch';
    fireEvent.click(chip('Open'));
    await waitFor(() => expect((chip('In progress') as HTMLButtonElement).disabled).toBe(true));
    expect(row('4').getAttribute('aria-disabled')).toBe('true');
  });
});

describe('session tree column states', () => {
  it('shows the loading skeleton until the session arrives', async () => {
    const { store } = await mount({ load: false });
    expect(screen.getByText('Reading the session…')).toBeTruthy();
    await act(async () => { await store.refresh(); });
    expect(screen.queryByText('Reading the session…')).toBeNull(); expect(screen.getByRole('tree')).toBeTruthy();
  });
  it('shows the empty session with its connection line', async () => {
    await mount({ configure: transport => { const session = transport.sessions.get(route.session_id)!; session.items = {}; session.inputs = {}; } });
    expect(screen.getByText('No items yet')).toBeTruthy();
    expect(document.querySelector('.tree-empty-connection')?.textContent).toMatch(/^Connected to .* waiting for the agent’s first message$/);
    expect(document.querySelector('.tree-empty-connection')?.textContent).not.toMatch(/ in /);
  });
  it('names the terminal app in the empty state', async () => {
    await mount({ configure: transport => {
      const session = transport.sessions.get(route.session_id)!; session.items = {}; session.inputs = {};
      session.bindings[session.active_binding_id!]!.host_location = 'iTerm window 1';
    } });
    // The session bar's title ("demo.local · iTerm window 1") is the top bar's now; session-name.test pins sessionBar().
    expect(document.querySelector('.tree-session-title')).toBeNull();
    expect(document.querySelector('.tree-empty-connection')?.textContent).toBe('Connected to demo.local in iTerm · waiting for the agent’s first message');
  });
  it('shows the empty session without a running agent', async () => {
    await mount({ configure: transport => {
      const session = transport.sessions.get(route.session_id)!; session.items = {}; session.inputs = {};
      const binding = session.bindings[session.active_binding_id!]!; binding.connection_state = 'disconnected'; binding.dispatch_state = 'disconnected';
    } });
    expect(document.querySelector('.tree-empty-connection')?.textContent).toMatch(/is not running · items appear when it writes$/);
    // The run chip ("Disconnected") is the top bar's connection badge now, not part of the tree.
    expect(document.querySelector('.tree-run')).toBeNull();
  });
  it('shows graph content in place of the rows', async () => {
    const { rerender } = await mount();
    rerender({ graph: <p>Topic graph stand-in</p> });
    expect(screen.getByText('Topic graph stand-in')).toBeTruthy(); expect(screen.queryByRole('tree')).toBeNull();
  });
  it('lists archived topics with Restore and no session bar or chips', async () => {
    const transport = new HistoryTransport();
    const { calls } = await mount({ transport, configure: value => {
      const session = value.sessions.get(route.session_id)!, topic = Object.values(session.topics).find(item => item?.name === 'Continued context')!;
      topic.archived_at = session.updated_at; viewOf(value).filters.archived = true;
    } });
    expect(ids()).toEqual(['8']); expect(screen.queryByRole('group', { name: 'Filter items' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close session' })).toBeNull();
    await act(async () => { fireEvent.click(within(topicRow('Continued context')).getByRole('button', { name: 'Restore' })); });
    await waitFor(() => expect(screen.getByText('No archived topics in this session.')).toBeTruthy());
    expect(transport.mutations.at(-1)?.command.command).toBe('topic_restore'); expect(calls.archive).toBe(0);
  });
});

describe('session tree lifecycle', () => {
  it('archives an agent-seeded closed topic once when ready is published before Pause finishes refreshing', async () => {
    const transport = new HistoryTransport();
    const { store, actions } = await mount({ transport, configure: value => {
      const session = value.sessions.get(route.session_id)!;
      session.topics = {}; session.items = {}; session.inputs = {}; session.messages = []; session.rounds = {}; session.answers = [];
    } });
    const session = transport.source, binding = session.bindings[session.active_binding_id!]!;
    const seed = new HistoryTransport().source;
    const topic = structuredClone(Object.values(seed.topics)[0]!);
    const item = structuredClone(Object.values(seed.items).find(item => item?.topic_id === topic.id)!);
    item.status = 'done'; item.waiting_since = null; item.ack_to = null;
    let releasePresence!: () => void;
    const presence = new Promise<void>(resolve => { releasePresence = resolve; });
    const invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if (name === 'session_list') await presence;
      if (name === 'session_get' && binding.owner_paused && !session.topics[topic.id]) {
        // Seed the agent's completed Apply before the owner's post-save session read.
        session.topics[topic.id] = topic; session.items[item.id] = item; ++session.revision;
        transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision });
      }
      return invoke(name, args);
    });
    let pause!: Promise<boolean>;
    act(() => {
      pause = actions.execute({ command: 'binding_pause', api_version: 1, op_id: '', params: {
        binding_id: binding.id, expected_generation: binding.generation,
      } }, session.revision);
    });
    await waitFor(() => {
      expect(store.getSnapshot().status).toBe('ready');
      // The pause landed (the run chip that said "Paused (by you)" is the connection card's now).
      expect(binding.owner_paused).toBe(true);
      expect(screen.getByText('Everything here is closed.')).toBeTruthy();
    });
    expect(document.querySelector('.tree-column')?.getAttribute('data-session-status')).toBe('ready');
    expect(actions.getSnapshot().writing).toBe(true);
    const prompt = screen.getByRole('button', { name: 'Archive topic' });
    fireEvent.click(prompt); fireEvent.click(prompt);
    expect(transport.mutations.filter(request => request.command.command === 'topic_archive')).toHaveLength(0);
    await act(async () => { releasePresence(); await pause; await store.refresh(); });
    await waitFor(() => expect(notices.getSnapshot().some(notice => notice.text === `Archived “${topic.name}”.`)).toBe(true));
    expect(transport.mutations.filter(request => request.command.command === 'topic_archive')).toHaveLength(1);
    expect(topic.archived_at).not.toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('archives a closed topic at once from its prompt, with Undo and View archive', async () => {
    const transport = new HistoryTransport();
    const { calls } = await mount({ transport, configure: value => {
      const session = value.sessions.get(route.session_id)!; session.items['8']!.status = 'done';
      for (const input of Object.values(session.inputs)) if (input && input.target.topic_id === session.items['8']!.topic_id) input.state = 'handled';
    } });
    render(<Notices />);
    const band = topicRow('Continued context');
    expect(within(band.parentElement!).getByText('Everything here is closed.')).toBeTruthy();
    await act(async () => { fireEvent.click(within(band.parentElement!).getByRole('button', { name: 'Archive topic' })); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText('Archived “Continued context”.')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Session tree' }).textContent).not.toContain('Archived “Continued context”.');
    vi.useFakeTimers();
    await act(async () => { await vi.advanceTimersByTimeAsync(6500); });
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
    vi.useRealTimers();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo' })); });
    await waitFor(() => expect(screen.queryByText('Archived “Continued context”.')).toBeNull());
    expect(transport.mutations.map(value => value.command.command)).toEqual(['topic_archive', 'topic_restore']);
    await act(async () => { fireEvent.click(within(topicRow('Continued context')).getByRole('button', { name: 'Archive' })); });
    fireEvent.click(await screen.findByRole('button', { name: 'View archive' }));
    expect(calls.archive).toBe(1); expect(screen.queryByText('Archived “Continued context”.')).toBeNull();
    expect(notices.getSnapshot().some(notice => notice.actions?.some(action => action.label === 'Undo'))).toBe(false);
  });
  it('dismisses an archive outcome without replaying it on an unrelated tree update', async () => {
    const transport = new HistoryTransport();
    const view = await mount({ transport, configure: value => {
      const session = value.sessions.get(route.session_id)!; session.items['8']!.status = 'done';
      for (const input of Object.values(session.inputs)) if (input && input.target.topic_id === session.items['8']!.topic_id) input.state = 'handled';
    } });
    render(<Notices />);
    await act(async () => { fireEvent.click(within(topicRow('Continued context')).getByRole('button', { name: 'Archive' })); });
    await screen.findByText('Archived “Continued context”.');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    view.rerender({ detailOpen: true });
    expect(notices.getSnapshot()).toEqual([]);
    expect(transport.mutations.map(value => value.command.command)).toEqual(['topic_archive']);
  });
  it('archives a topic with open work after one confirmation, leaving its items and cancelling its unsent messages', async () => {
    const transport = new HistoryTransport();
    await mount({ transport });
    const session = transport.sessions.get(route.session_id)!, topicId = session.items['4']!.topic_id;
    const unsent = Object.values(session.inputs).filter(input => input?.target.topic_id === topicId
      && ['queued', 'in_flight', 'needs_attention'].includes(input.state)).map(input => input!.id);
    const statuses = Object.values(session.items).map(item => item!.status);
    expect(unsent.length).toBeGreaterThan(1);
    // Archive is offered on a topic with open items; it asks first and never refuses.
    fireEvent.click(within(topicRow('Delivery decisions')).getByRole('button', { name: 'Archive' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Archive “Delivery decisions”?' }));
    expect(dialog.getByText(/open items? stays? as (it is|they are)\. .*archiving cancels them\. You can restore it any time\.$/)).toBeTruthy();
    await act(async () => { fireEvent.click(dialog.getByRole('button', { name: 'Archive topic' })); });
    expect(transport.mutations.map(value => value.command.command)).toEqual(['topic_archive']);
    await waitFor(() => expect(notices.getSnapshot().some(notice => notice.text.includes(`${unsent.length} unsent messages were cancelled.`))).toBe(true));
    expect(unsent.every(id => session.inputs[id]!.state === 'cancelled')).toBe(true);
    expect(Object.values(session.items).map(item => item!.status)).toEqual(statuses);
  });
  it('keeps a refused archive confirmation error in its dialog without a duplicate toast', async () => {
    const transport = new HistoryTransport(); await mount({ transport });
    transport.replies.push({ api_version: 1, ok: false,
      error: { code: 'invalid_argument', message: 'Refused archive.', hint: '', retryable: false, field_errors: [] } });
    fireEvent.click(within(topicRow('Delivery decisions')).getByRole('button', { name: 'Archive' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Archive “Delivery decisions”?' }));
    await act(async () => { fireEvent.click(dialog.getByRole('button', { name: 'Archive topic' })); });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Something in that isn’t valid. Check it and try again.');
    expect(screen.getByRole('dialog', { name: 'Archive “Delivery decisions”?' }).contains(alert)).toBe(true);
    expect(notices.getSnapshot()).toEqual([]);
  });
  it('asks before archiving a topic from its band, and the e key no longer does', async () => {
    const transport = new HistoryTransport();
    await mount({ transport });
    // SPEC 6.1 leaves e unbound: archiving is the band's own button.
    row('4').focus(); fireEvent.keyDown(row('4'), { key: 'e' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(within(topicRow('Delivery decisions')).getByRole('button', { name: 'Archive' }));
    expect(screen.getByRole('dialog', { name: 'Archive “Delivery decisions”?' })).toBeTruthy();
  });
  it('offers Continue here on an earlier topic and asks which other session takes it', async () => {
    const { navigation, rerender } = await mount();
    rerender({ summaries: navigation.getSnapshot().sessions!.sessions.items });
    expect(within(topicRow('Continued context')).queryByRole('button', { name: 'Continue here' })).toBeNull();
    fireEvent.click(within(topicRow('Delivery decisions')).getByRole('button', { name: 'Continue here' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Continue “Delivery decisions” in another session' }));
    expect(dialog.getAllByRole('button').map(button => button.getAttribute('aria-labelledby') ? button.textContent : null).filter(Boolean))
      .toEqual([expect.stringMatching(/^Separate session/)]);
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('offers Continue here on a topic from a session created today', async () => {
    const session = new AppTransport().sessions.get(route.session_id)!;
    await mount({ props: { now: () => Date.parse(session.created_at) } });
    expect(within(topicRow('Delivery decisions')).queryByText(/· (today|yesterday)/)).toBeNull();
    expect(within(topicRow('Delivery decisions')).getByRole('button', { name: 'Continue here' })).toBeTruthy();
  });
  it('keeps an uncertain session action for an exact reconcile from the column', async () => {
    const transport = new HistoryTransport();
    const { actions, store } = await mount({ transport, configure: value => {
      const session = value.sessions.get(route.session_id)!, binding = session.bindings[session.active_binding_id!]!;
      binding.dispatch_state = 'paused'; binding.owner_paused = true; session.inputs = {};
      Object.values(session.items).forEach(item => { if (item) { item.status = 'done'; item.waiting_since = null; } });
    } });
    transport.replies.push(new Error('Lost acknowledgement'));
    // Close is asked for from the connection card or an All sessions row; both start the session's lifecycle review.
    const closing = render(<CloseHost actions={actions} />);
    await act(async () => { fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Close session' })); });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    closing.unmount();
    expect(screen.getByText('Closing the session isn’t confirmed yet. Check whether your last change was saved before making another.')).toBeTruthy();
    // A second Close is refused while the first is unconfirmed: its review offers only Check again, and nothing more is sent.
    const again = render(<CloseHost actions={actions} />);
    const review = await screen.findByRole('dialog');
    expect(within(review).queryByRole('button', { name: 'Close session' })).toBeNull();
    expect(within(review).getByRole('button', { name: 'Check again' })).toBeTruthy();
    expect(transport.mutations).toHaveLength(1);
    fireEvent.click(within(review).getByRole('button', { name: 'Cancel' }));
    again.unmount();
    const request = structuredClone(transport.mutations[0]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check again' })); });
    expect(transport.mutations).toEqual([request, request]);
    await waitFor(() => expect(store.getSnapshot().snapshot!.session.state).toBe('closed'));
  });
});

describe('stopped deliveries in the tree', () => {
  const stopped = '00000000-0000-4000-8000-000000000074';
  // Input 74 (item 7) stopped mid-delivery; on the active binding it is a recovery target.
  const active = (transport: AppTransport) => { const session = transport.sessions.get(route.session_id)!; session.inputs[stopped]!.binding_id = session.active_binding_id!; };
  const banner = () => screen.queryByRole('region', { name: 'Delivery recovery' });
  it('keeps a delivered topic reply neutral in both the sticky line and its recovery note', async () => {
    let topicName = '';
    await mount({ configure: transport => {
      const session = transport.sessions.get(route.session_id)!, input = session.inputs[stopped]!, attempt = input.attempts[0]!;
      topicName = session.topics[input.target.topic_id]!.name;
      input.target.item_id = null; input.kind = 'topic_reply';
      attempt.acceptance = 'accepted'; attempt.host_turn_id = 'turn-example'; attempt.turn_state = 'completed'; attempt.result_state = 'missing';
      attempt.error = { code: 'result_missing', reason: 'No saved result.', retryable: false, observed_at: session.updated_at };
    } });
    const band = topicRow(topicName), line = band.querySelector<HTMLElement>('.tree-topic-status')!;
    expect(line.textContent).toBe('demo.local has your message but hasn’t saved its answer yet. It may still be working.');
    expect(line.style.color).not.toBe('var(--a-warn)');
    const fix = band.parentElement!.querySelector<HTMLElement>('.stuck-note[data-stuck="answer"]')!;
    expect(fix.textContent).not.toMatch(/Couldn’t deliver|Not delivered/);
    expect(within(fix).getByRole('button', { name: 'Ask for the answer' })).toBeTruthy();
    expect(within(fix).queryByRole('button', { name: 'Cancel message' })).toBeNull();
  });
  it('answers it on the item row: Couldn’t deliver, Retry in one click, without selecting the row', async () => {
    // On its own (old) binding there is no presence: Retry is the owner's word that the agent is idle.
    const { transport, calls } = await mount();
    const fix = row('7').querySelector<HTMLElement>('.stuck-note[data-stuck="decision"]')!;
    expect(fix.textContent).toContain('Couldn’t deliver “Followup request for item 7. Preserve…”. Ariadne isn’t sure it reached demo.local.');
    expect(within(fix).getByRole('button', { name: 'Mark as done' })).toBeTruthy();
    expect((within(fix).getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { fireEvent.click(within(fix).getByRole('button', { name: 'Retry' })); });
    expect(transport.mutations.find(request => request.command.command === 'input_resolve')!.command).toMatchObject({ params: {
      input_id: stopped, attempt_id: '00000000-0000-4000-8000-000000000063', decision: 'resend', reason: '', evidence: { source: 'owner_attestation', owner_attested_idle: true } } });
    expect(calls.selected).toHaveLength(0);
  });
  it('keeps the decision on the row when a later message is queued behind it on the same item', async () => {
    const { transport } = await mount({ configure: transport => {
      const session = transport.sessions.get(route.session_id)!, successor = structuredClone(session.inputs[stopped]!);
      successor.id = '00000000-0000-4000-8000-0000000000f4'; successor.seq = Math.max(...Object.values(session.inputs).map(value => value?.seq ?? 0)) + 1;
      successor.state = 'queued'; successor.attempts = []; successor.active_attempt_id = null;
      session.inputs[successor.id] = successor;
    } });
    const fix = row('7').querySelector<HTMLElement>('.stuck-note[data-stuck="decision"]')!;
    expect(fix.getAttribute('data-stuck-input')).toBe(stopped);
    fireEvent.click(within(fix).getByRole('button', { name: 'Mark as done' }));
    await waitFor(() => expect(transport.mutations.find(request => request.command.command === 'input_resolve')).toBeTruthy());
  });
  it('opens the audited form from More options, and keys typed there never reach the tree', async () => {
    const { transport } = await mount({ configure: active });
    fireEvent.click(within(row('7')).getByRole('button', { name: 'More options' }));
    const dialog = screen.getByRole('dialog', { name: 'Resolve delivery' });
    fireEvent.keyDown(within(dialog).getByLabelText('Reason'), { key: 'e' });
    expect(screen.queryByRole('dialog', { name: /^Archive “/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Resolve delivery' })).toBeNull(); expect(transport.mutations).toHaveLength(0);
  });
  it('shows no recovery banner while the row is visible, and the banner when a filter hides the row', async () => {
    const view = await mount({ configure: active });
    view.rerender({ notices: <RecoveryPanel actions={view.actions} /> });
    const fix = row('7').querySelector<HTMLElement>('.stuck-note[data-stuck="decision"]')!;
    expect(banner()).toBeNull();
    // The agent is running on the active binding: Retry and Mark as done wait, and say why.
    const retry = within(fix).getByRole('button', { name: 'Retry' }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true); expect(retry.title).toBe('demo.local is still working. Wait, or stop it in the terminal first.');
    expect((within(fix).getByRole('button', { name: 'Mark as done' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(chip('Open'));
    await waitFor(() => expect(ids()).toEqual(['1', '1.1', '4', '8']));
    await waitFor(() => expect(banner()).not.toBeNull());
    expect(within(banner()!).getByText('A message needs your decision')).toBeTruthy();
    clearChips();
    await waitFor(() => expect(banner()).toBeNull());
  });
});

describe('Reply to topic', () => {
  const box = () => document.querySelector<HTMLElement>('[data-owner-input^="topic:"]');
  it('keeps the reply composer and closed-topic prompt outside the sticky header in the same topic section', async () => {
    await mount({ configure: transport => {
      for (const item of Object.values(transport.sessions.get(route.session_id)!.items)) if (item) item.status = 'done';
    } });
    const band = topicRow('Delivery decisions'), group = band.parentElement!;
    fireEvent.click(within(band).getByRole('button', { name: 'Reply to topic' }));
    await waitFor(() => expect(box()).not.toBeNull());
    expect(band.querySelector('.tree-prompt')).toBeNull();
    expect(band.contains(box())).toBe(false);
    const content = group.querySelector('.tree-topic-content')!;
    expect(content.previousElementSibling).toBe(band);
    expect(content.contains(box())).toBe(true);
    expect(content.querySelector('.tree-prompt')).not.toBeNull();
    expect(group.contains(row('1'))).toBe(true);
    const css = readFileSync(resolve(__dirname, '../../../src/ui/tree/tree.css'), 'utf8');
    expect(css).toMatch(/\.tree-topic-group\s*\{[^}]*position: relative/s);
    expect(css).toMatch(/\.tree-topic\s*\{[^}]*position: sticky;[^}]*top: 0/s);
    expect(css).toMatch(/\.tree-topic-status > span\s*\{[^}]*white-space: nowrap;[^}]*text-overflow: ellipsis/s);
    expect(css).not.toMatch(/\.tree-topic-content\s*\{[^}]*position: sticky/s);
  });
  it('opens a box on the topic band and sends a topic reply with no item', async () => {
    const { transport, drafts } = await mount();
    fireEvent.click(within(topicRow('Delivery decisions')).getByRole('button', { name: 'Reply to topic' }));
    await waitFor(() => expect(box()).not.toBeNull());
    await waitFor(() => expect(drafts.getSnapshot().ready).toBe(true));
    const text = within(box()!).getByLabelText('Reply to this topic');
    await waitFor(() => expect((text as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.change(text, { target: { value: 'Keep the retry limit at three across this topic.' } });
    fireEvent.keyDown(text, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(transport.mutations.some(request => request.command.command === 'input_submit')).toBe(true));
    const topicId = topicRow('Delivery decisions').getAttribute('data-topic-id');
    expect(transport.mutations.find(request => request.command.command === 'input_submit')!.command).toMatchObject({ params: {
      kind: 'topic_reply', target: { topic_id: topicId, item_id: null }, text: 'Keep the retry limit at three across this topic.',
      expected_question_revision: null, supersedes_answer_id: null, selected_option_id: null,
    } });
    await waitFor(() => expect(box()).toBeNull());
  });
  it('closes on Escape and keeps the draft for next time', async () => {
    await mount();
    fireEvent.click(within(topicRow('Delivery decisions')).getByRole('button', { name: 'Reply to topic' }));
    await waitFor(() => expect((within(box()!).getByLabelText('Reply to this topic') as HTMLTextAreaElement).disabled).toBe(false));
    const text = within(box()!).getByLabelText('Reply to this topic');
    fireEvent.change(text, { target: { value: 'Half a thought' } });
    fireEvent.keyDown(text, { key: 'Escape' });
    expect(box()).toBeNull(); expect(document.activeElement).toBe(topicRow('Delivery decisions'));
    fireEvent.click(within(topicRow('Delivery decisions')).getByRole('button', { name: 'Reply to topic' }));
    await waitFor(() => expect((within(box()!).getByLabelText('Reply to this topic') as HTMLTextAreaElement).value).toBe('Half a thought'));
  });
  it('keeps the words and the focus when typed while the session view refreshes, with no shortcut firing, and holds Send until it is fresh', async () => {
    const { transport, store, calls } = await mount(), user = userEvent.setup();
    fireEvent.click(within(topicRow('Delivery decisions')).getByRole('button', { name: 'Reply to topic' }));
    await waitFor(() => expect(box()).not.toBeNull());
    const text = within(box()!).getByLabelText('Reply to this topic') as HTMLTextAreaElement;
    await waitFor(() => expect(text.disabled).toBe(false));
    // The app's window-level routing, and every key that reaches something other than the box.
    const root = document.body.firstElementChild as HTMLElement, elsewhere: Element[] = [];
    const routeKey = (event: KeyboardEvent) => { routeWindowKey(event, root); };
    const record = (event: KeyboardEvent) => { if (event.target !== text) elsewhere.push(event.target as Element); };
    window.addEventListener('keydown', routeKey); document.addEventListener('keydown', record, true);
    try {
      await user.click(text);
      act(() => { (store as unknown as { publish: (update: object) => void }).publish({ status: 'stale' }); });
      await user.keyboard('de1');
      await waitFor(() => expect(text.value).toBe('de1'));
      expect(document.activeElement).toBe(text);
      expect(elsewhere).toEqual([]);
      expect(calls.acts).toEqual([]);
      // Nothing goes out against a view that may be behind.
      expect(within(box()!).getByRole('button', { name: 'Send reply' }).hasAttribute('disabled')).toBe(true);
      await user.keyboard('{Meta>}{Enter}{/Meta}');
      expect(transport.mutations.some(request => request.command.command === 'input_submit')).toBe(false);
      await act(async () => { await store.refresh(); });
      await waitFor(() => expect(within(box()!).getByRole('button', { name: 'Send reply' }).hasAttribute('disabled')).toBe(false));
      expect(text.value).toBe('de1');
    } finally { window.removeEventListener('keydown', routeKey); document.removeEventListener('keydown', record, true); }
  });
  it('is not offered in a closed session', async () => {
    await mount({ configure: transport => { const session = transport.sessions.get(route.session_id)!; session.state = 'closed'; session.closed_at = session.updated_at; } });
    expect(within(topicRow('Delivery decisions')).queryByRole('button', { name: 'Reply to topic' })).toBeNull();
  });
});

describe('session tree answer handoff', () => {
  it.each(['2', '4', 'Delivery decisions'])('leaves a on %s for the workspace without opening a row editor', async target => {
    const { transport, calls } = await mount();
    const element = target === 'Delivery decisions' ? topicRow(target) : row(target);
    const reached: { target: EventTarget | null; prevented: boolean }[] = [];
    const record = (event: KeyboardEvent) => { reached.push({ target: event.target, prevented: event.defaultPrevented }); };
    document.body.addEventListener('keydown', record);
    try {
      element.focus(); fireEvent.keyDown(element, { key: 'a' });
      expect(reached).toEqual([{ target: element, prevented: false }]);
      expect(document.activeElement).toBe(element);
      expect(document.querySelector('.tree-answer')).toBeNull();
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(calls.selected).toEqual([]);
      expect(transport.mutations.some(request => request.command.command === 'input_submit')).toBe(false);
    } finally { document.body.removeEventListener('keydown', record); }
  });

  it.each(['2', 'Delivery decisions'])('leaves number keys on %s for the workspace', async target => {
    await mount();
    const element = target === 'Delivery decisions' ? topicRow(target) : row(target);
    const reached: { key: string; prevented: boolean }[] = [];
    const record = (event: KeyboardEvent) => { reached.push({ key: event.key, prevented: event.defaultPrevented }); };
    document.body.addEventListener('keydown', record);
    try {
      element.focus();
      fireEvent.keyDown(element, { key: '1' });
      fireEvent.keyDown(element, { key: '9' });
      expect(reached).toEqual([{ key: '1', prevented: false }, { key: '9', prevented: false }]);
    } finally { document.body.removeEventListener('keydown', record); }
  });

  it('selects a waiting row into Details on Enter without sending an answer', async () => {
    const { transport, calls } = await mount();
    row('2').focus(); fireEvent.keyDown(row('2'), { key: 'a' });
    fireEvent.keyDown(row('2'), { key: 'Enter' });
    await waitFor(() => expect(calls.selected).toHaveLength(1));
    expect(calls.selected[0]).toMatchObject({ kind: 'item', route: { item_id: '2' } });
    expect(calls.openedDetail).toEqual([true]);
    expect(transport.mutations.some(request => request.command.command === 'input_submit')).toBe(false);
    expect(document.querySelector('.tree-answer')).toBeNull();
  });
});

describe('session tree reading position', () => {
  it('saves the first visible row when focus leaves the tree and restores it on open', async () => {
    const rectangle = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.matches('[data-item-id="1"]')) return new DOMRect(0, -30, 300, 20);
      if (this.matches('[data-item-id="1.1"]')) return new DOMRect(0, 12, 300, 40);
      return rectangle.call(this);
    });
    const { transport } = await mount();
    const outside = document.createElement('button'); document.body.append(outside);
    row('1.1').focus(); outside.focus();
    await waitFor(() => expect(viewOf(transport).scroll).toEqual({ item_id: '1.1', offset: 12 }));
    const writes = patches(transport).length;
    row('1.1').focus(); outside.focus();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(patches(transport)).toHaveLength(writes);
    cleanup();
    await mount({ transport });
    expect(screen.getByRole('tree')).toBeTruthy();
    outside.remove();
  });
  // A 400 px scroller over rows 100 px apart that move with its scrollTop.
  const layout = () => {
    const rectangle = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = document.querySelector<HTMLElement>('.tree-scroll');
      if (this === box) return new DOMRect(0, 0, 300, 400);
      const id = this.getAttribute('data-item-id'), at = id ? ids().indexOf(id) : -1;
      if (this.getAttribute('role') === 'treeitem' && at >= 0) return new DOMRect(0, at * 100 - (box?.scrollTop ?? 0), 300, 40);
      return rectangle.call(this);
    });
  };
  const top = (id: string) => row(id).getBoundingClientRect().top;
  const savedAtTop = (transport: AppTransport) => {
    transport.preferences.sessions = transport.preferences.sessions.map(view =>
      view.session.session_id === route.session_id ? { ...view, scroll: { item_id: '1', offset: 0 } } : view);
  };
  it('restores the reading position even when the open item is off-screen', async () => {
    layout();
    await mount({ configure: savedAtTop, props: { selectedId: '8' } });
    // Detail closed: the saved position wins.
    expect(top('1')).toBe(0); expect(top('8')).toBe(800);
    cleanup();
    await mount({ configure: savedAtTop, props: { selectedId: '8', detailOpen: true } });
    expect(top('1')).toBe(0); expect(top('8')).toBe(800);
  });
  it('brings an explicit item route into view on mount even when the session has a reading anchor', async () => {
    layout();
    const first = await mount();
    let target: RevealedItem | null = null;
    await act(async () => { target = await first.navigation.routes.revealItem({ ...route, item_id: '8' }); });
    cleanup();
    await mount({ transport: first.transport, configure: savedAtTop, props: { selectedId: '8', reveal: target } });
    expect(top('8')).toBe(180);
  });
  it('places an opening selection after its hidden row mounts, when there is no saved anchor', async () => {
    layout();
    const view = await mount({ configure: transport => {
      const view = viewOf(transport);
      view.selected_item_id = '8'; view.scroll = null; view.hidden_item_ids = ['8'];
    }, props: { selectedId: '8' } });
    await waitFor(() => expect(row('8')).not.toBeNull());
    expect(top('8')).toBe(180);
    expect(view.calls.openedDetail).toEqual([false]);
  });
  it.each(['Waiting/link', 'Back/Forward'] as const)('allows later %s reveals after a saved archived selection cannot mount', async path => {
    layout();
    const view = await mount({ configure: transport => {
      const saved = viewOf(transport), session = transport.sessions.get(route.session_id)!;
      saved.selected_item_id = '8'; saved.scroll = null;
      session.topics[session.items['8']!.topic_id]!.archived_at = session.updated_at;
    }, props: { selectedId: '8' } });
    await waitFor(() => expect(view.calls.openedDetail).toEqual([false]));
    expect(row('8')).toBeNull();
    const box = document.querySelector<HTMLElement>('.tree-scroll')!;
    box.scrollTop = 600; fireEvent.scroll(box);
    const target: RevealedItem = { kind: 'item', route: { ...route, item_id: '2' }, store: view.store, temporaryExpandedItemIds: [] };
    view.rerender({ selectedId: '2', reveal: target, historyReveal: path === 'Back/Forward' ? target : null });
    expect(top('2')).toBe(8);
    expect(document.activeElement).toBe(row('2'));
    expect(notices.getSnapshot().some(notice => notice.id === 'tree-reveal-failed')).toBe(false);
  });
  it.each([true, false])('clears absent opening placement before View archive (owner scrolled: %s)', async scroll => {
    layout();
    const view = await mount({ configure: transport => {
      const saved = viewOf(transport), session = transport.sessions.get(route.session_id)!;
      saved.selected_item_id = '8'; saved.scroll = null;
      session.topics[session.items['8']!.topic_id]!.archived_at = session.updated_at;
    }, props: { selectedId: '8' } });
    await waitFor(() => expect(view.calls.openedDetail).toEqual([false]));
    const box = document.querySelector<HTMLElement>('.tree-scroll')!;
    box.scrollTop = 175;
    if (scroll) fireEvent.scroll(box);
    await act(async () => {
      const saved = view.navigation.getSnapshot().preferences!;
      const next = structuredClone(saved.sessions.find(value => value.session.session_id === route.session_id)!) as SessionPreferences;
      next.filters.archived = true;
      await view.navigation.saveSessionView(next, saved.revision);
    });
    expect(row('8')).not.toBeNull();
    expect(box.scrollTop).toBe(175);
  });
  it('finishes a timed-out opening quietly and allows a subsequent deliberate reveal', async () => {
    layout(); vi.useFakeTimers();
    const transport = new AppTransport(), invoke = transport.invoke.bind(transport);
    let release!: () => void, delayed = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if (name === 'reveal_item' && !delayed) { delayed = true; await gate; }
      return invoke(name, args);
    });
    const view = await mount({ transport, configure: transport => {
      const saved = viewOf(transport); saved.selected_item_id = '1.1'; saved.expanded_item_ids = []; saved.scroll = null;
    }, props: { selectedId: '1.1' } });
    expect(delayed).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(view.calls.selected).toHaveLength(0);
    expect(notices.getSnapshot().some(notice => notice.id === 'tree-reveal-failed')).toBe(false);
    const box = document.querySelector<HTMLElement>('.tree-scroll')!;
    box.scrollTop = 600; fireEvent.scroll(box);
    const target: RevealedItem = { kind: 'item', route: { ...route, item_id: '2' }, store: view.store, temporaryExpandedItemIds: [] };
    view.rerender({ selectedId: '2', reveal: target });
    expect(top('2')).toBe(8); expect(document.activeElement).toBe(row('2'));
    await act(async () => { release(); });
    expect(view.calls.selected).toHaveLength(0);
  });
  it('cancels unfinished opening placement when a visible row is clicked', async () => {
    layout();
    const transport = new AppTransport(), invoke = transport.invoke.bind(transport);
    let release!: () => void, delayed = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if (name === 'reveal_item' && !delayed) { delayed = true; await gate; }
      return invoke(name, args);
    });
    const view = await mount({ transport, configure: transport => {
      const saved = viewOf(transport);
      saved.selected_item_id = '1.1'; saved.expanded_item_ids = []; saved.scroll = null;
    }, props: { selectedId: '1.1' } });
    expect(delayed).toBe(true); expect(row('1.1')).toBeNull();
    const box = document.querySelector<HTMLElement>('.tree-scroll')!;
    box.scrollTop = 150; fireEvent.scroll(box);
    fireEvent.click(row('4'));
    await waitFor(() => expect(view.calls.selected).toHaveLength(1));
    view.rerender({ selectedId: '4', reveal: view.calls.selected[0], detailOpen: true });
    await waitFor(() => expect(view.navigation.getSnapshot().writing).toBe(false));
    expect(box.scrollTop).toBe(150);
    await act(async () => { release(); });
    expect(view.calls.selected).toHaveLength(1);
    expect(box.scrollTop).toBe(150);
  });

  it.each(['1.1', '2', 'graph'] as const)('cancels an active opening read when an external reveal mounts target %s', async destination => {
    const id = destination === 'graph' ? '2' : destination;
    layout();
    const transport = new AppTransport(), invoke = transport.invoke.bind(transport);
    let release!: () => void, delayed = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if (name === 'reveal_item' && !delayed) { delayed = true; await gate; }
      return invoke(name, args);
    });
    const view = await mount({ transport, configure: transport => {
      const saved = viewOf(transport); saved.selected_item_id = '1.1'; saved.expanded_item_ids = []; saved.scroll = null;
    }, props: { selectedId: '1.1' } });
    expect(delayed).toBe(true); expect(row('1.1')).toBeNull();
    // Mount the folded row in the same render as a deliberate request, including the same target.
    const target: RevealedItem = { kind: 'item', route: { ...route, item_id: id }, store: view.store, temporaryExpandedItemIds: ['1'] };
    view.rerender({ selectedId: id, reveal: target, ...(destination === 'graph' ? { graph: <p>Graph destination</p> } : {}) });
    if (destination === 'graph') expect(screen.getByText('Graph destination')).toBeTruthy();
    else expect(row('1.1')).not.toBeNull();
    const box = document.querySelector<HTMLElement>('.tree-scroll'), scroll = box?.scrollTop;
    await act(async () => { release(); });
    expect(view.calls.selected).toHaveLength(0);
    expect(box?.scrollTop).toBe(scroll);
    expect(notices.getSnapshot().some(notice => notice.id === 'tree-reveal-failed')).toBe(false);
  });
  it('keeps an offscreen selection in place when detail opens', async () => {
    layout();
    const { rerender } = await mount({ configure: savedAtTop, props: { selectedId: '8' } });
    expect(top('8')).toBe(800);
    rerender({ detailOpen: true });
    expect(top('8')).toBe(800);
  });
  it('leaves a visible selection in place when detail opens', async () => {
    layout();
    const { rerender } = await mount({ configure: savedAtTop, props: { selectedId: '3' } });
    const before = top('3');
    rerender({ detailOpen: true });
    expect(top('3')).toBe(before);
  });

  it.each(['detail', 'window'] as const)('keeps the reading anchor when %s changes and text reflows', async change => {
    let width = 300, spacing = 100;
    const observers: { run: () => void; targets: Set<Element> }[] = [];
    vi.stubGlobal('ResizeObserver', class {
      targets = new Set<Element>();
      constructor(run: () => void) { observers.push({ run, targets: this.targets }); }
      observe(target: Element) { this.targets.add(target); }
      disconnect() { this.targets.clear(); }
    });
    const rectangle = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = document.querySelector<HTMLElement>('.tree-scroll');
      if (this === box) return new DOMRect(0, 0, width, 400);
      const id = this.getAttribute('data-item-id'), at = id ? ids().indexOf(id) : -1;
      if (at >= 0) return new DOMRect(0, at * spacing - (box?.scrollTop ?? 0), width, 40);
      return rectangle.call(this);
    });
    try {
      const view = await mount({ configure: transport => {
        transport.preferences.sessions = transport.preferences.sessions.map(view => ({ ...view, scroll: { item_id: '4', offset: 20 } }));
      }, props: { selectedId: '8' } });
      const box = document.querySelector<HTMLElement>('.tree-scroll')!;
      expect(box.scrollTop).toBe(380);
      if (change === 'detail') view.rerender({ detailOpen: true });
      expect(box.scrollTop).toBe(380);
      // The native layout's observer arrives after the panel state has rendered.
      width = 200; spacing = 120;
      act(() => observers.filter(observer => observer.targets.size).forEach(observer => observer.run()));
      expect(box.scrollTop).toBe(460);
      expect(top('4')).toBe(20);
    } finally { vi.unstubAllGlobals(); }
  });

  it.each([-34.4, 34.4])('keeps an ordinary reading anchor when the edge observer sees a %s px resize reflow first', async shift => {
    let width = 300, reflow = 0;
    const observers: { run: () => void; targets: Set<Element> }[] = [];
    vi.stubGlobal('ResizeObserver', class {
      targets = new Set<Element>();
      constructor(run: () => void) { observers.push({ run, targets: this.targets }); }
      observe(target: Element) { this.targets.add(target); }
      disconnect() { this.targets.clear(); }
    });
    const rectangle = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = document.querySelector<HTMLElement>('.tree-scroll');
      if (this === box) return new DOMRect(0, 0, width, 400);
      if (this.matches('.tree-topic')) return new DOMRect(0, 0, width, 20);
      const id = this.getAttribute('data-item-id'), at = id ? ids().indexOf(id) : -1, target = ids().indexOf('4');
      if (at >= 0 && this.getAttribute('role') === 'treeitem') {
        return new DOMRect(0, at * 100 - (box?.scrollTop ?? 0) + (at >= target ? reflow : 0), width,
          at === target - 1 ? 100 + reflow : 100);
      }
      return rectangle.call(this);
    });
    try {
      await mount({ configure: transport => {
        viewOf(transport).scroll = { item_id: '4', offset: 0 };
      }, props: { selectedId: '4', detailOpen: true } });
      const box = document.querySelector<HTMLElement>('.tree-scroll')!;
      // Ordinary reading has finished the opening restoration and has no deliberate reveal to pin it.
      fireEvent.wheel(box); fireEvent.scroll(box);
      expect(top('4')).toBe(20);
      const edge = observers.find(observer => observer.targets.has(box)
        && !observer.targets.has(row('4')) && [...observer.targets].some(target => target.matches('.tree-rows')))!;
      const correction = observers.find(observer => !observer.targets.has(box)
        && [...observer.targets].some(target => target.matches('.tree-rows')))!;
      width = shift < 0 ? 500 : 200; reflow = shift;
      // The scroller/edge callback can arrive before the content callback after a window resize.
      act(() => edge.run());
      act(() => correction.run());
      expect(top('4')).toBeCloseTo(20);
      expect(box.scrollTop).toBeCloseTo(380 + shift);
    } finally { vi.unstubAllGlobals(); }
  });

  it.each([-0.06, 0, 0.06])('holds item 7 at %s px from the sticky edge through detail, widening, and narrowing', async offset => {
    const headerHeight = 85.39;
    let width = 700, reflow = 0;
    const observers: { run: () => void; targets: Set<Element> }[] = [];
    vi.stubGlobal('ResizeObserver', class {
      targets = new Set<Element>();
      constructor(run: () => void) { observers.push({ run, targets: this.targets }); }
      observe(target: Element) { this.targets.add(target); }
      disconnect() { this.targets.clear(); }
    });
    const rectangle = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = document.querySelector<HTMLElement>('.tree-scroll');
      if (this === box) return new DOMRect(0, 0, width, 400);
      if (this.matches('.tree-topic')) return new DOMRect(0, 0, width, headerHeight);
      const id = this.getAttribute('data-item-id'), at = id ? ids().indexOf(id) : -1, target = ids().indexOf('7');
      if (at >= 0 && this.getAttribute('role') === 'treeitem') {
        const readingHeight = width === 800 ? 162.4 : 176.8;
        return new DOMRect(0, at * 100 + (at >= target ? reflow : 0) + (at > target ? readingHeight - 100 : 0) - (box?.scrollTop ?? 0), width,
          at === target - 1 ? 100 + reflow : at === target ? readingHeight : 100);
      }
      return rectangle.call(this);
    });
    try {
      const view = await mount({ configure: transport => {
        viewOf(transport).scroll = { item_id: '7', offset };
      }, props: { selectedId: '7' } });
      const box = document.querySelector<HTMLElement>('.tree-scroll')!;
      fireEvent.wheel(box); fireEvent.scroll(box);
      const before = top('7');
      expect(before).toBeCloseTo(headerHeight + offset);
      // The predecessor ends at the same sub-pixel edge where the reading row starts.
      const predecessor = row(ids()[ids().indexOf('7') - 1]!);
      expect(predecessor.getBoundingClientRect().bottom).toBeCloseTo(before);
      const deliver = () => {
        const active = observers.filter(observer => observer.targets.size);
        const edge = active.find(observer => observer.targets.has(box) && !observer.targets.has(row('7'))
          && [...observer.targets].some(target => target.matches('.tree-rows')))!;
        act(() => edge.run());
        act(() => edge.run());
        act(() => active.find(observer => !observer.targets.has(box)
          && [...observer.targets].some(target => target.matches('.tree-rows')))!.run());
      };
      fireEvent.pointerDown(row('7')); fireEvent.click(row('7'));
      await waitFor(() => expect(view.calls.selected.at(-1)).toMatchObject({ route: { item_id: '7' } }));
      width = 560; reflow = 52; view.rerender({ detailOpen: true }); deliver();
      expect(top('7')).toBeCloseTo(before);
      width = 800; reflow = -52; deliver();
      expect(top('7')).toBeCloseTo(before);
      expect(row('7').getBoundingClientRect().height).toBeCloseTo(162.4);
      // Our first correction queues a scroll event. A second reflow can land before
      // that event, without changing scrollTop or delivering another observer yet.
      const correctedScroll = box.scrollTop;
      reflow += 34.4;
      expect(box.scrollTop).toBe(correctedScroll);
      fireEvent.scroll(box);
      expect(top('7')).toBeCloseTo(before);
      expect(box.scrollTop).toBeCloseTo(correctedScroll + 34.4);
      deliver();
      expect(top('7')).toBeCloseTo(before);
      reflow -= 16.4; deliver();
      expect(top('7')).toBeCloseTo(before);
      width = 656; reflow = 18; deliver();
      expect(top('7')).toBeCloseTo(before);
      expect(row('7').getBoundingClientRect().height).toBeCloseTo(176.8);
      // Narrowing measures the new text width first. Preview clamping then reflows the
      // preceding row again, and the edge callback can run before content correction.
      reflow += 16.4;
      fireEvent.scroll(box);
      expect(top('7')).toBeCloseTo(before);
      deliver();
      expect(top('7')).toBeCloseTo(before);
      deliver();
      expect(top('7')).toBeCloseTo(before);
      await act(async () => { fireEvent.blur(row('7'), { relatedTarget: document.body }); });
      expect(viewOf(view.transport).scroll?.item_id).toBe('7');
      expect(viewOf(view.transport).scroll?.offset).toBeCloseTo(offset);
    } finally { vi.unstubAllGlobals(); }
  });

  it('holds the selected row when closing detail shortens a visible predecessor by one line without browser anchoring', async () => {
    let shrink = 0;
    const callbacks: (() => void)[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(run: () => void) { callbacks.push(run); }
      observe() {} disconnect() {}
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = document.querySelector<HTMLElement>('.tree-scroll');
      if (this === box) return new DOMRect(0, 0, shrink ? 500 : 300, 400);
      const id = this.getAttribute('data-item-id'), at = id ? ids().indexOf(id) : -1;
      return at >= 0 && this.getAttribute('role') === 'treeitem'
        ? new DOMRect(0, at * 100 - (box?.scrollTop ?? 0) - (at >= 4 ? shrink : 0), 300, at === 3 ? 100 - shrink : 100) : new DOMRect();
    });
    try {
      const view = await mount({ props: { selectedId: '4', detailOpen: true } });
      const box = document.querySelector<HTMLElement>('.tree-scroll')!;
      box.scrollTop = 250; fireEvent.scroll(box);
      const before = row('4').getBoundingClientRect().top;
      expect(before).toBe(150);
      // Row 3 is the first visible reading anchor; its top does not move. Row 4 does.
      shrink = 21; view.rerender({ detailOpen: false });
      act(() => callbacks.forEach(run => run()));
      expect(row('4').getBoundingClientRect().top).toBe(before);
      const css = readFileSync(resolve(__dirname, '../../../src/ui/tree/tree.css'), 'utf8');
      expect(css.match(/\.tree-scroll\s*\{([^}]+)\}/)?.[1]).toContain('overflow-anchor: none');
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('item details in the tree', () => {
  const long = Array.from({ length: 20 }, (_, index) => `Line ${index + 1} of a long finding the agent wrote.`).join('\n');
  // jsdom has no native text geometry. Supply rendered text lines; container pixels are irrelevant.
  const measure = (count: (node: Node) => number = node => (node.parentElement?.closest('.tree-clamp')?.textContent?.length ?? 0) > 100 ? 20 : 1,
    lineHeight = () => 21) => {
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = new Range(); let node: Node;
      range.selectNodeContents = target => { node = target; };
      range.getClientRects = () => Object.assign(Array.from({ length: count(node) }, (_, index) => new DOMRect(0, index * lineHeight() + 3, 120, lineHeight() - 6)), { item: () => null });
      return range;
    });
    const computed = window.getComputedStyle;
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
      const style = document.createElement('span').style; style.cssText = computed(element, pseudo).cssText;
      if (element.closest('.tree-clamp')) { style.lineHeight = `${lineHeight()}px`; style.fontSize = '14px'; }
      return style;
    });
  };
  const longOutcome = (transport: AppTransport) => { transport.sessions.get(route.session_id)!.items['1']!.outcome = long; };
  const more = (id: string) => within(row(id)).queryByRole('button', { name: /^Show (more|less)$/ });

  it('folds a long body to four lines with Show more and Show less, and none for short text', async () => {
    measure();
    const { calls } = await mount({ configure: longOutcome });
    const preview = row('1').querySelector<HTMLElement>('.tree-preview')!;
    expect(preview.style.getPropertyValue('--tree-clamp')).toBe('4');
    expect(preview.hasAttribute('data-open')).toBe(false);
    // Short details and titles have no control.
    expect(more('5')).toBeNull(); expect(more('3')).toBeNull();
    expect(row('1').querySelector('.tree-question')!.classList.contains('tree-clamp')).toBe(false);
    const button = more('1')!;
    expect(button.textContent).toBe('Show more'); expect(button.tabIndex).toBe(0); expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(more('1')!.textContent).toBe('Show less'); expect(preview.hasAttribute('data-open')).toBe(true);
    expect(more('1')!.getAttribute('aria-expanded')).toBe('true');
    // Unfolding one item opens nothing else and selects nothing.
    expect(calls.selected).toHaveLength(0); expect(row('1').getAttribute('aria-selected')).toBe('false');
    expect(row('1').getAttribute('aria-expanded')).toBe('true');
    // The unfolded state is per item and outlives the rows being rebuilt.
    cleanup();
    await mount({ configure: longOutcome });
    expect(more('1')!.textContent).toBe('Show less');
    fireEvent.click(more('1')!);
    expect(more('1')!.textContent).toBe('Show more');
    expect(row('1').querySelector('.tree-preview')!.hasAttribute('data-open')).toBe(false);
  });

  it('never clamps a title and keeps status beside it without item numbers', async () => {
    measure();
    await mount({ configure: transport => {
      const item = transport.sessions.get(route.session_id)!.items['4']!;
      item.question = 'A long title that needs more room. '.repeat(15); item.outcome = null;
    } });
    expect(more('4')).toBeNull();
    expect(row('4').querySelector('.tree-question.tree-clamp')).toBeNull();
    // The status sits in the end cluster's reserved badge slot, beside the title's first line, not in the heading.
    expect(row('4').querySelector('.tree-end > .tree-end-badge')?.textContent).toBe('Open');
    expect(row('4').querySelector('.tree-heading')?.textContent).toBe(row('4').querySelector('.tree-question')?.textContent);
    expect(document.querySelector('.tree-id')).toBeNull();
    expect(row('4').textContent).not.toMatch(/#4|^4/);
  });

  it('lets Show more and Show less steer after a deliberate reveal instead of restoring its old anchor', async () => {
    measure();
    const observers: { run: () => void; targets: Set<Element> }[] = [];
    vi.stubGlobal('ResizeObserver', class {
      targets = new Set<Element>();
      constructor(run: () => void) { observers.push({ run, targets: this.targets }); }
      observe(target: Element) { this.targets.add(target); }
      disconnect() { this.targets.clear(); }
    });
    const rectangle = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = document.querySelector<HTMLElement>('.tree-scroll');
      if (this === box) return new DOMRect(0, 0, 300, 400);
      if (this.matches('.tree-topic')) return new DOMRect(0, 0, 300, 20);
      const id = this.getAttribute('data-item-id'), at = id ? ids().indexOf(id) : -1, target = ids().indexOf('3');
      const extra = row('3')?.querySelector('.tree-preview')?.hasAttribute('data-open') ? 200 : 0;
      if (at >= 0 && this.getAttribute('role') === 'treeitem') {
        return new DOMRect(0, at * 100 + (at > target ? extra : 0) - (box?.scrollTop ?? 0), 300, at === target ? 100 + extra : 100);
      }
      return rectangle.call(this);
    });
    try {
      await mount({ configure: transport => {
        transport.sessions.get(route.session_id)!.items['3']!.outcome = long;
        viewOf(transport).scroll = { item_id: '4', offset: 20 };
      }, props: { selectedId: '4' } });
      const box = document.querySelector<HTMLElement>('.tree-scroll')!;
      backToSelected();
      expect(row('4').getBoundingClientRect().top).toBe(40);
      const scroll = box.scrollTop;
      const deliver = () => act(() => observers.filter(observer => !observer.targets.has(box)
        && [...observer.targets].some(target => target.matches('.tree-rows'))).forEach(observer => observer.run()));
      fireEvent.click(more('3')!);
      deliver();
      expect(box.scrollTop).toBe(scroll);
      expect(row('4').getBoundingClientRect().top).toBe(240);
      fireEvent.click(more('3')!);
      deliver();
      expect(row('3').getBoundingClientRect().top).toBe(20);
      expect(row('4').getBoundingClientRect().top).toBe(120);
    } finally { vi.unstubAllGlobals(); }
  });

  it.each([4, 5, 6, 7, 8])('clamps %s body lines only if at least three would be hidden', async lines => {
    measure(node => node.parentElement?.closest('[data-item-id="4"]') ? lines : 1);
    await mount({ configure: transport => { transport.sessions.get(route.session_id)!.items['4']!.outcome = 'Body with a measured height.'; } });
    expect(!!more('4')).toBe(lines >= 7);
    expect(row('4').querySelector('.tree-preview')!.hasAttribute('data-clamped')).toBe(lines >= 7);
    if (lines >= 7) {
      fireEvent.click(more('4')!);
      expect(row('4').querySelector('.tree-preview')!.hasAttribute('data-clamped')).toBe(false);
      fireEvent.click(more('4')!);
      expect(row('4').querySelector('.tree-preview')!.hasAttribute('data-clamped')).toBe(true);
    }
  });

  it('remeasures real lines and the complete fourth-line boundary after the clipped text resizes', async () => {
    let line = 21, lines = 7;
    const observers: { run: () => void; targets: Set<Element> }[] = [];
    vi.stubGlobal('ResizeObserver', class {
      targets = new Set<Element>();
      constructor(run: () => void) { observers.push({ run, targets: this.targets }); }
      observe(target: Element) { this.targets.add(target); }
      disconnect() { this.targets.clear(); }
    });
    measure(node => node.parentElement?.closest('[data-item-id="4"]') ? lines : 1, () => line);
    try {
      await mount({ configure: transport => { transport.sessions.get(route.session_id)!.items['4']!.outcome = 'Body with a measured height.'; } });
      const excerpt = row('4').querySelector('.tree-clamp')!;
      expect(more('4')).not.toBeNull();
      lines = 6; line = 25.2; act(() => observers.find(observer => observer.targets.has(excerpt))!.run());
      expect(more('4')).toBeNull();
      expect(parseFloat(row('4').querySelector<HTMLElement>('.tree-preview')!.style.getPropertyValue('--tree-clamp-height'))).toBeCloseTo(100.8);
      const css = readFileSync(resolve(__dirname, '../../../src/ui/tree/tree.css'), 'utf8');
      expect(css).toContain('--tree-preview-line: calc(21px * var(--text-scale))');
      expect(css).toContain('max-height: var(--tree-clamp-height)');
    } finally { vi.unstubAllGlobals(); }
  });

  it('clamps a long waiting preview without rendering answer controls in the row', async () => {
    measure();
    await mount({ configure: transport => {
      const item = transport.sessions.get(route.session_id)!.items['2']!; item.ask = long;
      item.options = Array.from({ length: 3 }, (_, index) => ({ id: crypto.randomUUID(), label: `Option ${index + 1}`, consequence: long, recommended: index === 0 }));
    } });
    row('2').focus(); fireEvent.keyDown(row('2'), { key: 'a' });
    expect(row('2').querySelector('.tree-answer')).toBeNull();
    expect(row('2').querySelector('.answer-option')).toBeNull();
    expect(within(row('2')).queryByRole('textbox')).toBeNull();
    expect(row('2').querySelector('.tree-preview[data-clamped]')).not.toBeNull();
  });

  it('unfolds the body when keyboard focus reaches a link inside its clipped text', async () => {
    measure();
    await mount({ configure: transport => { transport.sessions.get(route.session_id)!.items['1']!.outcome = `${long}\n[Read the evidence](https://example.com)`; } });
    expect(row('1').querySelector('.tree-preview[data-clamped]')).not.toBeNull();
    const link = within(row('1')).getByRole('link', { name: 'Read the evidence' });
    const matches = link.matches.bind(link);
    vi.spyOn(link, 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
    act(() => link.focus());
    expect(document.activeElement).toBe(link);
    expect(row('1').querySelector('.tree-preview[data-clamped]')).toBeNull();
    expect(more('1')!.textContent).toBe('Show less');
  });

  it('tabs from a top-level row to its preview link and Show more while skipping the Focus action', async () => {
    measure();
    await mount({ configure: transport => { transport.sessions.get(route.session_id)!.items['1']!.outcome = `[Read the evidence](https://example.com)\n${long}`; } });
    const link = within(row('1')).getByRole('link', { name: 'Read the evidence' });
    const matches = link.matches.bind(link);
    vi.spyOn(link, 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
    act(() => row('1').focus());
    await userEvent.tab();
    expect(document.activeElement).toBe(link);
    expect(row('1').querySelector('.tree-preview[data-clamped]')).toBeNull();
    await userEvent.tab();
    expect(document.activeElement).toBe(more('1'));
    await userEvent.tab();
    const focus = within(row('1')).getByRole('button', { name: /^Focus on / });
    expect(focus.tabIndex).toBe(-1);
    expect(document.activeElement).not.toBe(focus);
  });

  it('preserves full Markdown structure and agent-written item links without selecting their row', async () => {
    const { calls, openLink } = await mount({ configure: transport => {
      transport.sessions.get(route.session_id)!.items['1']!.outcome = '**Bold** and `code`, [website](https://example.com) and [next item](item:4).\n\n| Name | Value |\n| --- | --- |\n| Result | **Ready** |';
    } });
    const excerpt = row('1').querySelector('.tree-outcome')!;
    expect(excerpt.querySelector('strong')?.textContent).toBe('Bold');
    expect(excerpt.querySelector('code')?.textContent).toBe('code');
    expect(within(row('1')).getByRole('table')).toBeTruthy();
    fireEvent.click(within(row('1')).getByRole('link', { name: 'website' }));
    expect(openLink).toHaveBeenCalledWith('https://example.com'); expect(calls.selected).toHaveLength(0);
    fireEvent.click(within(row('1')).getByRole('link', { name: 'next item' }));
    await waitFor(() => expect(calls.selected).toHaveLength(1));
    expect(calls.selected[0]).toMatchObject({ kind: 'item', route: { item_id: '4' } });
  });

  it('groups each topic with its items and separates roots more than children with continuous guides', async () => {
    await mount();
    const groups = document.querySelectorAll('.tree-topic-group');
    expect(groups).toHaveLength(2);
    expect(groups[0]!.firstElementChild).toBe(topicRow('Delivery decisions'));
    expect(groups[0]!.contains(row('7'))).toBe(true);
    expect(groups[0]!.contains(row('8'))).toBe(false);
    expect(groups[1]!.lastElementChild).toBe(row('8'));
    expect(row('1').classList.contains('tree-item-root')).toBe(true);
    expect(row('1.1').classList.contains('tree-item-child')).toBe(true);
    expect(row('1.1').querySelector('.tree-elbow')).not.toBeNull();
    const css = readFileSync(resolve(__dirname, '../../../src/ui/tree/tree.css'), 'utf8');
    expect(css).toMatch(/\.tree-topic\s*\{[^}]*position: sticky;[^}]*top: 0;[^}]*background: var\(--a-side\)/s);
    expect(css).toMatch(/\.tree-item\s*\{[^}]*padding-top: 12px;[^}]*padding-bottom: 14px;[^}]*border-bottom: 1px solid var\(--color-divider\)/s);
    expect(css).toMatch(/\.tree-item-root\s*\{[^}]*padding-top: 20px/s);
    expect(css).toMatch(/scroll-padding-top: var\(--tree-header-height, 0\)/);
  });

  it('keeps an item’s details while a message to the agent is on its way', async () => {
    const delivering = (transport: AppTransport) => {
      const session = transport.sessions.get(route.session_id)!;
      const sent = structuredClone(Object.values(session.inputs).find(input => input?.state === 'in_flight')!);
      sent.id = '00000000-0000-4000-8000-000000000099'; sent.seq = 99; sent.kind = 'followup';
      sent.target = { topic_id: sent.target.topic_id, item_id: '5' };
      session.inputs[sent.id] = sent;
    };
    await mount({ configure: delivering });
    // A closed item keeps its outcome and gains the delivery as a small line.
    expect(row('5').querySelector('.tree-outcome')?.textContent).toBe('Recorded final decision.');
    expect(row('5').querySelector('.tree-delivery')?.textContent).toMatch(/^Follow-up received/);
    // An item being worked on keeps its note beside its reply in flight.
    expect(row('3').textContent).toContain('Receipt lookup is underway.');
    expect(row('3').querySelector('.tree-delivery')?.textContent).toMatch(/^Your reply was received/);
    // A stopped delivery shows its fix under the details, not in their place.
    expect(row('7').textContent).toContain('Replaced by');
    expect(row('7').querySelector('.stuck-note')).not.toBeNull();
  });

  it('floats the shortcut icons over the row so the text never changes width on hover', async () => {
    await mount();
    const body = row('4').querySelector('.tree-body')!, before = row('4').innerHTML;
    expect(row('4').querySelector('.tree-end > .tree-actions')).not.toBeNull();
    fireEvent.mouseEnter(row('4'));
    expect(row('4').innerHTML).toBe(before); expect(row('4').querySelector('.tree-body')).toBe(body);
    // The hover bar is absolute inside the end cluster (it takes no room) and only fades in; it is never display:none,
    // so showing it lays nothing out again. The cluster's slots keep fixed widths (alpha.20 C4).
    const css = readFileSync(resolve(__dirname, '../../../src/ui/tree/tree.css'), 'utf8');
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, selector]) => /\.tree-actions\b/.test(selector!));
    expect(rules.length).toBeGreaterThan(0);
    for (const [, , declarations] of rules) expect(declarations).not.toMatch(/display:\s*none|width:/);
    expect(rules.some(([, , declarations]) => /position:\s*absolute/.test(declarations!) && /visibility:\s*hidden/.test(declarations!)
      && /opacity:\s*0/.test(declarations!))).toBe(true);
    expect(css).toMatch(/\.tree-end\s*\{[^}]*position: relative/);
    for (const slot of ['marker', 'related']) expect(css).toMatch(new RegExp(`\\.tree-end-${slot}\\s*\\{\\s*width: var\\(--tree-end-${slot}\\)`));
    expect(css).toMatch(/\.tree-ack-slot\s*\{\s*width: var\(--tree-end-ack\)/);
  });
  it('keeps the space of a topic band’s actions so the topic name never rewraps on hover or focus', async () => {
    await mount({ configure: transport => {
      const session = transport.sessions.get(route.session_id)!;
      for (const item of Object.values(session.items)) if (item) item.status = 'done';
    } });
    const band = topicRow('Delivery decisions'), before = band.innerHTML;
    expect(band.querySelector('.tree-topic-actions')).not.toBeNull();
    fireEvent.mouseEnter(band); band.focus();
    expect(band.innerHTML).toBe(before);
    const css = readFileSync(resolve(__dirname, '../../../src/ui/tree/tree.css'), 'utf8');
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, selector]) => /\.tree-topic-actions\b/.test(selector!));
    const hidden = rules.filter(([, , declarations]) => /visibility:\s*hidden/.test(declarations!));
    const shown = rules.filter(([, , declarations]) => /visibility:\s*visible/.test(declarations!));
    // Hidden by visibility and opacity only: no rule takes the actions out of the flow, at rest or on hover or focus.
    expect(hidden).toHaveLength(1); expect(hidden[0]![2]).toMatch(/opacity:\s*0/);
    expect(shown).toHaveLength(1); expect(shown[0]![1]).toMatch(/:hover[^,]*\.tree-topic-actions/); expect(shown[0]![1]).toMatch(/:focus-within/);
    for (const [, , declarations] of rules) expect(declarations).not.toMatch(/display:\s*none|width:|position:\s*absolute/);
    // The buttons stay out of the tab order while hidden, like the item shortcuts.
    for (const button of band.querySelectorAll('.tree-topic-actions button')) expect((button as HTMLElement).tabIndex).toBe(-1);
    // Icon-only like the item shortcuts, so the reserved room is small: each has its plain name and a distinct icon.
    const buttons = [...band.querySelectorAll<HTMLElement>('.tree-topic-actions button')];
    expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual(['Reply to topic', 'Continue here', 'Archive', 'Remove']);
    for (const button of buttons) { expect(button.textContent).toBe(''); expect(button.title).not.toBe(''); }
    expect(new Set(buttons.map(button => button.querySelector('i')!.className)).size).toBe(buttons.length);
  });
});

describe('scrolling the tree', () => {
  it('keeps a breadcrumb reveal below the pinned header when its chain shortens and an edge callback precedes reflow correction', async () => {
    let shrink = 0;
    const callbacks: { run: () => void; targets: Set<Element> }[] = [];
    vi.stubGlobal('ResizeObserver', class {
      targets = new Set<Element>();
      constructor(run: () => void) { callbacks.push({ run, targets: this.targets }); }
      observe(target: Element) { this.targets.add(target); }
      disconnect() { this.targets.clear(); }
    });
    const rectangle = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = document.querySelector<HTMLElement>('.tree-scroll');
      if (this === box) return new DOMRect(0, 100, 300, 400);
      if (this.matches('.tree-topic')) return new DOMRect(0, 100, 300, 60);
      const id = this.getAttribute('data-item-id'), at = id ? ids().indexOf(id) : -1, target = ids().indexOf('deep-1');
      if (at >= 0 && this.getAttribute('role') === 'treeitem') {
        return new DOMRect(0, 100 + at * 200 - (box?.scrollTop ?? 0) - (at >= target ? shrink : 0), 300, at === target - 1 ? 200 - shrink : 100);
      }
      return rectangle.call(this);
    });
    try {
      const view = await mount({ configure: transport => {
        const session = transport.sessions.get(route.session_id)!, saved = viewOf(transport);
        for (let level = 0; level < 5; level++) {
          const id = `deep-${level}`;
          session.items[id] = { ...session.items['1.1']!, id, ordinal: 100 + level, parent: level ? `deep-${level - 1}` : '1', question: `Level ${level}`, short: `Level ${level}` };
          saved.expanded_item_ids.push(id);
        }
      } });
      const box = scroller(), slot = screen.getByRole('navigation', { name: 'Map ancestors' });
      box.scrollTop = ids().indexOf('deep-4') * 200 - 70; fireEvent.scroll(box);
      expect(within(slot).getAllByRole('button').map(button => button.textContent)).toEqual(['Level 1', 'Level 2', 'Level 3']);
      fireEvent.click(within(slot).getByRole('button', { name: 'Level 1' }));
      await waitFor(() => expect(view.calls.selected.at(-1)).toMatchObject({ kind: 'item', route: { item_id: 'deep-1' } }));
      expect(row('deep-1').getBoundingClientRect().top).toBe(168);
      expect(within(slot).getAllByRole('button')).toHaveLength(2);
      // A late preview clamp runs after the breadcrumb changed; the edge observer
      // may see that new geometry before the observer that repairs the reading anchor.
      shrink = 108;
      act(() => callbacks.find(callback => callback.targets.has(box) && [...callback.targets].some(target => target.matches('.tree-rows')))!.run());
      act(() => callbacks.find(callback => !callback.targets.has(box) && [...callback.targets].some(target => target.matches('.tree-rows')))!.run());
      expect(row('deep-1').getBoundingClientRect().top).toBe(168);
      expect(row('deep-1').getBoundingClientRect().bottom).toBeLessThanOrEqual(box.getBoundingClientRect().bottom);
      expect(within(slot).getAllByRole('button')).toHaveLength(2);
      // Back to the selected item, asked while the tree holds a reveal.
      backToSelected();
      shrink = 140;
      act(() => callbacks.find(callback => callback.targets.has(box) && [...callback.targets].some(target => target.matches('.tree-rows')))!.run());
      act(() => callbacks.find(callback => !callback.targets.has(box) && [...callback.targets].some(target => target.matches('.tree-rows')))!.run());
      expect(row('deep-1').getBoundingClientRect().top).toBe(168);
    } finally { vi.unstubAllGlobals(); }
  });

  it('keeps ancestor names in a permanent slot outside rows and reveals the chosen ancestor', async () => {
    layout();
    const view = await mount({ configure: transport => {
      const session = transport.sessions.get(route.session_id)!, saved = viewOf(transport);
      for (let level = 0; level < 5; level++) {
        const id = `deep-${level}`;
        session.items[id] = { ...session.items['1.1']!, id, ordinal: 100 + level, parent: level ? `deep-${level - 1}` : '1', question: `Level ${level}`, short: `Level ${level}` };
        saved.expanded_item_ids.push(id);
      }
    } });
    const slot = screen.getByRole('navigation', { name: 'Map ancestors' });
    expect(document.querySelector('.tree-scroll')!.contains(slot)).toBe(false);
    const box = scroller();
    box.scrollTop = ids().indexOf('deep-4') * 100; fireEvent.scroll(box);
    expect(within(slot).getAllByRole('button').map(button => button.textContent)).toEqual(['Level 1', 'Level 2', 'Level 3']);
    const css = readFileSync(resolve(__dirname, '../../../src/ui/tree/tree.css'), 'utf8');
    expect(css).toMatch(/\.tree-breadcrumb\s*\{[^}]*height: 28px/);
    fireEvent.click(within(slot).getByRole('button', { name: 'Level 2' }));
    await waitFor(() => expect(view.calls.selected.at(-1)).toMatchObject({ kind: 'item', route: { item_id: 'deep-2' } }));
    expect(screen.getByRole('navigation', { name: 'Map ancestors' })).toBe(slot);
  });

  it('returns keyboard focus to the selected row when Enter activates its tag', async () => {
    await opened({ props: { selectedId: '8' } });
    fireEvent.scroll(scroller());
    const tag = backPill('below');
    tag.focus(); await userEvent.keyboard('{Enter}');
    expect(document.activeElement).toBe(row('8'));
    expect(row('8').getBoundingClientRect().top).toBeGreaterThanOrEqual(8);
  });

  it('names ancestors of the first fully visible row below pinned chrome, skipping a clipped predecessor after reflow', async () => {
    let predecessorGrowth = 0;
    let viewportHeight = 400;
    const callbacks: { run: () => void; targets: Set<Element> }[] = [];
    vi.stubGlobal('ResizeObserver', class {
      targets = new Set<Element>();
      constructor(run: () => void) { callbacks.push({ run, targets: this.targets }); }
      observe(target: Element) { this.targets.add(target); }
      disconnect() { this.targets.clear(); }
    });
    const rectangle = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = document.querySelector<HTMLElement>('.tree-scroll');
      if (this === box) return new DOMRect(0, 100, 300, viewportHeight);
      if (this.matches('.tree-topic')) return new DOMRect(0, 100, 300, 60);
      const id = this.getAttribute('data-item-id'), at = id ? ids().indexOf(id) : -1;
      if (at >= 0 && this.getAttribute('role') === 'treeitem') {
        return new DOMRect(0, 100 + at * 100 - (box?.scrollTop ?? 0) + (id === 'deep-4' ? predecessorGrowth : 0), 300, id === 'deep-3' ? 100 + predecessorGrowth : 40);
      }
      return rectangle.call(this);
    });
    try {
      await mount({ configure: transport => {
        const session = transport.sessions.get(route.session_id)!, saved = viewOf(transport);
        for (let level = 0; level < 5; level++) {
          const id = `deep-${level}`;
          session.items[id] = { ...session.items['1.1']!, id, ordinal: 100 + level, parent: level ? `deep-${level - 1}` : '1', question: `Level ${level}`, short: `Level ${level}` };
          saved.expanded_item_ids.push(id);
        }
      } });
      const box = scroller(), slot = screen.getByRole('navigation', { name: 'Map ancestors' });
      box.scrollTop = ids().indexOf('deep-4') * 100 - 68; fireEvent.scroll(box);
      expect(row('deep-3').getBoundingClientRect().bottom).toBe(168);
      expect(row('deep-4').getBoundingClientRect().top).toBe(168);
      expect(within(slot).getAllByRole('button').map(button => button.textContent)).toEqual(['Level 1', 'Level 2', 'Level 3']);
      predecessorGrowth = 20;
      act(() => callbacks.find(callback => [...callback.targets].some(target => target.matches('.tree-rows')) && !callback.targets.has(box))!.run());
      expect(row('deep-4').getBoundingClientRect().top).toBe(188);
      expect(within(slot).getAllByRole('button').map(button => button.textContent)).toEqual(['Level 1', 'Level 2', 'Level 3']);
      // An item hidden by the pinned topic is not the first fully visible row.
      box.scrollTop += 40; fireEvent.scroll(box);
      expect(within(slot).queryAllByRole('button').map(button => button.textContent)).not.toEqual(['Level 1', 'Level 2', 'Level 3']);
      // Neither is a row whose bottom is outside the window.
      box.scrollTop -= 40; fireEvent.scroll(box);
      viewportHeight = 100;
      act(() => callbacks.find(callback => [...callback.targets].some(target => target.matches('.tree-rows')) && !callback.targets.has(box))!.run());
      expect(within(slot).queryAllByRole('button')).toHaveLength(0);
    } finally { vi.unstubAllGlobals(); }
  });
  // A 400 px tree over rows 100 px apart that move with its scrollTop, scrolled 150 px down.
  const layout = () => {
    const rectangle = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = document.querySelector<HTMLElement>('.tree-scroll');
      if (this === box) return new DOMRect(0, 0, 300, 400);
      const id = this.getAttribute('data-item-id'), at = id ? ids().indexOf(id) : -1;
      if (this.getAttribute('role') === 'treeitem' && at >= 0) return new DOMRect(0, at * 100 - (box?.scrollTop ?? 0), 300, 40);
      return rectangle.call(this);
    });
  };
  const scroller = () => document.querySelector<HTMLElement>('.tree-scroll')!;
  const opened = async (extra: Parameters<typeof mount>[0] = {}) => {
    layout();
    const view = await mount(extra);
    scroller().scrollTop = 150;
    return view;
  };
  const link = (view: Awaited<ReturnType<typeof mount>>, id: string): RevealedItem =>
    ({ kind: 'item', route: { ...route, item_id: id }, store: view.store, temporaryExpandedItemIds: [] });

  it('pauses global Map shortcuts while covered and restores them when Conversation closes', async () => {
    const view = await opened({ props: { selectedId: '8' } });
    const box = scroller();
    fireEvent.scroll(box);
    expect(backPill('below')).toBeTruthy();
    view.rerender({ selectedId: '8', covered: true });
    const offset = box.scrollTop, selectedCalls = view.calls.selected.length;
    // The keys ask for intents; the Map answers `.` and `n` only while it is not covered, so neither is handled now.
    // (Recent is the exception: its dialog is lifted above the bigger view, so ⌘E still answers; see the end.)
    for (const intent of ['map.backToSelected', 'map.nextUnseen'] as const) {
      let handled = true;
      act(() => { handled = dispatchIntent(intent); });
      expect(handled).toBe(false);
      expect(box.scrollTop).toBe(offset);
      expect(view.calls.selected).toHaveLength(selectedCalls);
      expect(screen.queryByRole('dialog', { name: 'Recent items' })).toBeNull();
    }
    view.rerender({ selectedId: '8', covered: false });
    let handled = false;
    act(() => { handled = dispatchIntent('map.backToSelected'); });
    expect(handled).toBe(true);
    expect(box.scrollTop).not.toBe(offset);
    noBackPill();
    act(() => { handled = dispatchIntent('recent.open'); });
    expect(handled).toBe(true);
    expect(screen.getByRole('dialog', { name: 'Recent items' })).toBeTruthy();
  });

  it('holds a revealed ancestor below the sticky header when detail-width clamping shrinks its preceding row', async () => {
    let shrink = 0;
    const callbacks: { run: () => void; targets: Set<Element> }[] = [];
    vi.stubGlobal('ResizeObserver', class {
      targets = new Set<Element>();
      constructor(run: () => void) { callbacks.push({ run, targets: this.targets }); }
      observe(target: Element) { this.targets.add(target); }
      disconnect() { this.targets.clear(); }
    });
    const rectangle = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = document.querySelector<HTMLElement>('.tree-scroll');
      if (this === box) return new DOMRect(0, 0, 300, 200);
      if (this.matches('.tree-topic')) return new DOMRect(0, 0, 300, 60);
      const id = this.getAttribute('data-item-id'), at = id ? ids().indexOf(id) : -1, target = ids().indexOf('8');
      if (at >= 0 && this.getAttribute('role') === 'treeitem') {
        const height = at === target - 1 ? 100 - shrink : at === target ? 140 : 40;
        return new DOMRect(0, at * 100 - (box?.scrollTop ?? 0) - (at >= target ? shrink : 0), 300, height);
      }
      return rectangle.call(this);
    });
    try {
      const view = await mount();
      scroller().scrollTop = 150; fireEvent.scroll(scroller());
      view.rerender({ reveal: link(view, '8'), selectedId: '8', detailOpen: true });
      expect(row('8').getBoundingClientRect().top).toBe(68);
      // The preceding row still ends eight pixels below the header, then loses eighty pixels.
      shrink = 80;
      act(() => callbacks.find(callback => [...callback.targets].some(target => target.matches('.tree-rows')) && !callback.targets.has(scroller()))!.run());
      expect(row('8').getBoundingClientRect().top).toBe(68);
      const top = scroller().scrollTop;
      fireEvent.pointerDown(row('8'));
      shrink = 90;
      act(() => callbacks.find(callback => [...callback.targets].some(target => target.matches('.tree-rows')) && !callback.targets.has(scroller()))!.run());
      expect(scroller().scrollTop).toBe(top);
      expect(row('8').getBoundingClientRect().top).toBe(58);
      fireEvent.wheel(scroller());
      scroller().scrollTop -= 20; fireEvent.scroll(scroller());
      shrink = 95;
      act(() => callbacks.find(callback => [...callback.targets].some(target => target.matches('.tree-rows')) && !callback.targets.has(scroller()))!.run());
      expect(scroller().scrollTop).toBe(top - 20);
      expect(row('8').getBoundingClientRect().top).toBe(73);
    } finally { vi.unstubAllGlobals(); }
  });

  it('observes sticky topic headers arriving after a saved search starts loading', async () => {
    const observers: Set<Element>[] = [];
    vi.stubGlobal('ResizeObserver', class {
      targets = new Set<Element>();
      constructor() { observers.push(this.targets); }
      observe(target: Element) { this.targets.add(target); }
      disconnect() { this.targets.clear(); }
    });
    try {
      const view = await mount({ load: false, props: { query: 'receipt', selectedId: '8' } });
      expect(document.querySelector('.tree-topic')).toBeNull();
      await act(async () => { await view.store.refresh(); });
      expect(document.querySelector('.tree-topic')).not.toBeNull();
      expect(observers.some(targets => targets.has(scroller()) && [...targets].some(target => target.matches('.tree-topic')))).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });

  it('updates the edge marker when sticky topic height changes, without scrolling', async () => {
    let headerHeight = 0;
    const callbacks: { run: () => void; targets: Set<Element> }[] = [];
    vi.stubGlobal('ResizeObserver', class { targets = new Set<Element>(); constructor(run: () => void) { callbacks.push({ run, targets: this.targets }); } observe(target: Element) { this.targets.add(target); } disconnect() {} });
    layout();
    const rectangle = vi.mocked(HTMLElement.prototype.getBoundingClientRect).getMockImplementation()!;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.matches('.tree-topic')) return new DOMRect(0, 0, 300, headerHeight);
      return rectangle.call(this);
    });
    try {
      await mount({ props: { selectedId: '2' } });
      scroller().scrollTop = 190; fireEvent.scroll(scroller());
      noBackPill();
      headerHeight = 60; act(() => callbacks.find(callback => callback.targets.has(scroller()))!.run());
      expect(backPill('above')).toBeTruthy();
      expect(scroller().scrollTop).toBe(190);
    } finally { vi.unstubAllGlobals(); }
  });

  it('never scrolls when an item is clicked, even once the workspace echoes the opening back', async () => {
    const view = await opened();
    fireEvent.click(row('3'));
    await waitFor(() => expect(view.calls.selected).toHaveLength(1));
    view.rerender({ reveal: view.calls.selected[0], selectedId: '3', detailOpen: true });
    expect(scroller().scrollTop).toBe(150);
    // An item part-way down the tree stays where it is as well.
    fireEvent.click(row('4'));
    await waitFor(() => expect(view.calls.selected).toHaveLength(2));
    view.rerender({ reveal: view.calls.selected[1], selectedId: '4', detailOpen: true });
    expect(scroller().scrollTop).toBe(150);
    fireEvent.click(row('8'));
    await waitFor(() => expect(view.calls.selected).toHaveLength(3));
    view.rerender({ reveal: view.calls.selected[2], selectedId: '8', detailOpen: true });
    expect(scroller().scrollTop).toBe(150);
  });

  it('never scrolls when a search-result tree row is clicked or its selection echoes back', async () => {
    const view = await opened({ props: { query: 'receipt' } });
    const box = scroller(); box.scrollTop = 600; fireEvent.scroll(box);
    fireEvent.click(row('1.1'));
    await waitFor(() => expect(view.calls.selected).toHaveLength(1));
    view.rerender({ reveal: view.calls.selected[0], selectedId: '1.1', detailOpen: true });
    expect(box.scrollTop).toBe(600);
  });

  it('never scrolls on a click after keyboard row navigation', async () => {
    const view = await opened();
    row('3').focus(); fireEvent.keyDown(row('3'), { key: 'End' });
    expect(scroller().scrollTop).toBe(448);
    scroller().scrollTop = 150; fireEvent.scroll(scroller());
    fireEvent.click(row('1'));
    expect(scroller().scrollTop).toBe(150);
    await waitFor(() => expect(view.calls.selected).toHaveLength(1));
    view.rerender({ reveal: view.calls.selected[0], selectedId: '1', detailOpen: true });
    expect(scroller().scrollTop).toBe(150);
  });

  it.each(['fold topic', 'collapse item', 'status chip', 'Resume filtered view'])(
  'never scrolls when %s dismisses the active tree reveal', async path => {
    const view = await opened();
    fireEvent.click(row('8'));
    await waitFor(() => expect(viewOf(view.transport).selected_item_id).toBe('8'));
    const reveal = view.calls.selected[0];
    view.rerender({ reveal, selectedId: '8', detailOpen: true });
    // A status filter that leaves the revealed item out (a search no longer filters the Map).
    if (path === 'Resume filtered view') await act(async () => { const saved = structuredClone(viewOf(view.transport));
      await view.navigation.saveSessionView({ ...saved, filters: { ...saved.filters, statuses: ['decided'] } }, view.transport.preferences.revision); });
    const readingPosition = path === 'collapse item' ? 0 : 150;
    scroller().scrollTop = readingPosition;
    fireEvent.scroll(scroller());
    switch (path) {
      case 'fold topic':
        fireEvent.click(within(topicRow('Delivery decisions')).getByRole('button', { name: 'Expand or collapse topic' }));
        break;
      case 'collapse item':
        fireEvent.click(within(row('1')).getByRole('button', { name: 'Expand or collapse' }));
        break;
      case 'status chip':
        fireEvent.click(chip('Open'));
        break;
      case 'Resume filtered view':
        fireEvent.click(screen.getByRole('button', { name: 'Resume filtered view' }));
        break;
    }
    await waitFor(() => expect(path === 'Resume filtered view' ? view.calls.resumed : view.calls.dismissed).toBe(1));
    // Dismissal can reach the workspace before a queued preference write changes selection.
    view.rerender({ reveal: null, selectedId: '8', detailOpen: true });
    expect(scroller().scrollTop).toBe(readingPosition);
    await waitFor(() => expect(view.navigation.getSnapshot().writing).toBe(false));
    expect(scroller().scrollTop).toBe(readingPosition);
  });

  it('reveals external selections only as far as needed', async () => {
    const view = await opened();
    row('3').focus(); fireEvent.keyDown(row('3'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row('4'));
    view.rerender({ reveal: link(view, '4'), selectedId: '4' });
    expect(scroller().scrollTop).toBe(150);
    view.rerender({ reveal: link(view, '8'), selectedId: '8', detailOpen: true });
    expect(scroller().scrollTop).toBe(448);
  });

  it('reveals offscreen history selections while leaving visible targets in place', async () => {
    const view = await opened();
    row('3').focus(); fireEvent.keyDown(row('3'), { key: 'ArrowDown' });
    const onscreen = link(view, '4');
    view.rerender({ reveal: onscreen, historyReveal: onscreen, selectedId: '4' });
    expect(scroller().scrollTop).toBe(150);
    const offscreen = link(view, '8');
    view.rerender({ reveal: offscreen, historyReveal: offscreen, selectedId: '8', detailOpen: true });
    expect(scroller().scrollTop).toBe(448);
    noBackPill();
  });

  it.each([['4', 150], ['8', 448]] as const)('reveals preview link target %s only as far as needed', async (target, expectedScroll) => {
    const view = await opened({ configure: transport => {
      const item = transport.sessions.get(route.session_id)!.items['4']!;
      item.status = 'done'; item.outcome = `[Next item](item:${target})`;
    } });
    fireEvent.click(within(row('4')).getByRole('link', { name: 'Next item' }));
    await waitFor(() => expect(view.calls.selected).toHaveLength(1));
    view.rerender({ reveal: view.calls.selected[0], selectedId: target, detailOpen: true });
    expect(scroller().scrollTop).toBe(expectedScroll);
  });
  it('reveals an offscreen replacement link', async () => {
    const view = await opened({ configure: transport => {
      const item = transport.sessions.get(route.session_id)!.items['4']!;
      item.status = 'replaced'; item.replaced_by = '8';
    } });
    fireEvent.click(within(row('4')).getByRole('link', { name: view.transport.sessions.get(route.session_id)!.items['8']!.question }));
    await waitFor(() => expect(view.calls.selected).toHaveLength(1));
    view.rerender({ reveal: view.calls.selected[0], selectedId: '8', detailOpen: true });
    expect(scroller().scrollTop).toBe(448);
  });
  it('keeps the tree still when a row action echoes a new detail selection from the workspace', async () => {
    const act = vi.fn();
    const view = await opened({ props: { onAct: act } });
    fireEvent.click(within(row('8')).getByRole('button', { name: 'Bring it up (b)' }));
    expect(act.mock.calls[0]?.slice(0, 2)).toMatchObject(['bring', { item_id: '8' }]);
    const result = link(view, '8');
    act.mock.calls[0]?.[2](result);
    view.rerender({ reveal: result, selectedId: '8', detailOpen: true });
    expect(scroller().scrollTop).toBe(150);
    // A later deliberate request for this same item reveals it.
    view.rerender({ reveal: link(view, '8'), selectedId: '8', detailOpen: true });
    expect(scroller().scrollTop).toBe(448);
  });
  it('reveals an external item after a tree action fails or is cancelled before revealing it', async () => {
    const view = await opened();
    fireEvent.click(within(row('8')).getByRole('button', { name: 'Bring it up (b)' }));
    expect(view.calls.acts).toMatchObject([['bring', { item_id: '8' }]]);
    // A failed or cancelled operation never calls the exact-result callback.
    view.rerender({ reveal: link(view, '8'), selectedId: '8', detailOpen: true });
    expect(scroller().scrollTop).toBe(448);
  });

  it('keeps selection still when detail opens after the owner scrolls away', async () => {
    const view = await opened({ props: { selectedId: '8' } });
    view.rerender({ detailOpen: true });
    expect(scroller().scrollTop).toBe(150);
    scroller().scrollTop = 150;
    fireEvent.scroll(scroller());
    view.rerender({ detailOpen: false });
    expect(scroller().scrollTop).toBe(150);
  });

  it.each(['above', 'below'] as const)('floats the %s Back-to pill over the Map, outside the scroller and the top bars, and reveals on click and on the back-to-selected key', async edge => {
    await opened({ props: { selectedId: edge === 'above' ? '1' : '8' } });
    fireEvent.scroll(scroller());
    const marker = () => backPill(edge);
    // The pill sits in the scroller's shell over the rows: it covers them rather than taking a row of space (SPEC §5.8).
    expect(marker().parentElement).toBe(document.querySelector('.tree-scroll-shell'));
    expect(scroller().contains(marker())).toBe(false);
    expect(marker().closest('[aria-label="Filter items"]')).toBeNull();
    expect(marker().closest('.tree-path')).toBeNull();
    expect(document.querySelector('.tree-selected-slot')).toBeNull();
    expect(marker().querySelector('.tree-back-label')?.textContent).not.toBe('');
    expect(marker().querySelector('.tree-back-arrow')?.textContent).toBe(edge === 'above' ? '↑' : '↓');
    expect(marker().querySelector('.p-key')?.textContent).toBe('.');
    fireEvent.click(marker());
    expect(document.activeElement).toBe(row(edge === 'above' ? '1' : '8'));
    noBackPill();
    // The Back-to-selected key is `.` (SPEC 6.1) and asks the Map for map.backToSelected.
    scroller().scrollTop = 150; fireEvent.scroll(scroller());
    expect(marker()).toBeTruthy();
    backToSelected();
    noBackPill();
    const css = readFileSync(resolve(__dirname, '../../../src/ui/tree/tree.css'), 'utf8');
    const solid = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(([, selector]) => selector!.includes('.tree-back:active'))!;
    for (const state of ['', ':hover', ':focus', ':active']) expect(solid[1]).toContain(`.tree-back${state}`);
    expect(solid[2]).toContain('background: var(--a-card)'); expect(solid[2]).not.toContain('transparent');
    expect(solid[2]).toMatch(/position:\s*absolute/);
    expect(solid[2]).toContain('height: 30px');
    expect(css).toMatch(/\.tree-scroll-shell\s*\{[^}]*position: relative/);
  });

  it('uses the full selected question for accessibility and distinguishing words before tag truncation', async () => {
    const view = await opened({ configure: transport => {
      const items = transport.sessions.get(route.session_id)!.items;
      items['1']!.short = items['4']!.short = 'Count cache reads';
      items['1']!.question = 'Count cache reads for Redis';
      items['4']!.question = 'Count cache reads for Postgres';
    }, props: { selectedId: '1' } });
    fireEvent.scroll(scroller());
    const first = screen.getByRole('button', { name: 'Back to “Count cache reads for Redis”' });
    expect(first.querySelector('.tree-back-label')!.textContent).toBe('Back to “Redis · Count cache reads”');
    expect(first.title).toContain('Count cache reads for Redis');
    view.rerender({ selectedId: '4' });
    scroller().scrollTop = 600; fireEvent.scroll(scroller());
    const second = screen.getByRole('button', { name: 'Back to “Count cache reads for Postgres”' });
    expect(second.querySelector('.tree-back-label')!.textContent).toBe('Back to “Postgres · Count cache reads”');
  });

  it.each(['opening', 'navigation', 'tag', 'back-to-selected key'] as const)('lands %s reveals clear of the pinned bars and a tall sticky topic', async path => {
    layout();
    const rectangle = vi.mocked(HTMLElement.prototype.getBoundingClientRect).getMockImplementation()!;
    // Session/filter bars end at 150; the scroller starts below them, with a 220 px topic band.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.matches('.tree-session-bar')) return new DOMRect(0, 0, 300, 104);
      if (this.matches('.tree-recent')) return new DOMRect(0, 104, 300, 46);
      if (this.matches('.tree-topic')) return new DOMRect(0, 150, 300, 220);
      const rect = rectangle.call(this);
      if (this.matches('.tree-scroll, [role="treeitem"][data-item-id]')) return new DOMRect(rect.x, rect.y + 150, rect.width, rect.height);
      return rect;
    });
    const view = await mount({ props: { selectedId: '8' } });
    if (path !== 'opening') {
      scroller().scrollTop = 750; fireEvent.scroll(scroller());
      expect(row('8').getBoundingClientRect().top).toBeLessThan(topicRow('Delivery decisions').getBoundingClientRect().bottom);
      if (path === 'navigation') view.rerender({ reveal: link(view, '8'), selectedId: '8' });
      else if (path === 'tag') fireEvent.click(backPill('above'));
      else backToSelected();
    }
    const target = row('8').getBoundingClientRect();
    expect(target.top).toBeGreaterThanOrEqual(topicRow('Delivery decisions').getBoundingClientRect().bottom + 8);
    expect(target.bottom).toBeLessThanOrEqual(scroller().getBoundingClientRect().bottom - 8);
    noBackPill();
  });

  it('keeps the Back-to pill over the Map when viewing archived topics', async () => {
    await opened({ configure: transport => {
      const session = transport.sessions.get(route.session_id)!;
      for (const topic of Object.values(session.topics)) if (topic) topic.archived_at = session.updated_at;
      viewOf(transport).filters.archived = true;
    }, props: { selectedId: '8' } });
    fireEvent.scroll(scroller());
    expect(backPill('below').parentElement).toBe(document.querySelector('.tree-scroll-shell'));
    expect(screen.queryByRole('button', { name: /^Filter/ })).toBeNull();
  });

  it('does not add a Back-to pill to the graph', async () => {
    await mount({ props: { selectedId: '8', graph: <p>Graph content</p> } });
    expect(document.querySelector('.tree-back')).toBeNull();
    noBackPill();
  });

  it('temporarily reveals a folded selection with the back-to-selected key and scrolls only after its row mounts', async () => {
    const view = await opened({ props: { selectedId: '1.1' } });
    fireEvent.click(within(row('1')).getByRole('button', { name: 'Expand or collapse' }));
    await waitFor(() => expect(row('1.1')).toBeNull());
    backToSelected();
    await waitFor(() => expect(view.calls.selected).toHaveLength(1));
    expect(scroller().scrollTop).toBe(150);
    view.rerender({ reveal: view.calls.selected[0], selectedId: '1.1' });
    expect(row('1.1')).not.toBeNull();
    expect(scroller().scrollTop).toBe(92);
    expect(row('1.1').getBoundingClientRect().top).toBe(8);
    expect(viewOf(view.transport).expanded_item_ids).not.toContain('1');
  });

  it('scrolls on the keyboard only when the row is off-screen, and only as far as needed', async () => {
    await opened();
    row('3').focus();
    fireEvent.keyDown(row('3'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row('4')); expect(scroller().scrollTop).toBe(150);
    fireEvent.keyDown(row('4'), { key: 'End' });
    expect(document.activeElement).toBe(row('8'));
    // The last row's bottom (840) lands 8 px above the tree's bottom: 840 + 8 - 400.
    expect(scroller().scrollTop).toBe(448);
    expect(row('8').getBoundingClientRect().top).toBe(352);
  });

  it('reveals a row hidden by its topic header using the least movement and restores below that header', async () => {
    layout();
    const rect = vi.mocked(HTMLElement.prototype.getBoundingClientRect).getMockImplementation()!;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.matches('.tree-topic')) return new DOMRect(0, 0, 300, 60);
      if (this.matches('.tree-topic-content')) return new DOMRect(0, 60, 300, 360);
      return rect.call(this);
    });
    const view = await mount();
    fireEvent.click(within(topicRow('Delivery decisions')).getByRole('button', { name: 'Reply to topic' }));
    await waitFor(() => expect(document.querySelector('.tree-topic-reply')).not.toBeNull());
    scroller().scrollTop = 190;
    const target = link(view, '2'); // top 10: on screen, but behind the 60 px band.
    view.rerender({ reveal: target, historyReveal: target, selectedId: '2' });
    expect(row('2').getBoundingClientRect().top).toBe(68);
    expect(scroller().scrollTop).toBe(132);
    fireEvent.scroll(scroller());
    expect(scroller().style.getPropertyValue('--tree-header-height')).toBe('60px');
    const outside = document.createElement('button'); document.body.append(outside);
    row('2').focus(); outside.focus();
    await waitFor(() => expect(viewOf(view.transport).scroll).toEqual({ item_id: '2', offset: 8 }));
    cleanup();
    await mount({ transport: view.transport });
    expect(row('2').getBoundingClientRect().top).toBe(68);
    outside.remove();
  });

  it.each([12, -40])('restores the same reading position when a header is at %s px during a topic transition', async headerTop => {
    layout();
    const rect = vi.mocked(HTMLElement.prototype.getBoundingClientRect).getMockImplementation()!;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.matches('.tree-topic')) return new DOMRect(0, headerTop, 300, 60);
      return rect.call(this);
    });
    const view = await mount();
    scroller().scrollTop = 150;
    fireEvent.scroll(scroller());
    const before = row('2').getBoundingClientRect().top;
    const outside = document.createElement('button'); document.body.append(outside);
    row('2').focus(); outside.focus();
    await waitFor(() => expect(viewOf(view.transport).scroll).toEqual({ item_id: '2', offset: before - 60 }));
    cleanup();
    await mount({ transport: view.transport });
    expect(row('2').getBoundingClientRect().top).toBe(before);
    outside.remove();
  });

  // The first row grows by `grow` px (a live edit made it longer); every row below it moves down with it.
  it('flushes an earlier deliberate scroll on blur without moving the reading row or saving an unchanged anchor twice', async () => {
    const rectangle = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = document.querySelector<HTMLElement>('.tree-scroll');
      if (this === box) return new DOMRect(0, 0, 300, 400);
      if (this.matches('.tree-topic')) return new DOMRect(0, 0, 300, 60);
      const id = this.getAttribute('data-item-id'), at = id ? ids().indexOf(id) : -1;
      if (at >= 0) return new DOMRect(0, 257 + at * 100 - (box?.scrollTop ?? 0), 300, 40);
      return rectangle.call(this);
    });
    const view = await mount({ configure: transport => { viewOf(transport).scroll = { item_id: '1', offset: 197 }; } });
    const outside = document.createElement('button'); document.body.append(outside);
    try {
      fireEvent.pointerDown(row('1')); row('1').focus();
      scroller().scrollTop = 27; fireEvent.scroll(scroller());
      const before = row('1').getBoundingClientRect().top;
      expect(before - 60).toBe(170);
      expect(viewOf(view.transport).scroll).toEqual({ item_id: '1', offset: 197 });
      // Moving focus to another control persists the deliberate scroll on blur.
      outside.focus();
      await waitFor(() => expect(viewOf(view.transport).scroll).toEqual({ item_id: '1', offset: 170 }));
      expect(row('1').getBoundingClientRect().top).toBe(before);
      const writes = () => patches(view.transport).filter(value => value.command.command === 'preferences_patch'
        && value.command.params.entries.some(entry => entry.kind === 'set_session_view'));
      expect(writes()).toHaveLength(1);
      row('1').focus(); outside.focus();
      await act(async () => { await Promise.resolve(); });
      expect(writes()).toHaveLength(1);
      expect(row('1').getBoundingClientRect().top).toBe(before);
    } finally { outside.remove(); }
  });

  it('holds the reading row through a 27 px layout shrink above it without writing an unchanged saved anchor', async () => {
    let prefix = 257;
    const observers: { run: () => void; targets: Set<Element> }[] = [];
    vi.stubGlobal('ResizeObserver', class {
      targets = new Set<Element>();
      constructor(run: () => void) { observers.push({ run, targets: this.targets }); }
      observe(target: Element) { this.targets.add(target); }
      disconnect() { this.targets.clear(); }
    });
    const rectangle = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = document.querySelector<HTMLElement>('.tree-scroll');
      if (this === box) return new DOMRect(0, 0, 300, 400);
      if (this.matches('.tree-topic')) return new DOMRect(0, 0, 300, 60);
      const id = this.getAttribute('data-item-id'), at = id ? ids().indexOf(id) : -1;
      if (at >= 0) return new DOMRect(0, prefix + at * 100 - (box?.scrollTop ?? 0), 300, 40);
      return rectangle.call(this);
    });
    const outside = document.createElement('button'); document.body.append(outside);
    try {
      const view = await mount({ configure: transport => { viewOf(transport).scroll = { item_id: '1', offset: 20 }; } });
      expect(scroller().scrollTop).toBe(177);
      fireEvent.pointerDown(row('1')); fireEvent.scroll(scroller());
      const before = row('1').getBoundingClientRect().top;
      // A topic child can resize without rerendering TreeView; delivery arrives
      // through its existing content ResizeObserver, as it does in WKWebView.
      prefix -= 27;
      act(() => observers.filter(observer => [...observer.targets].some(target => target.matches('.tree-rows'))).forEach(observer => observer.run()));
      expect(scroller().scrollTop).toBe(150);
      expect(row('1').getBoundingClientRect().top).toBe(before);
      row('1').focus(); outside.focus();
      await act(async () => { await Promise.resolve(); });
      expect(viewOf(view.transport).scroll).toEqual({ item_id: '1', offset: 20 });
      expect(patches(view.transport).filter(value => value.command.command === 'preferences_patch'
        && value.command.params.entries.some(entry => entry.kind === 'set_session_view'))).toHaveLength(0);
    } finally { outside.remove(); vi.unstubAllGlobals(); }
  });

  describe('when rows above the viewport change size', () => {
    let grow = 0;
    const growing = () => {
      grow = 0;
      const rectangle = HTMLElement.prototype.getBoundingClientRect;
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const box = document.querySelector<HTMLElement>('.tree-scroll');
        if (this === box) return new DOMRect(0, 0, 300, 400);
        const id = this.getAttribute('data-item-id'), at = id ? ids().indexOf(id) : -1;
        if (this.getAttribute('role') === 'treeitem' && at >= 0) return new DOMRect(0, at * 100 + (at > 0 ? grow : 0) - (box?.scrollTop ?? 0), 300, 40);
        return rectangle.call(this);
      });
    };
    const firstVisible = () => ids().find(id => row(id!).getBoundingClientRect().bottom > 0);

    it('keeps the row being read where it is, instead of letting the view shift', async () => {
      growing();
      const view = await mount();
      scroller().scrollTop = 150; fireEvent.scroll(scroller());
      const reading = firstVisible()!, offset = row(reading).getBoundingClientRect().top;
      grow = 600; view.rerender({});
      expect(firstVisible()).toBe(reading);
      expect(row(reading).getBoundingClientRect().top).toBe(offset);
      expect(scroller().scrollTop).toBe(750);
      // It holds through a shrink too, and after the owner scrolls on.
      grow = 200; view.rerender({});
      expect(row(reading).getBoundingClientRect().top).toBe(offset);
      scroller().scrollTop = 350; fireEvent.scroll(scroller());
      const next = firstVisible()!, nextOffset = row(next).getBoundingClientRect().top;
      grow = 500; view.rerender({});
      expect(row(next).getBoundingClientRect().top).toBe(nextOffset);
    });

    it('lets new rows show when the tree is at the very top, and never undoes the owner’s own scrolling', async () => {
      growing();
      const view = await mount();
      grow = 300; view.rerender({});
      expect(scroller().scrollTop).toBe(0);
      scroller().scrollTop = 150; fireEvent.scroll(scroller());
      scroller().scrollTop = 250;
      grow = 400; view.rerender({});
      expect(scroller().scrollTop).toBe(250);
    });

    it('keeps the row being read when the tree grows after the render, as fonts and images do', async () => {
      growing();
      const observers: (() => void)[] = [];
      vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { observers.push(callback); } observe() {} unobserve() {} disconnect() {} });
      try {
        await mount();
        scroller().scrollTop = 150; fireEvent.scroll(scroller());
        const reading = firstVisible()!, offset = row(reading).getBoundingClientRect().top;
        grow = 450;
        act(() => { observers.forEach(callback => callback()); });
        expect(row(reading).getBoundingClientRect().top).toBe(offset);
      } finally { vi.unstubAllGlobals(); }
    });
  });

  // The tree opens with an anchor (the saved reading position: row 4, 20 px below the top). A row above the
  // viewport is then folded away, which moves every row under it up by 100 px, as an unfold moves them down.
  describe('with an opening anchor', () => {
    const observers: (() => void)[] = [];
    const readingAt4 = (transport: AppTransport) => {
      transport.preferences.sessions = transport.preferences.sessions.map(view =>
        view.session.session_id === route.session_id ? { ...view, scroll: { item_id: '4', offset: 20 } } : view);
    };
    const top = (id: string) => row(id).getBoundingClientRect().top;
    const fold = (id: string) => within(row(id)).getByRole('button', { name: 'Expand or collapse' });
    const opening = async () => {
      observers.length = 0;
      vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { observers.push(callback); } observe() {} unobserve() {} disconnect() {} });
      layout();
      const view = await mount({ configure: readingAt4 });
      expect(top('4')).toBe(20);
      return view;
    };
    const visible = () => ids().filter(id => { const rectangle = row(id!).getBoundingClientRect(); return rectangle.bottom > 0 && rectangle.top < 400; });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('keeps the visible rows still when a row above the viewport opens or closes while the view is still settling', async () => {
      await opening();
      const before = visible(), at = Object.fromEntries(before.map(id => [id, top(id!)]));
      expect(before).toContain('4');
      fireEvent.click(fold('1'));
      await waitFor(() => expect(ids()).not.toContain('1.1'));
      act(() => { observers.forEach(callback => callback()); });
      expect(top('4')).toBe(20);
      // Every row that was in view and is still there sits exactly where it was.
      for (const id of before.filter(id => ids().includes(id))) if (Number(id) >= 4) expect(top(id!)).toBe(at[id!]);
      // Opening it again moves everything down; the anchored row still does not move.
      fireEvent.click(fold('1'));
      await waitFor(() => expect(ids()).toContain('1.1'));
      act(() => { observers.forEach(callback => callback()); });
      expect(top('4')).toBe(20);
    });

    it('keeps the clicked row in place when a pointerdown hands the view over to the owner', async () => {
      await opening();
      const clicked = top('4');
      // The press settles the view: from here the first visible row holds its place on every render, no observer needed.
      fireEvent.pointerDown(fold('1'));
      fireEvent.click(fold('1'));
      await waitFor(() => expect(ids()).not.toContain('1.1'));
      expect(top('4')).toBe(clicked);
      // The row pressed is the one that was under the pointer, and it stays there through the next change too.
      fireEvent.pointerDown(row('4'));
      fireEvent.click(fold('1'));
      await waitFor(() => expect(ids()).toContain('1.1'));
      expect(top('4')).toBe(clicked);
    });
  });
});
