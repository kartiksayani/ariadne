// Waiting column view model (handoff Ariadne.dc.html renderVals: `waiting`,
// `sent`, `pathText`, `lastOf`, `deliveryOf`). Pure: the column passes the
// captured queue, the answer drafts and the clock.
import type { ItemRoute, SessionRef } from '../../generated/core';
import type { Input, Item, PresenceObservation, Session } from '../../generated/domain/models';
import type { Immutable } from '../../data/session-store';
import type { SupervisorHealth } from '../../data/service';
import { deliveryEvidence } from '../../selectors/waiting/delivery';
import { counted, stuckInput, type Stuck } from '../../selectors/waiting/stuck';
import type { WaitingSession } from '../../selectors/waiting/rows';
import type { WaitingState } from '../../selectors/waiting/store';
import type { DraftEntry } from '../../state/drafts/store';
import { deliveryLine, deliveryStage, draftStage, quote, type DeliveryLine, type DeliveryStage } from '../answer/delivery';
import { agentName, dayWord, ownerName } from '../shell/model';
import { connectionOf } from '../shared/connection';
import { shortLabel } from '../shared/short';

/** How the card's Retry resolves: prepare a revised draft of a rejected save, or open the item's recovery review. */
export type RetryKind = 'revise' | 'recovery';
export interface CardDelivery extends DeliveryLine { readonly retry: RetryKind | null }

export interface WaitingCardModel {
  readonly id: string;
  readonly route: ItemRoute;
  readonly session: Immutable<Session>;
  readonly item: Immutable<Item>;
  /** The option of a failed input still awaiting recovery; the card shows it chosen. */
  readonly chosen: string | null;
  readonly path: string;
  readonly ask: string | null;
  readonly earlier: string | null;
  readonly last: string | null;
  /** "28 min", "1 h 4 min", "since yesterday". */
  readonly age: string;
  /** "#16", or "codex #19" for a session other than the current one. */
  readonly tag: string;
  readonly delivery: CardDelivery | null;
}
export interface SentRowModel {
  readonly id: string;
  readonly question: string;
  readonly line: DeliveryLine;
  /** The saved message, once the session has it; a send still being saved has none. */
  readonly input: Immutable<Input> | null;
  /** Why it hasn't reached the agent, with its fixes (ui/answer/StuckNote); replaces `line`. */
  readonly stuck: Stuck | null;
  /** What was sent, quoted from the saved message ("“Old choice”"); shown with `stuck`. */
  readonly what: string;
  readonly item: ItemRoute | null;
  readonly session: SessionRef;
}
export interface WaitingModel {
  readonly cards: readonly WaitingCardModel[];
  readonly sent: readonly SentRowModel[];
  /** The pill: "–" while loading or before any session exists. */
  readonly count: string;
  readonly emptyText: string;
}
export interface ModelInput {
  readonly state: WaitingState;
  /** The answer draft for an item, if any. */
  readonly draft: (route: ItemRoute) => DraftEntry | undefined;
  /** Live presence for a binding from the shared session cache. */
  readonly presence: (session: SessionRef, bindingId: string) => Immutable<PresenceObservation> | null;
  /** The desktop supervisor's health for a binding generation, when known. */
  readonly health?: (bindingId: string, generation: string | null | undefined) => SupervisorHealth | null;
  readonly now: number;
}

const key = (route: SessionRef) => `${route.project_id}:${route.session_id}`;
const binding = (session: Immutable<Session>, id: string | null) => id ? session.bindings[id] ?? null : null;
const running = (captured: WaitingSession) => captured.session.state === 'active'
  && binding(captured.session, captured.session.active_binding_id)?.connection_state === 'connected';
const agentOf = (session: Immutable<Session>, bindingId: string | null) => {
  const value = binding(session, bindingId ?? session.active_binding_id);
  return value ? agentName(value.adapter_id) : '';
};
/** What names an earlier session in a card: the owner's name for it, else its agent. */
const earlierName = (session: Immutable<Session>, bindingId: string | null) => ownerName(session) ?? agentOf(session, bindingId);

