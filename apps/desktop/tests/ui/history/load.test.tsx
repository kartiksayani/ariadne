import { describe, expect, it } from 'vitest';
import { loadMessages } from '../../../src/components/history/load';
import { createDesktopService, ServiceFailure } from '../../../src/data/service';
import { cursor, HistoryTransport, page, route } from './fixtures';

describe('complete canonical history pages', () => {
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
});
