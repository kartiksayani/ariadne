// Queued view edits (alpha.22 E12, plan §2c): an owner view change made while another preferences write is unsettled
// queues per session outside the Map. Each row of the failure table is a test here, over the real navigation store.
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { OwnerMutationRequest, SessionPreferences } from '../../../src/generated/core';
import { createDesktopService } from '../../../src/data/service';
import type { SessionStore } from '../../../src/data';
import { NavigationStore } from '../../../src/state/navigation/store';
import { VIEW_SAVE_FAILED, viewEditsFor } from '../../../src/state/navigation/viewEdits';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { SessionActionControllers } from '../../../src/components/bindings/actions';
import { TreeView, type TreeViewProps } from '../../../src/ui/tree/TreeView';
import { notices } from '../../../src/ui/pages/notices';
import { toasts } from '../../../src/ui/shell/toast';
import { AppTransport, route, secondId } from '../app/transport';

const stores: NavigationStore[] = [];
afterEach(() => {
  cleanup();
  stores.splice(0).forEach(store => store.stop());
  notices.clear();
  const toast = toasts.current();
  if (toast) toasts.dismiss(toast.id);
  vi.restoreAllMocks();
  localStorage.clear();
});
const second = { ...route, session_id: secondId };
const viewOf = (transport: AppTransport, sessionId = route.session_id) => transport.preferences.sessions.find(value => value.session.session_id === sessionId)!;
/** The session views the Map's queued edits asked navigation to write, in order. */
const viewWrites = (view: Mounted, sessionId = route.session_id) => view.writes.mock.calls.flatMap(([value]) => value.session.session_id === sessionId ? [value] : []);
const recentVisit = [{ item_id: '1', action: 'peeked' as const, visited_at: '2026-10-13T12:00:00.000Z' }];
const isRecentPatch = (request: unknown) => {
  const command = (request as Partial<OwnerMutationRequest>).command;
  return command?.command === 'preferences_patch' && command.params.entries.some(entry => entry.kind === 'set_session_view' && entry.preferences.recent_items?.[0]?.item_id === '1');
};
const topicRow = (name: string) => screen.getByRole('treeitem', { name });
const topicFolded = (name: string) => topicRow(name).getAttribute('aria-expanded') === 'false';
const foldTopic = (name: string) => { fireEvent.click(within(topicRow(name)).getByRole('button', { name: 'Expand or collapse topic' })); };
const TOPIC = 'Delivery decisions';
const filterRow = () => screen.getByRole('group', { name: 'Filter items' });
const chip = (label: string) => within(filterRow()).getByRole('button', { name: new RegExp(`^${label}\\s*\\d+$`) });

async function mount({ configure, strict = false }: { configure?: (transport: AppTransport) => void; strict?: boolean } = {}) {
  const transport = new AppTransport();
  configure?.(transport);
  // As the core does: a preferences write against an older revision is refused with revision_conflict.
  if (strict) {
    const raw = transport.invoke.bind(transport);
    transport.invoke = (async (name: string, args: { request: OwnerMutationRequest }) => {
      const command = 'command' in args.request ? args.request.command : null;
      if (command?.command === 'preferences_patch' && command.params.expected_preferences_revision !== transport.preferences.revision) {
        return { api_version: 1, ok: false, error: { code: 'revision_conflict', message: 'Changed', hint: 'Retry.', retryable: true, field_errors: [] } };
      }
      return raw(name, args);
    }) as typeof transport.invoke;
  }
  transport.preferences.sessions = transport.preferences.sessions.map(view => ({ ...view, tab_open: true }));
  const service = createDesktopService(transport), navigation = new NavigationStore(service); stores.push(navigation);
  await navigation.start();
  const store = navigation.opened.open(route);
  await store.refresh();
  const controllers = new SessionActionControllers(service), drafts = new OwnerDraftStore(service);
  function Harness({ shown = true, session = store }: { shown?: boolean; session?: SessionStore }) {
    const [selected, setSelected] = useState<string | null>(null);
    const props: TreeViewProps = { navigation, store: session, actions: controllers.forSession(session), drafts, query: '', reveal: null, selectedId: selected,
      detailOpen: false, summaries: [], onSelected: result => { if (result.kind === 'item') setSelected(result.route.item_id); },
      onDismissReveal: () => {}, onResume: () => {}, onAct: () => {}, onClearFilters: () => {}, onShowArchive: () => {}, onRemove: () => {} };
    return shown ? <TreeView {...props} /> : null;
  }
  const writes = vi.spyOn(navigation, 'saveSessionView');
  const view = render(<Harness />);
  // The Map's own opening (the selected row's reveal) finishes saving first, so the write under test is the only one.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  await waitFor(() => expect(navigation.getSnapshot().writing || navigation.getSnapshot().pendingOperationId !== null).toBe(false));
  writes.mockClear();
  return { transport, navigation, store, writes, rerender: (props: { shown?: boolean; session?: SessionStore }) => view.rerender(<Harness {...props} />) };
}
type Mounted = Awaited<ReturnType<typeof mount>>;