/** Minutes since `at`, as the card footer words it. */
export function waitingAge(at: number, now: number): string {
  const day = dayWord(at, now);
  if (day) return `since ${day === 'Yesterday' ? 'yesterday' : day}`;
  const minutes = Math.max(1, Math.floor((now - at) / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Project (when several), topic and ancestors; longer than four collapses to the first two, "…" and the last. */
export function pathText(session: Immutable<Session>, item: Immutable<Item>, project: string | null): string {
  const ancestors: string[] = [];
  for (let parent = item.parent ? session.items[item.parent] : undefined; parent; parent = parent.parent ? session.items[parent.parent] : undefined) ancestors.unshift(shortLabel(parent));
  const topic = session.topics[item.topic_id];
  let parts = [...(project ? [project] : []), topic ? shortLabel(topic) : '', ...ancestors];
  if (parts.length > 4) parts = [parts[0], parts[1], '…', parts[parts.length - 1]];
  return parts.join('  ›  ');
}

/** "Round 3 · last time you replied “…”" when the open round follows an answered one. */
export function lastRound(session: Immutable<Session>, item: Immutable<Item>): string | null {
  const rounds = Object.values(session.rounds).filter(round => !!round && round.item_id === item.id).sort((a, b) => a!.ordinal - b!.ordinal);
  // An answer whose message archive or close cancelled never reached the agent: it is not "last time you replied".
  const answerOf = (ids: readonly string[]) => session.answers.filter(answer => answer.item_id === item.id && ids.includes(answer.message_id)
    && session.messages.every(message => message.id !== answer.message_id || counted(session, message))).sort((a, b) => b.seq - a.seq)[0];
  if (rounds.length < 2 || answerOf(rounds.at(-1)!.owner_message_ids)) return null;
  for (const round of rounds.slice(0, -1).reverse()) {
    const answer = answerOf(round!.owner_message_ids);
    if (!answer) continue;
    const option = answer.options_snapshot.find(value => value.id === answer.selected_option_id);
    return `Round ${rounds.length} · last time you ${option ? 'chose' : 'replied'} ${quote(option?.label ?? answer.text)}`;
  }
  return null;
}

function askedNumber(session: Immutable<Session>, item: Immutable<Item>): number | null {
  const round = item.current_round_id ? session.rounds[item.current_round_id] : undefined;
  return session.messages.find(message => message.id === (round?.opened_message_id ?? item.created_message_id))?.number ?? null;
}
const inputLabel = (input: Immutable<Input>) => input.payload.target_snapshot.options.find(option => option.id === input.payload.selected_option_id)?.label ?? input.payload.text;
const draftLabel = (entry: DraftEntry, item: Immutable<Item>) => {
  const content = entry.sent ?? entry.draft;
  return item.options.find(option => option.id === content.selected_option_id)?.label ?? content.text;
};

export function waitingModel({ state, draft, presence, health, now }: ModelInput): WaitingModel {
  const sessions = new Map(state.sessions.map(captured => [key({ project_id: captured.session.project_id, session_id: captured.session.id }), captured]));
  const several = new Set(state.sessions.map(captured => captured.session.project_id)).size > 1;
  // The current session: the newest one whose agent is running. Messages of
  // other sessions carry their agent's name.
  const live = state.sessions.filter(running).sort((a, b) => b.session.created_at.localeCompare(a.session.created_at));
  const primary = live[0] ?? null;
  const cards: WaitingCardModel[] = [], sent: SentRowModel[] = [];
  const card = (captured: WaitingSession, item: Immutable<Item>, id: string, delivery: CardDelivery | null, chosen: string | null = null) => {
    const { session } = captured, route = { project_id: session.project_id, session_id: session.id, item_id: item.id };
    const number = askedNumber(session, item), mine = !primary || primary.session.id === session.id;
    const runningHere = live.find(value => value.session.project_id === session.project_id);
    const earlier = !running(captured) && runningHere && runningHere !== captured
      ? `Asked in ${ownerName(session) ? `the “${ownerName(session)}”` : `an earlier ${agentOf(session, item.recipient_binding_id)}`} session. Your answer goes to ${agentOf(runningHere.session, null)}, with this item’s context.` : null;
    cards.push({ id, route, session, item, chosen, path: pathText(session, item, several ? captured.project.project?.display_name ?? 'Unavailable project' : null),
      ask: delivery ? null : item.ask, earlier, last: lastRound(session, item),
      age: item.waiting_since ? waitingAge(Date.parse(item.waiting_since), now) : '',
      tag: number === null ? '' : mine ? `#${number}` : `${earlierName(session, item.recipient_binding_id)} #${number}`, delivery });
  };
  const pending = (stage: 'sending' | 'checking', entry: DraftEntry, item: Immutable<Item>, route: ItemRoute, session: Immutable<Session>) => sent.push({ id: entry.draft.op_id,
    question: item.question, line: deliveryLine(stage, 'answer', draftLabel(entry, item), agentOf(session, entry.draft.binding_id)),
    input: null, stuck: null, what: quote(draftLabel(entry, item)), item: route, session: { project_id: route.project_id, session_id: route.session_id } });
  for (const row of state.waiting) {
    const captured = sessions.get(key(row.route));
    if (!captured || captured.session.state !== 'active') continue;
    const entry = draft(row.route), stage = entry ? draftStage(entry) : null;
    // A receipt whose input is already captured belongs to an earlier episode.
    const stale = entry?.receipt?.data.kind === 'input_submit' && !!captured.session.inputs[entry.receipt.data.input_id];
    // Sending and Checking move the question to Sent (handoff 1l, 1m); the
    // item's detail offers the exact-operation retry of an unconfirmed save.
    if (entry && !stale && (stage === 'sending' || stage === 'checking')) { pending(stage, entry, row.item, row.route, captured.session); continue; }
    const delivery = entry && !stale && stage === 'failed'
      ? { ...deliveryLine(stage, 'answer', draftLabel(entry, row.item), agentOf(captured.session, entry.draft.binding_id)), retry: 'revise' as const } : null;
    card(captured, row.item, row.id, delivery);
  }
  const failed: { captured: WaitingSession; item: Immutable<Item>; input: Immutable<Input>; line: DeliveryLine }[] = [];
  for (const row of state.sent) {
    const captured = sessions.get(key(row.session));
    if (!captured) continue;
    const observed = presence(row.session, row.input.binding_id);
    const evidence = deliveryEvidence(row.input, captured.summary.active_binding, captured.session.operation_receipts, observed);
    const stage: DeliveryStage | null = deliveryStage(evidence.kind);
    if (!stage) continue;
    const line = deliveryLine(stage, row.input.kind, inputLabel(row.input), agentOf(captured.session, row.input.binding_id));
    const stuck = stuckInput(captured.session, row.input, observed,
      health?.(row.input.binding_id, captured.session.bindings[row.input.binding_id]?.generation) ?? null);
    if (stage === 'failed') {
      // A failed answer to the still-open question stays in Waiting with its
      // delivery line; other failed inputs stay in Sent, with Retry and Cancel.
      if (row.input.kind === 'answer' && row.currentItem?.status === 'waiting_on_me' && !row.changedQuestion && captured.session.state === 'active'
        && captured.session.topics[row.currentItem.topic_id]?.archived_at === null) { failed.push({ captured, item: row.currentItem, input: row.input, line }); continue; }
      if (!stuck) continue;
    }
    const target = row.input.payload.target_snapshot;
    sent.push({ id: row.id, question: target.item_question ?? target.topic_name, line, input: row.input, stuck, what: quote(inputLabel(row.input)),
      item: row.route ? { ...row.route } : null, session: { ...row.session } });
  }
  for (const { captured, item, input, line } of failed) {
    // The question is still the owner's (a failed answer reads Waiting on me),
    // so its card is already here: it carries the failed delivery and its fix.
    const at = cards.findIndex(value => value.route.session_id === captured.session.id && value.item.id === item.id);
    if (at >= 0) {
      const existing = cards[at]!;
      if (!existing.delivery) cards[at] = { ...existing, ask: null, chosen: input.payload.selected_option_id, delivery: { ...line, retry: 'recovery' } };
      continue;
    }
    card(captured, item, `${captured.session.id}:${item.id}:${input.id}`, { ...line, retry: 'recovery' }, input.payload.selected_option_id);
  }
  const order = (value: WaitingCardModel) => value.item.waiting_since ?? '';
  cards.sort((a, b) => order(a).localeCompare(order(b)));
  const loading = state.status === 'loading', first = !loading && state.status === 'ready' && state.sessions.length === 0;
  const reconnecting = state.sessions.some(captured => {
    const bound = binding(captured.session, captured.session.active_binding_id), route = { project_id: captured.session.project_id, session_id: captured.session.id };
    return connectionOf(bound, bound ? presence(route, bound.id) : null) === 'reconnecting';
  });
  const blank = state.sessions.length > 0 && state.sessions.every(captured => Object.keys(captured.session.items).length === 0);
  return {
    cards, sent, count: loading || first ? '–' : String(cards.length),
    emptyText: first ? 'Connect a session to see what the agent needs from you.' : blank ? 'Questions the agent asks you will collect here, oldest first.'
      : reconnecting ? 'New questions from the agent will appear here. Based on the last synced session.' : 'New questions from the agent will appear here.',
  };
}
