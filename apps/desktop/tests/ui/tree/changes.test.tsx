import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { SessionSeen } from '../../../src/generated/core';
import { createDesktopService } from '../../../src/data/service';
import { NavigationStore } from '../../../src/state/navigation/store';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { SessionActionControllers } from '../../../src/components/bindings/actions';
import { TreeView, type TreeViewProps } from '../../../src/ui/tree/TreeView';
import { mapChanges, nextMarkedItem } from '../../../src/ui/tree/model';
import { AppTransport, route } from '../app/transport';
import { notices } from '../../../src/ui/pages/notices';

const baseline = '2026-10-01T00:00:00.000Z', later = '2026-10-13T09:00:00.000Z';
const stores: NavigationStore[] = [];
afterEach(() => { cleanup(); stores.splice(0).forEach(store => store.stop()); notices.clear(); vi.restoreAllMocks(); vi.useRealTimers(); });
const row = (id: string) => document.querySelector<HTMLElement>(`.tree-item[data-item-id="${id}"]`)!;
const target = () => document.querySelector<HTMLElement>('.tree-item[data-next-unseen]');
const next = () => fireEvent.keyDown(window, { key: 'n' });

function changesFixture() {
  const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
  Object.values(session.items).forEach(item => { if (item) { item.created_at = baseline; item.changes = []; } });
  session.items['1.1']!.created_at = later;
  session.items['2']!.revision = 2;
  session.items['2']!.changes = [{ revision: 2, at: later, cause_message_id: session.items['2']!.created_message_id, before: { status: 'open' } }];
  session.items['3']!.changes = [{ revision: 2, at: later, wording_only: true, cause_message_id: session.items['3']!.created_message_id, before: { question: 'Old wording' } }];
  const seen: SessionSeen = { session: route, since: baseline, items: [], topics: [] };
  transport.preferences.seen = [seen];
  return { transport, session, seen };
}

async function mount(configure?: (transport: AppTransport) => void, extra: Partial<TreeViewProps> = {}) {
  const { transport } = changesFixture(); configure?.(transport);
  const service = createDesktopService(transport), navigation = new NavigationStore(service); stores.push(navigation);
  await navigation.start();
  const store = navigation.opened.open(route); await store.refresh();
  const selected = vi.fn();
  const props: TreeViewProps = { navigation, store, actions: new SessionActionControllers(service).forSession(store), drafts: new OwnerDraftStore(service),
    query: '', reveal: null, selectedId: null, detailOpen: false, summaries: [],
    onSelected: selected, onDismissReveal: () => {}, onResume: () => {}, onAct: () => {}, onClearFilters: () => {}, onShowArchive: () => {}, onRemove: () => {}, ...extra };
  const rendered = render(<TreeView {...props} />);
  return { transport, navigation, store, selected, rerender: (extra: Partial<TreeViewProps>) => rendered.rerender(<TreeView {...props} {...extra} />) };
}

