// The badge row's marker (SPEC 9.10): New or Changed while unseen, "Seen" for the rest of the visit once the dwell or Mark seen
// clears it, and back to Changed if the agent changes the item again.
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { immutable } from '../../../src/data';
import type { SessionSeen } from '../../../src/generated/core';
import { useDetailMarker } from '../../../src/ui/changes/useDetailMarker';
import { changesFixture } from './fixture';

describe('useDetailMarker', () => {
  const setup = () => {
    const value = changesFixture(1, 0, 1), session = immutable(value.session);
    return { value, changed: session.items['updated-0']!, created: session.items['new-0']!, seen: value.seen as SessionSeen };
  };
  it.each([['changed', 'updated-0'], ['new', 'new-0']] as const)('%s while unseen, then Seen once it is read, never null mid-visit', (kind, id) => {
    const { value, seen } = setup(), item = immutable(value.session).items[id]!;
    const { result, rerender } = renderHook(({ seen: current }) => useDetailMarker(item, current), { initialProps: { seen } });
    expect(result.current).toBe(kind);
    rerender({ seen: { ...seen, items: [{ item_id: id, revision: item.revision }] } });
    expect(result.current).toBe('seen');
  });
  it('is null for an item that was already seen when Details opened', () => {
    const { value, seen } = setup(), item = immutable(value.session).items['updated-0']!;
    const read = { ...seen, items: [{ item_id: item.id, revision: item.revision }] };
    const { result } = renderHook(() => useDetailMarker(item, read));
    expect(result.current).toBeNull();
  });
  it('brings Changed back when the item changes again after Seen', () => {
    const { value, seen } = setup(), first = immutable(value.session).items['updated-0']!;
    const read = { ...seen, items: [{ item_id: first.id, revision: first.revision }] };
    const { result, rerender } = renderHook(({ item, current }) => useDetailMarker(item, current), { initialProps: { item: first, current: seen as SessionSeen } });
    rerender({ item: first, current: read });
    expect(result.current).toBe('seen');
    const again = immutable({ ...value.session.items['updated-0']!, revision: first.revision + 1, changes: [...value.session.items['updated-0']!.changes!, value.record({ revision: first.revision + 1, at: '2026-10-10T02:00:00.000Z' })] });
    rerender({ item: again, current: read });
    expect(result.current).toBe('changed');
  });
  it('is null without an item', () => {
    const { result } = renderHook(() => useDetailMarker(undefined, null));
    expect(result.current).toBeNull();
  });
});
