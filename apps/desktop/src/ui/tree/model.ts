import { activeItems, activeTopics, itemRemoved } from '../../selectors/removed';
// The session tree column as data: rows with their guides and thread, the
// status chips and their counts, the session bar and the supporting line of
// every item. A port of the handoff's buildRows/includeSets and the guide
// pass (Ariadne.dc.html:1054-1114, 1798-1901) over the real Session and
// SessionPreferences. Nothing here touches React or the stores.
import type { BindingSummary, Input, Item, ItemOption, ItemStatus, PresenceObservation, Session, SessionSummary, Topic } from '../../generated/domain/models';
import type { SessionPreferences } from '../../generated/core';
import { indexSession, type Immutable } from '../../data';
import type { SupervisorHealth } from '../../data/service';
import { sameOwner } from '../../selectors/tree/rows';
import { hitSegments, holdsTerms, searchTerms, type MatchField, type Segment } from '../../selectors/tree/search';
import { deliveryEvidence } from '../../selectors/waiting/delivery';
import { agentReceived, stoppedAttempt, stuckInput, type Stuck } from '../../selectors/waiting/stuck';
import { deliveryLine as deliveryText, deliveryStage } from '../answer/delivery';
import { agentLine, agentName, dayWord, hostApp, ownerName, sessionLabel } from '../shell/model';
import { STATUS, statusKey, type StatusKey } from '../shared/status';
import { displayStatus, type DisplayStatus } from '../../selectors/waiting/replied';
import { closedSessionQuestion, sessionEnded, waitingOnOwner } from '../../selectors/sessionClosed';
import { continuedLabel } from '../shared/continued';
import { hiddenGroupKey, hiddenGroupsFor, hiddenItems } from './hidden';
import { branchHue } from './branch';
import { withBoxes } from './boxes';
import { agentRunning, connectionOf, type Connection } from '../shared/connection';
import { connectedItems } from '../../selectors/related';
import { ackTarget } from '../../selectors/ack';
import { FILTER_STATUSES, hasStatusFilter, matchExpansion } from '../../selectors/tree/folds';
import { changeTreeOrder, type SeenState } from '../../selectors/changes/seen';

export type ChangeMarker = 'new' | 'changed';

/** Derive once per session/seen snapshot, never once per rendered row. New takes precedence over changed. */
export function mapChanges(session: Immutable<Session>, seen: SeenState): {
  readonly order: readonly string[]; readonly markers: ReadonlyMap<string, ChangeMarker>;
} {
  const order = changeTreeOrder(session);
  const markers = new Map<string, ChangeMarker>();
  if (!seen) return { order, markers };
  const baseline = Date.parse(seen.since);
  const read = new Map(seen.items.map(value => [value.item_id, value.revision]));
  for (const id of order) {
    const item = session.items[id]!;
    // Same predicates as selectors/changes/seen, with the read index shared across every item.
    if (Date.parse(item.created_at) > baseline && !read.has(id)) markers.set(id, 'new');
    else if ((item.changes ?? []).some(change => !change.wording_only
      && change.revision > (read.get(id) ?? 0) && Date.parse(change.at) > baseline)) markers.set(id, 'changed');
  }
  return { order, markers };
}

/** Walk the complete Map preorder, wrapping once, even when the previous target has since been read. */
export function nextMarkedItem(order: readonly string[], markers: ReadonlyMap<string, ChangeMarker>, after: string | null): string | null {
  const start = after === null ? -1 : order.indexOf(after);
  for (let step = 1; step <= order.length; step++) {
    const id = order[(start + step) % order.length]!;
    if (markers.has(id)) return id;
  }
  return null;
}

export const visual = (status: DisplayStatus): StatusKey => statusKey[status];
const CLOSED: ReadonlySet<ItemStatus> = new Set(['decided', 'done', 'dropped', 'replaced']);
export const closed = (status: DisplayStatus) => status !== 'sent' && status !== 'queued' && CLOSED.has(status);
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const items = (session: Immutable<Session>) => activeItems(session);
const topicList = (session: Immutable<Session>) => [...activeTopics(session)]
  .sort((a, b) => a.order - b.order);

// ---------------------------------------------------------------- chips

