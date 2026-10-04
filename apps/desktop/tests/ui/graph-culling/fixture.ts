import demo from '../../../../../fixtures/domain/demo/session.json';
import type { Session } from '../../../src/generated/domain/models';
import type { SessionPreferences } from '../../../src/generated/core';
import { OpenSessions } from '../../../src/data/session-store';
import { RegisteredRoutes } from '../../../src/data/routes';
import { createDesktopService, type DesktopTransport } from '../../../src/data/service';

// Twenty ordered trees of 100 items; a long replacement crosses the central
// viewport while both endpoints are off screen. Only the transport is doubled.
export function graphSession(): Session {
  const session = structuredClone(demo) as Session, template = session.items['1']!;
  session.items = {};
  for (let root = 1; root <= 20; root++) {
    for (let child = 0; child < 100; child++) {
      const id = child ? `${root}.${child}` : String(root);
      session.items[id] = { ...structuredClone(template), id, parent: child ? String(root) : null,
        ordinal: child || root, question: `Graph question ${id}`, status: 'open', replaced_by: null };
    }
  }
  session.items['1.1']!.status = 'replaced'; session.items['1.1']!.replaced_by = '20.99';
  return session;
}
export async function graphFixture() {
  const session = graphSession(), route = { project_id: session.project_id, session_id: session.id };
  const transport: DesktopTransport = {
    async invoke<T>(command: string, args: Parameters<DesktopTransport['invoke']>[1]): Promise<T> {
      const request = args.request;
      const data = command === 'session_get' ? { session: structuredClone(session), freshness: 'fresh' }
        : { ...route, item_id: 'request' in request ? (request.request.params as { item_id: string }).item_id : '1' };
      return { api_version: 1, ok: true, data: { kind: command, data } } as T;
    },
    async listen() { return () => {}; },
  };
  const service = createDesktopService(transport), opened = new OpenSessions(service), store = opened.open(route);
  await store.refresh();
  const view: SessionPreferences = { session: route, tab_open: true, tab_order: 0, selected_item_id: null, expanded_item_ids: [],
    filters: { search: '', statuses: [], owners: [], topic_id: null, archived: false, hide_later: false }, rail: 'waiting', scroll: null };
  return { session, store, opened, routes: new RegisteredRoutes(service, opened), view, topicId: session.items['1']!.topic_id };
}
