import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { TopicChanges, unseenTopicRows } from '../../../src/ui/changes/TopicChanges';
import { NavigationStore, useNavigation } from '../../../src/state/navigation/store';
import { useReadingSeen } from '../../../src/state/preferences/reading';
import { useImplicitCaughtUp } from '../../../src/ui/changes/useCaughtUp';
import { createDesktopService } from '../../../src/data/service';
import { AppTransport, route } from '../app/transport';
import { changesFixture, baseline, later } from './fixture';

const stores: NavigationStore[] = [];
afterEach(() => { cleanup(); stores.splice(0).forEach(store => store.stop()); vi.useRealTimers(); localStorage.clear(); });
async function setup(updated = 1, replaced = 0, added = 0, old = false) {
  vi.useFakeTimers(); vi.setSystemTime(old ? '2026-10-13T12:00:00Z' : '2026-10-10T02:00:00Z');
  const value = changesFixture(updated, replaced, added), transport = new AppTransport();
  transport.sessions.set(value.session.id, value.session); transport.preferences.seen = [value.seen];
  transport.preferences.global.selected_navigation = { kind: 'session', session: route };
  const navigation = new NavigationStore(createDesktopService(transport)); stores.push(navigation);
  await navigation.start(); await navigation.opened.open(route).refresh();
  const onOpenItem = vi.fn();
  const element = () => <TopicChanges session={structuredClone(value.session)} topicId={value.topic.id} navigation={navigation} onOpenItem={onOpenItem} />;
  const rendered = render(element());
  return { ...value, transport, navigation, onOpenItem, element, ...rendered };
}