/** Leaves a Recent write unconfirmed (lost response); `settle` lets its Check again through. */
async function unconfirmedRecent(view: Mounted) {
  let lose = true;
  const invoke = view.transport.invoke.bind(view.transport);
  vi.spyOn(view.transport, 'invoke').mockImplementation(async (name, args) => {
    if (lose && isRecentPatch(args.request)) throw new Error('Lost response');
    return invoke(name, args);
  });
  await act(async () => { await view.navigation.saveRecentItems(route, recentVisit, view.transport.preferences.revision); });
  expect(view.navigation.isRecentPending()).toBe(true);
  return async () => {
    lose = false;
    await act(async () => { expect(await view.navigation.retryMutation()).toBe(true); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  };
}
/** Holds the next preferences write matching `match` until `release`. */
function gateWrite(view: Mounted, match: (request: OwnerMutationRequest) => boolean) {
  let release!: () => void, entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; }), invoke = view.transport.invoke.bind(view.transport);
  vi.spyOn(view.transport, 'invoke').mockImplementation(async (name, args) => {
    if (!entered && 'command' in args.request && match(args.request)) { entered = true; await gate; }
    return invoke(name, args);
  });
  return { entered: () => entered, release: async () => { await act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 0)); }); } };
}
/** Every value an attribute of `element` takes from now on. */
function watchAttribute(element: Element, name: string) {
  const values: (string | null)[] = [element.getAttribute(name)];
  const observer = new MutationObserver(() => { const value = element.getAttribute(name); if (value !== values.at(-1)) values.push(value); });
  observer.observe(element, { attributes: true, attributeFilter: [name] });
  return { values, stop: () => observer.disconnect() };
}

