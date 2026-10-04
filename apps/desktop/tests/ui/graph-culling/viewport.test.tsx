import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useViewport } from '../../../src/graph/culling/use-viewport';
import { zoomAt } from '../../../src/graph/layout/viewport';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('animation-frame viewport', () => {
  it('coalesces events, composes against the latest request and cancels unmounted work', () => {
    let callback!: FrameRequestCallback;
    const schedule = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(fn => { callback = fn; return 7; });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const initial = { x: 10, y: 20, scale: 1 }, cursor = { x: 100, y: 120 };
    const { result, unmount } = renderHook(() => useViewport(initial));
    act(() => {
      result.current.setViewport(previous => zoomAt(previous, cursor, previous.scale * 1.2));
      result.current.setViewport(previous => zoomAt(previous, cursor, previous.scale * 1.2));
    });
    expect(schedule).toHaveBeenCalledOnce(); expect(result.current.viewport).toEqual(initial);
    act(() => callback(0));
    expect(result.current.viewport).toEqual(zoomAt(initial, cursor, 1.44));
    act(() => result.current.setViewport({ x: 90, y: 80, scale: 0.5 }));
    expect(schedule).toHaveBeenCalledTimes(2); unmount(); expect(cancel).toHaveBeenCalledWith(7);
  });
});