export type Chip = 'all' | 'waiting' | 'open' | 'progress' | 'closed';
export const CHIPS: readonly { readonly chip: Chip; readonly label: string; readonly icon: string; readonly iconColor: string; readonly statuses: readonly ItemStatus[] }[] = [
  { chip: 'all', label: 'All', icon: 'ph ph-list', iconColor: 'inherit', statuses: [] },
  { chip: 'waiting', label: 'Waiting on me', icon: STATUS.waiting.icon, iconColor: 'var(--st-waiting)', statuses: ['waiting_on_me'] },
  { chip: 'open', label: 'Open', icon: STATUS.open.icon, iconColor: 'var(--st-open)', statuses: ['open'] },
  { chip: 'progress', label: 'In progress', icon: STATUS.progress.icon, iconColor: 'var(--st-progress)', statuses: ['in_progress'] },
  { chip: 'closed', label: 'Closed', icon: STATUS.decided.icon, iconColor: 'var(--st-decided)', statuses: ['decided', 'done', 'dropped', 'replaced'] },
];
const fullStatusFilter = (statuses: readonly ItemStatus[]) => statuses.length > 0 && !hasStatusFilter(statuses);
/** The selected chips represented by the saved status set; empty and full sets mean All. */
export function chipsOf(statuses: readonly ItemStatus[]): ReadonlySet<Chip> {
  return new Set(statuses.length && !fullStatusFilter(statuses)
    ? CHIPS.filter(value => value.statuses.some(status => statuses.includes(status))).map(value => value.chip) : ['all']);
}
/** Toggle a group of statuses without changing the persisted preference shape. */
export function toggleChip(statuses: readonly ItemStatus[], chip: Chip): ItemStatus[] {
  if (chip === 'all') return [];
  const group = CHIPS.find(value => value.chip === chip)!.statuses, next = new Set(fullStatusFilter(statuses) ? [] : statuses);
  if (group.some(status => next.has(status))) group.forEach(status => next.delete(status));
  else group.forEach(status => next.add(status));
  const ordered = FILTER_STATUSES.filter(status => next.has(status));
  return ordered.length === FILTER_STATUSES.length ? [] : ordered;
}
/** Local reply delivery stays under the persisted In progress filter. */
export const statusIn = (statuses: readonly ItemStatus[], status: DisplayStatus) =>
  status === 'sent' || status === 'queued' ? statuses.includes('in_progress') : statuses.includes(status);
const inChip = (chip: Chip, status: DisplayStatus) => chip === 'all' || statusIn(CHIPS.find(value => value.chip === chip)!.statuses, status);

// ---------------------------------------------------------------- search

// Search highlights in place and never decides rows (SPEC §6.9): the rows below are the same with or without it.
export type { Segment } from '../../selectors/tree/search';
/** The question split into search hits and the rest (Ariadne.dc.html:1044). */
export const segments = (text: string, query: string): readonly Segment[] => hitSegments(text, searchTerms(query));

/** Whether the row shows the item's outcome under its title (ItemRow's preview order): search counts only what shows. */
export function outcomeShown(item: Immutable<Item>, later: boolean, replacedBy: Immutable<Item> | null): boolean {
  if (later || !item.outcome) return false;
  if (item.status === 'waiting_on_me' && item.ask) return false;
  if (item.status === 'replaced' && replacedBy) return false;
  return closed(item.status) || item.status === 'open' || item.status === 'in_progress';
}

/** What "Show them" opens for this search, in memory only: ancestors to expand, topics to unfold, hidden groups to show. */
export interface SearchReveal { readonly items: readonly string[]; readonly topics: readonly string[]; readonly groups: readonly string[] }
export const NO_REVEAL: SearchReveal = { items: [], topics: [], groups: [] };

// ---------------------------------------------------------------- delivery

export interface Delivery {
  readonly icon: string; readonly text: string; readonly color: string; readonly failed: boolean;
  /** A stopped delivery: the row answers it inline (ui/answer/StuckNote) instead of the line. */
  readonly stuck: { readonly input: Immutable<Input>; readonly note: Stuck } | null;
}
const inputLabel = (input: Immutable<Input>, options: readonly Immutable<ItemOption>[]) => {
  const option = input.payload.selected_option_id ? options.find(value => value.id === input.payload.selected_option_id) : null;
  return option?.label ?? input.payload.text;
};
/**
 * The delivery line of the latest unsettled input on an item or topic (Ariadne.dc.html:1415). A stopped delivery
 * needing a decision comes first, even with later messages queued behind it: those cannot go out until it is
 * settled, so its Retry / Mark as done must stay on the row.
 */