describe('queued view edits (E12, §2c)', () => {
  it('session switch before settle: the edit stays with its session and lands there once the Recent save settles', async () => {
    const view = await mount({ configure: transport => { transport.preferences.sessions.push({ ...transport.view(secondId), tab_order: 1 }); } });
    const settle = await unconfirmedRecent(view);
    act(() => { foldTopic(TOPIC); });
    expect(topicFolded(TOPIC)).toBe(true);
    const topicId = Object.values(view.transport.sessions.get(route.session_id)!.topics).find(topic => topic?.name === TOPIC)!.id;
    const other = view.navigation.opened.open(second);
    await act(async () => { await other.refresh(); });
    view.rerender({ session: other });
    await settle();
    await waitFor(() => expect(viewOf(view.transport).collapsed_topic_ids).toEqual([topicId]));
    // The other session's view never takes the first one's fold.
    expect(viewOf(view.transport, secondId).collapsed_topic_ids ?? []).toEqual([]);
    expect(viewWrites(view, secondId)).toHaveLength(0);
    expect(viewWrites(view)).toHaveLength(1);
  });

  describe('leave and return before the save settles: the Map draws the effective view, never fold → unfold → fold', () => {
    const waits = [
      { name: 'an unconfirmed Recent save', hold: async (view: Mounted) => unconfirmedRecent(view) },
      { name: 'a running Recent save', hold: async (view: Mounted) => {
        const gate = gateWrite(view, isRecentPatch);
        let saving!: Promise<boolean>;
        act(() => { saving = view.navigation.saveRecentItems(route, recentVisit, view.transport.preferences.revision); });
        await waitFor(() => expect(gate.entered()).toBe(true));
        return async () => { await gate.release(); await act(async () => { await saving; }); };
      } },
    ];
    it.each(waits)('behind $name', async ({ hold }) => {
      const view = await mount();
      const settle = await hold(view);
      act(() => { foldTopic(TOPIC); });
      expect(topicFolded(TOPIC)).toBe(true);
      view.rerender({ shown: false });
      expect(screen.queryByRole('treeitem', { name: TOPIC })).toBeNull();
      view.rerender({ shown: true });
      // The first render after the return is folded already.
      expect(topicFolded(TOPIC)).toBe(true);
      const expanded = watchAttribute(topicRow(TOPIC), 'aria-expanded');
      await settle();
      await waitFor(() => expect(viewOf(view.transport).collapsed_topic_ids).toHaveLength(1));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
      expanded.stop();
      expect(expanded.values).toEqual(['false']);
      expect(viewWrites(view)).toHaveLength(1);
    });
  });

  it('two edits to the same topic: applied in order, the last wins, each in exactly one write', async () => {
    const view = await mount();
    const settle = await unconfirmedRecent(view);
    act(() => { foldTopic(TOPIC); });
    act(() => { foldTopic(TOPIC); });
    expect(topicFolded(TOPIC)).toBe(false);
    act(() => { foldTopic(TOPIC); });
    expect(topicFolded(TOPIC)).toBe(true);
    const done = viewEditsFor(view.navigation);
    expect(done.pending(route)).toBe(3);
    await settle();
    await waitFor(() => expect(done.pending(route)).toBe(0));
    const writes = viewWrites(view);
    // One batched write, in queue order: fold, unfold, fold leaves the topic folded once.
    expect(writes).toHaveLength(1);
    expect(writes[0]!.collapsed_topic_ids).toHaveLength(1);
    expect(topicFolded(TOPIC)).toBe(true);
  });

  it('a saved view arriving with an in-flight toggle drops it in that same update: the chip never flips back, nothing is written twice', async () => {
    const view = await mount();
    const gate = gateWrite(view, request => request.command.command === 'preferences_patch' && request.command.params.entries
      .some(entry => entry.kind === 'set_session_view' && entry.preferences.filters.statuses.includes('open')));
    const pressed = watchAttribute(chip('Open'), 'aria-pressed');
    act(() => { fireEvent.click(chip('Open')); });
    await waitFor(() => expect(gate.entered()).toBe(true));
    expect(chip('Open').getAttribute('aria-pressed')).toBe('true');
    await gate.release();
    await waitFor(() => expect(viewOf(view.transport).filters.statuses).toEqual(['open']));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    pressed.stop();
    expect(pressed.values).toEqual(['false', 'true']);
    expect(viewWrites(view)).toHaveLength(1);
    expect(viewEditsFor(view.navigation).pending(route)).toBe(0);
  });

  describe('a preferences refresh publishes the saved view carrying the in-flight chip before its receipt: the chip stays pressed', () => {
    const isOpenWrite = (request: OwnerMutationRequest) => request.command.command === 'preferences_patch' && request.command.params.entries
      .some(entry => entry.kind === 'set_session_view' && entry.preferences.filters.statuses.includes('open'));
    const outcomes = [
      { name: 'the receipt still on its way', hold: (view: Mounted, isWrite: (request: OwnerMutationRequest) => boolean = isOpenWrite) => {
        // The core commits the write; its response is held.
        let release!: () => void, entered = false;
        const gate = new Promise<void>(resolve => { release = resolve; }), invoke = view.transport.invoke.bind(view.transport);
        vi.spyOn(view.transport, 'invoke').mockImplementation(async (name, args) => {
          const reply = await invoke(name, args);
          if (!entered && 'command' in args.request && isWrite(args.request)) { entered = true; await gate; }
          return reply;
        });
        return { entered: () => entered, settle: async () => { await act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 0)); }); } };
      } },
      { name: 'the outcome unknown until Check again', hold: (view: Mounted, isWrite: (request: OwnerMutationRequest) => boolean = isOpenWrite) => {
        // The core commits the write; its response is lost.
        let entered = false;
        const invoke = view.transport.invoke.bind(view.transport);
        vi.spyOn(view.transport, 'invoke').mockImplementation(async (name, args) => {
          const reply = await invoke(name, args);
          if (!entered && 'command' in args.request && isWrite(args.request)) { entered = true; throw new Error('Lost response'); }
          return reply;
        });
        return { entered: () => entered, settle: async () => {
          await waitFor(() => expect(view.navigation.getSnapshot().pendingOperationId).not.toBeNull());
          await act(async () => { expect(await view.navigation.retryMutation()).toBe(true); });
          await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
        } };
      } },
    ];
    it.each(outcomes)('with $name', async ({ hold }) => {
      const view = await mount();
      const held = hold(view);
      const pressed = watchAttribute(chip('Open'), 'aria-pressed');
      act(() => { fireEvent.click(chip('Open')); });
      await waitFor(() => expect(held.entered()).toBe(true));
      expect(viewOf(view.transport).filters.statuses).toEqual(['open']);
      const rows = () => screen.getAllByRole('treeitem').map(row => row.getAttribute('aria-label') ?? row.textContent);
      const drawn = rows();
      // The 2 s poll (or a preferences_changed hint) reads the committed revision before the receipt.
      await act(async () => { await view.navigation.refresh(); });
      expect(view.navigation.getSnapshot().preferences!.sessions.find(value => value.session.session_id === route.session_id)!.filters.statuses).toEqual(['open']);
      expect(chip('Open').getAttribute('aria-pressed')).toBe('true');
      expect(rows()).toEqual(drawn);
      await held.settle();
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
      pressed.stop();
      expect(pressed.values).toEqual(['false', 'true']);
      expect(rows()).toEqual(drawn);
      expect(viewWrites(view)).toHaveLength(1);
      expect(viewOf(view.transport).filters.statuses).toEqual(['open']);
    });
  });

  describe('a legacy save of every status but done: Done saves no filter, and a refresh before the receipt never filters to Done', () => {
    const legacy = ['waiting_on_me', 'open', 'in_progress', 'decided', 'dropped', 'replaced'] as const;
    const isDoneWrite = (request: OwnerMutationRequest) => request.command.command === 'preferences_patch' && request.command.params.entries
      .some(entry => entry.kind === 'set_session_view' && entry.preferences.filters.statuses.length === 0);
    const outcomes = [
      { name: 'the receipt still on its way', hold: (view: Mounted) => {
        let release!: () => void, entered = false;
        const gate = new Promise<void>(resolve => { release = resolve; }), invoke = view.transport.invoke.bind(view.transport);
        vi.spyOn(view.transport, 'invoke').mockImplementation(async (name, args) => {
          const reply = await invoke(name, args);
          if (!entered && 'command' in args.request && isDoneWrite(args.request)) { entered = true; await gate; }
          return reply;
        });
        return { entered: () => entered, settle: async () => { await act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 0)); }); } };
      } },
      { name: 'the outcome unknown until Check again', hold: (view: Mounted) => {
        let entered = false;
        const invoke = view.transport.invoke.bind(view.transport);
        vi.spyOn(view.transport, 'invoke').mockImplementation(async (name, args) => {
          const reply = await invoke(name, args);
          if (!entered && 'command' in args.request && isDoneWrite(args.request)) { entered = true; throw new Error('Lost response'); }
          return reply;
        });
        return { entered: () => entered, settle: async () => {
          await waitFor(() => expect(view.navigation.getSnapshot().pendingOperationId).not.toBeNull());
          await act(async () => { expect(await view.navigation.retryMutation()).toBe(true); });
          await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
        } };
      } },
    ];
    it.each(outcomes)('with $name', async ({ hold }) => {
      const view = await mount({ configure: transport => { transport.preferences.sessions[0]!.filters.statuses = [...legacy]; } });
      const rows = () => screen.getAllByRole('treeitem').map(row => row.getAttribute('aria-label') ?? row.textContent);
      const held = hold(view);
      act(() => { fireEvent.click(chip('Done')); });
      await waitFor(() => expect(held.entered()).toBe(true));
      // Done joins the set, which is every status: no filter is saved.
      expect(viewOf(view.transport).filters.statuses).toEqual([]);
      const drawn = rows();
      await act(async () => { await view.navigation.refresh(); });
      expect(view.navigation.getSnapshot().preferences!.sessions.find(value => value.session.session_id === route.session_id)!.filters.statuses).toEqual([]);
      // The Map does not move on its own: no Done-only filter between the refresh and the receipt.
      expect(rows()).toEqual(drawn);
      expect(chip('Done').getAttribute('aria-pressed')).toBe('false');
      await held.settle();
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
      expect(rows()).toEqual(drawn);
      expect(chip('Done').getAttribute('aria-pressed')).toBe('false');
      expect(viewWrites(view)).toHaveLength(1);
      expect(viewOf(view.transport).filters.statuses).toEqual([]);
    });
  });

  it('the saved view moves under an in-flight toggle (another write landed): it stays drawn, rebased, until its own receipt', async () => {
    const view = await mount();
    const gate = gateWrite(view, request => request.command.command === 'preferences_patch' && request.command.params.entries
      .some(entry => entry.kind === 'set_session_view' && entry.preferences.filters.statuses.includes('open')));
    const pressed = watchAttribute(chip('Open'), 'aria-pressed');
    act(() => { fireEvent.click(chip('Open')); });
    await waitFor(() => expect(gate.entered()).toBe(true));
    // A foreign writer changes another field of this view meanwhile.
    viewOf(view.transport).expanded_item_ids = ['1'];
    ++view.transport.preferences.revision;
    await act(async () => { await view.navigation.refresh(); });
    expect(view.navigation.getSnapshot().preferences!.sessions[0]!.expanded_item_ids).toEqual(['1']);
    expect(chip('Open').getAttribute('aria-pressed')).toBe('true');
    await gate.release();
    await waitFor(() => expect(viewOf(view.transport).filters.statuses).toEqual(['open']));
    pressed.stop();
    expect(pressed.values).toEqual(['false', 'true']);
  });

  it('stale revision: queued edits rebase onto the newer saved view; an edit on a topic removed meanwhile is dropped', async () => {
    const view = await mount({ strict: true });
    const session = view.transport.sessions.get(route.session_id)!;
    const topics = Object.values(session.topics).filter(topic => !!topic).map(topic => topic.id);
    const delivery = topics.find(id => session.topics[id]!.name === TOPIC)!;
    const settle = await unconfirmedRecent(view);
    act(() => { foldTopic(TOPIC); });
    expect(topicFolded(TOPIC)).toBe(true);
    // Another writer folds a different topic and expands item 2 only; the agent removes the topic folded here.
    const foreign = topics.find(id => id !== delivery)!;
    Object.assign(viewOf(view.transport), { collapsed_topic_ids: [foreign], expanded_item_ids: ['2'] } satisfies Partial<SessionPreferences>);
    ++view.transport.preferences.revision;
    session.topics[delivery]!.removed_at = '2026-10-19T10:00:00.000Z' as never;
    ++session.revision;
    await act(async () => { await view.navigation.refresh(); await view.store.refresh(true); });
    await settle();
    await waitFor(() => expect(viewEditsFor(view.navigation).pending(route)).toBe(0));
    expect(viewOf(view.transport).collapsed_topic_ids).toEqual([foreign]);
    expect(viewOf(view.transport).expanded_item_ids).toEqual(['2']);
    expect(viewWrites(view)).toHaveLength(0);
  });

  it('stale revision: a queued fold rebases onto the newer saved view, keeping the other writer\'s change', async () => {
    const view = await mount({ strict: true });
    const session = view.transport.sessions.get(route.session_id)!;
    const delivery = Object.values(session.topics).find(topic => topic?.name === TOPIC)!.id;
    const settle = await unconfirmedRecent(view);
    act(() => { foldTopic(TOPIC); });
    viewOf(view.transport).expanded_item_ids = ['2'];
    ++view.transport.preferences.revision;
    await act(async () => { await view.navigation.refresh(); });
    expect(topicFolded(TOPIC)).toBe(true);
    await settle();
    await waitFor(() => expect(viewOf(view.transport).collapsed_topic_ids).toEqual([delivery]));
    expect(viewOf(view.transport).expanded_item_ids).toEqual(['2']);
    expect(viewWrites(view)).toHaveLength(1);
  });

  it('write fails: the edit stays queued and drawn, and is retried on the next settle', async () => {
    const view = await mount();
    let refuse = true;
    const invoke = view.transport.invoke.bind(view.transport);
    vi.spyOn(view.transport, 'invoke').mockImplementation(async (name, args) => {
      if (refuse && 'command' in args.request && args.request.command.command === 'preferences_patch'
        && args.request.command.params.entries.some(entry => entry.kind === 'set_session_view')) {
        refuse = false;
        view.transport.mutations.push(structuredClone(args.request));
        return { api_version: 1, ok: false, error: { code: 'invalid_argument', message: 'Refused.', hint: '', retryable: false, field_errors: [] } } as never;
      }
      return invoke(name, args);
    });
    const expanded = watchAttribute(topicRow(TOPIC), 'aria-expanded');
    await act(async () => { foldTopic(TOPIC); await new Promise(resolve => setTimeout(resolve, 20)); });
    await waitFor(() => expect(notices.getSnapshot().some(notice => notice.id === VIEW_SAVE_FAILED)).toBe(true));
    expect(topicFolded(TOPIC)).toBe(true);
    expect(viewOf(view.transport).collapsed_topic_ids ?? []).toEqual([]);
    expect(viewEditsFor(view.navigation).pending(route)).toBe(1);
    // Nothing retries on its own until another write settles.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(viewWrites(view)).toHaveLength(1);
    await act(async () => { await view.navigation.saveTheme('dark', view.transport.preferences.revision); });
    await waitFor(() => expect(viewOf(view.transport).collapsed_topic_ids).toHaveLength(1));
    expect(viewWrites(view)).toHaveLength(2);
    expect(viewEditsFor(view.navigation).pending(route)).toBe(0);
    expanded.stop();
    expect(expanded.values).toEqual(['true', 'false']);
  });

  it('write outcome unknown: the edit stays drawn while Check again replays it, and lands once, never re-queued', async () => {
    const view = await mount();
    let lose = true;
    const invoke = view.transport.invoke.bind(view.transport);
    vi.spyOn(view.transport, 'invoke').mockImplementation(async (name, args) => {
      if (lose && 'command' in args.request && args.request.command.command === 'preferences_patch'
        && args.request.command.params.entries.some(entry => entry.kind === 'set_session_view')) { lose = false; throw new Error('Lost response'); }
      return invoke(name, args);
    });
    await act(async () => { foldTopic(TOPIC); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(view.navigation.getSnapshot().pendingOperationId).not.toBeNull();
    expect(topicFolded(TOPIC)).toBe(true);
    await act(async () => { expect(await view.navigation.retryMutation()).toBe(true); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(viewOf(view.transport).collapsed_topic_ids).toHaveLength(1);
    expect(viewWrites(view)).toHaveLength(1);
    expect(viewEditsFor(view.navigation).pending(route)).toBe(0);
    expect(topicFolded(TOPIC)).toBe(true);
  });

  it('app quit with edits queued: they are lost, never half-applied', async () => {
    const view = await mount();
    await unconfirmedRecent(view);
    act(() => { foldTopic(TOPIC); });
    const before = structuredClone(viewOf(view.transport));
    cleanup();
    view.navigation.stop();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(viewWrites(view)).toHaveLength(0);
    expect(viewOf(view.transport)).toEqual(before);
  });
});