describe('Map change markers and next unseen navigation', () => {
  it('derives New and changed markers with New taking precedence and excludes wording-only, removed and archived items', () => {
    const { session, seen } = changesFixture();
    session.items['1.1']!.changes = session.items['2']!.changes;
    const result = mapChanges(session, seen);
    expect([...result.markers]).toEqual([['1.1', 'new'], ['2', 'changed']]);
    expect(nextMarkedItem(result.order, result.markers, '2')).toBe('1.1');
    expect(nextMarkedItem(result.order, result.markers, 'missing')).toBe('1.1');
    seen.items.push({ item_id: '1.1', revision: 2 });
    expect([...mapChanges(session, seen).markers]).toEqual([['2', 'changed']]);
    session.items['2']!.removed_at = later;
    expect(mapChanges(structuredClone(session), seen).markers.size).toBe(0);
    session.items['2']!.removed_at = null;
    session.topics[session.items['2']!.topic_id]!.archived_at = later;
    expect(mapChanges(structuredClone(session), seen).markers.size).toBe(0);
    expect(nextMarkedItem([], new Map(), null)).toBeNull();
  });

  it('renders accessible attention markers and reacts immediately to shared reads and catch-up Undo', async () => {
    const view = await mount();
    expect(within(row('1.1')).getByRole('img', { name: 'New to you' }).textContent).toBe('New');
    expect(within(row('2')).getByRole('img', { name: 'Changed since you read it' }).textContent).toBe('');
    expect(row('3').querySelector('.tree-change-marker')).toBeNull();
    act(() => view.navigation.markItemSeen(route, '1.1'));
    expect(row('1.1').querySelector('.tree-change-marker')).toBeNull();
    let token = '';
    act(() => { token = view.navigation.reading.catchUp({ kind: 'mark_seen', session: route, at: later,
      items: [{ item_id: '2', revision: 2 }], topics: [] }); });
    expect(row('2').querySelector('.tree-change-marker')).toBeNull();
    act(() => view.navigation.reading.undo(token));
    expect(within(row('2')).getByRole('img', { name: 'Changed since you read it' })).toBeTruthy();
  });

  it('walks Map preorder and wraps without opening, selecting or marking seen', async () => {
    const view = await mount();
    next();
    expect(target()).toBe(row('1.1')); expect(document.activeElement).toBe(row('1.1'));
    await waitFor(() => expect(row('1.1').hasAttribute('data-next-unseen-pulse')).toBe(true));
    // Finish the pulse while keeping its distinct outline and its New tag.
    await waitFor(() => expect(row('1.1').hasAttribute('data-next-unseen-pulse')).toBe(false), { timeout: 1500 });
    expect(target()).toBe(row('1.1'));
    expect(within(row('1.1')).getByRole('img', { name: 'New to you' })).toBeTruthy();
    next(); expect(target()).toBe(row('2')); expect(row('1.1').hasAttribute('data-next-unseen')).toBe(false);
    next(); expect(target()).toBe(row('1.1'));
    expect(view.selected).not.toHaveBeenCalled();
    expect(view.transport.preferences.seen![0]!.items).toEqual([]);
    expect(view.transport.mutations).toEqual([]);
    expect(view.transport.queries.filter(query => query.request.command === 'reveal_item')).toEqual([]);
    fireEvent.keyDown(row('1.1'), { key: 'Enter' });
    await waitFor(() => expect(view.selected).toHaveBeenCalledTimes(1));
    act(() => view.navigation.markItemSeen(route, '1.1'));
    expect(row('1.1').querySelector('.tree-change-marker')).toBeNull();
    next(); expect(target()).toBe(row('2'));
    fireEvent.click(row('2')); await waitFor(() => expect(view.selected).toHaveBeenCalledTimes(2));
  });

  it('temporarily exposes folded, hidden and filtered targets while preserving saved views', async () => {
    const view = await mount(transport => {
      const saved = transport.preferences.sessions[0]!;
      saved.expanded_item_ids = [];
      saved.collapsed_topic_ids = [transport.sessions.get(route.session_id)!.items['1.1']!.topic_id];
      saved.hidden_item_ids = ['1'];
    }, { query: 'matches nothing' });
    const saved = structuredClone(view.transport.preferences.sessions[0]);
    expect(row('1.1')).toBeNull(); next();
    expect(target()).toBe(row('1.1')); expect(row('1')).not.toBeNull();
    expect(screen.getByText('Showing an item outside your current filters.')).toBeTruthy();
    expect(view.transport.preferences.sessions[0]).toEqual(saved);
    // A deliberate owner fold overrides the temporary N reveal.
    fireEvent.click(within(row('1')).getByRole('button', { name: 'Expand or collapse' }));
    await waitFor(() => expect(row('1.1')).toBeNull());
    next(); expect(target()).toBe(row('2'));
    expect(view.selected).not.toHaveBeenCalled();
  });

  it('leaves Focus for an outside N target without opening it or marking it seen', async () => {
    const view = await mount(transport => { transport.preferences.sessions[0]!.focused_item_id = '1'; });
    const before = structuredClone(view.transport.preferences.sessions[0]!);
    expect(row('2')).toBeNull();
    next();
    expect(target()).toBe(row('1.1'));
    expect(view.transport.preferences.sessions[0]!.focused_item_id).toBe('1');
    next();
    await waitFor(() => expect(row('2')).not.toBeNull());
    await waitFor(() => expect(target()).toBe(row('2')));
    expect(row('2')).not.toBeNull();
    expect(document.activeElement).toBe(row('2'));
    await waitFor(() => expect(view.transport.preferences.sessions[0]!.focused_item_id).toBeUndefined());
    delete before.focused_item_id;
    expect(view.transport.preferences.sessions[0]).toEqual(before);
    expect(view.selected).not.toHaveBeenCalled();
    expect(view.transport.preferences.seen![0]!.items).toEqual([]);
    expect(view.transport.queries.filter(query => query.request.command === 'reveal_item')).toEqual([]);
  });

  it('skips typing, dialogs, modified or composing keys, repeated keys and Graph mode', async () => {
    const view = await mount();
    for (const tag of ['input', 'textarea', 'select']) {
      const editor = document.createElement(tag); document.body.append(editor);
      fireEvent.keyDown(editor, { key: 'n' }); expect(target()).toBeNull(); editor.remove();
    }
    const editor = document.createElement('div'); editor.contentEditable = 'true'; editor.setAttribute('contenteditable', 'true'); document.body.append(editor);
    fireEvent.keyDown(editor, { key: 'n' }); expect(target()).toBeNull(); editor.remove();
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); document.body.append(dialog);
    fireEvent.keyDown(dialog, { key: 'n' }); expect(target()).toBeNull(); dialog.remove();
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'isComposing', 'repeat']) {
      fireEvent.keyDown(window, { key: 'n', [modifier]: true }); expect(target()).toBeNull();
    }
    view.rerender({ graph: <div>Graph fixture</div> }); next(); expect(target()).toBeNull();
    view.rerender({ graph: undefined }); fireEvent.keyDown(window, { key: 'N', shiftKey: true });
    expect(target()).toBe(row('1.1'));
  });

  it('keeps an ordinary external reveal visible alongside the N target', async () => {
    const view = await mount();
    view.rerender({ query: 'matches nothing', reveal: { kind: 'item', route: { ...route, item_id: '8' },
      store: view.store, temporaryExpandedItemIds: [] } });
    expect(row('8')).not.toBeNull();
    next(); expect(target()).toBe(row('1.1'));
    expect(row('8')).not.toBeNull(); expect(view.selected).not.toHaveBeenCalled();
  });

  it('announces when no unseen items remain and clears the previous navigation outline', async () => {
    const view = await mount(); next(); expect(target()).toBe(row('1.1'));
    act(() => { view.navigation.markItemSeen(route, '1.1'); view.navigation.markItemSeen(route, '2'); });
    next(); expect(target()).toBeNull(); expect(screen.getByText('No unseen items.').getAttribute('role')).toBe('status');
    expect(notices.getSnapshot().find(notice => notice.id === 'tree-no-unseen')?.text).toBe('No unseen items.');
    expect(view.selected).not.toHaveBeenCalled();
  });

  it.each([60, 400])('scrolls a %s px N target clear of a sticky topic with Selected in the filter bar', async height => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = document.querySelector<HTMLElement>('.tree-scroll');
      if (this === box) return new DOMRect(0, 0, 300, 300);
      if (this.matches('.tree-topic')) return new DOMRect(0, 0, 300, 60);
      if (this.matches('.tree-selected-edge')) return new DOMRect(0, 8, 300, 32);
      const rows = [...document.querySelectorAll('.tree-item')], index = rows.indexOf(this);
      return index >= 0 ? new DOMRect(0, index * 80 - (box?.scrollTop ?? 0), 300, height) : new DOMRect();
    });
    const view = await mount(undefined, { selectedId: '1' });
    const box = document.querySelector<HTMLElement>('.tree-scroll')!;
    box.scrollTop = 200; fireEvent.scroll(box);
    next(); expect(target()).toBe(row('1.1'));
    expect(row('1.1').getBoundingClientRect().top).toBe(68);
    expect(view.selected).not.toHaveBeenCalled();
  });

  it('replaces a Selected reveal hold with the N target and keeps it clear through preview reflow', async () => {
    let shrink = 0;
    const callbacks: { run: () => void; targets: Set<Element> }[] = [];
    vi.stubGlobal('ResizeObserver', class {
      targets = new Set<Element>();
      constructor(run: () => void) { callbacks.push({ run, targets: this.targets }); }
      observe(target: Element) { this.targets.add(target); }
      disconnect() { this.targets.clear(); }
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = document.querySelector<HTMLElement>('.tree-scroll');
      if (this === box) return new DOMRect(0, 0, 300, 300);
      if (this.matches('.tree-topic')) return new DOMRect(0, 0, 300, 60);
      const index = [...document.querySelectorAll('.tree-item')].indexOf(this);
      return index >= 0 ? new DOMRect(0, 100 + index * 300 - (box?.scrollTop ?? 0) - (index > 0 ? shrink : 0), 300, 100) : new DOMRect();
    });
    try {
      const view = await mount(undefined, { selectedId: '1' });
      const box = document.querySelector<HTMLElement>('.tree-scroll')!;
      box.scrollTop = 500; fireEvent.scroll(box);
      fireEvent.keyDown(window, { key: 'j', metaKey: true });
      expect(row('1').getBoundingClientRect().top).toBe(68);
      const selections = view.selected.mock.calls.length;
      next(); expect(target()).toBe(row('1.1'));
      const landed = row('1.1').getBoundingClientRect().top;
      expect(landed).toBeGreaterThanOrEqual(68);
      expect(row('1.1').getBoundingClientRect().bottom).toBeLessThanOrEqual(300);
      shrink = 160;
      act(() => callbacks.find(callback => callback.targets.has(box) && [...callback.targets].some(node => node.matches('.tree-rows')))!.run());
      act(() => callbacks.find(callback => !callback.targets.has(box) && [...callback.targets].some(node => node.matches('.tree-rows')))!.run());
      expect(row('1.1').getBoundingClientRect().top).toBe(landed);
      expect(view.selected).toHaveBeenCalledTimes(selections);
      expect(view.transport.preferences.seen![0]!.items).toEqual([]);
      expect(view.transport.preferences.sessions[0]!.recent_items).toBeUndefined();
    } finally { vi.unstubAllGlobals(); }
  });

  it('renders topic content only under expanded topic headers', async () => {
    const view = await mount(undefined, { topicContent: id => <div data-topic-content={id}>Topic changes</div> });
    const header = document.querySelector<HTMLElement>('.tree-topic')!;
    expect(header.nextElementSibling?.getAttribute('data-topic-content')).toBe(header.dataset.row);
    fireEvent.click(within(header).getByRole('button', { name: 'Expand or collapse topic' }));
    await waitFor(() => expect(header.getAttribute('aria-expanded')).toBe('false'));
    expect(header.nextElementSibling?.hasAttribute('data-topic-content')).not.toBe(true);
    expect(view.transport.mutations).toHaveLength(1);
  });
});