export function deliveryLine(session: Immutable<Session>, target: { readonly topicId: string; readonly itemId: string | null },
  presence: Immutable<PresenceObservation> | null, health: SupervisorHealth | null = null): Delivery | null {
  const stopped = (value: Immutable<Input>) => value.state === 'needs_attention' ? 1 : 0;
  const input = Object.values(session.inputs).filter((value): value is Immutable<Input> => !!value
    && value.target.topic_id === target.topicId && value.target.item_id === target.itemId
    && value.state !== 'handled' && value.state !== 'cancelled' && value.state !== 'skipped')
    .sort((a, b) => stopped(b) - stopped(a) || b.seq - a.seq)[0];
  if (!input) return null;
  const binding = session.bindings[input.binding_id];
  const summary = binding ? { ...binding, presence: null } as Immutable<BindingSummary> : null;
  const evidence = deliveryEvidence(input, summary, session.operation_receipts, presence);
  const item = target.itemId ? session.items[target.itemId] : null;
  const label = inputLabel(input, item?.options ?? []), agent = binding ? agentName(binding.adapter_id) : 'the agent';
  const stage = deliveryStage(evidence.kind);
  const note = input.state === 'needs_attention' ? stuckInput(session, input, presence, health) : null;
  if (note) {
    const delivered = agentReceived(stoppedAttempt(input));
    const checking = note.kind === 'checking';
    return { ...deliveryText(checking ? 'checking' : delivered ? stage ?? 'waiting_answer' : 'failed', input.kind, label, agent),
      ...(delivered || checking ? { text: note.text } : {}), failed: !delivered && !checking, stuck: { input, note } };
  }
  // A topic reply not sent yet is answered on the band: Edit puts it back in the reply box, Delete drops it.
  const queued = target.itemId === null && input.state === 'queued' ? stuckInput(session, input, presence, health) : null;
  return stage ? { ...deliveryText(stage, input.kind, label, agent), failed: stage === 'failed', stuck: queued ? { input, note: queued } : null } : null;
}

// ---------------------------------------------------------------- session bar

export interface SessionBar {
  readonly sessionId: string;
  /** The owner's name for the session; unnamed, "codex · iTerm window 2" (the location segment only when the host reports one). */
  readonly title: string;
  /** The "codex · iTerm window 2" line kept quietly beside a name; null while unnamed. */
  readonly secondary: string | null;
  /** The owner's one-line description, or null. */
  readonly description: string | null;
  /** Whether the owner has named the session. */
  readonly named: boolean;
  /** The agent alone ("codex"), or "No agent". */
  readonly agent: string;
  /** The terminal app ("iTerm") for "Connected to codex in iTerm", or null. */
  readonly where: string | null;
  readonly meta: string;
  readonly running: boolean;
  /** The agent connection (ui/shared/connection): a stale host reads "Reconnecting", the agent still running. */
  readonly connection: Connection;
  readonly closed: boolean;
  readonly archived?: boolean;
}
/** The session name, connection and active topic count for the compact bar. */
export function sessionBar(session: Immutable<Session> | null, summary: Immutable<SessionSummary> | null,
  presence: Immutable<PresenceObservation> | null = null): SessionBar | null {
  const bound = session?.active_binding_id ? session.bindings[session.active_binding_id] ?? null : null;
  const binding = session ? bound : summary?.active_binding ?? null;
  const created = session?.created_at ?? summary?.created_at;
  if (!created) return null;
  // A fresh presence observation outranks the binding's stored connection state; a stale one is "Reconnecting".
  const connection = connectionOf(binding, bound ? presence : null), running = agentRunning(connection);
  // Before the snapshot loads, the summary's topic count stands in (archived topics excluded, like the loaded count).
  const topics = session ? topicList(session).filter(topic => topic.archived_at === null).length
    : summary ? summary.topic_count - summary.counts.archived_topics : null;
  const agent = binding ? agentName(binding.adapter_id) : 'No agent', location = binding?.host_location ?? null;
  const label = sessionLabel(session ?? summary, agentLine(agent, location));
  return { sessionId: session?.id ?? summary!.session_id, title: label.title, secondary: label.secondary, description: label.description, named: label.named, agent, where: hostApp(location),
    meta: topics === null ? '' : plural(topics, 'topic'),
    running, connection, closed: (session?.state ?? summary?.state) === 'closed', archived: (session ?? summary)?.archived_at != null };
}

// ---------------------------------------------------------------- rows

