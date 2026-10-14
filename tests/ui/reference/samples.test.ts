import { describe, expect, it } from 'vitest';
import { designFixture, prototypeData } from '../design/fixtures';
import { frameIds } from '../design/frames';
import { handoffMembers } from '../design/source.mts';
import { currentQuestionReplied, displayStatus } from '../../../apps/desktop/src/selectors/waiting/replied';
import { waitingOnOwner } from '../../../apps/desktop/src/selectors/waiting/rows';

const data = prototypeData(handoffMembers()['Ariadne.dc.html']);

describe('neutral design samples', () => {
  it('keeps historical thread answers out of the current waiting episode', () => {
    const fixture = designFixture('1u', data), session = fixture.transport.sessions.get(fixture.route!.session_id)!;
    const item = session.items['4.1']!, round = session.rounds[item.current_round_id!]!;
    expect(round.question_revision).toBe(item.question_revision);
    expect(session.answers.filter(answer => answer.item_id === item.id).every(answer => answer.question_revision < item.question_revision)).toBe(true);
    expect(currentQuestionReplied(session, item)).toBe(false);
    expect(waitingOnOwner(session, item)).toBe(true);
    expect(displayStatus(session, item)).toBe('waiting_on_me');
  });
  it('keeps project names, roots and session references consistent', () => {
    expect(data.PROJECTS.map(project => [project.id, project.name, project.path])).toEqual([
      ['notes', 'notes-sdk', '~/Documents/Code/notes-sdk'],
      ['sync', 'sync-service', '~/Documents/Code/sync-service'],
      ['search', 'search-api', '~/Documents/Code/search-api'],
    ]);
    const ids = new Set(data.PROJECTS.map(project => project.id));
    for (const session of data.PROJECT_SESSIONS) expect(ids.has(session.project)).toBe(true);
    for (const topic of data.OTHER_TOPICS) expect(ids.has(topic.project!)).toBe(true);
    expect(data.SYNC_MSGS).toHaveLength(4);
  });

  it('applies requested themes without changing frame content or adding Messages preferences', () => {
    const fixture = designFixture('1a', data, { theme: 'light' });
    expect(fixture.spec).toMatchObject({ id: '1a', theme: 'light' });
    expect(fixture.transport.preferences.global.theme).toBe('light');
    const view = fixture.transport.preferences.sessions.find(view => view.session.session_id === fixture.route!.session_id)!;
    expect(view).not.toHaveProperty('rail');
    expect(fixture.spec).not.toHaveProperty('rail');
    expect(fixture.spec).not.toHaveProperty('hoverMsg');
    expect(fixture.spec.selected).toBe(designFixture('1a', data).spec.selected);
  });

  it('compares the surviving columns of every former Messages frame', () => {
    const source = handoffMembers()['Ariadne.dc.html']!;
    expect(source).not.toContain('title="Messages (m)"');
    expect(source).not.toContain('Session activity');
    expect(source).not.toContain('session-activity');
    expect(source).toContain('rail: false,');
    expect(source).toContain('hoverMsg: null, msgSel: null,');
    for (const frame of frameIds) {
      const fixture = designFixture(frame, data);
      expect(fixture.spec).not.toHaveProperty('rail');
      expect(fixture.spec).not.toHaveProperty('hoverMsg');
      for (const view of fixture.transport.preferences.sessions) expect(view).not.toHaveProperty('rail');
    }
  });

  it('builds every frame and resolves the project-page selection', () => {
    for (const frame of frameIds) expect(() => designFixture(frame, data)).not.toThrow();
    const fixture = designFixture('1ac', data);
    const projectId = data.PROJECTS.findIndex(project => project.id === 'notes') + 1;
    expect(fixture.transport.preferences.global.selected_navigation).toEqual({
      kind: 'project', project_id: `00000000-0000-4000-8000-a${String(projectId).padStart(11, '0')}`,
    });
  });
});
