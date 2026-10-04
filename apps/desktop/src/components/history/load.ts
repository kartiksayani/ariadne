import type { ItemPageRequest, RoundPageRequest, SessionRef } from '../../generated/core';
import type {
  ItemMessagesProjection, ItemReadProjection, ItemRoundsProjection, Message,
  Page, QueryCursor, RoundProjection,
} from '../../generated/domain/models';
import { ServiceFailure, type RendererService } from '../../data/service';

export interface ItemHistory {
  readonly conversation: ItemMessagesProjection;
  readonly item: ItemReadProjection;
  readonly rounds: ItemRoundsProjection;
}
const limit = 100;
function checked<T>(page: Page<T>, revision: number, view: QueryCursor['view']): void {
  if (page.snapshot_revision !== revision || (page.next_cursor
      && (page.next_cursor.revision !== revision || page.next_cursor.view !== view))) {
    throw new ServiceFailure('invalid_response');
  }
}
async function complete<T>(initial: Page<T>, revision: number, view: QueryCursor['view'],
  next: (cursor: QueryCursor) => Promise<Page<T>>): Promise<Page<T>> {
  let page = initial;
  const items: T[] = [], seen = new Set<string>();
  for (;;) {
    checked(page, revision, view);
    items.push(...page.items);
    if (!page.next_cursor) return { items, next_cursor: null, snapshot_revision: revision };
    const key = JSON.stringify(page.next_cursor);
    if (seen.has(key)) throw new ServiceFailure('invalid_response');
    seen.add(key);
    page = await next(page.next_cursor);
  }
}
export async function loadMessages(service: RendererService, route: SessionRef, revision: number, signal?: AbortSignal): Promise<Page<Message>> {
  const read = async (cursor: QueryCursor | null) => {
    signal?.throwIfAborted();
    const result = await service.query({ session: route, request: { command: 'session_read', params: {
      selection: { view: 'messages', filters: { topic_id: null, item_id: null } }, cursor, limit, item_pages: [],
    } } });
    if (result.view !== 'messages') throw new ServiceFailure('invalid_response');
    return result.page;
  };
  return complete(await read(null), revision, 'messages', read);
}
export async function loadItemHistory(service: RendererService, route: SessionRef, itemId: string,
  revision: number, signal?: AbortSignal): Promise<ItemHistory> {
  const messages = async (cursor: QueryCursor | null) => {
    signal?.throwIfAborted();
    const result = await service.query({ session: route, request: { command: 'item_messages', params: { item_id: itemId, cursor, limit } } });
    if (result.item_id !== itemId) throw new ServiceFailure('invalid_response');
    return result;
  };
  const conversation = structuredClone(await messages(null));
  conversation.messages = await complete(conversation.messages, revision, 'item_messages', async cursor => (await messages(cursor)).messages);
  const readItem = async (itemPages: ItemPageRequest[]) => {
    signal?.throwIfAborted();
    const result = await service.query({ session: route, request: { command: 'session_read', params: {
      selection: { view: 'items', filters: { topic_id: null, item_id: itemId, parent_item_id: null, statuses: [], archived: null } },
      cursor: null, limit: 1, item_pages: itemPages,
    } } });
    if (result.view !== 'items') throw new ServiceFailure('invalid_response');
    checked(result.page, revision, 'items');
    const item = result.page.items[0];
    if (result.page.items.length !== 1 || result.page.next_cursor || item.item.id !== itemId) throw new ServiceFailure('invalid_response');
    return item;
  };
  const item = structuredClone(await readItem([]));
  item.updated_messages = await complete(item.updated_messages, revision, 'item_updated_messages', async cursor =>
    (await readItem([{ view: 'item_updated_messages', item_id: itemId, cursor, limit }])).updated_messages);
  item.status_history = await complete(item.status_history, revision, 'item_status_history', async cursor =>
    (await readItem([{ view: 'item_status_history', item_id: itemId, cursor, limit }])).status_history);
  const rounds = async (cursor: QueryCursor | null, roundPages: RoundPageRequest[]) => {
    signal?.throwIfAborted();
    const result = await service.query({ session: route, request: { command: 'item_rounds', params: {
      item_id: itemId, cursor, limit: 1, round_pages: roundPages,
    } } });
    if (result.item_id !== itemId) throw new ServiceFailure('invalid_response');
    checked(result.rounds, revision, 'item_rounds');
    return result.rounds;
  };
  const values: RoundProjection[] = [], seen = new Set<string>();
  let cursor: QueryCursor | null = null;
  for (;;) {
    // One parent per outer page keeps its nested continuation address stable
    // even when a complete body consumes the projection's byte budget.
    const page = await rounds(cursor, []);
    for (const supplied of page.items) {
      const projection = structuredClone(supplied);
      if (projection.round.item_id !== itemId || values.some(value => value.round.id === projection.round.id)) throw new ServiceFailure('invalid_response');
      const roundId = projection.round.id, parentCursor = cursor;
      const nested = async (view: RoundPageRequest['view'], nestedCursor: QueryCursor) => {
        const response = await rounds(parentCursor, [{ view, round_id: roundId, cursor: nestedCursor, limit }]);
        const value = response.items.find(value => value.round.id === roundId);
        if (!value || value.round.item_id !== itemId) throw new ServiceFailure('invalid_response');
        return value;
      };
      projection.answers = await complete(projection.answers, revision, 'round_answers', async cursor => (await nested('round_answers', cursor)).answers);
      projection.owner_messages = await complete(projection.owner_messages, revision, 'round_owner_messages', async cursor => (await nested('round_owner_messages', cursor)).owner_messages);
      projection.agent_messages = await complete(projection.agent_messages, revision, 'round_agent_messages', async cursor => (await nested('round_agent_messages', cursor)).agent_messages);
      projection.results = await complete(projection.results, revision, 'round_results', async cursor => (await nested('round_results', cursor)).results);
      projection.forks = await complete(projection.forks, revision, 'round_forks', async cursor => (await nested('round_forks', cursor)).forks);
      values.push(projection);
    }
    if (!page.next_cursor) break;
    const key = JSON.stringify(page.next_cursor);
    if (seen.has(key)) throw new ServiceFailure('invalid_response');
    seen.add(key); cursor = page.next_cursor;
  }
  return { conversation, item, rounds: { item_id: itemId, rounds: { items: values, snapshot_revision: revision, next_cursor: null } } };
}