export interface Guide {
  readonly kind: 'line' | 'elbow';
  readonly x: number;
  readonly on: boolean;
  readonly width: number;
  /** A rail begins/ends at this row's bullet instead of the row boundary. */
  readonly fromBullet?: boolean;
  readonly toBullet?: boolean;
}
export interface Count { readonly icon: string; readonly color: string; readonly text: string }
export interface TopicRow {
  readonly kind: 'topic';
  readonly key: string;
  readonly topic: Immutable<Topic>;
  readonly depth: 0;
  readonly expanded: boolean;
  readonly first: boolean;
  readonly guides: readonly Guide[];
  readonly counts: readonly Count[];
  /** A topic from a session that did not start today and was not continued into it. */
  readonly earlier: boolean;
  readonly chip: { readonly label: string; readonly title: string } | null;
  readonly allClosed: boolean;
  readonly delivery: Delivery | null;
}
export interface ItemRow {
  readonly kind: 'item';
  readonly key: string;
  readonly item: Immutable<Item>;
  readonly sessionClosed?: boolean;
  /** The persisted item status or local Sent/Queued reply delivery. */
  readonly status: DisplayStatus;
  readonly ack: NonNullable<Item['ack_to']> | null;
  readonly depth: number;
  readonly hasKids: boolean;
  readonly expanded: boolean;
  readonly context: boolean;
  readonly guides: readonly Guide[];
  readonly later: boolean;
  readonly hidden: boolean;
  readonly segments: readonly Segment[];
  /** The fields on this row that hold every word of the search, question first; none without a search. */
  readonly matches: readonly MatchField[];
  readonly replacedBy: Immutable<Item> | null;
  readonly relatedCount: number;
  readonly collapsed: { readonly waiting: number; readonly open: number; readonly progress: number; readonly closed: number } | null;
  readonly delivery: Delivery | null;
  readonly badge: string;
  readonly hue?: number;
}
/** Why a run of siblings is left out of the Map: outside the focus, not matching the filter, or hidden by the owner. */
export type StripReason = 'hidden' | 'filter' | 'focus';
/**
 * The Map's one strip row: a run of consecutive omitted siblings. Its reason is the first that applies, focus then
 * filter then hidden. Only a hidden strip opens (per parent, as `hiddenGroupKey`); the others are undone by Clear and Unfocus.
 */
export interface StripRow {
  readonly kind: 'strip';
  /** `${topicId}/${parent ?? 'top'}/${reason}/${firstOmittedItemKey}` */
  readonly key: string;
  readonly reason: StripReason;
  readonly topicId: string;
  readonly parent: string | null;
  readonly depth: number;
  /** The siblings in the run. */
  readonly count: number;
  /** Questions waiting on the owner among the run and everything below it. */
  readonly waiting: number;
  readonly expanded: boolean;
  readonly guides: readonly Guide[];
  readonly delivery: null;
}
export type Row = TopicRow | ItemRow | StripRow;

/** Which items the Map's filters keep. `active` is false when nothing scopes the rows. */
export interface TreeFilter { readonly active: boolean; matches(item: Immutable<Item>): boolean }

export const stripKey = (topicId: string, parent: string | null, reason: StripReason, firstOmitted: string) =>
  `${topicId}/${parent ?? 'top'}/${reason}/${firstOmitted}`;

