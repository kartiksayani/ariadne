// Remove (handoff README "Remove"): the undo window, the commands it runs and
// their arguments, the notes, and the tree triggers and keys that ask first.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import demo from '../../../../../fixtures/domain/demo/session.json';
import type { SessionRef } from '../../../src/generated/core';
import type { Session } from '../../../src/generated/domain/models';
import { CoreFailure, createDesktopService, type RendererService } from '../../../src/data/service';
import type { Immutable } from '../../../src/data/session-store';
import { NavigationStore } from '../../../src/state/navigation/store';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { SessionActionControllers } from '../../../src/components/bindings/actions';
import { NoticeStore } from '../../../src/ui/pages/notices';
import { removeCopy, type RemoveSubject, type RemoveTarget } from '../../../src/ui/dialogs/remove';
import { projectRemoval, sessionRemoval } from '../../../src/ui/pages/model';
import { RemovalContext, RemovalQueue, UNDO_MS, type Pinned } from '../../../src/ui/remove/queue';
import { Hidden, hiddenKey, nextSelection, removeLabel, removeSubject, tellOf, visibleSession } from '../../../src/ui/remove/model';
import { TreeView } from '../../../src/ui/tree/TreeView';
import { AppTransport, route } from '../app/transport';

const session = demo as unknown as Immutable<Session>;
const topicId = session.items['1']!.topic_id;
const ops = () => { let next = 0; return () => `00000000-0000-4000-8000-0000000009${String(++next).padStart(2, '0')}`; };
const itemTarget = (itemId: string): RemoveTarget => ({ kind: 'item', item: { ...route, item_id: itemId } });
const tell = (mode: 'tell' | 'queued' | 'closed') => ({ agent: 'claude-code', mode });
const itemSubject = (mode: 'tell' | 'queued' | 'closed' = 'tell', items = 2): RemoveSubject => ({ kind: 'item', short: 'stale plans', items, waiting: 0, tell: tell(mode) });

function harness(read: (route: SessionRef) => Promise<Immutable<Session> | null> = async () => session) {
  const service = {
    removeItem: vi.fn(async () => ({})), removeTopic: vi.fn(async () => ({})),
    removeSession: vi.fn(async () => ({})), removeProject: vi.fn(async () => ({})),
  };
  const notices = new NoticeStore(), removed = vi.fn(async () => {});
  // The toast store as the queue sees it: what it showed, and when the Undo window ended.
  const shown: { id: string; text: string; undo?: () => void | Promise<void> }[] = [];
  const toasts = { show: vi.fn((spec: { text: string; undo?: () => void | Promise<void> }) => { const id = `toast-${shown.length + 1}`; shown.push({ id, ...spec }); return id; }),
    expire: vi.fn(), dismiss: vi.fn() };
  const settled = vi.fn(async () => {}), again = vi.fn();
  let review: Pinned | null = null;
  const queue = new RemovalQueue({ service: service as unknown as RendererService, notices, read, removed, operationId: ops(), toasts, settled, again,
    review: () => review });
  const text = () => notices.getSnapshot().map(notice => notice.text);
  const notice = () => notices.getSnapshot()[0]!;
  const toast = () => shown.at(-1)!;
  return { service, notices, queue, removed, text, notice, toasts, toast, settled, again, setReview: (value: Pinned | null) => { review = value; } };
}
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

