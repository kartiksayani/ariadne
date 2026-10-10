import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useFilterFolds } from '../../../src/ui/shared/filterFolds';
import { filterSignature } from '../../../src/selectors/tree/folds';
import { preferences } from '../graph/fixture';

afterEach(cleanup);

describe('filter folds across view switches', () => {
  it('keeps matching live search scopes aligned while the saved search catches up', () => {
    const router = {}, view = preferences();
    const tree = renderHook(({ filters }) => useFilterFolds(router, view.session, filters, 'live query'), { initialProps: { filters: view.filters } });
    const graph = renderHook(({ filters }) => useFilterFolds(router, view.session, filters, 'live query'), { initialProps: { filters: view.filters } });
    act(() => { graph.result.current.setFold('items', '1', true); });
    expect([...tree.result.current.items]).toEqual(['1']);
    const saved = { ...view.filters, search: 'live query' };
    tree.rerender({ filters: saved }); graph.rerender({ filters: saved });
    expect([...tree.result.current.items]).toEqual(['1']);
    expect([...graph.result.current.items]).toEqual(['1']);
  });
  it('shares explicit folds for one router and resets them when the visible filter changes', () => {
    const router = {}, view = preferences(); view.filters.search = 'matching descendant';
    const tree = renderHook(() => useFilterFolds(router, view.session, view.filters));
    act(() => { tree.result.current.setFold('items', '1', true); tree.result.current.setFold('topics', 'topic', true); });
    tree.unmount();
    const graph = renderHook(({ filters }) => useFilterFolds(router, view.session, filters), { initialProps: { filters: view.filters } });
    expect([...graph.result.current.items]).toEqual(['1']);
    expect([...graph.result.current.topics]).toEqual(['topic']);
    graph.rerender({ filters: { ...view.filters, statuses: ['open'] } });
    expect([...graph.result.current.items]).toEqual([]);
    expect([...graph.result.current.topics]).toEqual([]);
    graph.rerender({ filters: view.filters });
    expect([...graph.result.current.items]).toEqual([]);
    expect(view.expanded_item_ids).toEqual(['1', '1.1']);
  });
  it('ignores retired topic scope, whitespace and filter ordering in its signature', () => {
    const filters = preferences().filters;
    expect(filterSignature({ ...filters, topic_id: 'saved', search: '  TOKEN   TWO ' }))
      .toBe(filterSignature({ ...filters, topic_id: null, search: 'two token' }));
  });
});