export interface TreeInput {
  readonly session: Immutable<Session>;
  readonly view: Immutable<SessionPreferences>;
  /** The filters that scope the rows (owners, Later and statuses, today through `shimFilter`). */
  readonly filter: TreeFilter;
  /** The walk keeps only this top item (and its topic); the other top items of its topic become one 'focus' strip. */
  readonly focusRootId?: string | null;
  /** Items whose single Ack is held for its 6 s Undo. The band's "N to ack" leaves them out: they are as good as acked. */
  readonly ackHeld?: ReadonlySet<string>;
  /** The header search as typed, which can run ahead of the saved filter. It highlights; it never decides rows. */
  readonly search: string;
  /** What "Show them" opened for the search (in memory, never saved). */
  readonly searchShown?: SearchReveal | null;
  readonly later: ReadonlySet<string>;
  readonly expandedHiddenGroups?: ReadonlySet<string>;
  readonly collapsedTopics: ReadonlySet<string>;
  readonly filterCollapsedItemIds?: ReadonlySet<string>;
  readonly filterCollapsedTopicIds?: ReadonlySet<string>;
  readonly selectedId: string | null;
  /** An item revealed from elsewhere (a link, the waiting panel). */
  readonly revealId: string | null;
  /** N reveals a row without selecting it, opening detail or changing saved folds. */
  readonly attentionRevealId?: string | null;
  readonly temporaryExpanded: readonly string[];
  readonly presence: Immutable<PresenceObservation> | null;
  /** The desktop supervisor's health for the session's binding, when known. */
  readonly health?: SupervisorHealth | null;
  /** Catalogue summaries, to name the session a continued topic came from. */
  readonly summaries: readonly Immutable<SessionSummary>[];
  readonly now: number;
}
export interface TreeModel {
  readonly rows: readonly Row[];
  /** A status, owner or Later filter scopes the rows. A search never does. */
  readonly filtering: boolean;
  /** Items the filters keep, hidden ones aside: the "Showing N of M" count. */
  readonly shownCount: number;
  readonly hiddenCount: number;
  readonly itemCount: number;
  /** "Showing an item outside your current filters." */
  readonly outside: boolean;
  readonly noMatch: boolean;
  /** The session has no items at all. */
  readonly empty: boolean;
  readonly chips: ReadonlySet<Chip>;
  readonly counts: Readonly<Record<Chip, number>>;
  /** Matching items the rows do not show: in hidden items, and inside folded items or topics; and what shows them. */
  readonly search: { readonly hidden: number; readonly collapsed: number; readonly reveal: SearchReveal };
}

function topicChip(session: Immutable<Session>, topic: Immutable<Topic>, summaries: readonly Immutable<SessionSummary>[], now: number) {
  if (topic.origin) return { label: continuedLabel(topic.origin, summaries, now), title: 'Started in an earlier session, continued in this one' };
  const day = dayWord(Date.parse(session.created_at), now).toLowerCase();
  if (!day) return null;
  const binding = session.active_binding_id ? session.bindings[session.active_binding_id] : null;
  return { label: `${ownerName(session) ?? (binding ? agentName(binding.adapter_id) : 'Session')} · ${day}`, title: 'From an earlier session' };
}

export function topicCounts(statuses: readonly DisplayStatus[], ackCount = 0, ended = false): Count[] {
  const count = (test: (status: DisplayStatus) => boolean) => statuses.filter(test).length;
  const waiting = ended ? 0 : count(status => status === 'waiting_on_me'), open = count(status => status === 'open');
  const sent = count(status => status === 'sent'), queued = count(status => status === 'queued');
  const progress = count(status => status === 'in_progress'), done = count(closed);
  return [
    waiting ? { icon: STATUS.waiting.icon, color: 'var(--st-waiting)', text: `${waiting} waiting on you` } : null,
    sent ? { icon: STATUS.agent.icon, color: 'var(--st-agent)', text: `${sent} sent` } : null,
    queued ? { icon: STATUS.queued.icon, color: 'var(--st-open)', text: `${queued} queued` } : null,
    ackCount ? { icon: 'ph ph-check', color: 'var(--color-text)', text: `${ackCount} to ack` } : null,
    open ? { icon: STATUS.open.icon, color: 'var(--st-open)', text: `${open} open` } : null,
    progress ? { icon: STATUS.progress.icon, color: 'var(--st-progress)', text: `${progress} in progress` } : null,
    done ? { icon: STATUS.decided.icon, color: 'var(--st-decided)', text: `${done} closed` } : null,
  ].filter((value): value is Count => !!value);
}

/** "1 waiting · 2 open · 5 closed inside" for folded descendants. */
export function collapsedNote(collapsed: NonNullable<ItemRow['collapsed']>): string {
  const parts = [collapsed.waiting && `${collapsed.waiting} waiting`, collapsed.open && `${collapsed.open} open`,
    collapsed.progress && `${collapsed.progress} in progress`, collapsed.closed && `${collapsed.closed} closed`].filter(Boolean);
  return `${parts.join(' · ')} inside`;
}

export function badgeLabel(item: Immutable<Item>, later: boolean, status: DisplayStatus = item.status): string {
  if (item.status === 'open' && later) return 'Later';
  if (item.status === 'done' && item.type === 'explanation') return 'Explained';
  return STATUS[visual(status)].label;
}