describe('the removal queue', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('hides an item at once and tells the agent only after 5 seconds without Undo', async () => {
    const { service, queue, text, removed, toast, toasts } = harness();
    const op = queue.schedule(itemTarget('1'), itemSubject());
    expect(queue.getSnapshot().item(route, session, '1.1')).toBe(true);
    expect(toast().text).toBe('Removed “stale plans” and the 1 item below it. claude-code is told in 5 s.');
    expect(text()).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS - 1); });
    expect(service.removeItem).not.toHaveBeenCalled();
    expect(toasts.expire).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    // The producer ends the toast's Undo when its window ends.
    expect(toasts.expire).toHaveBeenCalledWith(toast().id);
    expect(service.removeItem).toHaveBeenCalledWith(route, { item_id: '1', expected_revision: session.items['1']!.revision }, op);
    expect(text()).toEqual([]);
    expect(removed).toHaveBeenCalledWith(itemTarget('1'));
    expect(queue.getSnapshot().empty).toBe(true);
  });

  it('Undo in the window (the toast or the strip) sends nothing, restores the rows and runs the restore', async () => {
    const { service, queue, notices, toast, toasts } = harness(), restore = vi.fn();
    queue.schedule(itemTarget('2'), itemSubject('tell', 1), { restore });
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS - 1); });
    await act(async () => { await toast().undo!(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS * 2); });
    expect(service.removeItem).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledOnce();
    expect(toasts.dismiss).toHaveBeenCalledWith(toast().id);
    expect(queue.getSnapshot().empty).toBe(true);
    expect(notices.getSnapshot()).toEqual([]);
    queue.schedule(itemTarget('2'), itemSubject('tell', 1));
    queue.undoKey(hiddenKey.item(route, '2'));
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS * 2); });
    expect(service.removeItem).not.toHaveBeenCalled();
  });

  // E28: one deadline, 5 s, in every connection state.
  it.each([
    ['tell', 'Removed “stale plans”. claude-code is told in 5 s.'],
    ['queued', 'Removed “stale plans”. claude-code is told when it runs again.'],
    ['closed', 'Removed “stale plans”. The session is closed, so claude-code isn’t told.'],
  ] as const)('a %s removal says so in its toast and runs after 5 s', async (mode, words) => {
    const { service, queue, toast, text } = harness();
    queue.schedule(itemTarget('2'), itemSubject(mode, 1));
    expect(toast().text).toBe(words);
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS); });
    expect(service.removeItem).toHaveBeenCalledOnce();
    expect(text()).toEqual([]);
  });

  it('gives each removal its own timer and op id', async () => {
    const { service, queue } = harness();
    const first = queue.schedule(itemTarget('2'), itemSubject('tell', 1));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    const second = queue.schedule({ kind: 'topic', session: route, topic_id: topicId }, { kind: 'topic', name: 'Delivery decisions', items: 3, waiting: 1, tell: tell('tell') });
    expect(first).not.toBe(second);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(service.removeItem).toHaveBeenCalledWith(route, expect.objectContaining({ item_id: '2' }), first);
    expect(service.removeTopic).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(service.removeTopic).toHaveBeenCalledWith(route, { topic_id: topicId, expected_revision: session.topics[topicId]!.revision }, second);
  });

  // Never lose typed text (E28): the commit compares a fresh read with what the owner reviewed.
  it.each([
    ['a draft typed in scope', { scope: ['1', '1.1'], words: ['draft:new'] }],
    ['an input saved in scope', { scope: ['1', '1.1'], words: ['input:new'] }],
    ['an item added below it', { scope: ['1', '1.1', '1.2'], words: [] }],
  ] as const)('%s during the window stops the commit and puts the rows back', async (_, now) => {
    const { service, queue, text, notices, again, setReview } = harness(), restore = vi.fn();
    queue.schedule(itemTarget('1'), itemSubject(), { restore, pinned: { scope: ['1', '1.1'], words: [] } });
    setReview(now);
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS); });
    expect(service.removeItem).not.toHaveBeenCalled();
    expect(queue.getSnapshot().empty).toBe(true);
    expect(restore).toHaveBeenCalledOnce();
    expect(text()).toEqual(['“Stale plans” changed while you were removing it. Nothing was removed.']);
    expect(notices.getSnapshot()[0]!.tone).toBe('problem');
    notices.getSnapshot()[0]!.actions![0]!.run();
    expect(again).toHaveBeenCalledWith(itemTarget('1'));
  });

  it('commits when the fresh read finds only what was reviewed, or less', async () => {
    const { service, queue, setReview } = harness();
    queue.schedule(itemTarget('1'), itemSubject(), { pinned: { scope: ['1', '1.1'], words: ['input:a', 'draft:b'] } });
    setReview({ scope: ['1'], words: ['input:a'] });
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS); });
    expect(service.removeItem).toHaveBeenCalledOnce();
  });

  it('waits for a send being saved in the session before it reads and commits', async () => {
    const { service, queue, settled } = harness();
    let land!: () => void;
    settled.mockImplementationOnce(() => new Promise<void>(resolve => { land = resolve; }));
    queue.schedule(itemTarget('2'), itemSubject('tell', 1), { pinned: { scope: ['2'], words: [] } });
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS * 3); });
    expect(settled).toHaveBeenCalledWith(route);
    expect(service.removeItem).not.toHaveBeenCalled();
    await act(async () => { land(); await vi.advanceTimersByTimeAsync(0); });
    expect(service.removeItem).toHaveBeenCalledOnce();
  });

  it('commits early when the window hides, with the same recheck', async () => {
    const { service, queue, setReview } = harness();
    const detach = queue.attach(window);
    queue.schedule(itemTarget('1'), itemSubject(), { pinned: { scope: ['1', '1.1'], words: [] } });
    setReview({ scope: ['1', '1.1'], words: ['draft:late'] });
    window.dispatchEvent(new Event('pagehide')); await settle();
    expect(service.removeItem).not.toHaveBeenCalled();
    detach();
  });

  it('removes a session and a project from Ariadne only, with Undo until the next remove', async () => {
    const { service, queue, text } = harness();
    const sessionOp = queue.schedule({ kind: 'session', session: route },
      { kind: 'session', agent: 'codex', when: 'Yesterday', topics: 2, items: 9, shared: 0, waiting: 1 });
    expect(text()).toEqual(['Removed the codex session from yesterday.']);
    expect(queue.getSnapshot().session(route)).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS * 4); });
    expect(service.removeSession).not.toHaveBeenCalled();
    const projectOp = queue.schedule({ kind: 'project', project_id: route.project_id },
      { kind: 'project', name: 'notes', path: '/code/notes', sessions: 2, topics: 3, items: 9, waiting: 1 });
    await settle();
    expect(service.removeSession).toHaveBeenCalledWith({ ...route, expected_revision: session.revision }, sessionOp);
    expect(queue.getSnapshot().project(route.project_id)).toBe(true);
    await act(async () => { await queue.flush(); });
    expect(service.removeProject).toHaveBeenCalledWith({ project_id: route.project_id }, projectOp);
  });

  it('shows a failure with Retry under the same op id and reads the revision again after a definite rejection', async () => {
    let revision = 3;
    const { service, queue, text, notice } = harness(async () => ({ ...session, items: { ...session.items, 1: { ...session.items['1']!, revision } } }) as Immutable<Session>);
    service.removeItem.mockRejectedValueOnce(new CoreFailure({ code: 'revision_conflict', message: 'The revision changed', hint: '', retryable: false, field_errors: [] }));
    const op = queue.schedule(itemTarget('1'), itemSubject());
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS); });
    expect(text()).toEqual(['Couldn’t remove “Stale plans” and 1 item below it. This changed while you were working. Look at it as it is now, then try again.']);
    expect(queue.getSnapshot().empty).toBe(true);
    revision = 4;
    await act(async () => { notice().actions![0]!.run(); await vi.advanceTimersByTimeAsync(0); });
    expect(service.removeItem.mock.calls.map(call => [(call as unknown[])[1], (call as unknown[])[2]])).toEqual([
      [{ item_id: '1', expected_revision: 3 }, op], [{ item_id: '1', expected_revision: 4 }, op]]);
  });

  it('retries the exact command after an uncertain failure', async () => {
    let revision = 3;
    const { service, queue, notice } = harness(async () => ({ ...session, items: { ...session.items, 1: { ...session.items['1']!, revision } } }) as Immutable<Session>);
    service.removeItem.mockRejectedValueOnce(new Error('Desktop service is unavailable.'));
    queue.schedule(itemTarget('1'), itemSubject());
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS); });
    revision = 9;
    await act(async () => { notice().actions![0]!.run(); await vi.advanceTimersByTimeAsync(0); });
    expect(service.removeItem.mock.calls.map(call => ((call as unknown[])[1] as { expected_revision: number }).expected_revision)).toEqual([3, 3]);
  });

  // E31: Empty deletes at once, one fresh op id each, no window and no note per entry; what left the bin is not deleted.
  it('deletes bin entries at once and reports what it could not delete', async () => {
    const binned = structuredClone(demo) as Session;
    const continued = Object.keys(binned.topics).find(id => id !== topicId)!;
    binned.items['1']!.removed_at = binned.updated_at; binned.topics[continued]!.removed_at = binned.updated_at;
    const { service, queue, notices, removed } = harness(async () => binned);
    service.removeTopic.mockRejectedValueOnce(new CoreFailure({ code: 'revision_conflict', message: 'changed', hint: '', retryable: false, field_errors: [] }));
    const item = itemTarget('1') as Extract<RemoveTarget, { kind: 'item' }>, topic = { kind: 'topic' as const, session: route, topic_id: continued };
    const result = await queue.deleteNow([item, topic, itemTarget('2') as Extract<RemoveTarget, { kind: 'item' }>]);
    expect(service.removeItem).toHaveBeenCalledOnce();
    const op = (mock: { mock: { calls: unknown[][] } }) => mock.mock.calls[0]![2];
    expect(op(service.removeItem)).not.toBe(op(service.removeTopic));
    expect(result.deleted).toEqual([item]);
    expect(result.failed.map(value => value.target)).toEqual([topic, itemTarget('2')]);
    expect(result.failed[1]!.error).toBe('It isn’t in the bin any more.');
    expect(notices.getSnapshot()).toEqual([]);
    expect(queue.pending()).toEqual([]);
    expect(removed).toHaveBeenCalledOnce();
  });

  it('flushes pending removals when the window hides or the page goes, and skips what is already gone', async () => {
    const { service, queue } = harness(async () => ({ ...session, items: {} }) as unknown as Immutable<Session>);
    const detach = queue.attach(window);
    queue.schedule(itemTarget('2'), itemSubject('tell', 1));
    window.dispatchEvent(new Event('pagehide')); await settle();
    expect(queue.pending()).toEqual([]);
    expect(service.removeItem).not.toHaveBeenCalled();
    detach();
  });

  it('runs on visibilitychange to hidden', async () => {
    const { service, queue } = harness();
    const detach = queue.attach(window);
    queue.schedule({ kind: 'project', project_id: route.project_id }, { kind: 'project', name: 'notes', path: '/p', sessions: 0, topics: 0, items: 0, waiting: 0 });
    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange')); await settle();
    expect(service.removeProject).toHaveBeenCalledOnce();
    state.mockRestore(); detach();
  });
});

