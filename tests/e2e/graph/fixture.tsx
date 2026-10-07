import { Profiler, useState } from 'react';
import { createRoot } from 'react-dom/client';
import demo from '../../../fixtures/domain/demo/session.json';
import type { Session } from '../../../apps/desktop/src/generated/domain/models';
import type { SessionPreferences } from '../../../apps/desktop/src/generated/core';
import { OpenSessions } from '../../../apps/desktop/src/data/session-store';
import { RegisteredRoutes } from '../../../apps/desktop/src/data/routes';
import { createDesktopService, type DesktopTransport } from '../../../apps/desktop/src/data/service';
import { GraphView } from '../../../apps/desktop/src/ui/graph/GraphView';
import '../../../apps/desktop/src/styles/reference.css';

declare global {
  interface Window { __graphEvidence: { mountMs: number[]; updateMs: number[]; saved: SessionPreferences[] } }
}

// Twenty ordered trees of 100 items in one topic; a long replacement runs from
// the first tree to the last. Only the transport is doubled.
function graphSession(): Session {
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
const routes = new RegisteredRoutes(service, opened), later = new Set<string>();
// Every root expanded: all 2,000 nodes are laid out and rendered.
const initial: SessionPreferences = { session: route, tab_open: true, tab_order: 0, selected_item_id: null,
  expanded_item_ids: Array.from({ length: 20 }, (_, index) => String(index + 1)),
  filters: { search: '', statuses: [], owners: [], topic_id: null, archived: false, hide_later: false }, rail: 'hidden', scroll: null };
window.__graphEvidence = { mountMs: [], updateMs: [], saved: [] };

function Fixture() {
  const [view, setView] = useState(initial), [detail, setDetail] = useState<string | null>(null);
  return <>
    <button type="button" onClick={() => setView(previous => ({ ...previous, selected_item_id: '15.50' }))}>Select off-screen item</button>
    {detail && <p role="status">Detail {detail}</p>}
    <div style={{ display: 'flex', flexDirection: 'column', height: 600 }}>
      <Profiler id="graph-view" onRender={(_id, phase, duration) => {
        window.__graphEvidence[phase === 'mount' ? 'mountMs' : 'updateMs'].push(duration);
      }}>
        <GraphView store={store} routes={routes} view={view} later={later} reveal={null} tight={false} sessionLabel={null}
          saveView={async next => { window.__graphEvidence.saved.push(next); setView(next); return true; }}
          onReveal={(result, openDetail) => { if (openDetail && result.kind === 'item') setDetail(result.route.item_id); }} />
      </Profiler>
    </div>
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
