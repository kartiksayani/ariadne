// Strings and colours of the Projects, Project, All sessions and Archive pages,
// ported from Ariadne.dc.html (runOf, sessCard, group, projCards: 1605-1680;
// projectVals: 1727-1775) and built from catalogue summaries and session snapshots.
import type { Immutable } from '../../data/session-store';
import type { ContinuePreview, SessionRef } from '../../generated/core';
import type { Item, ItemStatus, ProjectSummary, Session, SessionSummary, Topic } from '../../generated/domain/models';
import { agentName, clock, sessionRange, sessionWhen } from '../shell/model';

export type VisualStatus = 'open' | 'waiting' | 'progress' | 'decided' | 'done' | 'dropped' | 'replaced';
export const ICON: Readonly<Record<VisualStatus, string>> = {
  open: 'ph ph-circle', waiting: 'ph-fill ph-question', progress: 'ph ph-circle-half', decided: 'ph ph-check-circle',
  done: 'ph-fill ph-check-circle', dropped: 'ph ph-x-circle', replaced: 'ph ph-arrow-circle-right',
};
export const STATUS_LABEL: Readonly<Record<VisualStatus, string>> = {
  open: 'Open', waiting: 'Waiting on me', progress: 'In progress', decided: 'Decided', done: 'Done', dropped: 'Dropped', replaced: 'Replaced',
};
export const visualStatus = (status: ItemStatus): VisualStatus => status === 'waiting_on_me' ? 'waiting' : status === 'in_progress' ? 'progress' : status;
const closedStatuses = new Set<ItemStatus>(['decided', 'done', 'dropped', 'replaced']);

export const neutral = (percent: number) => `color-mix(in srgb, var(--color-text) ${percent}%, transparent)`;
const accentMix = (percent: number) => `color-mix(in srgb, var(--color-accent) ${percent}%, transparent)`;
export const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
export const sessionKey = (route: Immutable<SessionRef>) => JSON.stringify([route.project_id, route.session_id]);
export const routeOf = (summary: Immutable<SessionSummary>): SessionRef => ({ project_id: summary.project_id, session_id: summary.session_id });
export const projectName = (project: Immutable<ProjectSummary> | null | undefined) => project?.project?.display_name ?? 'Unavailable project';

const startOfDay = (at: number) => { const date = new Date(at); return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(); };
const daysBefore = (at: number, now: number) => Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);

