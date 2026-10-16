// The workspace owns a waiting reader (it feeds the switcher and the page chip) that reads the same catalogue as the
// navigation store. A scripted transport hands out one answer per read, so the reader would take the answers the
// navigation store is waiting for. These tests give it its own service, which answers with fixed lists, and keep
// every scripted answer for the store under test.
import demo from '../../../../../fixtures/domain/demo/session.json';
import projectsFixture from '../../../../../fixtures/domain/projections/projects.json';
import sessionsFixture from '../../../../../fixtures/domain/projections/sessions.json';
import { createDesktopService, type DesktopTransport } from '../../../src/data/service';
import { OpenSessions } from '../../../src/data/session-store';
import { WaitingStore } from '../../../src/selectors/waiting/store';

class QuietTransport implements DesktopTransport {
  async invoke<T>(name: string): Promise<T> {
    const counts = sessionsFixture.items[0]!.counts;
    const data = name === 'project_list' ? { projects: structuredClone(projectsFixture), counts }
      : name === 'session_list' ? { sessions: structuredClone(sessionsFixture), counts, active_total: 9, closed_total: 3, archived_total: 0 }
        : name === 'session_get' ? { session: structuredClone(demo), freshness: 'fresh' } : null;
    if (!data) throw new Error(`The quiet transport only reads lists and sessions: ${name}`);
    return { api_version: 1, ok: true, data: { kind: name, data } } as T;
  }
  async listen() { return () => {}; }
}

const readers: WaitingStore[] = [];
/** A waiting reader of its own; `stopQuietWaiting` after each test. */
export function quietWaiting(): WaitingStore {
  const service = createDesktopService(new QuietTransport());
  const reader = new WaitingStore(service, new OpenSessions(service));
  readers.push(reader);
  return reader;
}
export const stopQuietWaiting = () => readers.splice(0).forEach(reader => reader.stop());
