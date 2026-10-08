import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { ITEM_HISTORY_LIMIT, useItemHistory } from '../../../src/ui/shell/itemHistory';

afterEach(cleanup);
const exists = () => true;

describe('session item history', () => {
  it('seeds a restored selection, deduplicates consecutive selections and truncates Forward after a new selection', async () => {
    const { result, rerender } = renderHook(({ id }) => useItemHistory('session', id, exists), { initialProps: { id: '1' } });
    expect(result.current.canBack).toBe(false);
    rerender({ id: '1' }); rerender({ id: '2' }); rerender({ id: '3' });
    const open = vi.fn(async (id: string) => { rerender({ id }); return true; });
    await act(async () => { result.current.navigate('back', open); });
    expect(open).toHaveBeenLastCalledWith('2'); expect(result.current.canForward).toBe(true);
    await act(async () => { result.current.navigate('back', open); });
    expect(open).toHaveBeenLastCalledWith('1'); expect(result.current.canBack).toBe(false);
    await act(async () => { result.current.navigate('forward', open); });
    expect(open).toHaveBeenLastCalledWith('2');
    rerender({ id: '4' });
    expect(result.current.canForward).toBe(false);
    await act(async () => { result.current.navigate('back', open); });
    expect(open).toHaveBeenLastCalledWith('2');
  });

  it('skips removed entries and ignores null or nonexistent effective selections', async () => {
    const available = new Set(['1', '2', '3', '4']);
    const exists = (id: string) => available.has(id);
    const { result, rerender } = renderHook(({ id }) => useItemHistory('session', id, exists), { initialProps: { id: '1' as string | null } });
    rerender({ id: '2' }); rerender({ id: '3' }); rerender({ id: '4' });
    available.delete('2'); available.delete('3');
    rerender({ id: null }); rerender({ id: 'missing' }); rerender({ id: '4' });
    const open = vi.fn(async (id: string) => { rerender({ id }); return true; });
    await act(async () => { result.current.navigate('back', open); });
    expect(open).toHaveBeenLastCalledWith('1'); expect(result.current.canBack).toBe(false);
    await act(async () => { result.current.navigate('forward', open); });
    expect(open).toHaveBeenLastCalledWith('4');
  });

  it('keeps independent histories in memory for each session and starts fresh on a new mount', async () => {
    const { result, rerender, unmount } = renderHook(({ key, id }) => useItemHistory(key, id, exists), { initialProps: { key: 'a', id: '1' } });
    rerender({ key: 'a', id: '2' });
    rerender({ key: 'b', id: '9' });
    expect(result.current.canBack).toBe(false);
    rerender({ key: 'a', id: '2' });
    const open = vi.fn(async (id: string) => { rerender({ key: 'a', id }); return true; });
    await act(async () => { result.current.navigate('back', open); });
    expect(open).toHaveBeenCalledWith('1');
    unmount();
    const fresh = renderHook(() => useItemHistory('a', '2', exists));
    expect(fresh.result.current.canBack).toBe(false); expect(fresh.result.current.canForward).toBe(false);
  });

  it('bounds the oldest entries and does not add entries during traversal', async () => {
    const { result, rerender } = renderHook(({ id }) => useItemHistory('session', id, exists), { initialProps: { id: '0' } });
    for (let index = 1; index <= ITEM_HISTORY_LIMIT; index++) rerender({ id: String(index) });
    const open = vi.fn(async (id: string) => { rerender({ id }); return true; });
    for (let index = ITEM_HISTORY_LIMIT - 1; index >= 1; index--) {
      await act(async () => { result.current.navigate('back', open); });
      expect(open).toHaveBeenLastCalledWith(String(index));
    }
    expect(result.current.canBack).toBe(false);
  });

  it.each(['refused', 'failed'])('restores the cursor when navigation is %s and blocks overlapping traversals', async outcome => {
    const { result, rerender } = renderHook(({ id }) => useItemHistory('session', id, exists), { initialProps: { id: '1' } });
    rerender({ id: '2' });
    let finish!: (opened: boolean) => void, fail!: (error: Error) => void;
    const open = vi.fn(() => new Promise<boolean>((resolve, reject) => { finish = resolve; fail = reject; }));
    act(() => { expect(result.current.navigate('back', open)).toBe(true); });
    expect(result.current.canBack).toBe(false); expect(result.current.canForward).toBe(false);
    act(() => { expect(result.current.navigate('forward', open)).toBe(false); });
    await act(async () => { if (outcome === 'refused') finish(false); else fail(new Error('read failed')); });
    expect(result.current.canBack).toBe(true); expect(result.current.canForward).toBe(false);
  });

  it('retains the actual selection when a newer selection overtakes a pending traversal', async () => {
    const { result, rerender } = renderHook(({ id }) => useItemHistory('session', id, exists), { initialProps: { id: '1' } });
    rerender({ id: '2' }); rerender({ id: '3' });
    let finish!: (opened: boolean) => void;
    act(() => { result.current.navigate('back', () => new Promise(resolve => { finish = resolve; })); });
    rerender({ id: '4' });
    await act(async () => { finish(false); });
    const open = vi.fn(async (id: string) => { rerender({ id }); return true; });
    await act(async () => { result.current.navigate('back', open); });
    expect(open).toHaveBeenCalledWith('3');
  });
});