/** "today", "yesterday", "3 days ago", "last week", else "3 Oct". */
export function relativeDay(at: number, now: number): string {
  const days = daysBefore(at, now);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  return new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** A project's last activity: "today 15:04", "yesterday 16:40", "3 days ago", "last week". */
export function lastActivity(at: number, now: number): string {
  const day = relativeDay(at, now);
  return day === 'today' || day === 'yesterday' ? `${day} ${clock(at)}` : day;
}

/** The agent of a session is running: active in Ariadne and its binding is connected. */
export const isRunning = (session: Immutable<SessionSummary>) => session.state === 'active' && session.active_binding?.connection_state === 'connected';
export const agentOf = (session: Immutable<SessionSummary>) => session.active_binding ? agentName(session.active_binding.adapter_id) : 'No agent';

export interface Run { readonly run: string; readonly runColor: string; readonly runDot: string; readonly runRing: string }
export function runOf(running: boolean): Run {
  return { run: running ? 'Agent running' : 'Agent not running', runColor: running ? 'var(--st-done)' : neutral(60),
    runDot: running ? 'var(--st-done)' : 'transparent', runRing: running ? 'none' : `inset 0 0 0 1.5px ${neutral(50)}` };
}

export interface ProjectCardModel {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly sessionsText: string;
  readonly runText: string;
  readonly runColor: string;
  readonly runDot: string;
  readonly runRing: string;
  readonly waitText: string;
  readonly waitColor: string;
  readonly last: string;
  readonly agents: readonly string[];
  readonly ring: string;
}

export function projectCard(project: Immutable<ProjectSummary>, sessions: readonly Immutable<SessionSummary>[], now: number): ProjectCardModel {
  const own = sessions.filter(session => session.project_id === project.project_id);
  const active = own.filter(session => session.state !== 'closed').length, closed = own.length - active, running = own.filter(isRunning).length;
  const wait = project.counts.waiting_unanswered;
  const latest = Math.max(...own.map(session => Date.parse(session.updated_at)));
  return {
    id: project.project_id, name: projectName(project), path: project.canonical_root,
    sessionsText: `${active} active · ${closed} closed`,
    runText: running ? `${running} agent${running > 1 ? 's' : ''} running` : 'No agent running',
    runColor: running ? 'var(--st-done)' : neutral(60), runDot: running ? 'var(--st-done)' : 'transparent', runRing: running ? 'none' : `inset 0 0 0 1.5px ${neutral(50)}`,
    waitText: wait ? `${wait} waiting on you` : 'Nothing waiting', waitColor: wait ? 'var(--a-acc-text)' : neutral(60),
    last: `Last activity ${Number.isFinite(latest) ? lastActivity(latest, now) : '—'}`,
    agents: [...new Set(own.filter(session => session.active_binding).map(agentOf))],
    ring: `${wait ? `0 0 0 1px ${accentMix(45)}` : '0 0 0 1px var(--color-divider)'}, var(--a-lift)`,
  };
}

/** Topics continued from or into another session, by `${session}:${topic}`. */
export function continuationLinks(sessions: readonly Immutable<Session>[]): { readonly movedOn: ReadonlySet<string>; readonly shared: ReadonlySet<string> } {
  const movedOn = new Set<string>(), shared = new Set<string>();
  for (const session of sessions) {
    for (const topic of Object.values(session.topics)) {
      const origin = topic?.origin;
      if (!topic || !origin || origin.session_id === session.id) continue;
      movedOn.add(`${origin.session_id}:${origin.topic_id}`);
      shared.add(`${origin.session_id}:${origin.topic_id}`);
      shared.add(`${session.id}:${topic.id}`);
    }
  }
  return { movedOn, shared };
}

const topicItems = (session: Immutable<Session>, topicId: string) => Object.values(session.items).filter((item): item is Immutable<Item> => !!item && item.topic_id === topicId);
export const sortedTopics = (session: Immutable<Session>) => Object.values(session.topics).filter((topic): topic is Immutable<Topic> => !!topic).sort((a, b) => a.order - b.order);

export interface TopicChip { readonly id: string; readonly name: string; readonly counts: string; readonly icon: string; readonly color: string }
export function topicChips(session: Immutable<Session>, movedOn: ReadonlySet<string>): TopicChip[] {
  return sortedTopics(session).map(topic => {
    const items = topicItems(session, topic.id), moved = movedOn.has(`${session.id}:${topic.id}`);
    const waiting = items.filter(item => item.status === 'waiting_on_me').length;
    const open = items.filter(item => item.status === 'open' || item.status === 'in_progress').length;
    const closed = items.filter(item => closedStatuses.has(item.status)).length;
    const counts = topic.archived_at !== null ? 'archived' : moved ? 'continued later'
      : [waiting && `${waiting} waiting`, open && `${open} open`, closed && `${closed} closed`].filter(Boolean).join(' · ');
    return { id: topic.id, name: topic.name, counts, icon: topic.archived_at !== null ? 'ph ph-archive' : moved ? 'ph ph-arrow-bend-down-right' : 'ph ph-folder-simple',
      color: topic.archived_at !== null ? neutral(64) : 'var(--color-text)' };
  });
}

export interface SessionCardText extends Run {
  readonly agent: string;
  readonly title: string;
  readonly meta: string;
  readonly titleColor: string;
  readonly background: string;
  readonly closed: boolean;
}
export function sessionCardText(summary: Immutable<SessionSummary>, snapshot: Immutable<Session> | null, now: number, where: string | null = null): SessionCardText {
  const closed = summary.state === 'closed', running = isRunning(summary), agent = agentOf(summary);
  const range = sessionRange(Date.parse(summary.created_at), Date.parse(summary.closed_at ?? summary.updated_at), running, now);
  const messages = snapshot ? ` · ${plural(snapshot.messages.length, 'message')}` : '';
  return { ...runOf(running), agent, closed, title: where ? `${agent} · ${where}` : agent, meta: `${range}${messages}${closed ? ' · read-only' : ''}`,
    titleColor: closed ? neutral(74) : 'var(--color-text)', background: closed ? 'transparent' : 'var(--a-card)' };
}

export interface ArchivedTopic {
  readonly source: SessionRef;
  readonly topic: Immutable<Topic>;
  readonly name: string;
  readonly meta: string;
  readonly lines: readonly { readonly id: string; readonly status: VisualStatus; readonly text: string }[];
  readonly more: string | null;
  readonly items: number;
  readonly waiting: number;
  readonly sourceAgent: string;
  readonly sourceRunning: boolean;
  readonly sourceClosed: boolean;
}

const partOrder: readonly [ItemStatus, string][] = [['decided', 'decided'], ['done', 'done'], ['dropped', 'dropped'], ['replaced', 'replaced'], ['open', 'open'], ['waiting_on_me', 'waiting on you']];
const byId = (a: Immutable<Item>, b: Immutable<Item>) => a.id.localeCompare(b.id, undefined, { numeric: true });

/** Every archived topic of the project's sessions, newest archive first. */
export function archivedTopics(summaries: readonly Immutable<SessionSummary>[], snapshots: ReadonlyMap<string, Immutable<Session>>, query: string, now: number): ArchivedTopic[] {
  const needle = query.trim().toLowerCase();
  return summaries.flatMap(summary => {
    const session = snapshots.get(sessionKey(summary));
    if (!session) return [];
    const from = `${agentOf(summary)} · ${sessionWhen(Date.parse(summary.created_at), now).toLowerCase()}`;
    return sortedTopics(session).filter(topic => topic.archived_at !== null).flatMap(topic => {
      const items = topicItems(session, topic.id).sort(byId);
      if (needle && !`${topic.name} ${items.map(item => `${item.question} ${item.outcome ?? ''}`).join(' ')}`.toLowerCase().includes(needle)) return [];
      const parts = partOrder.map(([status, word]) => { const count = items.filter(item => item.status === status).length; return count ? `${count} ${word}` : ''; })
        .filter(Boolean).join(' · ');
      return [{ source: routeOf(summary), topic, name: topic.name,
        meta: `From ${from} · archived ${relativeDay(Date.parse(topic.archived_at!), now)}${parts ? ` · ${parts}` : ''}`,
        lines: items.slice(0, 3).map(item => ({ id: item.id, status: visualStatus(item.status), text: item.outcome || item.question })),
        more: items.length > 3 ? `and ${items.length - 3} more` : null, items: items.length,
        waiting: items.filter(item => item.status === 'waiting_on_me').length,
        sourceAgent: agentOf(summary), sourceRunning: isRunning(summary), sourceClosed: summary.state === 'closed' }];
    });
  }).sort((a, b) => Date.parse(b.topic.archived_at!) - Date.parse(a.topic.archived_at!));
}

export interface ContinueGroup { readonly title: string; readonly icon: string; readonly color: string; readonly lines: readonly { readonly id: string; readonly text: string }[] }
/** The four groups of the Continue dialog (Ariadne.dc.html:1745-1760), from the preview's mapping. */
export function continueGroups(source: Immutable<Session>, preview: Immutable<ContinuePreview>): ContinueGroup[] {
  const items = preview.mapping.flatMap(mapping => { const item = source.items[mapping.source_item_id]; return item && item.topic_id === preview.source_topic_id ? [item] : []; });
  const group = (title: string, status: VisualStatus, statuses: readonly ItemStatus[], text: (item: Immutable<Item>) => string): ContinueGroup | null => {
    const list = items.filter(item => statuses.includes(item.status));
    return list.length ? { title: `${title} · ${list.length}`, icon: ICON[status], color: `var(--st-${status})`, lines: list.map(item => ({ id: item.id, text: text(item) })) } : null;
  };
  return [
    group('Waiting on you', 'waiting', ['waiting_on_me'], item => item.question),
    group('Open or in progress', 'open', ['open', 'in_progress'], item => item.question),
    group('Decided or done', 'decided', ['decided', 'done'], item => item.outcome || item.question),
    group('Dropped or replaced', 'dropped', ['dropped', 'replaced'], item => item.outcome || item.question),
  ].filter((value): value is ContinueGroup => !!value);
}

/** Session counts for the Remove dialog of a session (README, Remove). */
export function sessionRemoval(session: Immutable<Session> | null, shared: ReadonlySet<string>) {
  if (!session) return { topics: 0, items: 0, shared: 0, waiting: 0 };
  const topics = sortedTopics(session), own = topics.filter(topic => !shared.has(`${session.id}:${topic.id}`));
  const ownIds = new Set(own.map(topic => topic.id));
  const items = Object.values(session.items).filter(item => item && ownIds.has(item.topic_id));
  return { topics: own.length, items: items.length, shared: topics.length - own.length, waiting: items.filter(item => item?.status === 'waiting_on_me').length };
}

/** Project counts for the Remove dialog of a project. */
export function projectRemoval(sessions: readonly Immutable<Session>[]) {
  const items = sessions.flatMap(session => Object.values(session.items).filter(item => !!item));
  return { topics: sessions.reduce((sum, session) => sum + Object.keys(session.topics).length, 0), items: items.length,
    waiting: items.filter(item => item?.status === 'waiting_on_me').length };
}
