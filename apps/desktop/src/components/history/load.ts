import type { SessionRef } from '../../generated/core';
import type { Message, Page, QueryCursor } from '../../generated/domain/models';
import { ServiceFailure, type RendererService } from '../../data/service';

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
