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
import { hitSegments, holdsTerms, searchableMarkdown, searchTerms, type MatchField, type Segment } from '../../selectors/tree/search';
import { deliveryEvidence } from '../../selectors/waiting/delivery';
import { agentReceived, stoppedAttempt, stuckInput } from '../../selectors/waiting/stuck';
import { deliveryLine as deliveryText, deliveryStage } from '../answer/delivery';
import { agentLine, agentName, dayWord, hostApp, ownerName, sessionLabel } from '../shell/model';
import { STATUS, statusKey, type StatusKey } from '../shared/status';
import { displayStatus, type DisplayStatus } from '../../selectors/waiting/replied';
import { closedSessionQuestion, sessionEnded, waitingOnOwner } from '../../selectors/sessionClosed';
import { continuedLabel } from '../shared/continued';
import { hiddenGroupKey, hiddenGroupsFor, hiddenItems } from './hidden';
import { columnX, COLUMN_STEP, withBoxes, type Box } from './boxes';
import { agentRunning, connectionOf, type Connection } from '../shared/connection';
import { connectedItems } from '../../selectors/related';
import { ackTarget } from '../../selectors/ack';
import { matchExpansion } from '../../selectors/tree/folds';
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

/**
 * The fields of `item` that hold every search word, in Map order: question, outcome (only where the row shows it), note.
 * The note is the item's body and Details always shows it, so it is searched for every status, parked included.
 * The rows and the tally of matches the Map does not draw both read this, so they cannot drift.
 */
export function matchFields(item: Immutable<Item>, later: boolean, replacedBy: Immutable<Item> | null, terms: readonly string[]): MatchField[] {
  const fields: MatchField[] = [];
  if (holdsTerms(item.question, terms)) fields.push('question');
  // Outcome and note are Markdown: a link's target is never drawn, so only its label counts.
  if (outcomeShown(item, later, replacedBy) && holdsTerms(item.outcome && searchableMarkdown(item.outcome), terms)) fields.push('outcome');
  if (holdsTerms(item.note && searchableMarkdown(item.note), terms)) fields.push('note');
  return fields;
}

/** What "Show them" opens for this search, in memory only: ancestors to expand, topics to unfold, hidden groups to show. */
export interface SearchReveal { readonly items: readonly string[]; readonly topics: readonly string[]; readonly groups: readonly string[] }
export const NO_REVEAL: SearchReveal = { items: [], topics: [], groups: [] };

// ---------------------------------------------------------------- delivery

export interface Delivery {
  readonly icon: string; readonly text: string; readonly color: string; readonly failed: boolean;
}
const inputLabel = (input: Immutable<Input>, options: readonly Immutable<ItemOption>[]) => {
  const option = input.payload.selected_option_id ? options.find(value => value.id === input.payload.selected_option_id) : null;
  return option?.label ?? input.payload.text;
};
/**
 * The delivery line of the latest unsettled input on an item or topic (Ariadne.dc.html:1415). A stopped delivery
 * needing a decision comes first, even with later messages queued behind it: those cannot go out until it is
 * settled. The row only says so; the decision is made in Details (ui/answer/StuckNote) and the recovery banner.
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
      ...(delivered || checking ? { text: note.text } : {}), failed: !delivered && !checking };
  }
  return stage ? { ...deliveryText(stage, input.kind, label, agent), failed: stage === 'failed' } : null;
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
  /** Shown only because it was revealed or selected: the filter would leave it out (SPEC 11.4). */
  readonly outside?: boolean;
  readonly guides: readonly Guide[];
  readonly later: boolean;
  readonly hidden: boolean;
  readonly segments: readonly Segment[];
  /** The fields on this row that hold every word of the search, question first; none without a search. */
  readonly matches: readonly MatchField[];
  readonly replacedBy: Immutable<Item> | null;
  readonly relatedCount: number;
  readonly collapsed: { readonly inside: number; readonly waiting: number; readonly open: number; readonly progress: number; readonly closed: number } | null;
  readonly delivery: Delivery | null;
  readonly badge: string;
  /** The branch's hue slot (0-4): its top item's ordinal round the five hues. Children inherit it. */
  readonly branch: number;
  /** This row's slice of every box around it (the box pass). */
  readonly boxes: readonly Box[];
}
/**
 * Why a run of siblings is left out of the Map: outside the focus, not matching the filter, or hidden by the owner; or,
 * in the place of one item or topic (E29), removed by the owner (during the Undo window), removed by the agent (in the
 * bin), or archived this visit.
 */
