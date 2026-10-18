// One list of item actions feeds the actions row and the head's "…" menu (alpha.21 §5.6): every slot is there, `applies`
// says which fit the status, and `run` always calls the latest handler.
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { immutable } from '../../../src/data';
import type { Session } from '../../../src/generated/domain/models';
import { useItemActions, type ItemActionHandlers, type ItemActionId } from '../../../src/ui/detail/itemActions';
import { sessionFixture } from '../history/fixtures';

const handlers = (): ItemActionHandlers => ({ hide: vi.fn(), unhide: vi.fn(), remove: vi.fn(), bring: vi.fn(), later: vi.fn(), reopen: vi.fn(), followUp: vi.fn(), drop: vi.fn(), copyRef: vi.fn() });
const withStatus = (status: string, patch: (session: Session) => void = () => {}) => {
  const session = sessionFixture(), item = Object.values(session.items).find(value => value)!;
  item.status = status as typeof item.status;
  patch(session);
  return { session: immutable(session), item: immutable(session).items[item.id]! };
};
const ids = (list: readonly { id: ItemActionId; applies: boolean }[]) => list.filter(action => action.applies).map(action => action.id);

describe('useItemActions', () => {
  it.each([
    ['open', ['followUp', 'bring', 'later', 'drop', 'hide', 'remove', 'copyRef'], 'Reply'],
    ['waiting_on_me', ['followUp', 'hide', 'remove', 'copyRef'], 'Answer'],
    ['in_progress', ['followUp', 'hide', 'remove', 'copyRef'], 'Add a note'],
    ['decided', ['followUp', 'reopen', 'hide', 'remove', 'copyRef'], 'Follow up'],
    ['done', ['followUp', 'reopen', 'hide', 'remove', 'copyRef'], 'Follow up'],
    ['replaced', ['followUp', 'hide', 'remove', 'copyRef'], 'Follow up'],
  ])('%s applies %j', (status, applies, label) => {
    const { session, item } = withStatus(status);
    const { result } = renderHook(() => useItemActions({ session, item, on: handlers() }));
    expect(ids(result.current)).toEqual(applies);
    expect(result.current.find(action => action.id === 'followUp')!.label).toBe(label);
  });

  it('keeps the hover bar order and swaps Hide for Unhide and Later for Unpark', () => {
    const { session, item } = withStatus('open');
    const { result } = renderHook(() => useItemActions({ session, item, on: handlers(), hidden: true, later: true }));
    expect(result.current.map(action => action.id)).toEqual(['followUp', 'bring', 'reopen', 'later', 'drop', 'unhide', 'remove', 'copyRef']);
    expect(result.current.find(action => action.id === 'later')!.label).toBe('Unpark');
    expect(result.current.find(action => action.id === 'unhide')!.label).toBe('Unhide');
  });

  it('runs the latest handler and keeps the same array while nothing visible changed', () => {
    const { session, item } = withStatus('open');
    const first = handlers(), second = handlers();
    const { result, rerender } = renderHook(({ on }) => useItemActions({ session, item, on }), { initialProps: { on: first } });
    const before = result.current;
    rerender({ on: second });
    expect(result.current).toBe(before);
    before.find(action => action.id === 'drop')!.run();
    expect(second.drop).toHaveBeenCalledTimes(1);
    expect(first.drop).not.toHaveBeenCalled();
  });

  it('names why a fitting action cannot run now, and never blocks Hide, Remove or Copy', () => {
    const { session, item } = withStatus('open');
    const { result } = renderHook(() => useItemActions({ session, item, on: handlers(), held: 'A message is on its way' }));
    expect(result.current.filter(action => action.disabledReason).map(action => action.id)).toEqual(['followUp', 'bring', 'later', 'drop']);
    expect(result.current.find(action => action.id === 'bring')!.disabledReason).toBe('A message is on its way');
  });

  it('is empty without an item', () => {
    const { result } = renderHook(() => useItemActions({ session: undefined, item: undefined, on: handlers() }));
    expect(result.current).toEqual([]);
  });
});
