import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { unseenTopicRows } from '../../../src/selectors/changes/unseen';
import { useNavigation } from '../../../src/state/navigation/store';
import { useReadingSeen } from '../../../src/state/preferences/reading';
import { useImplicitCaughtUp } from '../../../src/ui/changes/useCaughtUp';
import { isChangedSinceRead } from '../../../src/selectors/changes/seen';
import { route } from '../app/transport';
import { changesFixture, baseline, later } from './fixture';
import { setupChanges as setup, stores } from './harness';

afterEach(() => { cleanup(); stores.splice(0).forEach(store => store.stop()); vi.useRealTimers(); localStorage.clear(); });
const open = () => fireEvent.click(screen.getByRole('button', { name: /new|changed|changes since|All caught up/ }));
const popover = () => screen.getByRole('dialog', { name: 'What changed' });

describe('topic brief and shared catch-up', () => {
  it('labels the agent’s brief, preserves every line, links lists and remembers whether it is open', async () => {
    const value = await setup(1, 1, 0);
    open();
    const brief = within(popover()).getByRole('region', { name: 'Topic brief' });
    // Closed, the brief reads as counts; the owner opens it once and it stays open.
    expect(within(brief).getByRole('button', { name: /Brief/ }).getAttribute('aria-expanded')).toBe('false');
    expect(brief.textContent).toContain('1 decided · 0 your turn · 1 replaced');
    fireEvent.click(within(brief).getByRole('button', { name: /Brief/ }));
    expect(within(brief).getByText(/by the agent · updated/)).toBeTruthy();
    expect(brief.querySelector('.brief-text')?.textContent).toBe(value.session.topics[value.topic.id]!.brief);
    expect(within(brief).getByText('Decided')).toBeTruthy(); expect(within(brief).getByText('Your turn')).toBeTruthy();
    expect(brief.querySelector('del')?.textContent).toBe('Replaced name A');
    expect(within(brief).getByText('replaced by')).toBeTruthy();
    fireEvent.click(within(brief).getAllByRole('button', { name: 'Owner decision' })[0]!);
    expect(value.onOpenItem).toHaveBeenCalledWith('1');
    value.unmount(); render(value.element()); open();
    expect(within(popover()).getByRole('button', { name: /Brief/ }).getAttribute('aria-expanded')).toBe('true');
  });
  it('keeps a row’s ✓ Seen while the popover is open and drops it when reopened', async () => {
    const value = await setup(2);
    open();
    const row = screen.getByText('Updated name A').closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Mark Updated name A seen' }));
    expect(within(row).getByRole('button', { name: 'Updated name A is seen' }).textContent).toBe('✓ Seen');
    expect(within(row).queryByTestId('change-marker')).toBeNull();
    expect(value.navigation.reading.getSnapshot().some(patch => patch.items.some(item => item.item_id === 'updated-0'))).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    open();
    expect(within(popover()).queryByText('Updated name A')).toBeNull();
    expect(within(popover()).getByText('Updated name B')).toBeTruthy();
  });
  it('drops a row read elsewhere (the dock or Details) without a click', async () => {
    const value = await setup(2);
    open();
    act(() => value.navigation.markItemSeen(route, 'updated-0'));
    expect(within(popover()).queryByText('Updated name A')).toBeNull();
    expect(within(popover()).getByText('Updated name B')).toBeTruthy();
    expect(value.session.items['updated-0']!.status).toBe('open');
  });
  it('accepts an explicit Seen while a change hint makes the session stale', async () => {
    const value = await setup();
    open();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const invoke = value.transport.invoke.bind(value.transport);
    vi.spyOn(value.transport, 'invoke').mockImplementation(async (name, args) => {
      if (name === 'session_get') await gate;
      return invoke(name, args);
    });
    value.session.items['updated-0']!.revision = 3;
    value.session.items['updated-0']!.changes!.push(value.record({ revision: 3, at: '2026-10-10T01:30:00Z' }));
    ++value.session.revision; value.session.updated_at = '2026-10-10T01:30:00Z';
    act(() => value.transport.emit('ariadne://session_changed', { session_id: value.session.id, revision: value.session.revision }));
    expect(value.navigation.opened.get(route)!.getSnapshot().status).toBe('stale');
    fireEvent.click(screen.getByRole('button', { name: 'Mark Updated name A seen' }));
    expect(screen.getByRole('button', { name: 'Updated name A is seen' })).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(value.transport.preferences.seen![0].items).toEqual([{ item_id: 'updated-0', revision: 2 }]);
    await act(async () => { release(); await value.navigation.opened.get(route)!.refresh(); });
    value.rerender(value.element());
    // The newer revision is still unread: it comes back as a changed row the owner can mark.
    fireEvent.keyDown(window, { key: 'Escape' }); open();
    expect(within(popover()).getByRole('button', { name: 'Mark Updated name A seen' }).hasAttribute('disabled')).toBe(false);
    expect(value.navigation.getSnapshot().error).toBeNull();
  });
  it('keeps an unaccepted Seen action available without showing success or removing its row', async () => {
    const value = await setup();
    open();
    const mark = vi.spyOn(value.navigation, 'markItemSeen').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Mark Updated name A seen' }));
    expect(mark).toHaveBeenCalledWith(route, 'updated-0', 2);
    expect(screen.queryByRole('button', { name: 'Updated name A is seen' })).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole('button', { name: 'Mark Updated name A seen' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Updated name A' })).toBeTruthy();
  });
  it.each(['implicit', 'bulk'] as const)('keeps an unobserved commit made before %s catch-up unread, with its changed marker', async kind => {
    const value = await setup(2);
    // The agent commits at 01:30, but the renderer still holds the 01:00 snapshot.
    const item = value.session.items['updated-1']!;
    item.revision = 3;
    item.changes!.push(value.record({ revision: 3, at: '2026-10-10T01:30:00Z' }));
    ++value.session.revision; value.session.updated_at = '2026-10-10T01:30:00Z';
    open();
    if (kind === 'bulk') fireEvent.click(screen.getByRole('button', { name: /Mark all caught up/ }));
    else act(() => {
      value.navigation.markItemSeen(route, 'updated-0', 2);
      value.navigation.markItemSeen(route, 'updated-1', 2);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    const confirmed = value.transport.preferences.seen![0];
    expect(confirmed.topics).toEqual(kind === 'bulk' ? [{ topic_id: value.topic.id, at: later }] : []);
    await act(async () => { await value.navigation.opened.get(route)!.refresh(); });
    value.rerender(value.element());
    expect(unseenTopicRows(value.session, value.topic.id, confirmed).rows.map(row => row.item.id)).toEqual(['updated-1']);
    expect(isChangedSinceRead(item, confirmed)).toBe(true);
    expect(screen.getByRole('button', { name: /1 changed/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Updated name B' })).toBeTruthy();
  });
  it('leads a long absence with a calm summary, then the brief, and keeps Undo reachable after marking', async () => {
    const value = await setup(1, 0, 1, true);
    expect(screen.getByRole('button', { name: /2 changes since/ })).toBeTruthy();
    open();
    const away = within(popover()).getByRole('region', { name: 'While you were away' });
    expect(away.textContent).toMatch(/You were away since \w+ \d\d:\d\d\. A lot moved in this topic/);
    expect(within(away).getByRole('button', { name: 'Read the brief' })).toBeTruthy();
    expect(within(popover()).queryByRole('button', { name: /Undo/ })).toBeNull();
    // The summary comes before the brief, and markers are never hidden: the rows are still listed below.
    const regions = within(popover()).getAllByRole('region').map(region => region.getAttribute('aria-label'));
    expect(regions.indexOf('While you were away')).toBeLessThan(regions.indexOf('Topic brief'));
    expect(within(popover()).getAllByTestId('changes-row')).toHaveLength(2);
    fireEvent.click(within(away).getByRole('button', { name: 'Mark all caught up' }));
    expect(screen.getByText(/All caught up\. The markers are cleared/)).toBeTruthy();
    expect(value.transport.preferences.seen![0].items).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '↺ Undo' }));
    expect(within(popover()).getByRole('region', { name: 'While you were away' })).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(value.transport.preferences.seen![0].items).toHaveLength(0);
  });
  it('starts with what is waiting: the oldest question in the topic', async () => {
    const value = await setup(2, 0, 0, true);
    for (const [id, since] of [['updated-0', '2026-10-09T10:00:00Z'], ['updated-1', '2026-10-09T09:00:00Z']] as const) {
      Object.assign(value.session.items[id]!, { status: 'waiting_on_me', ask: 'Which one?', waiting_since: since });
    }
    value.rerender(value.element()); open();
    fireEvent.click(screen.getByRole('button', { name: /Start with what’s waiting/ }));
    expect(value.onOpenItem).toHaveBeenCalledWith('updated-1');
    expect(screen.queryByRole('dialog', { name: 'What changed' })).toBeNull();
  });
  it('commits the bulk shortcut after eight seconds and never hides a change arriving during Undo', async () => {
    const value = await setup(1, 0, 0, true);
    open();
    fireEvent.click(screen.getByRole('button', { name: /Mark all caught up/ }));
    value.add('new-arrival', 'A later change', { created_at: '2026-10-13T12:00:01Z', changes: [], created_message_id: 'later-batch' });
    ++value.session.revision; value.session.updated_at = '2026-10-13T12:00:01Z';
    await value.navigation.opened.open(route).refresh();
    value.rerender(value.element());
    expect(within(popover()).getAllByTestId('changes-row')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '↺ Undo' }));
    expect(within(popover()).getAllByTestId('changes-row')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /Mark all caught up/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
    expect(value.transport.preferences.seen![0].items).toHaveLength(2);
  });
  it('offers Mark all caught up in the normal list and Undo restores the rows', async () => {
    await setup(1, 1, 1);
    open();
    fireEvent.click(screen.getByRole('button', { name: /Mark all caught up/ }));
    expect(screen.getByText(/All caught up\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '↺ Undo' }));
    expect(screen.getByRole('button', { name: 'Updated name A' })).toBeTruthy();
  });
  it('keeps Undo available after the topic is folded and shown again', async () => {
    const value = await setup(1, 0, 1, true);
    open();
    fireEvent.click(screen.getByRole('button', { name: /Mark all caught up/ }));
    value.unmount(); render(value.element());
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByRole('button', { name: /2 changes since/ })).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(value.transport.preferences.seen![0].items).toHaveLength(0);
  });
  it('catches up a folded topic when the last unseen item is read elsewhere', async () => {
    const value = await setup();
    value.unmount(); // No opener is mounted.
    renderHook(() => {
      const nav = useNavigation(value.navigation);
      const seen = useReadingSeen(value.navigation.reading, nav.preferences, route);
      useImplicitCaughtUp(value.navigation, value.session, seen);
    });
    act(() => value.navigation.markItemSeen(route, 'updated-0'));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(value.transport.preferences.seen![0].topics).toEqual([{ topic_id: value.topic.id, at: value.session.updated_at }]);
  });
  it('keeps a new unread batch when the store advances between the rendered catch-up capture and its effect', async () => {
    const value = await setup(); value.unmount();
    act(() => value.navigation.markItemSeen(route, 'updated-0'));
    const captured = structuredClone(value.session);
    value.add('arrival', 'A concurrently arriving item', { created_at: '2026-10-10T01:30:00Z', changes: [] });
    ++value.session.revision; value.session.updated_at = '2026-10-10T01:30:00Z';
    await value.navigation.opened.open(route).refresh();
    renderHook(() => {
      const nav = useNavigation(value.navigation);
      const seen = useReadingSeen(value.navigation.reading, nav.preferences, route);
      useImplicitCaughtUp(value.navigation, captured, seen);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    const confirmed = value.transport.preferences.seen![0];
    expect(confirmed.topics).toEqual([]);
    expect(unseenTopicRows(value.session, value.topic.id, confirmed).rows.map(row => row.item.id)).toEqual(['arrival']);
  });
  it('marks captured rows with Undo but keeps the topic uncaught-up when a newer unread batch precedes the click', async () => {
    const value = await setup(1, 0, 0, true);
    open();
    value.add('arrival', 'A concurrent item', { created_at: '2026-10-13T11:59:00Z', changes: [] });
    ++value.session.revision; value.session.updated_at = '2026-10-13T11:59:00Z';
    await value.navigation.opened.open(route).refresh(); // The popover still renders its earlier capture.
    fireEvent.click(screen.getByRole('button', { name: /Mark all caught up/ }));
    value.rerender(value.element());
    expect(screen.getByRole('button', { name: '↺ Undo' })).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    const confirmed = value.transport.preferences.seen![0];
    expect(confirmed.items).toEqual([{ item_id: 'updated-0', revision: 2 }]);
    expect(confirmed.topics).toEqual([]);
    expect(unseenTopicRows(value.session, value.topic.id, confirmed).rows.map(row => row.item.id)).toEqual(['arrival']);
  });
  it('treats thirty changes as a long absence even after a short one', async () => {
    await setup(30);
    expect(screen.getByRole('button', { name: /30 changes since/ })).toBeTruthy();
  });
  it('filters wording-only, read creations and read revisions and keeps newest changes first', () => {
    const value = changesFixture(2, 0, 1);
    value.session.items['updated-0']!.changes![0]!.wording_only = true;
    value.session.items['updated-1']!.changes!.push(value.record({ revision: 3, at: '2026-10-10T03:00:00Z' }));
    value.seen.items.push({ item_id: 'new-0', revision: 2 }, { item_id: 'updated-1', revision: 2 });
    const result = unseenTopicRows(value.session, value.topic.id, value.seen, Date.parse(later));
    expect(result.rows.map(row => row.item.id)).toEqual(['updated-1']); expect(result.count).toBe(1);
    value.seen.topics.push({ topic_id: value.topic.id, at: baseline });
    expect(result.rows[0]!.records[0]!.revision).toBe(3);
    expect(result.list.map(entry => [entry.row.item.id, entry.kind, entry.record?.revision])).toEqual([['updated-1', 'changed', 3]]);
    expect([result.newCount, result.changedCount]).toEqual([0, 1]);
  });
});
