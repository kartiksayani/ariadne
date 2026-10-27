// The pages' words (SPEC 14.1–14.3) from the catalogue: dates, card footers and archive rows.
import { describe, expect, it } from 'vitest';
import { shortDate } from '../../../src/ui/shell/model';
import { lastActivity } from '../../../src/ui/pages/model';
import { archivedSessionRow, projectCardData } from '../../../src/components/navigation/pageData';
import projects from '../../../../../fixtures/domain/projections/projects.json';
import sessions from '../../../../../fixtures/domain/projections/sessions.json';
import type { ProjectSummary, SessionSummary } from '../../../src/generated/domain/models';

const now = new Date(2026, 9, 7, 21, 25).getTime();
const at = (month: number, day: number, hours = 12, minutes = 0) => new Date(2026, month, day, hours, minutes).getTime();
const project = projects.items[0] as ProjectSummary;
const summary = (patch: Partial<SessionSummary>): SessionSummary => ({ ...(sessions.items[0] as SessionSummary), project_id: project.project_id, ...patch });

describe('page dates', () => {
  it.each([[8, 12, '12 Sep'], [9, 3, '3 Oct'], [0, 30, '30 Jan']])('writes month %i day %i as "%s", never "Sept"', (month, day, words) => {
    expect(shortDate(at(month, day))).toBe(words);
  });
  it('writes today and yesterday with the time, any other day as its date', () => {
    expect(lastActivity(at(9, 7, 19, 40), now)).toBe('today 19:40');
    expect(lastActivity(at(9, 6, 18, 5), now)).toBe('yesterday 18:05');
    expect(lastActivity(at(9, 3), now)).toBe('3 Oct');
    expect(lastActivity(at(8, 28), now)).toBe('28 Sep');
  });
});

describe('project cards and archive rows', () => {
  it('a card footer reads the time alone for today, and an empty project names its archived last session', () => {
    const live = summary({ updated_at: new Date(at(9, 7, 21, 25)).toISOString(), state: 'active', archived_at: null });
    expect(projectCardData(project, [live], now, null).footer).toMatch(/ · last activity 21:25$/);
    const archived = summary({ title: 'landing copy', name: null, state: 'closed', updated_at: new Date(at(8, 12)).toISOString(),
      archived_at: new Date(at(8, 12)).toISOString() });
    const empty = projectCardData(project, [archived], now, null);
    expect(empty.footer).toBe('Last activity 12 Sep');
    expect(empty.emptyText).toBe('No sessions. Its last one, “landing copy”, is in Archive.');
  });
  it('a card lists its sessions by latest activity, newest first, closed ones in the same order and archived ones not at all (alpha.24 P1)', () => {
    const stamp = (month: number, day: number, hours: number) => new Date(at(month, day, hours)).toISOString();
    const own = [
      summary({ session_id: 'oldest', title: 'oldest', name: null, state: 'active', updated_at: stamp(9, 1, 9), archived_at: null }),
      summary({ session_id: 'newest-closed', title: 'newest closed', name: null, state: 'closed', updated_at: stamp(9, 7, 20), archived_at: null }),
      summary({ session_id: 'middle', title: 'middle', name: null, state: 'active', updated_at: stamp(9, 5, 8), archived_at: null }),
      summary({ session_id: 'gone', title: 'gone', name: null, state: 'closed', updated_at: stamp(9, 7, 21), archived_at: stamp(9, 7, 21) }),
      summary({ session_id: 'second-closed', title: 'second closed', name: null, state: 'closed', updated_at: stamp(9, 6, 12), archived_at: null }),
    ];
    const card = projectCardData(project, own, now, null);
    expect(card.sessions.map(row => row.name)).toEqual(['newest closed', 'second closed', 'middle', 'oldest']);
    expect(card.sessions.map(row => row.run)).toEqual(['closed', 'closed', expect.any(String), expect.any(String)]);
  });
  it('an archived session row counts its topics and items and dates its archiving', () => {
    const counts = (sessions.items[0] as SessionSummary).counts;
    const archived = summary({ title: 'March incident notes', name: null, state: 'closed', topic_count: 4, archived_at: new Date(at(9, 3)).toISOString(),
      counts: { ...counts, items_by_status: { open: 0, waiting_on_me: 0, in_progress: 0, decided: 1, done: 30, dropped: 0, replaced: 0 } } });
    const row = archivedSessionRow(archived, project, now);
    expect(row.sub).toMatch(/ · 4 topics · 31 items$/);
    expect(row.when).toBe('Archived 3 Oct');
  });
});
