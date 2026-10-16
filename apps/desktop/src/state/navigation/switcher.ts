// C7: the session and project switcher's data (SPEC §5.13, §6.5), and where each waiting question shows.
// It reads the waiting capture (WaitingStore), which already holds every unarchived session of every project
// with its snapshot, so opening the switcher reads nothing more. Archived sessions belong to the Archive page.
import type { NavigationSelection, SessionRef } from '../../generated/core';
import type { ProjectSummary } from '../../generated/domain/models';
import type { Immutable } from '../../data';
import type { WaitingRow, WaitingSession } from '../../selectors/waiting/rows';
import { agentRunning, connectionOf } from '../../ui/shared/connection';
import { shortDate } from '../../ui/shell/model';
import type { SessionRoute } from './view';

export const sameSession = (a: SessionRef | null | undefined, b: SessionRef | null | undefined) =>
  !!a && !!b && a.project_id === b.project_id && a.session_id === b.session_id;

/** Legacy tab fields remain on disk for previous-release readers; the newest-opened one stands in for "last". */
export function lastSessionFrom(selection: NavigationSelection, views: readonly { readonly session: SessionRef; readonly tab_order: number }[]): SessionRef | null {
  return selection.kind === 'session' ? selection.session : [...views].sort((a, b) => b.tab_order - a.tab_order)[0]?.session ?? null;
}

/** The product name of an agent, as the board writes it: "Claude Code", "Codex". */
export function agentProduct(adapterId: string): string {
  if (adapterId === 'claude_code_mod' || adapterId === 'claude-code') return 'Claude Code';
  if (adapterId === 'codex') return 'Codex';
  return adapterId;
}

/** How long a question has waited, as the switcher writes it: "4 min", "2 h", "yesterday", "3 Oct". */
export function waitedFor(at: number, now: number): string {
  const minutes = Math.max(1, Math.floor((now - at) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h`;
  const days = Math.floor(minutes / (24 * 60));
  return days === 1 ? 'yesterday' : shortDate(at);
}

const closedWhen = (at: number, now: number) => {
  const days = Math.floor((now - at) / 86_400_000);
  return days < 1 ? 'today' : days === 1 ? 'yesterday' : shortDate(at);
};

export interface SwitcherQuestion { readonly itemId: string; readonly title: string; readonly since?: string }
export interface SwitcherSessionData {
  readonly route: SessionRoute;
  readonly name: string;
  readonly agent?: string;
  readonly running: boolean;
  readonly closed?: boolean;
  readonly closedWhen?: string;
  readonly current?: boolean;
  /** Unsent questions waiting on the owner in this session, oldest first. */
  readonly waiting: readonly SwitcherQuestion[];
}
export interface SwitcherProjectData {
  readonly id: string;
  readonly name: string;
  /** The project of the session on screen (or the one a page returns to): listed first. */
  readonly current?: boolean;
  readonly sessions: readonly SwitcherSessionData[];
}
export interface SwitcherData {
  readonly current?: SessionRoute;
  readonly projects: readonly SwitcherProjectData[];
  /** Questions waiting on the owner in every other session: the chip on the switcher button. */
  readonly otherWaitingCount: number;
  /** Questions waiting in the current session: the dock line, or the page chip on a page. */
  readonly thisWaitingCount: number;
}

export interface SwitcherInput {
  /** Registered projects, without those whose removal is pending. */
  readonly projects: readonly Immutable<ProjectSummary>[];
  readonly sessions: readonly WaitingSession[];
  readonly waiting: readonly WaitingRow[];
  readonly current: SessionRoute | null;
  readonly now: number;
  /** A session whose removal is pending stays out of the list. */
  readonly hiddenSession?: (route: SessionRoute) => boolean;
}

export function switcherData({ projects, sessions, waiting, current, now, hiddenSession = () => false }: SwitcherInput): SwitcherData {
  const listed = sessions.filter(({ summary }) => summary.archived_at == null && !hiddenSession(summary));
  const byProject = [...projects].sort((a, b) => Number(b.project_id === current?.project_id) - Number(a.project_id === current?.project_id));
  const rows = (route: SessionRef) => waiting.filter(row => sameSession(row.route, route));
  const counted = waiting.filter(row => listed.some(({ summary }) => sameSession(summary, row.route)) || sameSession(row.route, current));
  const thisWaitingCount = counted.filter(row => sameSession(row.route, current)).length;
  return {
    current: current ?? undefined,
    otherWaitingCount: counted.length - thisWaitingCount,
    thisWaitingCount,
    projects: byProject.map(project => ({
      id: project.project_id,
      name: project.project?.display_name ?? 'Unavailable project',
      current: project.project_id === current?.project_id,
      sessions: listed.filter(({ summary }) => summary.project_id === project.project_id)
        .sort((a, b) => Number(sameSession(b.summary, current)) - Number(sameSession(a.summary, current)) || b.summary.updated_at.localeCompare(a.summary.updated_at))
        .map(({ summary }) => {
          const route = { project_id: summary.project_id, session_id: summary.session_id };
          const closed = summary.state === 'closed';
          return {
            route, name: summary.name?.trim() || summary.title,
            agent: summary.active_binding ? agentProduct(summary.active_binding.adapter_id) : undefined,
            running: !closed && agentRunning(connectionOf(summary.active_binding)),
            closed, closedWhen: closed && summary.closed_at ? closedWhen(Date.parse(summary.closed_at), now) : undefined,
            current: sameSession(route, current),
            waiting: rows(route).map(row => ({ itemId: row.route.item_id, title: row.item.question,
              since: row.item.waiting_since ? waitedFor(Date.parse(row.item.waiting_since), now) : undefined })),
          };
        }),
    })),
  };
}
