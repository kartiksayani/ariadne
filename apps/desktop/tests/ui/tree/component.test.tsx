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
import type { ItemRoute } from '../../../src/generated/core';
import { createDesktopService } from '../../../src/data/service';
import type { RevealedItem } from '../../../src/data/routes';
import { NavigationStore } from '../../../src/state/navigation/store';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { SessionActionControllers } from '../../../src/components/bindings/actions';
import { TreeView, type RowIntent, type TreeViewProps } from '../../../src/ui/tree/TreeView';
import type { PendingSubmission } from '../../../src/ui/answer/useSubmit';
import { AppTransport, route } from '../app/transport';
import { HistoryTransport } from '../history-actions/fixture';
import { RecoveryPanel } from '../../../src/components/recovery/RecoveryPanel';

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
      detailOpen={false} railOpen={false} highlightedItems={none} highlightedMessages={none} summaries={[]} now={now} onHoverItem={hover}
      onSelected={result => { calls.selected.push(result); if (result.kind === 'item') setSelected(result.route.item_id); }}
      onDismissReveal={() => { calls.dismissed++; }} onResume={() => { calls.resumed++; }} onAct={(intent, target) => { calls.acts.push([intent, target]); }}
      onClearFilters={() => { calls.cleared++; }} onShowArchive={() => { calls.archive++; }}
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
    expect(document.querySelector('.tree-run .dispatch-label')?.textContent).toBe('Sending');
    expect(within(screen.getByRole('group', { name: 'Sending to the agent' })).getByRole('button', { name: 'Pause' })).toBeTruthy();
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
    await act(async () => { fireEvent.click(within(band).getByRole('button', { name: 'Delete' })); });
    expect(cancels(transport).map(request => request.command.params)).toMatchObject([{ input_id: id }]);
    await waitFor(() => expect(within(topicRow('Continued context')).queryByRole('button', { name: 'Delete' })).toBeNull());
    expect(transport.preferences.drafts.filter(draft => draft.target.item_id === null)).toHaveLength(0);
  });
  it('edits a topic reply not sent yet: the queued reply is taken back first, then its text goes into the topic’s reply box', async () => {
    let id = '';
    const { transport } = await mount({ configure: value => { id = queuedReply(value); } });
    await act(async () => { fireEvent.click(within(topicRow('Continued context')).getByRole('button', { name: 'Edit' })); });
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
    await act(async () => { fireEvent.click(within(topicRow('Continued context')).getByRole('button', { name: 'Edit' })); });
    expect((await screen.findByLabelText('Your earlier message') as HTMLTextAreaElement).value).toBe(text);
    expect(drafts.findTopic(route, topic)?.draft.text).toBe('Something else');
    expect(cancels(transport)).toHaveLength(0);
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
    expect(document.querySelector('.tree-empty-connection')?.textContent).not.toMatch(/ in /);
  });
  it('names the host location in the session bar and the terminal app in the empty state', async () => {
    await mount({ configure: transport => {
      const session = transport.sessions.get(route.session_id)!; session.items = {}; session.inputs = {};
      session.bindings[session.active_binding_id!]!.host_location = 'iTerm window 1';
    } });
    expect(document.querySelector('.tree-session-title')?.textContent).toBe('demo.local · iTerm window 1');
    expect(document.querySelector('.tree-empty-connection')?.textContent).toBe('Connected to demo.local in iTerm · waiting for the agent’s first message');
  });
  it('shows the empty session without a running agent', async () => {
    await mount({ configure: transport => {
      const session = transport.sessions.get(route.session_id)!; session.items = {}; session.inputs = {};
      const binding = session.bindings[session.active_binding_id!]!; binding.connection_state = 'disconnected'; binding.dispatch_state = 'disconnected';
    } });
    expect(document.querySelector('.tree-empty-connection')?.textContent).toMatch(/is not running · items appear when it writes$/);
    expect(document.querySelector('.tree-run .dispatch-label')?.textContent).toBe('Disconnected');
    expect(document.querySelector('.tree-run')?.getAttribute('data-running')).toBeNull();
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
    expect(await screen.findByText(new RegExp(`${unsent.length} unsent messages were cancelled\\.`))).toBeTruthy();
    expect(unsent.every(id => session.inputs[id]!.state === 'cancelled')).toBe(true);
    expect(Object.values(session.items).map(item => item!.status)).toEqual(statuses);
  });
  it('archives the focused row’s topic with e', async () => {
    const transport = new HistoryTransport();
    await mount({ transport });
    row('4').focus(); fireEvent.keyDown(row('4'), { key: 'e' });
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
  it('offers Reopen session on a closed session', async () => {
    await mount({ configure: transport => { const session = transport.sessions.get(route.session_id)!; session.state = 'closed'; session.closed_at = session.updated_at; } });
    fireEvent.click(screen.getByRole('button', { name: 'Reopen session' }));
    expect(screen.getByRole('dialog', { name: 'Reopen this session?' })).toBeTruthy();
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
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close session' })); });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Closing the session isn’t confirmed yet. Check whether your last change was saved before making another.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Close session' }) as HTMLButtonElement).disabled).toBe(true);
    const request = structuredClone(transport.mutations[0]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check again' })); });
    expect(transport.mutations).toEqual([request, request]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reopen session' })).toBeTruthy());
  });
});

describe('stopped deliveries in the tree', () => {
  const stopped = '00000000-0000-4000-8000-000000000074';
  // Input 74 (item 7) stopped mid-delivery; on the active binding it is a recovery target.
  const active = (transport: AppTransport) => { const session = transport.sessions.get(route.session_id)!; session.inputs[stopped]!.binding_id = session.active_binding_id!; };
  const banner = () => screen.queryByRole('region', { name: 'Delivery recovery' });
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
    expect(within(banner()!).getByText('A message needs your decision')).toBeTruthy();
    fireEvent.click(chip('All'));
    await waitFor(() => expect(banner()).toBeNull());
  });
});