describe('remove model', () => {
  it('hides a removed item with everything below it, and a removed topic with its items', () => {
    const hidden = new Hidden(new Set([hiddenKey.item(route, '1')]));
    const visible = visibleSession(session, route, hidden);
    expect(visible.items['1']).toBeUndefined(); expect(visible.items['1.1']).toBeUndefined(); expect(visible.items['2']).toBeDefined();
    expect(visibleSession(session, route, new Hidden())).toBe(session);
    const topics = visibleSession(session, route, new Hidden(new Set([hiddenKey.topic(route, topicId)])));
    expect(topics.topics[topicId]).toBeUndefined();
    expect(Object.values(topics.items).some(item => item?.topic_id === topicId)).toBe(false);
    expect(new Hidden(new Set([hiddenKey.project(route.project_id)])).item(route, session, '2')).toBe(true);
  });
  it('builds the dialog subject and the note label for an item and a topic', () => {
    const subject = removeSubject(session, { kind: 'item', item: { ...route, item_id: '1' } })!;
    expect(subject).toMatchObject({ kind: 'item', items: 2, waiting: 0, tell: tellOf(session) });
    expect(removeLabel({ ...subject, short: 'stale plans' } as RemoveSubject)).toBe('“Stale plans” and 1 item below it');
    expect(removeSubject(session, { kind: 'item', item: { ...route, item_id: 'missing' } })).toBeNull();
    expect(removeLabel(removeSubject(session, { kind: 'topic', session: route, topic_id: topicId })!)).toBe('the topic “Delivery decisions”');
    expect(tellOf({ ...session, state: 'closed' } as Immutable<Session>).mode).toBe('closed');
  });
  it('says how many queued messages a removal cancels, naming their agent', () => {
    const warn = (subject: RemoveSubject | null) => removeCopy(subject!).warn;
    const item = (itemId: string) => ({ kind: 'item' as const, item: { ...route, item_id: itemId } });
    // Item 4 holds the queued drop (input 76); item 1 holds none.
    expect(removeSubject(session, item('4'))!.unsent).toEqual({ count: 1, agent: 'demo.local' });
    // A drop is not an answer: the warning says "messages" for every kind.
    expect(warn(removeSubject(session, item('4')))).toBe('1 of your messages hasn’t reached demo.local yet; removing cancels it.');
    expect(warn(removeSubject(session, item('1')))).toBe('');
    expect(removeSubject(session, { kind: 'topic', session: route, topic_id: topicId })!.unsent?.count).toBe(1);
    // The session and its project hold both queued messages (76 and the topic continuation 77).
    const counts = sessionRemoval(session, new Set());
    expect(warn({ kind: 'session', agent: 'demo.local', when: 'Yesterday', ...counts }))
      .toBe('1 question waiting on you goes with it. 2 of your messages haven’t reached demo.local yet; removing cancels them.');
    const other = structuredClone(demo) as Session, binding = other.bindings[other.active_binding_id!]!; binding.adapter_id = 'codex';
    expect(projectRemoval([session, other as Immutable<Session>]).unsent).toEqual({ count: 4, agent: 'the agent' });
    // Waiting questions and unsent messages are both named.
    expect(removeCopy({ ...removeSubject(session, item('4'))!, waiting: 1 } as RemoveSubject).warn)
      .toBe('1 question waiting on you goes with it. 1 of your messages hasn’t reached demo.local yet; removing cancels it.');
  });

  it.each(['item', 'topic'] as const)('warns about binned questions and only messages cancelled by agent removal for a %s', kind => {
    const binned = structuredClone(demo) as Session, input = Object.values(binned.inputs).find(value => value?.state === 'queued')!;
    const itemId = input.target.item_id!, item = binned.items[itemId]!, topic = binned.topics[item.topic_id]!;
    Object.values(binned.items).forEach(value => { if (value?.status === 'waiting_on_me') value.status = 'open'; });
    item.status = 'waiting_on_me';
    if (kind === 'item') item.removed_at = binned.updated_at;
    else topic.removed_at = binned.updated_at;
    input.state = 'cancelled'; input.cancel_cause = 'agent_removed';
    const unrelated = structuredClone(input); unrelated.id = '00000000-0000-4000-8000-000000000098'; unrelated.cancel_cause = 'owner';
    const notification = structuredClone(input); notification.id = '00000000-0000-4000-8000-000000000099'; notification.kind = 'removed';
    binned.inputs = { [input.id]: input, [unrelated.id]: unrelated, [notification.id]: notification };
    const target = kind === 'item' ? { kind: 'item' as const, item: { ...route, item_id: itemId } }
      : { kind: 'topic' as const, session: route, topic_id: topic.id };
    const subject = removeSubject(binned, target)!;
    expect(subject).toMatchObject({ removed: true, waiting: 1, unsent: { count: 0, cancelled: 1 } });
    expect(removeCopy(subject).warn).toBe('1 question waiting on you goes with it. Your 1 cancelled message is deleted forever.');
    unrelated.cancel_cause = 'agent_removed';
    expect(removeCopy(removeSubject(binned, target)!).warn).toBe('1 question waiting on you goes with it. Your 2 cancelled messages are deleted forever.');
    unrelated.cancel_cause = 'owner';
    input.state = 'queued'; delete input.cancel_cause;
    expect(removeSubject(binned, target)!.unsent).toEqual({ count: 1, agent: 'demo.local' });
  });
  it('keeps binned waiting questions out of an active topic removal warning', () => {
    const current = structuredClone(demo) as Session;
    Object.values(current.items).forEach(item => { if (item?.status === 'waiting_on_me') item.removed_at = current.updated_at; });
    expect(removeSubject(current, { kind: 'topic', session: route, topic_id: topicId }))
      .toMatchObject({ removed: false, waiting: 0 });
  });
  it('selects the next row, else the parent, else none', () => {
    const view = new AppTransport().view();
    const rows = Object.values(session.items).filter(item => item?.topic_id === topicId && !item.parent).map(item => item!.id).sort();
    expect(nextSelection(session, view, '1')).toBe(rows[rows.indexOf('1') + 1] ?? null);
    const last = rows.at(-1)!;
    expect(nextSelection(session, view, last)).toBeNull();
    expect(['2', '1']).toContain(nextSelection(session, view, '1.1'));
  });
});

