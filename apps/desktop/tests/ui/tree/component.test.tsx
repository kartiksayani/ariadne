// The Paperwhite session tree (ui/tree) over the real navigation, session,
// draft and action stores. The workspace props (reveal, selection, intents) are
// recorded instead of composed; App.test.tsx covers the composed workspace.
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ItemRoute } from '../../../src/generated/core';
import { createDesktopService } from '../../../src/data/service';
import type { RevealedItem } from '../../../src/data/routes';
import { NavigationStore } from '../../../src/state/navigation/store';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { SessionActionControllers } from '../../../src/components/bindings/actions';
import { TreeView, type RowIntent, type TreeViewProps } from '../../../src/ui/tree/TreeView';
import { AppTransport, route } from '../app/transport';
import { HistoryTransport } from '../history-actions/fixture';

const stores: NavigationStore[] = [];
afterEach(() => { cleanup(); stores.splice(0).forEach(store => store.stop()); vi.restoreAllMocks(); });
const none: ReadonlySet<string> = new Set();
const now = () => Date.parse('2026-10-07T12:00:00Z');

interface Recorded {
  selected: RevealedItem[]; hovered: (string | null)[]; acts: [RowIntent, ItemRoute][];
  dismissed: number; resumed: number; cleared: number; archive: number; removed: number;
}
async function mount({ transport = new AppTransport(), configure, props = {}, load = true }: {
  transport?: AppTransport; configure?: (transport: AppTransport) => void; props?: Partial<TreeViewProps>; load?: boolean;
} = {}) {
  configure?.(transport);
  transport.preferences.sessions = transport.preferences.sessions.map(view => ({ ...view, tab_open: true }));
  const service = createDesktopService(transport), navigation = new NavigationStore(service); stores.push(navigation);
  await navigation.start();
  const store = navigation.opened.open(route);
  if (load) await store.refresh();
  const actions = new SessionActionControllers(service).forSession(store), drafts = new OwnerDraftStore(service);
  const calls: Recorded = { selected: [], hovered: [], acts: [], dismissed: 0, resumed: 0, cleared: 0, archive: 0, removed: 0 };
  const hover = (id: string | null) => { calls.hovered.push(id); };
  function Harness(extra: Partial<TreeViewProps>) {
    const [selected, setSelected] = useState<string | null>(null);
    return <TreeView navigation={navigation} store={store} actions={actions} drafts={drafts} query="" reveal={null} selectedId={selected}
      detailOpen={false} railOpen={false} highlightedItems={none} highlightedMessages={none} summaries={[]} continueTargets={[]}
      actionsForTarget={() => actions} now={now} onHoverItem={hover}
      onSelected={result => { calls.selected.push(result); if (result.kind === 'item') setSelected(result.route.item_id); }}
      onDismissReveal={() => { calls.dismissed++; }} onResume={() => { calls.resumed++; }} onAct={(intent, target) => { calls.acts.push([intent, target]); }}
      onClearFilters={() => { calls.cleared++; }} onShowArchive={() => { calls.archive++; }} revealItem={() => {}} openSession={() => {}}
      onRemove={() => { calls.removed++; }} {...props} {...extra} />;
  }
  const view = render(<Harness />);
  return { transport, navigation, store, actions, drafts, calls, rerender: (extra: Partial<TreeViewProps>) => view.rerender(<Harness {...extra} />) };
}
const row = (id: string) => document.querySelector<HTMLElement>(`[role="treeitem"][data-item-id="${id}"]`)!;
const topicRow = (name: string) => screen.getByRole('treeitem', { name });
const ids = () => [...document.querySelectorAll('[role="treeitem"][data-item-id]')].map(element => element.getAttribute('data-item-id'));
const viewOf = (transport: AppTransport) => transport.preferences.sessions.find(value => value.session.session_id === route.session_id)!;
const patches = (transport: AppTransport) => transport.mutations.filter(request => request.command.command === 'preferences_patch');
const chip = (label: string) => within(screen.getByRole('group', { name: 'Filter items' })).getByRole('button', { name: new RegExp(`^${label}`) });

