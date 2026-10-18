// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useDetailTarget } from '../../../src/ui/shell/detailTarget';

const render = (initial: { route: string; selected: string | null }) =>
  renderHook(({ route, selected }) => useDetailTarget(route, selected), { initialProps: initial });

describe('useDetailTarget', () => {
  it.each([
    ['an item', { route: 'a', selected: 'item-1' }, { kind: 'item', id: 'item-1' }],
    ['no selection', { route: 'a', selected: null }, null],
  ])('starts in item mode with %s', (_name, initial, expected) => {
    expect(render(initial).result.current.target).toEqual(expected);
  });

  it('opens a topic beside the selection and returns with showItem', () => {
    const view = render({ route: 'a', selected: 'item-1' });
    act(() => view.result.current.openTopicInDetails('topic-1'));
    expect(view.result.current.target).toEqual({ kind: 'topic', topicId: 'topic-1' });
    act(() => view.result.current.showItem());
    expect(view.result.current.target).toEqual({ kind: 'item', id: 'item-1' });
  });

  it('opens a topic with nothing selected', () => {
    const view = render({ route: 'a', selected: null });
    act(() => view.result.current.openTopicInDetails('topic-1'));
    expect(view.result.current.target).toEqual({ kind: 'topic', topicId: 'topic-1' });
  });

  it.each([
    ['a session switch', { route: 'b', selected: 'item-1' }],
    ['another selection', { route: 'a', selected: 'item-2' }],
  ])('returns to item mode on %s, and stays there when the old state comes back', (_name, next) => {
    const view = render({ route: 'a', selected: 'item-1' });
    act(() => view.result.current.openTopicInDetails('topic-1'));
    view.rerender(next);
    expect(view.result.current.target).toEqual(next.selected ? { kind: 'item', id: next.selected } : null);
    view.rerender({ route: 'a', selected: 'item-1' });
    expect(view.result.current.target).toEqual({ kind: 'item', id: 'item-1' });
  });
});
