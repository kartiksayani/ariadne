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
import { NoticeStore, Notices } from '../../../src/ui/pages/notices';
import type { RemoveSubject, RemoveTarget } from '../../../src/ui/dialogs/remove';
import { RemovalContext, RemovalQueue, UNDO_MS } from '../../../src/ui/remove/queue';
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
  const queue = new RemovalQueue({ service: service as unknown as RendererService, notices, read, removed, operationId: ops() });
  const text = () => notices.getSnapshot().map(notice => notice.text);
  const notice = () => notices.getSnapshot()[0]!;
  return { service, notices, queue, removed, text, notice };
}
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

describe('the removal queue', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('hides an item at once and tells the agent only after 5 seconds without Undo', async () => {
    const { service, queue, text, removed } = harness();
    const op = queue.schedule(itemTarget('1'), itemSubject());
    expect(queue.getSnapshot().item(route, session, '1.1')).toBe(true);
    expect(text()).toEqual(['Removed “Stale plans” and 1 item below it. claude-code is told in 5 seconds unless you undo.']);
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS - 1); });
    expect(service.removeItem).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(service.removeItem).toHaveBeenCalledWith(route, { item_id: '1', expected_revision: session.items['1']!.revision }, op);
    expect(text()).toEqual(['Removed “Stale plans” and 1 item below it. claude-code was told and won’t bring them up again.']);
    expect(removed).toHaveBeenCalledWith(itemTarget('1'));
    expect(queue.getSnapshot().empty).toBe(true);
  });

  it('Undo in the window sends nothing, restores the rows and runs the restore', async () => {
    const { service, queue, notices } = harness(), restore = vi.fn();
    render(<Notices store={notices} />);
    act(() => { queue.schedule(itemTarget('2'), itemSubject('tell', 1), { restore }); });
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS * 2); });
    expect(service.removeItem).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledOnce();
    expect(queue.getSnapshot().empty).toBe(true);
    expect(notices.getSnapshot()).toEqual([]);
    cleanup();
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

  it('says when the agent is not running and that it is told later', async () => {
    const { queue, text, notice } = harness();
    queue.schedule(itemTarget('2'), itemSubject('queued', 1));
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS); });
    expect(text()).toEqual(['Removed “Stale plans”. claude-code isn’t running; it’s told when it runs again.']);
    expect(notice().dismissible).toBe(true);
  });

  it('keeps Undo for a closed session until Dismiss or the next remove, then runs', async () => {
    const { service, queue, text, notice } = harness();
    const op = queue.schedule(itemTarget('2'), itemSubject('closed', 1));
    expect(text()).toEqual(['Removed “Stale plans”. The session is closed, so claude-code isn’t told.']);
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS * 4); });
    expect(service.removeItem).not.toHaveBeenCalled();
    notice().onDismiss!(); await settle();
    expect(service.removeItem).toHaveBeenCalledWith(route, expect.objectContaining({ item_id: '2' }), op);
    queue.schedule(itemTarget('4'), itemSubject('closed', 1));
    queue.schedule(itemTarget('5'), itemSubject('closed', 1)); await settle();
    expect(service.removeItem).toHaveBeenLastCalledWith(route, expect.objectContaining({ item_id: '4' }), expect.any(String));
    expect(queue.pending()).toHaveLength(1);
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
      { kind: 'project', name: 'payments', path: '/code/payments', sessions: 2, topics: 3, items: 9, waiting: 1 });
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
    expect(text()).toEqual(['Couldn’t remove “Stale plans” and 1 item below it. The revision changed']);
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
    queue.schedule({ kind: 'project', project_id: route.project_id }, { kind: 'project', name: 'payments', path: '/p', sessions: 0, topics: 0, items: 0, waiting: 0 });
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
    const tree = <TreeView navigation={navigation} store={store} actions={actions} drafts={new OwnerDraftStore(service)} query="" reveal={null} selectedId={null}
      detailOpen={false} railOpen={false} highlightedItems={new Set()} highlightedMessages={new Set()} summaries={[]} continueTargets={[]}
      actionsForTarget={() => actions} onHoverItem={() => {}} onSelected={() => {}} onDismissReveal={() => {}} onResume={() => {}} onAct={() => {}}
      onClearFilters={() => {}} onShowArchive={() => {}} revealItem={() => {}} openSession={() => {}} onRemove={target => { targets.push(target); }} />;
    render(queue ? <RemovalContext.Provider value={queue}>{tree}</RemovalContext.Provider> : tree);
    return { targets };
  }
  const row = (id: string) => document.querySelector<HTMLElement>(`[role="treeitem"][data-item-id="${id}"]`);

  it('asks for the item from its trash, ⌫ and Delete, and for the topic from its Remove and ⌫', async () => {
    const { targets } = await mount();
    fireEvent.click(within(row('1.1')!).getByRole('button', { name: 'Remove (⌫)' }));
    fireEvent.keyDown(row('2')!, { key: 'Delete' });
    fireEvent.keyDown(row('4')!, { key: 'Backspace' });
    const topic = screen.getByRole('treeitem', { name: /Delivery decisions/ });
    fireEvent.keyDown(topic, { key: 'Backspace' });
    fireEvent.click(within(topic).getByRole('button', { name: 'Remove' }));
    expect(targets).toEqual([itemTarget('1.1'), itemTarget('2'), itemTarget('4'),
      { kind: 'topic', session: route, topic_id: topicId }, { kind: 'topic', session: route, topic_id: topicId }]);
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
