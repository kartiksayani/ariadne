import { describe, expect, it } from 'vitest';
import type { QueryResult, RoundPageRequest } from '../../../src/generated/core';
import type { RoundProjection } from '../../../src/generated/domain/models';
import { loadItemHistory, loadMessages } from '../../../src/components/history/load';
import { createDesktopService, ServiceFailure } from '../../../src/data/service';
import { cursor, HistoryTransport, page, projections, route } from './fixtures';

describe('complete canonical history pages', () => {
  it('walks every outer and nested family without losing full bodies or changing routes', async () => {
    const transport = new HistoryTransport(), values = projections(transport.session);
    const family: Record<RoundPageRequest['view'], keyof Pick<RoundProjection, 'answers' | 'owner_messages' | 'agent_messages' | 'results' | 'forks'>> = {
      round_answers: 'answers', round_owner_messages: 'owner_messages', round_agent_messages: 'agent_messages', round_results: 'results', round_forks: 'forks',
    };
    transport.override = request => {
      if (!('request' in request)) return;
      const query = request.request, result = transport.response(request);
      if (query.command === 'item_messages' && result.kind === 'item_messages') {
        result.data.messages = query.params.cursor ? page(values.conversation.messages.items.slice(1)) : page(values.conversation.messages.items.slice(0, 1), 21, cursor('item_messages'));
      }
      if (query.command === 'session_read' && result.kind === 'session_read' && result.data.view === 'items') {
        const item = result.data.page.items[0];
        for (const key of ['updated_messages', 'status_history'] as const) {
          const view = key === 'updated_messages' ? 'item_updated_messages' : 'item_status_history';
          if (!query.params.item_pages.some(selector => selector.view === view)) item[key] = { ...item[key], items: [], next_cursor: cursor(view) };
        }
      }
      if (query.command === 'item_rounds' && result.kind === 'item_rounds' && result.data.rounds.items[0].round.ordinal === 1) {
        const projection = result.data.rounds.items[0];
        for (const [view, field] of Object.entries(family)) {
          if (!query.params.round_pages.some(selector => selector.view === view)) projection[field] = { ...projection[field], items: [], next_cursor: cursor(view as RoundPageRequest['view']) };
        }
      }
      return result;
    };
    const history = await loadItemHistory(createDesktopService(transport), route, '1', 21);
    expect(history.rounds.rounds.items.map(value => value.round.ordinal)).toEqual([1, 2, 3, 4, 5]);
    expect(history.rounds.rounds.items[0]).toEqual(values.rounds[0]);
    expect(history.conversation.messages.items).toEqual(values.conversation.messages.items);
    expect(history.item.updated_messages.items).toEqual(values.read.updated_messages.items);
    expect(history.item.status_history.items).toEqual(values.read.status_history.items);
    expect(transport.calls.every(request => request.session?.project_id === route.project_id && request.session.session_id === route.session_id)).toBe(true);
    const nested = transport.calls.flatMap(request => 'request' in request && request.request.command === 'item_rounds' ? request.request.params.round_pages : []);
    expect(nested.map(value => value.view)).toEqual(Object.keys(family));
    expect(nested.every(value => value.round_id === values.rounds[0].round.id && value.limit === 100)).toBe(true);
  });
  it('pages the full rail and rejects changed revision, wrong view and repeated cursors', async () => {
    const transport = new HistoryTransport();
    transport.override = request => {
      if (!('request' in request) || request.request.command !== 'session_read') return;
      return { kind: 'session_read', data: { view: 'messages', page: request.request.params.cursor
        ? page(transport.session.messages.slice(1)) : page(transport.session.messages.slice(0, 1), 21, cursor('messages')) } };
    };
    expect((await loadMessages(createDesktopService(transport), route, 21)).items).toEqual(transport.session.messages);
    for (const invalid of [page([], 22), page([], 21, cursor('items')), page([], 21, cursor('messages'))]) {
      transport.override = () => ({ kind: 'session_read', data: { view: 'messages', page: invalid } });
      await expect(loadMessages(createDesktopService(transport), route, 21)).rejects.toBeInstanceOf(ServiceFailure);
    }
  });
  it('rejects wrong nested parent and wrong selected item rather than publishing incomplete data', async () => {
    const transport = new HistoryTransport();
    transport.override = request => {
      const result = transport.response(request);
      if (result.kind === 'item_rounds') result.data.rounds.items[0].round.item_id = '2';
      return result;
    };
    await expect(loadItemHistory(createDesktopService(transport), route, '1', 21)).rejects.toBeInstanceOf(ServiceFailure);
    transport.override = request => {
      const result: QueryResult = transport.response(request);
      if (result.kind === 'session_read' && result.data.view === 'items') result.data.page.items[0].item.id = '2';
      return result;
    };
    await expect(loadItemHistory(createDesktopService(transport), route, '1', 21)).rejects.toBeInstanceOf(ServiceFailure);
  });
});
