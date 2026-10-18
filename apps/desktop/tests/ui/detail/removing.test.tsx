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
import { AppTransport, route } from '../app/transport';

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
