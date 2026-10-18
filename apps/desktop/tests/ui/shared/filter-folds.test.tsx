import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useFilterFolds } from '../../../src/ui/shared/filterFolds';
import { filterSignature, type LocalChip } from '../../../src/selectors/tree/filter';
import type { SessionPreferences } from '../../../src/generated/core';
import { preferences } from '../graph/fixture';

afterEach(cleanup);

const sign = (filters: SessionPreferences['filters'], local: readonly LocalChip[] = []) =>
  filterSignature({ view: { ...preferences(), filters }, local });

describe('filter folds across view switches', () => {
  it('keeps the views’ shared folds aligned while a search is typed and saved, since a search filters nothing', () => {
    const router = {}, view = preferences(); view.filters.statuses = ['open'];
    const tree = renderHook(({ key }) => useFilterFolds(router, view.session, key), { initialProps: { key: sign(view.filters) } });
    const graph = renderHook(({ key }) => useFilterFolds(router, view.session, key), { initialProps: { key: sign(view.filters) } });
    act(() => { graph.result.current.setFold('items', '1', true); });
    expect([...tree.result.current.items]).toEqual(['1']);
    const saved = sign({ ...view.filters, search: 'live query' });
    tree.rerender({ key: saved }); graph.rerender({ key: saved });
    expect([...tree.result.current.items]).toEqual(['1']);
    expect([...graph.result.current.items]).toEqual(['1']);
  });
  it('shares explicit folds for one router and resets them when the visible filter changes', () => {
    const router = {}, view = preferences(); view.filters.statuses = ['open', 'in_progress'];
    const tree = renderHook(() => useFilterFolds(router, view.session, sign(view.filters)));
    act(() => { tree.result.current.setFold('items', '1', true); tree.result.current.setFold('topics', 'topic', true); });
    tree.unmount();
    const graph = renderHook(({ key }) => useFilterFolds(router, view.session, key), { initialProps: { key: sign(view.filters) } });
    expect([...graph.result.current.items]).toEqual(['1']);
    expect([...graph.result.current.topics]).toEqual(['topic']);
    graph.rerender({ key: sign({ ...view.filters, statuses: ['open'] }) });
    expect([...graph.result.current.items]).toEqual([]);
    expect([...graph.result.current.topics]).toEqual([]);
    graph.rerender({ key: sign(view.filters) });
    expect([...graph.result.current.items]).toEqual([]);
    expect(view.expanded_item_ids).toEqual(['1', '1.1']);
  });
  it('resets the folds when a local chip is picked or dropped, in either view', () => {
    const router = {}, view = preferences();
    const tree = renderHook(({ key }) => useFilterFolds(router, view.session, key), { initialProps: { key: sign(view.filters) } });
    act(() => { tree.result.current.setFold('items', '1', true); });
    expect([...tree.result.current.items]).toEqual(['1']);
    tree.rerender({ key: sign(view.filters, ['blocked']) });
    expect([...tree.result.current.items]).toEqual([]);
  });
  it('ignores retired topic scope, the search and filter ordering in its signature', () => {
    const filters = preferences().filters;
    expect(sign({ ...filters, topic_id: 'saved', search: '  TOKEN   TWO ', statuses: ['open', 'done'] }))
      .toBe(sign({ ...filters, topic_id: null, search: '', statuses: ['done', 'open'] }));
    expect(sign({ ...filters, statuses: ['open'] })).not.toBe(sign(filters));
  });
});
