import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { PreferencesSnapshot } from '../../../src/generated/core';
import { ReadingLane, useReadingSeen } from '../../../src/state/preferences/reading';
import { useSeenDwell } from '../../../src/ui/changes/useSeenDwell';
import { caughtUpTopics } from '../../../src/ui/changes/useCaughtUp';
import { changesFixture } from './fixture';

afterEach(() => { cleanup(); vi.useRealTimers(); });
describe('shared reading observations', () => {
  it('observes an open capture after one second and cancels closing or revision changes', () => {
    vi.useFakeTimers(); const observe = vi.fn();
    const result = renderHook(({ key, revision }) => useSeenDwell(key, revision, observe), { initialProps: { key: 'item' as string | null, revision: 1 } });
    act(() => vi.advanceTimersByTime(999)); expect(observe).not.toHaveBeenCalled();
    result.rerender({ key: 'item', revision: 2 });
    act(() => vi.advanceTimersByTime(999)); expect(observe).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1)); expect(observe).toHaveBeenCalledTimes(1);
    result.rerender({ key: 'other', revision: 1 }); result.rerender({ key: null, revision: 1 });
    act(() => vi.advanceTimersByTime(1000)); expect(observe).toHaveBeenCalledTimes(1);
  });
  it('shares optimistic reads, undoes bulk marks, and keeps reads made after the shortcut', () => {
    vi.useFakeTimers(); const save = vi.fn(), lane = new ReadingLane(save), value = changesFixture(2);
    const prefs = { seen: [value.seen] } as PreferencesSnapshot;
    const result = renderHook(() => useReadingSeen(lane, prefs, value.seen.session));
    let token = '';
    act(() => { token = lane.catchUp({ kind: 'mark_seen', session: value.seen.session, at: '2026-10-10T02:00:00Z',
      items: [{ item_id: 'updated-0', revision: 2 }, { item_id: 'updated-1', revision: 2 }], topics: [{ topic_id: value.topic.id, at: '2026-10-10T02:00:00Z' }] }); });
    expect(result.result.current!.items).toHaveLength(2); expect(save).not.toHaveBeenCalled();
    act(() => lane.mark({ kind: 'mark_seen', session: value.seen.session, at: '2026-10-10T02:00:01Z', items: [{ item_id: 'updated-0', revision: 3 }], topics: [] }));
    act(() => lane.undo(token));
    expect(result.result.current!.items).toEqual([{ item_id: 'updated-0', revision: 3 }]); expect(result.result.current!.topics).toHaveLength(0);
    act(() => vi.advanceTimersByTime(6000)); expect(save).toHaveBeenCalledTimes(1); lane.stop();
  });
  it('keeps upgrade baseline absent until navigation initializes it and scopes read state to its session', () => {
    const lane = new ReadingLane(vi.fn()), value = changesFixture();
    lane.mark({ kind: 'mark_seen', session: value.seen.session, at: value.seen.since, items: [{ item_id: 'updated-0', revision: 2 }], topics: [] });
    const result = renderHook(() => useReadingSeen(lane, null, value.seen.session));
    expect(result.result.current).toBeNull(); lane.stop();
  });
  it('publishes repeated real reads without changing earlier snapshots or waiting for confirmed preferences', () => {
    const save = vi.fn(), lane = new ReadingLane(save), value = changesFixture(2);
    const prefs = { seen: [value.seen] } as PreferencesSnapshot;
    const result = renderHook(() => useReadingSeen(lane, prefs, value.seen.session, false));
    const first = { kind: 'mark_seen' as const, session: value.seen.session, at: '2026-10-10T02:00:00Z',
      items: [{ item_id: 'updated-0', revision: 2 }], topics: [{ topic_id: value.topic.id, at: '2026-10-10T02:00:00Z' }] };
    act(() => { lane.mark(first); });
    const snapshot = lane.getMarkedSnapshot(), observed = result.result.current;
    act(() => { lane.mark({ ...first, at: '2026-10-10T01:00:00Z',
      items: [{ item_id: 'updated-0', revision: 1 }, { item_id: 'updated-1', revision: 2 }],
      topics: [{ topic_id: value.topic.id, at: '2026-10-10T01:00:00Z' }] }); });
    expect(result.result.current!.items).toEqual([{ item_id: 'updated-0', revision: 2 }, { item_id: 'updated-1', revision: 2 }]);
    expect(lane.getMarkedSnapshot()[0].at).toBe('2026-10-10T01:00:00Z');
    expect(result.result.current!.topics).toEqual(first.topics);
    act(() => { lane.mark({ ...first, at: '2026-10-10T03:00:00Z',
      items: [{ item_id: 'updated-0', revision: 3 }], topics: [{ topic_id: value.topic.id, at: '2026-10-10T03:00:00Z' }] }); });
    expect(result.result.current!.items).toEqual([{ item_id: 'updated-0', revision: 3 }, { item_id: 'updated-1', revision: 2 }]);
    expect(result.result.current!.topics).toEqual([{ topic_id: value.topic.id, at: '2026-10-10T03:00:00Z' }]);
    expect(lane.getMarkedSnapshot()[0].at).toBe('2026-10-10T01:00:00Z');
    expect(lane.getMarkedSnapshot()).not.toBe(snapshot);
    expect(snapshot).toEqual([first]);
    expect(observed!.items).toEqual(first.items);
    expect(observed!.topics).toEqual(first.topics);
    expect(prefs.seen![0].items).toEqual([]);
    expect(save).toHaveBeenCalledTimes(3); lane.stop();
  });
  it('excludes pending catch-up from real reads and preserves a same-revision read after Undo', () => {
    vi.useFakeTimers(); const save = vi.fn(), lane = new ReadingLane(save), value = changesFixture(2);
    const prefs = { seen: [value.seen] } as PreferencesSnapshot;
    const result = renderHook(() => ({ visible: useReadingSeen(lane, prefs, value.seen.session), observed: useReadingSeen(lane, prefs, value.seen.session, false) }));
    let token = '';
    act(() => { token = lane.catchUp({ kind: 'mark_seen', session: value.seen.session, at: value.session.updated_at,
      items: [{ item_id: 'updated-0', revision: 2 }, { item_id: 'updated-1', revision: 2 }], topics: [] }); });
    expect(result.result.current.visible!.items).toHaveLength(2);
    expect(result.result.current.observed!.items).toHaveLength(0);
    act(() => lane.mark({ kind: 'mark_seen', session: value.seen.session, at: value.session.updated_at, items: [{ item_id: 'updated-0', revision: 2 }], topics: [] }));
    expect(result.result.current.observed!.items).toEqual([{ item_id: 'updated-0', revision: 2 }]);
    act(() => lane.undo(token));
    expect(result.result.current.visible!.items).toEqual([{ item_id: 'updated-0', revision: 2 }]);
    act(() => vi.advanceTimersByTime(6000)); expect(save).toHaveBeenCalledTimes(1); lane.stop();
  });
  it('prunes confirmed optimistic reads while preserving newer reads and pending Undo', () => {
    vi.useFakeTimers(); const lane = new ReadingLane(vi.fn()), value = changesFixture(2);
    const entry = { kind: 'mark_seen' as const, session: value.seen.session, at: value.seen.since,
      items: [{ item_id: 'updated-0', revision: 2 }, { item_id: 'updated-1', revision: 3 }], topics: [] };
    lane.mark(entry);
    const token = lane.catchUp({ ...entry, items: [], topics: [{ topic_id: value.topic.id, at: value.session.updated_at }] });
    const confirmed = structuredClone(value.seen);
    confirmed.items = [{ item_id: 'updated-0', revision: 2 }, { item_id: 'updated-1', revision: 2 }];
    lane.reconcile({ seen: [confirmed] } as PreferencesSnapshot);
    expect(lane.getSnapshot()[0].items).toEqual([{ item_id: 'updated-1', revision: 3 }]);
    expect(lane.canUndo(token)).toBe(true);
    confirmed.items[1].revision = 3;
    lane.reconcile({ seen: [confirmed] } as PreferencesSnapshot);
    expect(lane.getSnapshot()).toHaveLength(1);
    lane.undo(token); expect(lane.getSnapshot()).toHaveLength(0); lane.stop();
  });
  it('only catches up topics with meaningful changes whose items are all read', () => {
    const value = changesFixture(2);
    expect(caughtUpTopics(value.session, value.seen)).toEqual([]);
    value.seen.items = [{ item_id: 'updated-0', revision: 2 }];
    expect(caughtUpTopics(value.session, value.seen)).toEqual([]);
    value.session.items['updated-1']!.changes![0].wording_only = true;
    expect(caughtUpTopics(value.session, value.seen)).toEqual([value.topic.id]);
    value.session.topics[value.topic.id]!.archived_at = value.session.updated_at;
    expect(caughtUpTopics(value.session, value.seen)).toEqual([]);
  });
  it('does not republish an already optimistic observation or keep expired Undo visible', () => {
    vi.useFakeTimers(); const save = vi.fn(), listener = vi.fn(), lane = new ReadingLane(save), value = changesFixture();
    lane.subscribe(listener);
    const entry = { kind: 'mark_seen' as const, session: value.seen.session, at: value.seen.since,
      items: [], topics: [{ topic_id: value.topic.id, at: value.session.updated_at }] };
    lane.mark(entry); lane.mark(entry);
    expect(listener).toHaveBeenCalledTimes(1); expect(save).toHaveBeenCalledTimes(1);
    const token = lane.catchUp(entry);
    vi.advanceTimersByTime(5000);
    expect(lane.canUndo(token)).toBe(false); expect(listener).toHaveBeenCalledTimes(3);
    expect(save).toHaveBeenCalledTimes(1); lane.stop();
  });
});