describe('topic brief and shared catch-up', () => {
  it('labels the agent’s brief, preserves every line, links lists and remembers its collapse', async () => {
    const value = await setup(1, 1, 0);
    expect(screen.getByText(/By the agent · as of/)).toBeTruthy();
    expect(document.querySelector('.brief-text')?.textContent).toBe(value.session.topics[value.topic.id]!.brief);
    const brief = screen.getByRole('region', { name: 'Topic brief' });
    expect(within(brief).getByText('Decided')).toBeTruthy(); expect(within(brief).getByText('Your turn')).toBeTruthy();
    expect(brief.querySelector('del .change-name')?.textContent).toBe('Replaced name A');
    expect(within(brief).getByText('replaced by')).toBeTruthy();
    fireEvent.click(within(brief).getAllByRole('button', { name: 'Owner decision' })[0]);
    expect(value.onOpenItem).toHaveBeenCalledWith('1');
    fireEvent.click(within(brief).getByRole('button', { name: 'Topic brief' }));
    expect(document.querySelector('.brief-text')).toBeNull();
    value.unmount(); render(value.element());
    expect(screen.getByRole('button', { name: 'Topic brief' }).getAttribute('aria-expanded')).toBe('false');
  });
  it('marks a card immediately in shared seen state, keeps ✓ Seen for three seconds, then removes it', async () => {
    const value = await setup();
    fireEvent.click(screen.getByRole('button', { name: /Since you were here ·/ }));
    const row = screen.getByRole('button', { name: 'Updated name A' }).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Seen' }));
    expect(screen.getByRole('button', { name: '✓ Seen' })).toBeTruthy();
    expect(value.navigation.reading.getSnapshot().some(patch => patch.items.some(item => item.item_id === 'updated-0'))).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(2999); });
    expect(screen.getByRole('button', { name: '✓ Seen' })).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.queryByRole('button', { name: 'Updated name A' })).toBeNull();
    expect(screen.getByText('All caught up')).toBeTruthy();
  });
  it('removes an implicitly read card and records topic caught-up without a click', async () => {
    const value = await setup();
    fireEvent.click(screen.getByRole('button', { name: /Since you were here ·/ }));
    act(() => value.navigation.markItemSeen(route, 'updated-0'));
    expect(screen.queryByRole('button', { name: 'Updated name A' })).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(value.transport.preferences.seen![0].topics.some(topic => topic.topic_id === value.topic.id)).toBe(true);
    expect(value.session.items['updated-0']!.status).toBe('open');
  });
  it('shows the long-absence brief before the compact strip and provides Undo only after marking', async () => {
    const value = await setup(1, 0, 1, true);
    expect(screen.getByText('2 changes while you were away')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(document.querySelector('.topic-changes')!.firstElementChild?.classList.contains('topic-brief')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Mark all seen' }));
    expect(screen.getByText('All caught up')).toBeTruthy();
    expect(value.transport.preferences.seen![0].items).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByText('2 changes while you were away')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(value.transport.preferences.seen![0].items).toHaveLength(0);
  });
  it('commits the bulk shortcut after five seconds and never hides a change arriving during Undo', async () => {
    const value = await setup(1, 0, 0, true);
    fireEvent.click(screen.getByRole('button', { name: 'Mark all seen' }));
    value.add('new-arrival', 'A later change', { created_at: '2026-10-13T12:00:01Z', changes: [], created_message_id: 'later-batch' });
    ++value.session.revision; value.session.updated_at = '2026-10-13T12:00:01Z';
    await value.navigation.opened.open(route).refresh();
    value.rerender(value.element());
    expect(screen.getByRole('button', { name: /Since you were here · 1 change/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByText('2 changes while you were away')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mark all seen' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(value.transport.preferences.seen![0].items).toHaveLength(2);
  });
  it('offers Mark all caught up in the normal cards and Undo restores them', async () => {
    await setup(1, 1, 1);
    fireEvent.click(screen.getByRole('button', { name: /Since you were here ·/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark all caught up' }));
    expect(screen.getByText('All caught up')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByRole('button', { name: 'Updated name A' })).toBeTruthy();
  });
  it('keeps Undo available after folding and reopening the topic', async () => {
    const value = await setup(1, 0, 1, true);
    fireEvent.click(screen.getByRole('button', { name: 'Mark all seen' }));
    value.unmount(); render(value.element());
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByText('2 changes while you were away')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(value.transport.preferences.seen![0].items).toHaveLength(0);
  });
  it('catches up a folded topic when the last unseen item is read elsewhere', async () => {
    const value = await setup();
    value.unmount(); // No topic header or Since component is mounted.
    renderHook(() => {
      const nav = useNavigation(value.navigation);
      const seen = useReadingSeen(value.navigation.reading, nav.preferences, route);
      useImplicitCaughtUp(value.navigation, value.session, seen);
    });
    act(() => value.navigation.markItemSeen(route, 'updated-0'));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(value.transport.preferences.seen![0].topics).toEqual([{ topic_id: value.topic.id, at: '2026-10-10T02:00:00.000Z' }]);
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
  it('marks captured cards with Undo but keeps the topic uncaught-up when a newer unread batch precedes the click', async () => {
    const value = await setup(1, 0, 0, true);
    value.add('arrival', 'A concurrent item', { created_at: '2026-10-13T11:59:00Z', changes: [] });
    ++value.session.revision; value.session.updated_at = '2026-10-13T11:59:00Z';
    await value.navigation.opened.open(route).refresh(); // Header still renders its earlier capture.
    fireEvent.click(screen.getByRole('button', { name: 'Mark all seen' }));
    value.rerender(value.element());
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
    expect(screen.getByText('1 change while you were away')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    const confirmed = value.transport.preferences.seen![0];
    expect(confirmed.items).toEqual([{ item_id: 'updated-0', revision: 2 }]);
    expect(confirmed.topics).toEqual([]);
    expect(unseenTopicRows(value.session, value.topic.id, confirmed).rows.map(row => row.item.id)).toEqual(['arrival']);
  });
  it('uses a thirty-change strip even during a short absence', async () => {
    await setup(30);
    expect(screen.getByText('30 changes while you were away')).toBeTruthy();
  });
  it('filters wording-only, read creations and read revisions and keeps newest changes first', () => {
    const value = changesFixture(2, 0, 1);
    value.session.items['updated-0']!.changes![0].wording_only = true;
    value.session.items['updated-1']!.changes!.push(value.record({ revision: 3, at: '2026-10-10T03:00:00Z' }));
    value.seen.items.push({ item_id: 'new-0', revision: 2 }, { item_id: 'updated-1', revision: 2 });
    const result = unseenTopicRows(value.session, value.topic.id, value.seen, Date.parse(later));
    expect(result.rows.map(row => row.item.id)).toEqual(['updated-1']); expect(result.count).toBe(1);
    value.seen.topics.push({ topic_id: value.topic.id, at: baseline });
    expect(result.rows[0].records[0].revision).toBe(3);
  });
});
