// A pending removal and Details' composers (alpha.21 E28): while an item (or the topic it sits in) is in its removal window, its
// composer says "Being removed · Undo first", Send is off and ⌘↵ sends nothing; Undo brings the words back and Send returns.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { createDesktopService, type RendererService } from '../../../src/data/service';
import { SessionStore } from '../../../src/data/session-store';
import { NoticeStore } from '../../../src/ui/pages/notices';
import type { RemoveSubject, RemoveTarget } from '../../../src/ui/dialogs/remove';
import { ItemDetail } from '../../../src/ui/detail/ItemDetail';
import { TopicConversation } from '../../../src/ui/detail/TopicConversation';
import { RemovalContext, RemovalQueue } from '../../../src/ui/remove/queue';
import { DesktopApp } from '../../../src/App';
import { AppTransport, route } from '../app/transport';
import { answerWords } from '../answer/words';

const stores: SessionStore[] = [];
afterEach(() => { cleanup(); stores.splice(0).forEach(store => store.close()); vi.restoreAllMocks(); });

const subject: RemoveSubject = { kind: 'item', short: 'cache lookup', items: 1, waiting: 0, tell: { agent: 'claude-code', mode: 'tell' } };
const itemTarget = (itemId: string): RemoveTarget => ({ kind: 'item', item: { ...route, item_id: itemId } });

function queueFor() {
  let next = 0;
  const service = { removeItem: vi.fn(async () => ({})), removeTopic: vi.fn(async () => ({})) };
  return new RemovalQueue({ service: service as unknown as RendererService, notices: new NoticeStore(), read: async () => null, removed: vi.fn(async () => {}),
    operationId: () => `00000000-0000-4000-8000-0000000007${String(++next).padStart(2, '0')}`,
    toasts: { show: vi.fn(() => 'toast-1'), expire: vi.fn(), dismiss: vi.fn() }, settled: vi.fn(async () => {}), again: vi.fn(), review: () => null });
}

/** Details for item 1.1 with the words "Keep this" typed in its Reply box, inside a removal queue. */
async function typed() {
  const transport = new AppTransport(), appService = createDesktopService(transport), store = new SessionStore(appService, route);
  stores.push(store);
  const drafts = new OwnerDraftStore(appService);
  await act(async () => { await Promise.all([store.refresh(), drafts.load()]); });
  let next = 0;
  const service = { removeItem: vi.fn(async () => ({})), removeTopic: vi.fn(async () => ({})) };
  const queue = new RemovalQueue({ service: service as unknown as RendererService, notices: new NoticeStore(), read: async () => null, removed: vi.fn(async () => {}),
    operationId: () => `00000000-0000-4000-8000-0000000008${String(++next).padStart(2, '0')}`,
    toasts: { show: vi.fn(() => 'toast-1'), expire: vi.fn(), dismiss: vi.fn() }, settled: vi.fn(async () => {}), again: vi.fn(), review: () => null });
  render(<RemovalContext.Provider value={queue}><ItemDetail drafts={drafts} store={store} itemId="1.1" later={false} onOpenItem={vi.fn()} /></RemovalContext.Provider>);
  const detail = document.querySelector<HTMLElement>('.item-detail')!;
  fireEvent.click(within(detail).getByRole('button', { name: 'Reply' }));
  const box = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Reply message' });
  fireEvent.change(box, { target: { value: 'Keep this' } });
  const send = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Send reply' });
  await waitFor(() => expect(send().disabled).toBe(false));
  return { queue, box, send, service, detail };
}

describe('Details while the item is being removed', () => {
  it.each([
    ['the item itself', '1.1'],
    ['the item above it', '1'],
  ])('%s: the bar says so, Send is off and ⌘↵ sends nothing; Undo gives Send back', async (_name, removed) => {
    const { queue, box, send, detail } = await typed();
    expect(send().disabled).toBe(false);
    let op = '';
    act(() => { op = queue.schedule(itemTarget(removed), subject); });
    expect(within(detail).getByText('Being removed · Undo first')).toBeTruthy();
    expect(send().disabled).toBe(true);
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(box.value).toBe('Keep this');
    expect(within(detail).queryByText(/Sending…/u)).toBeNull();
    act(() => { queue.undo(op); });
    expect(within(detail).queryByText('Being removed · Undo first')).toBeNull();
    expect(send().disabled).toBe(false);
    expect(box.value).toBe('Keep this');
  });

  it('an item that is not being removed keeps its Send', async () => {
    const { queue, send, detail } = await typed();
    let op = '';
    act(() => { op = queue.schedule(itemTarget('2'), subject); });
    expect(within(detail).queryByText('Being removed · Undo first')).toBeNull();
    expect(send().disabled).toBe(false);
    act(() => { queue.undo(op); });
  });
});