export type StripReason = 'hidden' | 'filter' | 'focus' | PlaceReason;
export type PlaceReason = 'removed' | 'agent-removed' | 'archived';
/** A strip standing where one item (and what's below it) or one topic was, so the rows around it don't move (E29). */
export interface PlaceStrip {
  readonly reason: PlaceReason;
  readonly topicId: string;
  /** The item it stands for; null for a whole topic. */
  readonly itemId: string | null;
  /** The item's parent (null at the top of its topic). */
  readonly parent: string | null;
  /** The item's ordinal among its siblings, or the topic's order. */
  readonly order: number;
  readonly name: string;
  /** The item and everything below it, or the topic's items. */
  readonly count: number;
  /** Who removed it, for "Claude Code removed “x”". */
  readonly agent?: string;
  /** The row keys it stands for: the item and everything below it, or the topic and its items. */
  readonly covers: readonly string[];
  /** A removed strip whose Undo window ended: its command is running, so it offers no Undo. */
  readonly ended?: boolean;
}
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
  /** The boxes of the ancestors this strip sits in (none for a top-level strip). */
  readonly boxes: readonly Box[];
  /** The branch's hue slot, or null for a top-level strip, which sits in no branch. */
  readonly branch: number | null;
  readonly delivery: null;
  /** A strip in one item's or topic's place: what it stands for. */
  readonly place?: PlaceStrip;
}
export type Row = TopicRow | ItemRow | StripRow;

/** The strip that now stands where the row `key` was (an item below a removed one, or a topic's item), if any (E29). */
export function stripAnchorFor(rows: readonly Row[], key: string): string | null {
  return rows.find(row => row.kind === 'strip' && !!row.place?.covers.includes(key))?.key ?? null;
}

/** Which items the Map's filters keep. `active` is false when nothing scopes the rows. */
export interface TreeFilter { readonly active: boolean; matches(item: Immutable<Item>): boolean }

export const stripKey = (topicId: string, parent: string | null, reason: StripReason, firstOmitted: string) =>
  `${topicId}/${parent ?? 'top'}/${reason}/${firstOmitted}`;

