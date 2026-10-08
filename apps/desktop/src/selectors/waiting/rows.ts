import type { Input, Item, ProjectSummary, Session, SessionSummary } from '../../generated/domain/models';
import type { ItemRoute, SessionRef } from '../../generated/core';
import type { Immutable } from '../../data';
import { ownerReplied } from './replied';

export interface WaitingSession {
  readonly summary: Immutable<SessionSummary>;
  readonly project: Immutable<ProjectSummary>;
  readonly session: Immutable<Session>;
}
export interface WaitingRow {
  readonly id: string;
  readonly route: Immutable<ItemRoute>;
  readonly projectLabel: string;
  readonly sessionLabel: string;
  readonly item: Immutable<Item>;
  readonly askedMessageNumber: number;
}
export interface SentRow {
  readonly id: string;
  readonly session: Immutable<SessionRef>;
  readonly route: Immutable<ItemRoute> | null;
  readonly projectLabel: string;
  readonly sessionLabel: string;
  readonly input: Immutable<Input>;
  readonly currentItem: Immutable<Item> | null;
  readonly changedQuestion: boolean;
}

// Select rows from canonical facts. Totals remain the backend SummaryCounts,
// including partial/unavailable metadata; visible rows never replace them.
// A question the owner already replied to waits on the agent, not on the owner.
const unanswered = (session: Immutable<Session>, item: Immutable<Item>) => item.status === 'waiting_on_me' && !ownerReplied(session, item);
function itemOrder(left: string, right: string): number {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
export function waitingRows(sessions: readonly WaitingSession[]): readonly WaitingRow[] {
  const rows: WaitingRow[] = [];
  for (const { project, summary, session } of sessions) {
    for (const item of Object.values(session.items)) {
      if (!item || session.topics[item.topic_id]?.archived_at !== null || !unanswered(session, item)) continue;
      const round = item.current_round_id ? session.rounds[item.current_round_id] : undefined;
      const message = session.messages.find(message => message.id === (round?.opened_message_id ?? item.created_message_id));
      if (!item.waiting_since || !message) throw new Error('Waiting episode provenance is unavailable.');
      rows.push(Object.freeze({ id: `${session.id}:${item.id}:${item.question_revision}`,
        route: Object.freeze({ project_id: session.project_id, session_id: session.id, item_id: item.id }),
        projectLabel: project.project?.display_name ?? 'Unavailable project', sessionLabel: summary.title,
        item, askedMessageNumber: message.number }));
    }
  }
  rows.sort((a, b) => a.item.waiting_since!.localeCompare(b.item.waiting_since!)
    || a.route.project_id.localeCompare(b.route.project_id) || a.route.session_id.localeCompare(b.route.session_id)
    || itemOrder(a.item.id, b.item.id));
  return Object.freeze(rows);
}
export function sentRows(sessions: readonly WaitingSession[]): readonly SentRow[] {
  const rows: SentRow[] = [];
  for (const { project, summary, session } of sessions) {
    for (const input of Object.values(session.inputs)) {
      if (!input || !['queued', 'in_flight', 'needs_attention'].includes(input.state)) continue;
      const item = input.target.item_id ? session.items[input.target.item_id] ?? null : null;
      rows.push(Object.freeze({ id: input.id,
        session: Object.freeze({ project_id: session.project_id, session_id: session.id }),
        route: input.target.item_id ? Object.freeze({ project_id: session.project_id, session_id: session.id, item_id: input.target.item_id }) : null,
        projectLabel: project.project?.display_name ?? 'Unavailable project', sessionLabel: summary.title, input,
        currentItem: item, changedQuestion: !!item && input.payload.target_snapshot.question_revision !== null
          && item.question_revision !== input.payload.target_snapshot.question_revision }));
    }
  }
  rows.sort((a, b) => a.input.created_at.localeCompare(b.input.created_at)
    || a.session.project_id.localeCompare(b.session.project_id) || a.session.session_id.localeCompare(b.session.session_id)
    || a.input.seq - b.input.seq);
  return Object.freeze(rows);
}