describe('Details in topic mode while the topic is being removed', () => {
  it('the bar says so, Send is off and ⌘↵ sends nothing; Undo gives Send back', async () => {
    const transport = new AppTransport(), appService = createDesktopService(transport), store = new SessionStore(appService, route);
    stores.push(store);
    const drafts = new OwnerDraftStore(appService);
    await act(async () => { await Promise.all([store.refresh(), drafts.load()]); });
    const topicId = store.getSnapshot().snapshot!.session.items['1.1']!.topic_id, queue = queueFor();
    render(<RemovalContext.Provider value={queue}><TopicConversation drafts={drafts} store={store} topicId={topicId} onOpenItem={vi.fn()} /></RemovalContext.Provider>);
    const box = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Reply to this topic' });
    fireEvent.change(box, { target: { value: 'Keep this topic reply' } });
    const send = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Send reply' });
    await waitFor(() => expect(send().disabled).toBe(false));
    let op = '';
    act(() => { op = queue.schedule({ kind: 'topic', session: route, topic_id: topicId }, { kind: 'topic', short: 'the topic', items: 2, waiting: 0, tell: { agent: 'claude-code', mode: 'tell' } } as unknown as RemoveSubject); });
    expect(screen.getByText('Being removed · Undo first')).toBeTruthy();
    expect(send().disabled).toBe(true);
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(0);
    expect(box.value).toBe('Keep this topic reply');
    act(() => { queue.undo(op); });
    expect(screen.queryByText('Being removed · Undo first')).toBeNull();
    expect(send().disabled).toBe(false);
  });
});

// The waiting question's answer card is a send too (E28): it carries the same reason and sends nothing in the window.
describe('the bigger view of a waiting item that is being removed', () => {
  it('the answer card says "Being removed · Undo first", its Send is off; Undo gives Send back', async () => {
    const transport = new AppTransport();
    transport.preferences.global.selected_navigation = { kind: 'session', session: route };
    transport.preferences.sessions.find(view => view.session.session_id === route.session_id)!.tab_open = true;
    render(<DesktopApp service={createDesktopService(transport)} />);
    await screen.findByRole('region', { name: 'Session tree' });
    await waitFor(() => expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready'));
    fireEvent.click(document.querySelector<HTMLElement>('[role="treeitem"][data-item-id="2"]')!);
    await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="2"]' });
    fireEvent.click(screen.getByRole('button', { name: 'Read in a bigger view' }));
    await screen.findByRole('region', { name: 'Item conversation' });
    const conversation = () => screen.getByRole('region', { name: 'Item conversation' });
    const send = () => within(conversation()).getByRole<HTMLButtonElement>('button', { name: /^Send/ });
    const words = await waitFor(() => answerWords(conversation()));
    await waitFor(() => expect(words.disabled).toBe(false));
    fireEvent.change(words, { target: { value: 'Use the morning window' } });
    await waitFor(() => expect(send().getAttribute('aria-disabled')).toBeNull());
    expect(within(conversation()).queryByText('Being removed · Undo first')).toBeNull();
    // Remove from the head's "…" menu: a waiting question asks first.
    fireEvent.click(within(conversation()).getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^Remove/ }));
    const dialog = await screen.findByRole('dialog', { name: /^Remove “/ });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Remove item|^Remove \d+ items/ }));
    await waitFor(() => expect(within(conversation()).getByText('Being removed · Undo first')).toBeTruthy());
    expect(send().getAttribute('aria-disabled') === 'true' || send().disabled).toBe(true);
    fireEvent.click(send());
    expect(transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(0);
    // Undo from the toast (the bigger view covers the Map's strip).
    fireEvent.click(within(await screen.findByTestId('toast')).getByRole('button', { name: 'Undo' }));
    // Undo brings the item back (the view may return to the Map's Details); its answer card sends again.
    await waitFor(() => expect(screen.queryByText('Being removed · Undo first')).toBeNull());
    const again = await waitFor(() => { const button = document.querySelector<HTMLButtonElement>(`[data-detail-item-id="2"] [data-answer-send]`); expect(button).not.toBeNull(); return button!; });
    expect(again.disabled).toBe(false);
    expect(again.getAttribute('aria-disabled')).toBeNull();
    expect(transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(0);
  }, 15_000);
});