describe('session tree rows', () => {
  it('renders topic bands and item rows with one roving tab stop and the session bar', async () => {
    await mount();
    expect(screen.getByRole('tree', { name: 'Session items' })).toBeTruthy();
    expect(topicRow('Delivery decisions').getAttribute('aria-level')).toBe('1');
    expect(row('1').getAttribute('aria-level')).toBe('2'); expect(row('1.1').getAttribute('aria-level')).toBe('3');
    expect(ids()).toEqual(['1', '1.1', '2', '3', '4', '5', '6', '7', '8']);
    expect(screen.getAllByRole('treeitem').filter(element => element.tabIndex === 0)).toHaveLength(1);
    // The bar names the agent (the binding's adapter); the session title is the tab's.
    expect(document.querySelector('.tree-session-title')?.textContent).toBe('demo.local');
    expect(document.querySelector('.tree-session-meta')?.textContent).toMatch(/· 2 topics$/);
    expect(document.querySelector('.tree-run')?.textContent).toBe('Agent running');
    expect(screen.getByRole('button', { name: 'Close session' })).toBeTruthy();
    expect(chip('All').textContent).toContain('9'); expect(chip('Open').textContent).toContain('3');
    expect(chip('Closed').textContent).toContain('4'); expect(chip('All').getAttribute('aria-pressed')).toBe('true');
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
  it('folds a topic locally without a preference write and drops a temporary reveal', async () => {
    const { transport, calls } = await mount(), writes = patches(transport).length;
    const band = topicRow('Delivery decisions');
    fireEvent.click(within(band).getByRole('button', { name: 'Expand or collapse topic' }));
    expect(band.getAttribute('aria-expanded')).toBe('false'); expect(ids()).toEqual(['8']);
    expect(calls.dismissed).toBe(1);
    band.focus(); fireEvent.keyDown(band, { key: 'ArrowRight' });
    expect(band.getAttribute('aria-expanded')).toBe('true'); expect(ids()).toHaveLength(9);
    fireEvent.keyDown(band, { key: 'ArrowLeft' }); expect(band.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(band, { key: 'Enter' }); expect(band.getAttribute('aria-expanded')).toBe('true');
    expect(patches(transport)).toHaveLength(writes);
  });
  it('reports hover, highlights touched rows and notes touches folded inside', async () => {
    const { calls, rerender } = await mount();
    fireEvent.mouseEnter(row('4')); fireEvent.mouseLeave(row('4'));
    expect(calls.hovered.slice(-2)).toEqual(['4', null]);
    rerender({ highlightedItems: new Set(['1.1']) });
    expect(row('1.1').getAttribute('data-highlight')).toBe('strong'); expect(row('1').getAttribute('data-highlight')).toBeNull();
    fireEvent.click(within(row('1')).getByRole('button', { name: 'Expand or collapse' }));
    await waitFor(() => expect(row('1').getAttribute('data-highlight')).toBe('weak'));
  });
  it('offers the row actions for the item status and routes them to the workspace', async () => {
    const { calls } = await mount();
    fireEvent.click(within(row('1.1')).getByRole('button', { name: 'Bring it up (b)' }));
    fireEvent.click(within(row('1.1')).getByRole('button', { name: 'Later (z)' }));
    fireEvent.click(within(row('5')).getByRole('button', { name: 'Back to Open (o)' }));
    fireEvent.click(within(row('5')).getByRole('button', { name: 'Follow up (r)' }));
    fireEvent.click(within(row('1.1')).getByRole('button', { name: 'Remove (⌫)' }));
    expect(calls.acts.map(([intent, target]) => `${intent}:${target.item_id}`)).toEqual(['bring:1.1', 'later:1.1', 'reopen:5', 'followup:5']);
    expect(calls.removed).toBe(1);
    // A delivery on its way (item 3's in-flight input) leaves only Remove.
    expect(within(row('3')).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Remove (⌫)']);
    fireEvent.keyDown(row('1.1'), { key: 'b' }); expect(calls.acts).toHaveLength(4);
  });
});

describe('session tree filters', () => {
  it('writes the status chip and the topic, and counts follow the search and topic', async () => {
    const { transport, rerender } = await mount();
    fireEvent.click(chip('Open'));
    await waitFor(() => expect(viewOf(transport).filters.statuses).toEqual(['open']));
    expect(chip('Open').getAttribute('aria-pressed')).toBe('true'); expect(ids()).toEqual(['1', '1.1', '4', '8']);
    expect(row('1').querySelector('.tree-question')?.getAttribute('style')).toContain('64%');
    rerender({ query: 'receipt' });
    expect(chip('All').textContent).toContain('2'); expect(chip('Open').textContent).toContain('1');
    expect(row('1.1').querySelector('.tree-hit')?.textContent?.toLowerCase()).toBe('receipt');
    rerender({ query: '' });
    const topic = Object.values(transport.sessions.get(route.session_id)!.topics).find(value => value?.name === 'Continued context')!;
    fireEvent.change(screen.getByRole('combobox', { name: 'Topic' }), { target: { value: topic.id } });
    await waitFor(() => expect(viewOf(transport).filters.topic_id).toBe(topic.id));
    expect(chip('All').textContent).toContain('1'); expect(ids()).toEqual(['8']);
    fireEvent.change(screen.getByRole('combobox', { name: 'Topic' }), { target: { value: 'all' } });
    await waitFor(() => expect(viewOf(transport).filters.topic_id).toBeNull());
    fireEvent.click(chip('All'));
    await waitFor(() => expect(viewOf(transport).filters.statuses).toEqual([]));
  });
  it('hides the topic select while detail and rail are both open', async () => {
    const { rerender } = await mount();
    rerender({ detailOpen: true });
    expect(screen.getByRole('combobox', { name: 'Topic' })).toBeTruthy();
    rerender({ detailOpen: true, railOpen: true });
    expect(screen.queryByRole('combobox', { name: 'Topic' })).toBeNull();
  });
  it('offers one clear action when nothing matches', async () => {
    const { calls, rerender } = await mount();
    rerender({ query: 'zzz' });
    expect(screen.getByText('Nothing matches “zzz”.')).toBeTruthy(); expect(screen.queryByRole('tree')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search and filters' })); expect(calls.cleared).toBe(1);
  });
  it('says so when a status filter matches nothing', async () => {
    await mount({ configure: transport => { viewOf(transport).filters.statuses = ['waiting_on_me']; transport.sessions.get(route.session_id)!.items['2']!.status = 'open'; } });
    expect(screen.getByText('No items match these filters.')).toBeTruthy();
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
    await waitFor(() => expect((chip('All') as HTMLButtonElement).disabled).toBe(true));
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
  });
  it('shows the empty session without a running agent', async () => {
    await mount({ configure: transport => {
      const session = transport.sessions.get(route.session_id)!; session.items = {}; session.inputs = {};
      const binding = session.bindings[session.active_binding_id!]!; binding.connection_state = 'disconnected'; binding.dispatch_state = 'disconnected';
    } });
    expect(document.querySelector('.tree-empty-connection')?.textContent).toMatch(/is not running · items appear when it writes$/);
    expect(document.querySelector('.tree-run')?.textContent).toBe('Agent not running');
  });
  it('shows graph content in place of the rows and clears the hover', async () => {
    const { calls, rerender } = await mount();
    fireEvent.mouseEnter(row('4'));
    rerender({ graph: <p>Topic graph stand-in</p> });
    expect(screen.getByText('Topic graph stand-in')).toBeTruthy(); expect(screen.queryByRole('tree')).toBeNull();
    expect(calls.hovered.at(-1)).toBeNull();
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
  it('archives a closed topic at once from its prompt, with Undo and View archive', async () => {
    const transport = new HistoryTransport();
    const { calls } = await mount({ transport, configure: value => {
      const session = value.sessions.get(route.session_id)!; session.items['8']!.status = 'done';
      for (const input of Object.values(session.inputs)) if (input && input.target.topic_id === session.items['8']!.topic_id) input.state = 'handled';
    } });
    const band = topicRow('Continued context');
    expect(within(band).getByText('Everything here is closed.')).toBeTruthy();
    await act(async () => { fireEvent.click(within(band).getByRole('button', { name: 'Archive topic' })); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText('Archived “Continued context”.')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo' })); });
    await waitFor(() => expect(screen.queryByText('Archived “Continued context”.')).toBeNull());
    expect(transport.mutations.map(value => value.command.command)).toEqual(['topic_archive', 'topic_restore']);
    await act(async () => { fireEvent.click(within(topicRow('Continued context')).getByRole('button', { name: 'Archive' })); });
    fireEvent.click(await screen.findByRole('button', { name: 'View archive' }));
    expect(calls.archive).toBe(1); expect(screen.queryByText('Archived “Continued context”.')).toBeNull();
  });
  it('reviews the blockers before archiving a topic with open work', async () => {
    const transport = new HistoryTransport();
    await mount({ transport });
    fireEvent.click(within(topicRow('Delivery decisions')).getByRole('button', { name: 'Archive' }));
    const dialog = within(screen.getByRole('dialog'));
    expect((dialog.getByRole('button', { name: 'Confirm topic archive' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' })); expect(transport.mutations).toHaveLength(0);
  });
  it('archives the focused row’s topic with e', async () => {
    const transport = new HistoryTransport();
    await mount({ transport });
    row('4').focus(); fireEvent.keyDown(row('4'), { key: 'e' });
    expect(screen.getByRole('dialog', { name: 'Confirm topic archive' })).toBeTruthy();
  });
  it('offers Continue here on an earlier topic and opens the continue dialog', async () => {
    await mount();
    expect(within(topicRow('Continued context')).queryByRole('button', { name: 'Continue here' })).toBeNull();
    fireEvent.click(within(topicRow('Delivery decisions')).getByRole('button', { name: 'Continue here' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('offers Continue here on a topic from a session created today', async () => {
    const session = new AppTransport().sessions.get(route.session_id)!;
    await mount({ props: { now: () => Date.parse(session.created_at) } });
    expect(within(topicRow('Delivery decisions')).queryByText(/· (today|yesterday)/)).toBeNull();
    expect(within(topicRow('Delivery decisions')).getByRole('button', { name: 'Continue here' })).toBeTruthy();
  });
  it('offers Reopen session on a closed session', async () => {
    await mount({ configure: transport => { const session = transport.sessions.get(route.session_id)!; session.state = 'closed'; session.closed_at = session.updated_at; } });
    fireEvent.click(screen.getByRole('button', { name: 'Reopen session' }));
    expect(screen.getByRole('dialog', { name: 'Confirm session reopen' })).toBeTruthy();
  });
  it('keeps an uncertain session action for an exact reconcile from the column', async () => {
    const transport = new HistoryTransport();
    await mount({ transport, configure: value => {
      const session = value.sessions.get(route.session_id)!, binding = session.bindings[session.active_binding_id!]!;
      binding.dispatch_state = 'paused'; binding.owner_paused = true; session.inputs = {};
      Object.values(session.items).forEach(item => { if (item) { item.status = 'done'; item.waiting_since = null; } });
    } });
    transport.replies.push(new Error('Lost acknowledgement'));
    fireEvent.click(screen.getByRole('button', { name: 'Close session' }));
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm session close' })); });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('The saved session close is not confirmed. Reconcile it before another change.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Close session' }) as HTMLButtonElement).disabled).toBe(true);
    const request = structuredClone(transport.mutations[0]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reconcile saved action' })); });
    expect(transport.mutations).toEqual([request, request]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reopen session' })).toBeTruthy());
  });
});

describe('session tree inline answering', () => {
  const options = (transport: AppTransport) => { transport.sessions.get(route.session_id)!.items['2']!.options = [
    { id: 'morning', label: 'Morning', consequence: 'Deliver before lunch.', recommended: false },
    { id: 'afternoon', label: 'Afternoon', consequence: 'Deliver after lunch.', recommended: true },
  ]; };
  const control = () => row('2').querySelector<HTMLElement>('.answer');
  const picked = () => [...control()!.querySelectorAll('.answer-option')].map(button => button.getAttribute('aria-pressed'));
  it('opens on a with the recommended option picked, changes it by number and sends it on Enter', async () => {
    const { transport, drafts } = await mount({ configure: options });
    row('2').focus(); fireEvent.keyDown(row('2'), { key: 'a' });
    await waitFor(() => expect(control()).not.toBeNull());
    expect(picked()).toEqual(['false', 'true']);
    await waitFor(() => expect(drafts.getSnapshot().ready).toBe(true));
    await waitFor(() => expect(within(control()!).getByRole('button', { name: /Send “Afternoon”/ })).toBeTruthy());
    fireEvent.keyDown(row('2'), { key: '1' });
    await waitFor(() => expect(picked()).toEqual(['true', 'false']));
    fireEvent.keyDown(row('2'), { key: 'Enter' });
    await waitFor(() => expect(transport.mutations.some(request => request.command.command === 'input_submit')).toBe(true));
    expect(transport.mutations.find(request => request.command.command === 'input_submit')!.command).toMatchObject({ params: { target: { item_id: '2' } } });
  });
  it('picks by click, keeps a typed reply and closes on Escape', async () => {
    await mount({ configure: options });
    row('2').focus(); fireEvent.keyDown(row('2'), { key: 'a' });
    await waitFor(() => expect(control()).not.toBeNull());
    await waitFor(() => expect((within(control()!).getByRole('button', { name: /Send “/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(control()!).getAllByRole('button', { pressed: false })[0]);
    await waitFor(() => expect(picked()).toEqual(['true', 'false']));
    const text = within(control()!).getByLabelText('Reply in your own words');
    fireEvent.change(text, { target: { value: 'Neither, ship tomorrow.' } });
    await waitFor(() => expect((within(control()!).getByRole('button', { name: 'Send reply' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.keyDown(text, { key: 'Escape' });
    expect(control()).toBeNull(); expect(document.activeElement).toBe(row('2'));
    fireEvent.keyDown(row('2'), { key: 'a' });
    await waitFor(() => expect((within(control()!).getByLabelText('Reply in your own words') as HTMLTextAreaElement).value).toBe('Neither, ship tomorrow.'));
    fireEvent.keyDown(row('2'), { key: 'Escape' }); expect(control()).toBeNull();
  });
  it('answers the oldest waiting question when a is pressed elsewhere', async () => {
    await mount({ configure: options });
    row('4').focus(); fireEvent.keyDown(row('4'), { key: 'a' });
    await waitFor(() => expect(control()).not.toBeNull()); expect(document.activeElement).toBe(row('2'));
  });
  it('blocks sending in a closed session', async () => {
    await mount({ configure: transport => { options(transport); transport.sessions.get(route.session_id)!.state = 'closed'; } });
    row('2').focus(); fireEvent.keyDown(row('2'), { key: 'a' });
    await waitFor(() => expect(control()).not.toBeNull());
    expect(within(control()!).getByText('This session is closed. Reopen it to answer.')).toBeTruthy();
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
});
