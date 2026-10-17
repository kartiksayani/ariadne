import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import demo from '../../../fixtures/domain/demo/session.json';
import type { Item, Session } from '../../../apps/desktop/src/generated/domain/models';
import type { SessionPreferences } from '../../../apps/desktop/src/generated/core';
import { OpenSessions } from '../../../apps/desktop/src/data/session-store';
import { RegisteredRoutes } from '../../../apps/desktop/src/data/routes';
import { createDesktopService, type DesktopTransport } from '../../../apps/desktop/src/data/service';
import { GraphView } from '../../../apps/desktop/src/ui/graph/GraphView';
import { MapSearchContext, type MapSearch } from '../../../apps/desktop/src/ui/graph/search';

// The Graph's "never moves on its own" fixture: eight top items of ten children each, one deeper chain under 4.1,
// beside a Details column whose width the spec sets. `window.__anchor` fires each trigger; only the transport is doubled.
declare global {
  interface Window {
    __anchor: {
      details(width: number): void; select(id: string | null): void; expanded(ids: readonly string[]): void;
      add(id: string, parent: string | null): Promise<void>; search(query: string): void;
    };
  }
}

const session = structuredClone(demo) as Session, template = session.items['1']!;
const item = (id: string, parent: string | null, ordinal: number): Item =>
  ({ ...structuredClone(template), id, parent, ordinal, question: `Anchor question ${id}`, status: 'open', replaced_by: null });
session.items = {};
for (let root = 1; root <= 8; root++) {
  session.items[String(root)] = item(String(root), null, root);
  for (let child = 1; child <= 10; child++) session.items[`${root}.${child}`] = item(`${root}.${child}`, String(root), child);
}
session.items['4.1.1'] = item('4.1.1', '4.1', 1);
session.items['4.1.1.1'] = item('4.1.1.1', '4.1.1', 1);
session.counters.next_root = 9;

const route = { project_id: session.project_id, session_id: session.id };
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
const routes = new RegisteredRoutes(service, opened), later = new Set<string>();
const params = new URLSearchParams(location.search);
const folded = new Set((params.get('folded') ?? '').split(',').filter(Boolean));
const initial: SessionPreferences = { session: route, tab_open: true, tab_order: 0, selected_item_id: params.get('selected'),
  expanded_item_ids: ['1', '2', '3', '4', '5', '6', '7', '8', '4.1', '4.1.1'].filter(id => !folded.has(id)),
  filters: { search: '', statuses: [], owners: [], topic_id: null, archived: false, hide_later: false }, scroll: null };

function Fixture() {
  const [view, setView] = useState(initial), [details, setDetails] = useState(Number(params.get('details') ?? 36));
  const [query, setQuery] = useState('');
  // The Map's search, as the Tree core computes it: every drawn question containing the query, in Map order.
  const search = useMemo((): MapSearch => {
    const ids = query ? Object.values(session.items).filter(value => value?.question.includes(query)).map(value => value!.id) : [];
    return { query, ids: new Set(ids), current: ids[0] ? { id: ids[0], field: 'question' } : null, stepped: 0 };
  }, [query]);
  useEffect(() => {
    window.__anchor = {
      details: setDetails,
      select: id => setView(previous => ({ ...previous, selected_item_id: id })),
      expanded: ids => setView(previous => ({ ...previous, expanded_item_ids: [...ids] })),
      async add(id, parent) {
        const siblings = Object.values(session.items).filter(value => value?.parent === parent).length;
        session.items[id] = item(id, parent, siblings + 1);
        session.revision += 1;
        await store.refresh();
      },
      search: setQuery,
    };
  }, []);
  // The Map column beside Details, as the window lays them out (SPEC §2): the Graph's scroller fills what Details leaves.
  return <div style={{ display: 'flex', height: '100%' }}>
    <div style={{ display: 'flex', flex: 1, minWidth: 0, flexDirection: 'column' }}>
      <MapSearchContext.Provider value={search}>
        <GraphView store={store} routes={routes} view={view} later={later} reveal={null}
          saveView={async next => { setView(next); return true; }} onReveal={() => {}} />
      </MapSearchContext.Provider>
    </div>
    <aside aria-label="Details" style={{ flex: 'none', width: details, borderLeft: '1px solid var(--color-divider)' }} />
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
