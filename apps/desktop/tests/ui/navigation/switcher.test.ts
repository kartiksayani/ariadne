import { describe, expect, it } from 'vitest';
import demo from '../../../../../fixtures/domain/demo/session.json';
import summaries from '../../../../../fixtures/domain/projections/sessions.json';
import projects from '../../../../../fixtures/domain/projections/projects.json';
import type { Session, SessionSummary, ProjectSummary } from '../../../src/generated/domain/models';
import { waitingRows, type WaitingSession } from '../../../src/selectors/waiting/rows';
import { agentProduct, lastSessionFrom, switcherData, waitedFor } from '../../../src/state/navigation/switcher';

const route = { project_id: demo.project_id, session_id: demo.id };
const other = { ...route, session_id: '00000000-0000-4000-8000-000000000099' };
const now = Date.parse(demo.updated_at) + 12 * 60_000;
function capture(answered = false, ended: 'closed' | 'archived' | null = null): WaitingSession[] {
  return [route, other].map((ref, index) => {
    const session = structuredClone(demo) as Session;
    session.id = ref.session_id;
    if (index === 0 && answered) Object.values(session.items).forEach(item => { if (item?.status === 'waiting_on_me') item.status = 'done'; });
    if (index === 0 && ended) { session.state = 'closed'; session.closed_at = session.updated_at; if (ended === 'archived') session.archived_at = session.updated_at; }
    const summary = { ...structuredClone(summaries.items[0]), ...ref, name: index ? 'Other review' : 'Current review', state: session.state,
      closed_at: session.closed_at ?? null, archived_at: session.archived_at } as SessionSummary;
    return { session, summary, project: projects.items[0] as ProjectSummary };
  });
}
const data = (sessions: WaitingSession[], current: typeof route | null = route, hidden: string[] = []) => switcherData({
  projects: [projects.items[0] as ProjectSummary], sessions, waiting: waitingRows(sessions), current, now,
  hiddenSession: value => hidden.includes(value.session_id) });

describe('switcher data (C7)', () => {
  it('lists this project first, the current session first in it, and names each waiting question with its age', () => {
    const result = data(capture());
    expect(result.projects[0]).toMatchObject({ id: route.project_id, current: true });
    expect(result.projects[0]!.sessions.map(value => value.name)).toEqual(['Current review', 'Other review']);
    const otherRow = result.projects[0]!.sessions[1]!;
    expect(otherRow.waiting.length).toBeGreaterThan(0);
    expect(otherRow.waiting[0]!.title).not.toMatch(/^\d/);
    expect(otherRow.waiting[0]!.since).toMatch(/min|h|yesterday|\w{3}/);
  });
  it('counts this session and the others apart, so the button chip names only other sessions', () => {
    const sessions = capture(), rows = waitingRows(sessions);
    const result = data(sessions);
    expect(result.thisWaitingCount).toBe(rows.filter(row => row.route.session_id === route.session_id).length);
    expect(result.otherWaitingCount).toBe(rows.filter(row => row.route.session_id === other.session_id).length);
    expect(result.thisWaitingCount + result.otherWaitingCount).toBe(rows.length);
  });
  it('keeps a closed session with its lock, and leaves an archived one to the Archive page', () => {
    const closed = data(capture(false, 'closed')).projects[0]!.sessions.find(value => value.route.session_id === route.session_id)!;
    expect(closed).toMatchObject({ closed: true, running: false });
    expect(closed.closedWhen).toBeTruthy();
    expect(data(capture(false, 'archived')).projects[0]!.sessions.map(value => value.route.session_id)).toEqual([other.session_id]);
  });
  it('drops a session whose removal is pending, and its questions from the counts', () => {
    const result = data(capture(), route, [other.session_id]);
    expect(result.projects[0]!.sessions.map(value => value.route.session_id)).toEqual([route.session_id]);
    expect(result.otherWaitingCount).toBe(0);
  });
  it('counts every question as another session’s on a page with no session to return to', () => {
    const sessions = capture(), result = data(sessions, null);
    expect(result.thisWaitingCount).toBe(0);
    expect(result.otherWaitingCount).toBe(waitingRows(sessions).length);
  });
  it('words agents and ages as the board does', () => {
    expect(agentProduct('claude_code_mod')).toBe('Claude Code');
    expect(agentProduct('codex')).toBe('Codex');
    expect(waitedFor(now - 12 * 60_000, now)).toBe('12 min');
    expect(waitedFor(now - 3 * 3_600_000, now)).toBe('3 h');
  });
  it('picks the selected session, else the newest-opened tab of an older release', () => {
    const views = [route, other].map((session, tab_order) => ({ session, tab_order, tab_open: true }));
    expect(lastSessionFrom({ kind: 'session', session: route }, views)).toEqual(route);
    expect(lastSessionFrom({ kind: 'projects' }, views)).toEqual(other);
    expect(lastSessionFrom({ kind: 'projects' }, [])).toBeNull();
  });
});