describe('Reply to topic', () => {
  const box = () => document.querySelector<HTMLElement>('[data-owner-input^="topic:"]');
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
  it('asks before sending when the agent is not running, and queues only on request', async () => {
    const held: PendingSubmission[] = [];
    const { transport, drafts } = await mount({ props: { onAgentNotRunning: submission => { held.push(submission); } }, configure: transport => {
      options(transport);
      const binding = transport.sessions.get(route.session_id)!.bindings[transport.sessions.get(route.session_id)!.active_binding_id!]!;
      binding.connection_state = 'disconnected'; binding.dispatch_state = 'disconnected';
    } });
    row('2').focus(); fireEvent.keyDown(row('2'), { key: 'a' });
    await waitFor(() => expect(control()).not.toBeNull());
    await waitFor(() => expect(drafts.getSnapshot().ready).toBe(true));
    await waitFor(() => expect((within(control()!).getByRole('button', { name: /Send “Afternoon”/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.keyDown(row('2'), { key: 'Enter' });
    await waitFor(() => expect(held).toHaveLength(1));
    expect(held[0]).toMatchObject({ route: { ...route, item_id: '2' }, intent: 'answer', label: 'Afternoon', question: transport.sessions.get(route.session_id)!.items['2']!.question });
    expect(transport.mutations.some(request => request.command.command === 'input_submit')).toBe(false);
    expect(await held[0].queue()).toBe(true);
    expect(transport.mutations.some(request => request.command.command === 'input_submit')).toBe(true);
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
  it('restores the reading position unless it leaves the open item off-screen', async () => {
    layout();
    await mount({ configure: savedAtTop, props: { selectedId: '8' } });
    // Detail closed: the saved position wins.
    expect(top('1')).toBe(0); expect(top('8')).toBe(800);
    cleanup();
    await mount({ configure: savedAtTop, props: { selectedId: '8', detailOpen: true } });
    expect(top('8')).toBeGreaterThanOrEqual(0); expect(top('8') + 40).toBeLessThanOrEqual(400);
  });
  it('brings the selected row back into view when the detail panel opens', async () => {
    layout();
    const { rerender } = await mount({ configure: savedAtTop, props: { selectedId: '8' } });
    expect(top('8')).toBe(800);
    rerender({ detailOpen: true });
    expect(top('8')).toBeGreaterThanOrEqual(0); expect(top('8') + 40).toBeLessThanOrEqual(400);
    // A row already in view stays put.
    const before = top('8');
    rerender({ detailOpen: true, railOpen: true });
    expect(top('8')).toBe(before);
  });
});

describe('item details in the tree', () => {
  const long = Array.from({ length: 20 }, (_, index) => `Line ${index + 1} of a long finding the agent wrote.`).join('\n');
  // jsdom has no layout: text over 100 characters reports a tall scrollHeight, anything shorter fits.
  const measure = () => vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
    return this.classList.contains('tree-clamp') && (this.textContent?.length ?? 0) > 100 ? 420 : 20;
  });
  const longOutcome = (transport: AppTransport) => { transport.sessions.get(route.session_id)!.items['1']!.outcome = long; };
  const more = (id: string) => within(row(id)).queryByRole('button', { name: /^Show (more|less)$/ });

  it('folds a long preview to six lines with Show more and Show less, and none for short text', async () => {
    measure();
    const { calls } = await mount({ configure: longOutcome });
    const preview = row('1').querySelector<HTMLElement>('.tree-preview')!;
    expect(preview.style.getPropertyValue('--tree-clamp')).toBe('6');
    expect(preview.hasAttribute('data-open')).toBe(false);
    // Short details have no control; the title is never folded.
    expect(more('5')).toBeNull(); expect(more('3')).toBeNull();
    expect(row('1').querySelector('.tree-question .tree-clamp')).toBeNull();
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

  it('keeps the space of the shortcut icons so the text never changes width on hover', async () => {
    await mount();
    const body = row('4').querySelector('.tree-body')!, before = row('4').innerHTML;
    expect(row('4').querySelector('.tree-actions')).not.toBeNull();
    fireEvent.mouseEnter(row('4'));
    expect(row('4').innerHTML).toBe(before); expect(row('4').querySelector('.tree-body')).toBe(body);
    // The icons are always laid out and only fade in: nothing in the stylesheet takes them out of the flow.
    const css = readFileSync(resolve(__dirname, '../../../src/ui/tree/tree.css'), 'utf8');
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, selector]) => /\.tree-actions\b/.test(selector!));
    expect(rules.length).toBeGreaterThan(0);
    for (const [, , declarations] of rules) expect(declarations).not.toMatch(/display:\s*none|width:|position:\s*absolute/);
    expect(rules.some(([, , declarations]) => /visibility:\s*hidden/.test(declarations!) && /opacity:\s*0/.test(declarations!))).toBe(true);
  });
});

describe('scrolling the tree', () => {
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
  });

  it('reveals an item opened from elsewhere only when it is not in view', async () => {
    const view = await opened();
    view.rerender({ reveal: link(view, '4'), selectedId: '4' });
    expect(scroller().scrollTop).toBe(150);
    view.rerender({ reveal: link(view, '8'), selectedId: '8' });
    expect(scroller().scrollTop).not.toBe(150);
    expect(row('8').getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    expect(row('8').getBoundingClientRect().bottom).toBeLessThanOrEqual(400);
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

  // The first row grows by `grow` px (a live edit made it longer); every row below it moves down with it.
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
});
