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
    ['waiting_on_me', ['hide', 'remove', 'copyRef'], 'Answer'],
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
    const { result } = renderHook(() => useItemActions({ session, item, on: handlers(), held: { followUp: 'A message is on its way', bring: 'A message is on its way', later: 'A message is on its way', drop: 'A message is on its way' } }));
    expect(result.current.filter(action => action.disabledReason).map(action => action.id)).toEqual(['followUp', 'bring', 'later', 'drop']);
    expect(result.current.find(action => action.id === 'bring')!.disabledReason).toBe('A message is on its way');
  });

  it('lets a waiting item that already has a reply box apply followUp, under the host’s own label', () => {
    const { session, item } = withStatus('waiting_on_me');
    const { result } = renderHook(() => useItemActions({ session, item, on: handlers(), replyApplies: true, replyLabel: 'Add a reply' }));
    expect(ids(result.current)).toEqual(['followUp', 'hide', 'remove', 'copyRef']);
    expect(result.current.find(action => action.id === 'followUp')!.label).toBe('Add a reply');
  });

  it('leaves out Hide, Unhide and Remove when the host gives no handler, and greys everything that sends in an archived session', () => {
    const { session, item } = withStatus('open', value => { value.archived_at = new Date().toISOString() as never; });
    const { result } = renderHook(() => useItemActions({ session, item, on: { copyRef: vi.fn() } }));
    expect(ids(result.current)).toEqual(['followUp', 'bring', 'later', 'drop', 'copyRef']);
    expect(result.current.filter(action => action.disabledReason).map(action => action.disabledReason)).toEqual(['Archived', 'Archived', 'Archived', 'Archived']);
  });

  it('is empty without an item', () => {
    const { result } = renderHook(() => useItemActions({ session: undefined, item: undefined, on: handlers() }));
    expect(result.current).toEqual([]);
  });
});
