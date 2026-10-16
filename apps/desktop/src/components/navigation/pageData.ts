// The pages' rows and cards (contract C8 page-types) from the catalogue: sessions, projects and archived topics.
import type { Immutable } from '../../data/session-store';
import type { SessionRef } from '../../generated/core';
import type { ProjectSummary, SessionSummary } from '../../generated/domain/models';
import type { ArchiveRowData, PageSession, ProjectCardData, SessionGroupData } from '../../ui/pages/page-types';
import { isRunning, lastActivity, projectName, relativeDay, routeOf, sessionKey, type ArchivedTopic } from '../../ui/pages/model';
import { ownerName } from '../../ui/shell/model';
import { agentProduct } from '../../state/navigation/switcher';

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const closedOf = (summary: Immutable<SessionSummary>) => summary.archived_at != null || summary.state === 'closed';
export const sessionName = (summary: Immutable<SessionSummary>) => ownerName(summary) ?? summary.title;
const agentWord = (summary: Immutable<SessionSummary>) => summary.active_binding ? agentProduct(summary.active_binding.adapter_id) : 'No agent';

/** A session row of a page: "Live · iTerm window 1", "Not running · 1 queued", "Closed yesterday 18:05". */
export function pageSession(summary: Immutable<SessionSummary>, now: number, current: SessionRef | null | undefined): PageSession<SessionRef> {
  const closed = closedOf(summary), live = !closed && isRunning(summary);
  const queued = summary.counts.sent_inputs.queued, where = summary.active_binding?.host_location;
  const status = closed ? `Closed ${lastActivity(Date.parse(summary.closed_at ?? summary.updated_at), now)}`
    : live ? `Live${where ? ` · ${where}` : ''}` : `Not running${queued ? ` · ${queued} queued` : ''}`;
  return { route: routeOf(summary), id: summary.session_id, name: sessionName(summary), agent: agentWord(summary), run: closed ? 'closed' : live ? 'live' : 'off',
    waiting: closed ? 0 : summary.counts.waiting_unanswered, current: !!current && sessionKey(current) === sessionKey(summary), status };
}

const byRecent = (a: Immutable<SessionSummary>, b: Immutable<SessionSummary>) => Date.parse(b.updated_at) - Date.parse(a.updated_at);
const lastArchivedOf = (own: readonly Immutable<SessionSummary>[]) => own.filter(summary => summary.archived_at != null)
  .sort((a, b) => Date.parse(b.archived_at!) - Date.parse(a.archived_at!))[0];

/** A project card: its unarchived sessions, newest first, and "3 sessions · 2 open · last activity 21:25". */
export function projectCardData(project: Immutable<ProjectSummary>, sessions: readonly Immutable<SessionSummary>[], now: number,
  current: SessionRef | null | undefined): ProjectCardData<SessionRef> {
  const all = sessions.filter(summary => summary.project_id === project.project_id);
  const own = all.filter(summary => summary.archived_at == null).sort(byRecent);
  // Archived sessions count for last activity only when nothing else is left.
  const latest = Math.max(...(own.length ? own : all).map(summary => Date.parse(summary.updated_at)));
  const last = Number.isFinite(latest) ? lastActivity(latest, now) : null;
  const archived = own.length === 0 ? lastArchivedOf(all) : undefined;
  return {
    id: project.project_id, name: projectName(project), path: project.canonical_root, current: current?.project_id === project.project_id,
    waiting: own.reduce((sum, summary) => sum + (closedOf(summary) ? 0 : summary.counts.waiting_unanswered), 0),
    sessions: own.map(summary => pageSession(summary, now, current)),
    footer: own.length ? `${plural(own.length, 'session')} · ${own.filter(summary => !closedOf(summary)).length} open${last ? ` · last activity ${last}` : ''}`
      : last ? `Last activity ${last}` : 'No activity yet',
    emptyText: own.length ? undefined : `No sessions.${archived ? ` Its last one, “${sessionName(archived)}”, is in Archive.` : ''}`,
  };
}

export type SessionsTabValue = 'open' | 'closed' | 'all';
export const inTab = (summary: Immutable<SessionSummary>, tab: SessionsTabValue) => summary.archived_at == null
  && (tab === 'all' || (tab === 'closed') === (summary.state === 'closed'));

/** All sessions (or one project's): a group per project with the sessions the tab shows. */
export function sessionGroups(projects: readonly Immutable<ProjectSummary>[], sessions: readonly Immutable<SessionSummary>[], tab: SessionsTabValue,
  now: number, current: SessionRef | null | undefined, single: boolean, onOpenArchive?: () => void): SessionGroupData<SessionRef>[] {
  return projects.flatMap(project => {
    const all = sessions.filter(summary => summary.project_id === project.project_id);
    const shown = all.filter(summary => inTab(summary, tab)).sort(byRecent);
    if (!single && shown.length === 0) return [];
    const archived = lastArchivedOf(all), name = projectName(project);
    const empty = all.some(summary => summary.archived_at == null)
      ? { title: `No ${tab === 'all' ? '' : `${tab} `}sessions`, text: `Nothing ${tab === 'closed' ? 'closed' : 'open'} in ${name} right now.` }
      : { title: `No sessions in ${name}`, text: `Start Claude Code or Codex in ${project.canonical_root} and run /ariadne-connect; the session shows up here.${archived ? ` Its last one, “${sessionName(archived)}”, is in Archive.` : ''}`,
        action: archived && onOpenArchive ? { label: 'Open Archive', onClick: onOpenArchive } : undefined };
    return [{ id: project.project_id, name, path: project.canonical_root, sessions: shown.map(summary => pageSession(summary, now, current)), empty }];
  });
}

/** An archived session's row: "notes-api · Claude Code · 4 topics", "Archived 3 Oct". */
export function archivedSessionRow(summary: Immutable<SessionSummary>, project: Immutable<ProjectSummary> | undefined, now: number): ArchiveRowData {
  return { id: sessionKey(summary), kind: 'session', name: sessionName(summary),
    sub: [projectName(project), agentWord(summary), plural(summary.topic_count, 'topic')].join(' · '),
    when: `Archived ${relativeDay(Date.parse(summary.archived_at!), now)}` };
}

/** An archived topic's row: "From “cache PR review” · 6 items". */
export function archivedTopicRow(topic: ArchivedTopic, source: Immutable<SessionSummary> | undefined, now: number): ArchiveRowData {
  return { id: `${sessionKey(topic.source)}:${topic.topic.id}`, kind: 'topic', name: topic.name,
    sub: `From “${source ? sessionName(source) : 'an earlier session'}” · ${plural(topic.items, 'item')}`,
    when: `Archived ${relativeDay(Date.parse(topic.topic.archived_at!), now)}` };
}