export interface TreeInput {
  readonly session: Immutable<Session>;
  readonly view: Immutable<SessionPreferences>;
  /** The filters that scope the rows (owners, Later and the picked chips: `filterOf` in selectors/tree/filter). */
  readonly filter: TreeFilter;
  /** The walk keeps only this top item (and its topic); the other top items of its topic become one 'focus' strip. */
  readonly focusRootId?: string | null;
  /** Items whose single Ack is held for its 6 s Undo. The band's "N to ack" leaves them out: they are as good as acked. */
  readonly ackHeld?: ReadonlySet<string>;
  /** The header search as typed, which can run ahead of the saved filter. It highlights; it never decides rows. */
  readonly search: string;
  /** What "Show them" opened for the search (in memory, never saved). */
  readonly searchShown?: SearchReveal | null;
  /** What the filter strip's "Show them" opened for the hidden matches (in memory, never saved); the search's reveal is separate. */
  readonly filterShown?: SearchReveal | null;
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
  /** Strips in the place of items and topics the session no longer shows (E29). */
  readonly places?: readonly PlaceStrip[];
  readonly now: number;
  /** The rows of the previous build: a row that is the same again is that same object, so a memoised row does not redraw (F6c). */
  readonly previous?: readonly Row[];
}
export interface TreeModel {
  readonly rows: readonly Row[];
  /** A status, owner or Later filter scopes the rows. A search never does. */
  readonly filtering: boolean;
  /** An item is shown that the filters would leave out (SPEC 11.4): the Map raises a notice and tags the row. */
  readonly outside: boolean;
  readonly noMatch: boolean;
  /** The session has no items at all. */
  readonly empty: boolean;
  /** Matching items the rows do not show: in hidden items, and inside folded items or topics; and what shows them. */
  readonly search: { readonly hidden: number; readonly collapsed: number; readonly outsideFocus: number; readonly reveal: SearchReveal };
  /**
   * The hidden items the filter matches, in the live items of the shown topics: `remaining` are not drawn and lie inside the Focus,
   * `shown` are drawn because of the filter's own reveal (not by hand, search or selection), `outside` lie outside the Focus.
   * `reveal` is what "Show them" opens for the remaining ones. All zero while no filter is active.
   */
  readonly filterHidden: { readonly remaining: number; readonly shown: number; readonly outside: number; readonly reveal: SearchReveal };
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

/** The folded descendants' chip (D7, SPEC 3.3): "4 closed inside" when every one is closed; else "5 inside", plus " · 1 waiting" when questions wait. */
export function collapsedNote(collapsed: NonNullable<ItemRow['collapsed']>): string {
  if (collapsed.inside > 0 && collapsed.closed === collapsed.inside) return `${collapsed.inside} closed inside`;
  return `${collapsed.inside} inside${collapsed.waiting ? ` · ${collapsed.waiting} waiting` : ''}`;
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
  // The filter's reveal is its own set beside the search's (it applies only while a filter is active). `openElsewhere` is every hidden
  // group open for another reason, so the tally below can tell what only the filter's reveal keeps open.
  const shownByFilter = filter.active ? input.filterShown ?? NO_REVEAL : NO_REVEAL;
  const openElsewhere = new Set(hiddenGroups);
  shownByFilter.groups.forEach(key => hiddenGroups.add(key));
  const terms = searchTerms(input.search);
  const attentionTopic = input.attentionRevealId ? session.items[input.attentionRevealId]?.topic_id : null;
  // Focus keeps one top item and its topic; a stale or non-top id focuses nothing.
  const focusItem = input.focusRootId ? session.items[input.focusRootId] : undefined;
  const focusRootId = focusItem && !focusItem.parent && !itemRemoved(session, focusItem.id) ? focusItem.id : null;
  // The topics in scope, whether or not a focus leaves them out of the walk: counts, matches and the search tally read all of them.
  const scopeTopics = topicList(session).filter(topic => topic.id === attentionTopic || (filters.archived ? topic.archived_at !== null : topic.archived_at === null));
  const topics = focusRootId ? scopeTopics.filter(topic => topic.id === focusItem!.topic_id) : scopeTopics;
  const shown = new Set(scopeTopics.map(topic => topic.id));
  const live = all.filter(item => shown.has(item.topic_id));
  const shows = new Map(all.map(item => [item.id, displayStatus(session, item)]));
  const display = (item: Immutable<Item>) => shows.get(item.id) ?? item.status;
  const filtering = filter.active;

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
  shownByFilter.items.forEach(id => expanded.add(id));
  shownByFilter.topics.forEach(id => revealTopics.add(id));
  const kids = (id: string | null) => indexes.childrenByParent.get(id) ?? [];
  const rootsOf = (topicId: string) => kids(null).filter(item => item.topic_id === topicId);

  const built: (Omit<TopicRow, 'guides'> | Omit<ItemRow, 'guides' | 'boxes' | 'branch'> | Omit<StripRow, 'guides' | 'boxes' | 'branch'>)[] = [];
  const places = input.places ?? [];
  const placeRow = (place: PlaceStrip, depth: number) => built.push({ kind: 'strip', key: stripKey(place.topicId, place.parent, place.reason, place.itemId ?? place.topicId),
    reason: place.reason, topicId: place.topicId, parent: place.itemId ? place.parent : null, depth, count: place.count, waiting: 0, expanded: false, delivery: null, place });
  // Strips for whole topics go in topic order among the topics shown; a focus shows only its own topic.
  const topicPlaces = focusRootId ? [] : places.filter(place => !place.itemId).sort((a, b) => a.order - b.order);
  let nextTopicPlace = 0;
  const topicPlacesBefore = (order: number) => { while (nextTopicPlace < topicPlaces.length && topicPlaces[nextTopicPlace]!.order < order) placeRow(topicPlaces[nextTopicPlace++]!, 0); };
  for (const topic of topics) {
    topicPlacesBefore(topic.order);
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
    // Strips in the place of items under `parent`, by ordinal among their siblings.
    const placesUnder = (parent: string | null) => places.filter(place => place.itemId && place.topicId === topic.id && place.parent === parent);
    const walk = (list: readonly Immutable<Item>[], depth: number, parent: string | null) => {
      const ghosts = placesUnder(parent).sort((a, b) => a.order - b.order);
      let nextGhost = 0;
      const ghostsBefore = (ordinal: number) => { while (nextGhost < ghosts.length && ghosts[nextGhost]!.order < ordinal) placeRow(ghosts[nextGhost++]!, depth); };
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
        const children = kids(item.id), placed = placesUnder(item.id).length > 0;
        const open = (children.length > 0 || placed) && expanded.has(item.id);
        let collapsed: ItemRow['collapsed'] = null;
        if (children.length && !open) {
          const below: Immutable<Item>[] = [];
          const gather = (id: string) => kids(id).forEach(child => { below.push(child); gather(child.id); });
          gather(item.id);
          collapsed = { inside: below.length, waiting: below.filter(value => waitingOnOwner(session, value)).length, open: below.filter(value => value.status === 'open').length,
            progress: below.filter(value => value.status === 'in_progress' || display(value) === 'sent' || display(value) === 'queued').length, closed: below.filter(value => closed(value.status)).length };
        }
        const parked = item.status === 'open' && later.has(item.id);
        const replacedBy = item.replaced_by && !itemRemoved(session, item.replaced_by) ? session.items[item.replaced_by] ?? null : null;
        const matches = matchFields(item, parked, replacedBy, terms);
        built.push({ kind: 'item', key: item.id, item, sessionClosed: closedSessionQuestion(session, item), status: display(item), ack: ackTarget(session, item), depth, hasKids: children.length > 0 || placed, expanded: open,
          hidden: hidden.has(item.id), context: filtering && !matched.has(item.id) && !forced.has(item.id), outside: filtering && forced.has(item.id) && !matched.has(item.id), later: parked,
          segments: matches.includes('question') ? hitSegments(item.question, terms) : [{ text: item.question, hit: false }], matches,
          replacedBy,
          relatedCount: connectedItems(session, item.id).length,
          collapsed, delivery: deliveryLine(session, { topicId: item.topic_id, itemId: item.id }, input.presence, input.health), badge: badgeLabel(item, parked, display(item)) });
        if (open) walk(children, depth + 1, item.id);
      };
      // Each run of consecutive omitted siblings with the same reason is one strip, in place; hidden siblings follow the
      // others as one group. A focused root the filter excludes is its own "not matching" strip, not part of "outside the focus".
      let run: Immutable<Item>[] = [], runReason: StripReason = 'filter';
      const flush = () => {
        if (run.length) strip(run, runReason, false);
        run = [];
      };
      const hiddenSiblings: Immutable<Item>[] = [];
      for (const item of list) {
        if (nextGhost < ghosts.length && ghosts[nextGhost]!.order < item.ordinal) { flush(); ghostsBefore(item.ordinal); }
        const reason = omitted(item);
        if (reason) {
          if (run.length && reason !== runReason) flush();
          runReason = reason;
          run.push(item);
        }
        else if (explicitHidden.has(item.id)) hiddenSiblings.push(item);
        else { flush(); emit(item); }
      }
      flush();
      ghostsBefore(Number.POSITIVE_INFINITY);
      if (hiddenSiblings.length) {
        strip(hiddenSiblings, 'hidden', groupOpen);
        if (groupOpen) hiddenSiblings.forEach(emit);
      }
    };
    walk(roots, 1, null);
  }
  topicPlacesBefore(Number.POSITIVE_INFINITY);

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
      const x = columnX(parent.depth), width = COLUMN_STEP;
      // Only the on guides (the accent thread to the selection) are drawn: the tinted boxes carry the rest of the structure.
      guides.push({ kind: 'line', x, on: false, width, fromBullet: at === parentAt, toBullet: at === end });
      const child = at !== parentAt && row.depth === parent.depth + 1;
      if (child) guides.push({ kind: 'elbow', x, on: false, width });
      const chainIndex = chainAt.indexOf(parentAt), next = chainAt[chainIndex + 1];
      if (threaded && chainIndex >= 0 && next !== undefined && at <= next) {
        guides.push({ kind: 'line', x, on: true, width, fromBullet: at === parentAt, toBullet: at === next });
        if (at === next) guides.push({ kind: 'elbow', x, on: true, width });
      }
    }
    return { ...row, guides } as Row;
  });
  // The box pass is the last step: each row's branch slot and its slice of every box around it. Then a row equal to the
  // previous build's row for its key is that row again (F6c), and the list is the previous list when every row is.
  const rows = reuseRows(input.previous, withBoxes(withGuides));

  // hasReveal (Ariadne.dc.html:2169): only a reveal raises the banner, not a plain selection.
  const outside = filtering && rows.length > 0 && revealIds.some(id => forced.has(id) && !matched.has(id));
  // Matches the rows do not show (SPEC §6.9): not counted, but named in the note, and "Show them" opens their way.
  // An item the filters leave out is neither: the filters chose not to show it.
  // A match the focus leaves out is counted apart ("N outside the focus"); "Show them" then leaves the focus too.
  let hiddenMatches = 0, collapsedMatches = 0, outsideFocus = 0;
  const reveal = { items: new Set<string>(), topics: new Set<string>(), groups: new Set<string>() };
  const shownIds = new Set(rows.flatMap(row => row.kind === 'item' ? [row.key] : []));
  const rootOf = (id: string) => { const chain = ancestors(id); return chain.at(-1) ?? id; };
  if (terms.length) {
    for (const item of live) {
      if (shownIds.has(item.id) || filtering && !include.has(item.id)) continue;
      // The same fields as the rows: an outcome counts only where the row would show it.
      const parked = item.status === 'open' && later.has(item.id);
      const replacedBy = item.replaced_by && !itemRemoved(session, item.replaced_by) ? session.items[item.replaced_by] ?? null : null;
      if (matchFields(item, parked, replacedBy, terms).length === 0) continue;
      if (focusRootId && rootOf(item.id) !== focusRootId) outsideFocus++;
      else if (hidden.has(item.id)) hiddenMatches++;
      else collapsedMatches++;
      if (hidden.has(item.id)) hiddenGroupsFor(session, explicitHidden, item.id).forEach(key => reveal.groups.add(key));
      ancestors(item.id).forEach(id => reveal.items.add(id));
      reveal.topics.add(item.topic_id);
    }
  }
  // The filter's hidden matches (the strip's note): the same split as the search's, but over the items the filter matches, and "shown"
  // keeps apart what only the filter's own reveal holds open from what the owner, the search or a selection opened.
  let remaining = 0, shownByReveal = 0, outsideFilter = 0;
  const wanted = { items: new Set<string>(), topics: new Set<string>(), groups: new Set<string>() };
  if (filtering) {
    for (const item of live) {
      if (!matched.has(item.id) || !hidden.has(item.id)) continue;
      if (focusRootId && rootOf(item.id) !== focusRootId) { outsideFilter++; continue; }
      const keys = hiddenGroupsFor(session, explicitHidden, item.id), above = ancestors(item.id);
      const foldedAbove = above.filter(id => input.filterCollapsedItemIds?.has(id)), topicFolded = !!input.filterCollapsedTopicIds?.has(item.topic_id);
      if (shownIds.has(item.id)) {
        const heldByFilter = keys.some(key => shownByFilter.groups.includes(key) && !openElsewhere.has(key))
          || foldedAbove.some(id => shownByFilter.items.includes(id)) || (topicFolded && shownByFilter.topics.includes(item.topic_id));
        if (heldByFilter) shownByReveal++;
        continue;
      }
      remaining++;
      keys.forEach(key => wanted.groups.add(key));
      foldedAbove.forEach(id => wanted.items.add(id));
      if (topicFolded) wanted.topics.add(item.topic_id);
    }
  }
  return { rows, filtering, outside, noMatch: live.length > 0 && rows.length === 0, empty: Object.keys(session.items).length === 0 && !Object.values(session.topics).some(topic => topic?.removed_at),
    search: { hidden: hiddenMatches, collapsed: collapsedMatches, outsideFocus, reveal: { items: [...reveal.items], topics: [...reveal.topics], groups: [...reveal.groups] } },
    filterHidden: { remaining, shown: shownByReveal, outside: outsideFilter, reveal: { items: [...wanted.items], topics: [...wanted.topics], groups: [...wanted.groups] } } };
}

