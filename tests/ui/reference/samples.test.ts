import { describe, expect, it } from 'vitest';
import { designFixture, prototypeData } from '../design/fixtures';
import { frameIds } from '../design/frames';
import { handoffMembers } from '../design/source.mts';

const data = prototypeData(handoffMembers()['Ariadne.dc.html']);

describe('neutral design samples', () => {
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

  it('builds every frame and resolves the project-page selection', () => {
    for (const frame of frameIds) expect(() => designFixture(frame, data)).not.toThrow();
    const fixture = designFixture('1ac', data);
    const projectId = data.PROJECTS.findIndex(project => project.id === 'notes') + 1;
    expect(fixture.transport.preferences.global.selected_navigation).toEqual({
      kind: 'project', project_id: `00000000-0000-4000-8000-a${String(projectId).padStart(11, '0')}`,
    });
  });
});