describe('tree remove triggers', () => {
  const stores: NavigationStore[] = [];
  afterEach(() => { cleanup(); stores.splice(0).forEach(store => store.stop()); });
  async function mount(queue: RemovalQueue | null = null) {
    const transport = new AppTransport();
    transport.preferences.sessions = transport.preferences.sessions.map(view => ({ ...view, tab_open: true }));
    const service = createDesktopService(transport), navigation = new NavigationStore(service); stores.push(navigation);
    await navigation.start();
    const store = navigation.opened.open(route); await store.refresh();
    const actions = new SessionActionControllers(service).forSession(store), targets: RemoveTarget[] = [];
    const drafts = new OwnerDraftStore(service);
    // ⌫ and Delete act on the selected item, so a test chooses which item is selected.
    const tree = (selectedId: string | null) => <TreeView navigation={navigation} store={store} actions={actions} drafts={drafts} query="" reveal={null} selectedId={selectedId}
      detailOpen={false} summaries={[]}
      onSelected={() => {}} onDismissReveal={() => {}} onResume={() => {}} onAct={() => {}}
      onClearFilters={() => {}} onShowArchive={() => {}} onRemove={target => { targets.push(target); }} />;
    const wrap = (selectedId: string | null) => queue ? <RemovalContext.Provider value={queue}>{tree(selectedId)}</RemovalContext.Provider> : tree(selectedId);
    const view = render(wrap(null));
    return { targets, select: (selectedId: string | null) => view.rerender(wrap(selectedId)) };
  }
  const row = (id: string) => document.querySelector<HTMLElement>(`[role="treeitem"][data-item-id="${id}"]`);

  it('asks for the item from its trash, ⌫ and Delete on the selected item, and for the topic from its Remove', async () => {
    const { targets, select } = await mount();
    fireEvent.click(within(row('1.1')!).getByRole('button', { name: 'Remove (⌫)' }));
    // ⌫ and Delete remove the selected item only (SPEC 6.1): another row's ⌫ does nothing.
    fireEvent.keyDown(row('2')!, { key: 'Delete' });
    expect(targets).toEqual([itemTarget('1.1')]);
    select('2'); fireEvent.keyDown(row('2')!, { key: 'Delete' });
    select('4'); fireEvent.keyDown(row('4')!, { key: 'Backspace' });
    const topic = screen.getByRole('treeitem', { name: /Delivery decisions/ });
    // A topic has no ⌫ key; its band's Remove asks.
    fireEvent.keyDown(topic, { key: 'Backspace' });
    expect(targets).toEqual([itemTarget('1.1'), itemTarget('2'), itemTarget('4')]);
    fireEvent.click(within(topic).getByRole('button', { name: /^More actions for/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^Remove topic/ }));
    expect(targets).toEqual([itemTarget('1.1'), itemTarget('2'), itemTarget('4'), { kind: 'topic', session: route, topic_id: topicId }]);
  });

  it('drops the rows of a pending removal and brings them back on Undo', async () => {
    const queue = harness().queue;
    await mount(queue);
    expect(row('1.1')).not.toBeNull();
    let op = '';
    act(() => { op = queue.schedule(itemTarget('1'), itemSubject()); });
    expect(row('1')).toBeNull(); expect(row('1.1')).toBeNull(); expect(row('2')).not.toBeNull();
    act(() => { queue.undo(op); });
    expect(row('1')).not.toBeNull();
  });
});