// ---------------------------------------------------------------- reuse (F6c)

/**
 * Row fields compared by identity. A session read that changed nothing in an item keeps the item object (SessionStore's
 * equality contract), so the same object means the same item; a new revision brings new objects, and those rows redraw.
 */
const BY_IDENTITY: ReadonlySet<string> = new Set(['item', 'replacedBy', 'topic']);
const plainObject = (value: object): boolean => { const proto = Object.getPrototypeOf(value) as unknown; return proto === Object.prototype || proto === null; };
/**
 * Plain values by value; arrays and plain objects of them member by member, two levels down (a guide list, a strip's covers).
 * Any other object (a Date, Set, Map or class instance) is the same only when it is the same instance: its keys say nothing about it.
 */
function sameValue(a: unknown, b: unknown, depth = 2): boolean {
  if (Object.is(a, b)) return true;
  if (depth === 0 || typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, at) => sameValue(value, b[at], depth - 1));
  }
  if (!plainObject(a) || !plainObject(b)) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>, keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => key in right && sameValue(left[key], right[key], depth - 1));
}
/** Whether two builds of a row draw the same: scalars by value, the domain objects by identity, the nested lists and records by their values. */
export function sameRow(a: Row, b: Row): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind || a.key !== b.key) return false;
  const left = a as unknown as Record<string, unknown>, right = b as unknown as Record<string, unknown>, keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every(key => key in right && (BY_IDENTITY.has(key) ? left[key] === right[key] : sameValue(left[key], right[key])));
}
/** `rows` with each row that equals the previous build's row for its key replaced by that row; `previous` itself when every row does. */
export function reuseRows(previous: readonly Row[] | undefined, rows: readonly Row[]): readonly Row[] {
  if (!previous?.length) return rows;
  const byKey = new Map(previous.map(row => [row.key, row]));
  let same = previous.length === rows.length;
  const next = rows.map((row, at) => {
    const kept = byKey.get(row.key), value = kept && sameRow(kept, row) ? kept : row;
    if (value !== previous[at]) same = false;
    return value;
  });
  return same ? previous : next;
}

/** The row ← moves to: the parent item, or the topic of a root item. */
export function parentKey(row: Row): string | null {
  if (row.kind === 'topic') return null;
  if (row.kind === 'strip') return row.parent ?? row.topicId;
  return row.item.parent ?? row.item.topic_id;
}
