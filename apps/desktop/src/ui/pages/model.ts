import { activeItems, activeTopics, itemRemoved } from '../../selectors/removed';
// Words of the pages built from catalogue summaries and session snapshots: relative days, archived topics, the
// Continue dialog's groups and the Remove dialog's counts.
import type { Immutable } from '../../data/session-store';
import type { SessionRef } from '../../generated/core';
import type { Item, ItemStatus, ProjectSummary, Session, SessionSummary, Topic } from '../../generated/domain/models';
import { agentName, clock, ownerName, sessionWhen, shortDate } from '../shell/model';
import { agentRunning, connectionOf } from '../shared/connection';
import { unsentOf } from '../remove/model';
import { sessionEnded, waitingOnOwner } from '../../selectors/sessionClosed';

export type VisualStatus = 'open' | 'waiting' | 'progress' | 'decided' | 'done' | 'dropped' | 'replaced';
export const ICON: Readonly<Record<VisualStatus, string>> = {
  open: 'ph ph-circle', waiting: 'ph-fill ph-question', progress: 'ph ph-circle-half', decided: 'ph ph-check-circle',
  done: 'ph-fill ph-check-circle', dropped: 'ph ph-x-circle', replaced: 'ph ph-arrows-clockwise',
};
export const visualStatus = (status: ItemStatus): VisualStatus => status === 'waiting_on_me' ? 'waiting' : status === 'in_progress' ? 'progress' : status;

export const neutral = (percent: number) => `color-mix(in srgb, var(--color-text) ${percent}%, transparent)`;
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
  return shortDate(at);
}

/** When something last happened, as the pages write it (SPEC 14.1–14.3): "today 15:04", "yesterday 16:40", "3 Oct". */
export function lastActivity(at: number, now: number): string {
  const day = relativeDay(at, now);
  return day === 'today' || day === 'yesterday' ? `${day} ${clock(at)}` : shortDate(at);
}

/** The agent of a session is running: active in Ariadne and its binding connected or reconnecting (ui/shared/connection). */
export const isRunning = (session: Immutable<SessionSummary>) => session.archived_at == null && session.state === 'active' && agentRunning(connectionOf(session.active_binding));
export const agentOf = (session: Immutable<SessionSummary>) => session.active_binding ? agentName(session.active_binding.adapter_id) : 'No agent';

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

const topicItems = (session: Immutable<Session>, topicId: string) => activeItems(session).filter(item => item.topic_id === topicId);
export const sortedTopics = (session: Immutable<Session>) => [...activeTopics(session)].sort((a, b) => a.order - b.order);

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
    const from = `${ownerName(summary) ? `“${ownerName(summary)}”` : agentOf(summary)} · ${sessionWhen(Date.parse(summary.created_at), now).toLowerCase()}`;
    return sortedTopics(session).filter(topic => topic.archived_at !== null).flatMap(topic => {
      const items = topicItems(session, topic.id).sort(byId);
      if (needle && !`${topic.name} ${items.map(item => `${item.question} ${item.outcome ?? ''}`).join(' ')}`.toLowerCase().includes(needle)) return [];
      const parts = partOrder.map(([status, word]) => { const count = status === 'waiting_on_me' && sessionEnded(session) ? 0 : items.filter(item => item.status === status).length; return count ? `${count} ${word}` : ''; })
        .filter(Boolean).join(' · ');
      return [{ source: routeOf(summary), topic, name: topic.name,
        meta: `From ${from} · archived ${relativeDay(Date.parse(topic.archived_at!), now)}${parts ? ` · ${parts}` : ''}`,
        lines: items.slice(0, 3).map(item => ({ id: item.id, status: visualStatus(item.status), text: item.outcome || item.question })),
        more: items.length > 3 ? `and ${items.length - 3} more` : null, items: items.length,
        waiting: items.filter(item => waitingOnOwner(session, item)).length,
        sourceAgent: agentOf(summary), sourceRunning: isRunning(summary), sourceClosed: summary.state === 'closed' }];
    });
  }).sort((a, b) => Date.parse(b.topic.archived_at!) - Date.parse(a.topic.archived_at!));
}

/** Session counts for the Remove dialog of a session (README, Remove). */
export function sessionRemoval(session: Immutable<Session> | null, shared: ReadonlySet<string>) {
  if (!session) return { topics: 0, items: 0, shared: 0, waiting: 0 };
  const topics = Object.values(session.topics).filter((topic): topic is Immutable<Topic> => !!topic), own = topics.filter(topic => !shared.has(`${session.id}:${topic.id}`));
  const ownIds = new Set(own.map(topic => topic.id));
  const items = Object.values(session.items).filter((item): item is Immutable<Item> => !!item && ownIds.has(item.topic_id));
  return { topics: own.length, items: items.length, shared: topics.length - own.length, waiting: items.filter(item => waitingOnOwner(session, item) && !itemRemoved(session, item.id)).length,
    unsent: unsentOf([session]) };
}

/** Project counts for the Remove dialog of a project. */
export function projectRemoval(sessions: readonly Immutable<Session>[]) {
  const items = sessions.flatMap(session => Object.values(session.items).filter((item): item is Immutable<Item> => !!item));
  return { topics: sessions.reduce((sum, session) => sum + Object.keys(session.topics).length, 0), items: items.length,
    waiting: sessions.reduce((count, session) => count + activeItems(session).filter(item => waitingOnOwner(session, item)).length, 0), unsent: unsentOf(sessions) };
}
