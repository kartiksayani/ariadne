import type { ProjectListResult, SessionListResult } from '../../generated/core';
import type { Page, ProjectSummary, QueryCursor, SessionSummary } from '../../generated/domain/models';
import { ServiceFailure, type RendererService } from '../../data/service';

const limit = 100;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

// A capture is published only after its final page. Cursors and counts belong
// to that capture; a failed continuation never creates a partial replacement.
async function collect<T, R>(view: 'projects' | 'sessions',
  load: (cursor: QueryCursor | null) => Promise<R>, pageOf: (result: R) => Page<T>,
  metadata: (result: R) => unknown, identity: (item: T) => string): Promise<{ first: R; items: T[] }> {
  let cursor: QueryCursor | null = null;
  let first: R | undefined;
  let revision: number | undefined;
  let digest: string | undefined;
  const items: T[] = [];
  const identities = new Set<string>();
  const cursors = new Set<string>();
  do {
    const result = await load(cursor);
    const page = pageOf(result);
    if (!Number.isSafeInteger(page.snapshot_revision) || page.snapshot_revision <= 0
        || page.items.length > limit || (revision !== undefined && page.snapshot_revision !== revision)
        || (first !== undefined && !same(metadata(first), metadata(result)))) {
      throw new ServiceFailure('invalid_response');
    }
    first ??= result;
    revision = page.snapshot_revision;
    for (const item of page.items) {
      const id = identity(item);
      if (identities.has(id)) throw new ServiceFailure('invalid_response');
      identities.add(id);
      items.push(item);
    }
    cursor = page.next_cursor;
    if (cursor) {
      const key = JSON.stringify(cursor);
      if (page.items.length === 0 || cursor.schema !== 1 || cursor.view !== view
          || cursor.revision !== revision || cursor.after === null
          || (digest !== undefined && cursor.filter_digest !== digest) || cursors.has(key)) {
        throw new ServiceFailure('invalid_response');
      }
      digest = cursor.filter_digest;
      cursors.add(key);
    }
  } while (cursor);
  return { first: first!, items };
}

export async function projects(service: RendererService): Promise<ProjectListResult> {
  const capture = await collect<ProjectSummary, ProjectListResult>('projects', cursor =>
    service.query({ session: null, request: { command: 'project_list', params: { cursor, limit } } }),
  result => result.projects, result => result.counts, item => item.project_id);
  return { ...capture.first, projects: { ...capture.first.projects, items: capture.items, next_cursor: null } };
}

export async function sessions(service: RendererService, projectId: string | null): Promise<SessionListResult> {
  const capture = await collect<SessionSummary, SessionListResult>('sessions', async cursor => {
    const result = await service.query({ session: null, request: { command: 'session_list',
      params: { project_id: projectId, state: null, cursor, limit } } });
    if (projectId !== null && result.sessions.items.some(item => item.project_id !== projectId)) {
      throw new ServiceFailure('invalid_response');
    }
    return result;
  }, result => result.sessions,
  result => [result.active_total, result.closed_total, result.counts], item => JSON.stringify([item.project_id, item.session_id]));
  return { ...capture.first, sessions: { ...capture.first.sessions, items: capture.items, next_cursor: null } };
}