export function treeModel(input: TreeInput): TreeModel {
  const { session, view, later, selectedId, revealId, filter } = input, filters = view.filters;
  const revealIds = [revealId, input.attentionRevealId].filter((id): id is string => !!id);
  const indexes = indexSession(session), all = items(session);
  const explicitHidden = new Set(view.hidden_item_ids ?? []);
  const hidden = hiddenItems(session, explicitHidden);
  const hiddenGroups = new Set(input.expandedHiddenGroups ?? []);
  revealIds.forEach(id => hiddenGroupsFor(session, explicitHidden, id).forEach(key => hiddenGroups.add(key)));
  const shownBySearch = input.searchShown ?? NO_REVEAL;
  shownBySearch.groups.forEach(key => hiddenGroups.add(key));
  const terms = searchTerms(input.search);
  const chips = chipsOf(filters.statuses);
  const attentionTopic = input.attentionRevealId ? session.items[input.attentionRevealId]?.topic_id : null;
  // Focus keeps one top item and its topic; a stale or non-top id focuses nothing.
  const focusItem = input.focusRootId ? session.items[input.focusRootId] : undefined;
  const focusRootId = focusItem && !focusItem.parent && !itemRemoved(session, focusItem.id) ? focusItem.id : null;
  const topics = topicList(session).filter(topic => (!focusItem || !focusRootId || topic.id === focusItem.topic_id)
    && (topic.id === attentionTopic || (filters.archived ? topic.archived_at !== null : topic.archived_at === null)));
  const shown = new Set(topics.map(topic => topic.id));
  const live = all.filter(item => shown.has(item.topic_id));
  const base = (item: Immutable<Item>) => {
    if (filters.owners.length && !filters.owners.some(owner => sameOwner(owner, item.owner))) return false;
    return !(filters.hide_later && later.has(item.id));
  };
  const shows = new Map(all.map(item => [item.id, displayStatus(session, item)]));
  const display = (item: Immutable<Item>) => shows.get(item.id) ?? item.status;
  const filtering = filter.active;
  const scoped = live.filter(item => base(item));
  const counts = Object.fromEntries(CHIPS.map(({ chip: key }) => [key, scoped.filter(item => (!hidden.has(item.id) || key === 'waiting') && (key !== 'waiting' || waitingOnOwner(session, item)) && inChip(key, display(item))).length])) as Record<Chip, number>;

  // includeSets: matches, the forced reveal and selection, and their ancestors.
  const matched = new Set<string>(), forced = new Set<string>(), include = new Set<string>();
  const ancestors = (id: string) => { const out: string[] = []; for (let parent = session.items[id]?.parent; parent; parent = session.items[parent]?.parent) out.push(parent); return out; };
  if (filtering) {
    for (const id of [...revealIds, selectedId]) if (id && session.items[id] && !itemRemoved(session, id)) forced.add(id);
    for (const item of live) {
      const match = filter.matches(item);
      if (match) matched.add(item.id);
      if (match || forced.has(item.id)) { include.add(item.id); ancestors(item.id).forEach(id => include.add(id)); }
    }
  }
  const expanded = matchExpansion(view.expanded_item_ids, input.temporaryExpanded,
    [...include].flatMap(ancestors), filtering, input.filterCollapsedItemIds);
  const revealTopics = new Set(revealIds.map(id => session.items[id]?.topic_id));
  revealIds.forEach(id => ancestors(id).forEach(id => expanded.add(id)));
  shownBySearch.items.forEach(id => expanded.add(id));
  shownBySearch.topics.forEach(id => revealTopics.add(id));
  const kids = (id: string | null) => indexes.childrenByParent.get(id) ?? [];
  const rootsOf = (topicId: string) => kids(null).filter(item => item.topic_id === topicId);

  const built: (Omit<TopicRow, 'guides'> | Omit<ItemRow, 'guides'> | Omit<StripRow, 'guides'>)[] = [];
  for (const topic of topics) {
    const roots = rootsOf(topic.id);
    // A topic with no items yet (or none left) still shows its band; filters hide topics without a match.
    // A session with no items at all shows its empty state instead (frame 1g).
    if (filtering && !roots.some(item => include.has(item.id))) continue;
    const open = revealTopics.has(topic.id) || (filtering ? !input.filterCollapsedTopicIds?.has(topic.id) : !input.collapsedTopics.has(topic.id));
    const topicItems = all.filter(item => item.topic_id === topic.id), statuses = topicItems.map(display);
    const chipValue = topicChip(session, topic, input.summaries, input.now);
    const delivery = deliveryLine(session, { topicId: topic.id, itemId: null }, input.presence, input.health);
    built.push({ kind: 'topic', key: topic.id, topic, depth: 0, expanded: open, first: built.length === 0, counts: topicCounts(statuses, topicItems.filter(item => ackTarget(session, item) && !input.ackHeld?.has(item.id)).length, sessionEnded(session)),
      earlier: !topic.origin && !!chipValue, chip: chipValue, allClosed: !delivery && statuses.length > 0 && statuses.every(closed), delivery });
    if (!open) continue;
    const walk = (list: readonly Immutable<Item>[], depth: number) => {
      const parent = list[0]?.parent ?? null;
      const groupOpen = hiddenGroups.has(hiddenGroupKey(topic.id, parent));
      // Why an item is left out of the walk, focus first; null when the Map shows it.
      const omitted = (item: Immutable<Item>): StripReason | null =>
        depth === 1 && focusRootId && item.id !== focusRootId ? 'focus' : filtering && !include.has(item.id) ? 'filter' : null;
      const strip = (run: readonly Immutable<Item>[], reason: StripReason, expanded: boolean) => {
        const below: Immutable<Item>[] = [];
        const gather = (value: Immutable<Item>) => { below.push(value); kids(value.id).forEach(gather); };
        run.forEach(gather);
        built.push({ kind: 'strip', key: stripKey(topic.id, parent, reason, run[0]!.id), reason, topicId: topic.id, parent, depth,
          count: run.length, waiting: below.filter(value => waitingOnOwner(session, value)).length, expanded, delivery: null });
      };
      const emit = (item: Immutable<Item>) => {
        const children = kids(item.id);
        const open = children.length > 0 && expanded.has(item.id);
        let collapsed: ItemRow['collapsed'] = null;
        if (children.length && !open) {
          const below: Immutable<Item>[] = [];
          const gather = (id: string) => kids(id).forEach(child => { below.push(child); gather(child.id); });
          gather(item.id);
          collapsed = { waiting: below.filter(value => waitingOnOwner(session, value)).length, open: below.filter(value => value.status === 'open').length,
            progress: below.filter(value => value.status === 'in_progress' || display(value) === 'sent' || display(value) === 'queued').length, closed: below.filter(value => closed(value.status)).length };
        }
        const parked = item.status === 'open' && later.has(item.id);
        const replacedBy = item.replaced_by && !itemRemoved(session, item.replaced_by) ? session.items[item.replaced_by] ?? null : null;
        const matches: MatchField[] = [];
        if (holdsTerms(item.question, terms)) matches.push('question');
        if (outcomeShown(item, parked, replacedBy) && holdsTerms(item.outcome, terms)) matches.push('outcome');
        built.push({ kind: 'item', key: item.id, item, sessionClosed: closedSessionQuestion(session, item), status: display(item), ack: ackTarget(session, item), depth, hasKids: children.length > 0, expanded: open,
          hidden: hidden.has(item.id), context: filtering && !matched.has(item.id) && !forced.has(item.id), later: parked,
          segments: matches.includes('question') ? hitSegments(item.question, terms) : [{ text: item.question, hit: false }], matches,
          replacedBy,
          relatedCount: connectedItems(session, item.id).length,
          collapsed, delivery: deliveryLine(session, { topicId: item.topic_id, itemId: item.id }, input.presence, input.health), badge: badgeLabel(item, parked, display(item)) });
        if (open) walk(children, depth + 1);
      };
      // Each run of consecutive omitted siblings is one strip, in place; hidden siblings follow the others as one group.
      let run: Immutable<Item>[] = [];
      const flush = () => {
        if (run.length) strip(run, run.some(value => omitted(value) === 'focus') ? 'focus' : 'filter', false);
        run = [];
      };
      const hiddenSiblings: Immutable<Item>[] = [];
      for (const item of list) {
        if (omitted(item)) run.push(item);
        else if (explicitHidden.has(item.id)) hiddenSiblings.push(item);
        else { flush(); emit(item); }
      }
      flush();
      if (hiddenSiblings.length) {
        strip(hiddenSiblings, 'hidden', groupOpen);
        if (groupOpen) hiddenSiblings.forEach(emit);
      }
    };
    walk(roots, 1);
  }

  // One rail at each parent's bullet, ending at its last direct child's bullet.
  // A depth stack finds visible parents/last children in one pass (including hidden groups).
  const index = new Map(built.map((row, at) => [row.key, at]));
  const selected = selectedId ? session.items[selectedId] : undefined;
  const chain = selected ? [selected.topic_id, ...ancestors(selected.id).reverse(), selected.id] : [];
  const chainAt = chain.map(key => index.get(key));
  const threaded = chainAt.length > 0 && chainAt.every(value => value !== undefined);
  const parents: number[][] = [], stack: number[] = [], lastChild = new Map<number, number>();
  built.forEach((row, at) => {
    stack.length = row.depth;
    parents[at] = [...stack];
    const parent = stack.at(-1);
    if (parent !== undefined) lastChild.set(parent, at);
    stack[row.depth] = at;
  });
  const withGuides = built.map((row, at): Row => {
    const guides: Guide[] = [];
    for (const parentAt of [...parents[at], at]) {
      const parent = built[parentAt], end = lastChild.get(parentAt);
      if (end === undefined || at > end) continue;
      const x = 20 + parent.depth * 24;
      guides.push({ kind: 'line', x, on: false, width: 24, fromBullet: at === parentAt, toBullet: at === end });
      const child = at !== parentAt && row.depth === parent.depth + 1;
      if (child) guides.push({ kind: 'elbow', x, on: false, width: 24 });
      const chainIndex = chainAt.indexOf(parentAt), next = chainAt[chainIndex + 1];
      if (threaded && chainIndex >= 0 && next !== undefined && at <= next) {
        guides.push({ kind: 'line', x, on: true, width: 24, fromBullet: at === parentAt, toBullet: at === next });
        if (at === next) guides.push({ kind: 'elbow', x, on: true, width: 24 });
      }
    }
    return { ...row, guides, ...(row.kind === 'item' && row.depth === 1 ? { hue: branchHue(row.key) } : {}) } as Row;
  });
  // The box pass is the last step; it changes nothing yet.
  const rows = withBoxes(withGuides);

  // hasReveal (Ariadne.dc.html:2169): only a reveal raises the banner, not a plain selection.
  const outside = filtering && rows.length > 0 && revealIds.some(id => forced.has(id) && !matched.has(id));
  // Matches the rows do not show (SPEC §6.9): not counted, but named in the note, and "Show them" opens their way.
  // An item the filters leave out is neither: the filters chose not to show it.
  let hiddenMatches = 0, collapsedMatches = 0;
  const reveal = { items: new Set<string>(), topics: new Set<string>(), groups: new Set<string>() };
  if (terms.length) {
    const shownIds = new Set(rows.flatMap(row => row.kind === 'item' ? [row.key] : []));
    for (const item of live) {
      if (shownIds.has(item.id) || filtering && !include.has(item.id)) continue;
      if (!holdsTerms(item.question, terms) && !holdsTerms(item.outcome, terms)) continue;
      if (hidden.has(item.id)) { hiddenMatches++; hiddenGroupsFor(session, explicitHidden, item.id).forEach(key => reveal.groups.add(key)); }
      else collapsedMatches++;
      ancestors(item.id).forEach(id => reveal.items.add(id));
      reveal.topics.add(item.topic_id);
    }
  }
  return { rows, filtering, shownCount: scoped.filter(item => !hidden.has(item.id) && filter.matches(item)).length, hiddenCount: scoped.filter(item => hidden.has(item.id) && filter.matches(item)).length, itemCount: live.filter(item => !hidden.has(item.id)).length, outside, noMatch: live.length > 0 && rows.length === 0, empty: Object.keys(session.items).length === 0 && !Object.values(session.topics).some(topic => topic?.removed_at), chips, counts,
    search: { hidden: hiddenMatches, collapsed: collapsedMatches, reveal: { items: [...reveal.items], topics: [...reveal.topics], groups: [...reveal.groups] } } };
}

/** The row ← moves to: the parent item, or the topic of a root item. */
export function parentKey(row: Row): string | null {
  if (row.kind === 'topic') return null;
  if (row.kind === 'strip') return row.parent ?? row.topicId;
  return row.item.parent ?? row.item.topic_id;
}

/** The oldest item waiting on the owner in this session; one the owner already replied to waits on the agent. */
export function oldestWaiting(session: Immutable<Session>): Immutable<Item> | null {
  return items(session).filter(item => waitingOnOwner(session, item) && session.topics[item.topic_id]?.archived_at === null)
    .sort((a, b) => (a.waiting_since ?? a.created_at).localeCompare(b.waiting_since ?? b.created_at))[0] ?? null;
}
