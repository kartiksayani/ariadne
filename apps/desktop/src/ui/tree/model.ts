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
import { normalizeSearch, sameOwner } from '../../selectors/tree/rows';
import { deliveryEvidence } from '../../selectors/waiting/delivery';
import { stuckInput, type Stuck } from '../../selectors/waiting/stuck';
import { deliveryLine as deliveryText, deliveryStage } from '../answer/delivery';
import { agentLine, agentName, dayWord, hostApp, ownerName, sessionLabel } from '../shell/model';
import { STATUS, statusKey, type StatusKey } from '../shared/status';
import { displayStatus, type DisplayStatus } from '../../selectors/waiting/replied';
import { continuedLabel } from '../shared/continued';
import { hiddenGroupKey, hiddenGroupsFor, hiddenItems } from './hidden';
import { agentRunning, connectionOf, type Connection } from '../shared/connection';
import { relatedItems } from '../../selectors/related';
import { ackTarget } from '../../selectors/ack';
import { FILTER_STATUSES, hasStatusFilter, matchExpansion } from '../../selectors/tree/folds';

export const visual = (status: DisplayStatus): StatusKey => statusKey[status];
const CLOSED: ReadonlySet<ItemStatus> = new Set(['decided', 'done', 'dropped', 'replaced']);
export const closed = (status: ItemStatus) => CLOSED.has(status);
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
/** Whether a status filter matches what a row shows: Waiting on agent counts as In progress, never as Waiting on me. */
export const statusIn = (statuses: readonly ItemStatus[], status: DisplayStatus) =>
  status === 'waiting_on_agent' ? statuses.includes('in_progress') : statuses.includes(status);
const inChip = (chip: Chip, status: DisplayStatus) => chip === 'all' || statusIn(CHIPS.find(value => value.chip === chip)!.statuses, status);

// ---------------------------------------------------------------- search

export interface Segment { readonly text: string; readonly hit: boolean }
const words = (query: string) => normalizeSearch(query).split(/\s+/u).filter(Boolean);
/** The question split into search hits and the rest (Ariadne.dc.html:1044). */
export function segments(text: string, query: string): readonly Segment[] {
  const terms = words(query);
  if (!terms.length) return [{ text, hit: false }];
  const lower = normalizeSearch(text), hit = new Array<boolean>(text.length).fill(false);
  // NFKC can change length; highlight only when it does not.
  if (lower.length !== text.length) return [{ text, hit: false }];
  for (const term of terms) for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + term.length)) hit.fill(true, at, at + term.length);
  const out: { text: string; hit: boolean }[] = [];
  for (let index = 0; index < text.length; index++) {
    const last = out.at(-1);
    if (last && last.hit === hit[index]) last.text += text[index]; else out.push({ text: text[index], hit: hit[index] });
  }
  return out;
}

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
  if (note) return { ...deliveryText('failed', input.kind, label, agent), failed: true, stuck: { input, note } };
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
  readonly through: boolean;
  readonly width: number;
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
  /** What the row shows: the item's status, or Waiting on agent once the owner replied. */
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
  readonly replacedBy: Immutable<Item> | null;
  readonly rounds: number;
  readonly relatedCount: number;
  readonly collapsed: { readonly waiting: number; readonly open: number; readonly progress: number; readonly closed: number; readonly ids: readonly string[] } | null;
  readonly delivery: Delivery | null;
  readonly badge: string;
}
export interface HiddenRow {
  readonly kind: 'hidden';
  readonly key: string;
  readonly topicId: string;
  readonly parent: string | null;
  readonly depth: number;
  readonly count: number;
  readonly waiting: boolean;
  readonly expanded: boolean;
  readonly guides: readonly Guide[];
  readonly delivery: null;
}
export type Row = TopicRow | ItemRow | HiddenRow;

export interface TreeInput {
  readonly session: Immutable<Session>;
  readonly view: Immutable<SessionPreferences>;
  /** The header search as typed, which can run ahead of the saved filter. */
  readonly search: string;
  readonly later: ReadonlySet<string>;
  readonly expandedHiddenGroups?: ReadonlySet<string>;
  readonly collapsedTopics: ReadonlySet<string>;
  readonly filterCollapsedItemIds?: ReadonlySet<string>;
  readonly filterCollapsedTopicIds?: ReadonlySet<string>;
  readonly selectedId: string | null;
  /** An item revealed from elsewhere (a link, the waiting panel). */
  readonly revealId: string | null;
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
  readonly filtering: boolean;
  readonly searchCount: number;
  readonly hiddenCount: number;
  readonly itemCount: number;
  /** "Showing an item outside your current filters." */
  readonly outside: boolean;
  readonly noMatch: boolean;
  /** The session has no items at all. */
  readonly empty: boolean;
  readonly chips: ReadonlySet<Chip>;
  readonly counts: Readonly<Record<Chip, number>>;
}

function topicChip(session: Immutable<Session>, topic: Immutable<Topic>, summaries: readonly Immutable<SessionSummary>[], now: number) {
  if (topic.origin) return { label: continuedLabel(topic.origin, summaries, now), title: 'Started in an earlier session, continued in this one' };
  const day = dayWord(Date.parse(session.created_at), now).toLowerCase();
  if (!day) return null;
  const binding = session.active_binding_id ? session.bindings[session.active_binding_id] : null;
  return { label: `${ownerName(session) ?? (binding ? agentName(binding.adapter_id) : 'Session')} · ${day}`, title: 'From an earlier session' };
}

export function topicCounts(statuses: readonly DisplayStatus[], ackCount = 0): Count[] {
  const count = (test: (status: DisplayStatus) => boolean) => statuses.filter(test).length;
  const waiting = count(status => status === 'waiting_on_me'), open = count(status => status === 'open');
  const agent = count(status => status === 'waiting_on_agent');
  const progress = count(status => status === 'in_progress'), done = count(status => status !== 'waiting_on_agent' && closed(status));
  return [
    waiting ? { icon: STATUS.waiting.icon, color: 'var(--st-waiting)', text: `${waiting} waiting on you` } : null,
    agent ? { icon: STATUS.agent.icon, color: 'var(--st-agent)', text: `${agent} waiting on agent` } : null,
    ackCount ? { icon: 'ph ph-check', color: 'var(--color-text)', text: `${ackCount} to ack` } : null,
    open ? { icon: STATUS.open.icon, color: 'var(--st-open)', text: `${open} open` } : null,
    progress ? { icon: STATUS.progress.icon, color: 'var(--st-progress)', text: `${progress} in progress` } : null,
    done ? { icon: STATUS.decided.icon, color: 'var(--st-decided)', text: `${done} closed` } : null,
  ].filter((value): value is Count => !!value);
}

/** "1 waiting · 2 open · 5 closed inside", plus " · 2 touched in #14" when the hovered message reaches inside. */
export function collapsedNote(collapsed: NonNullable<ItemRow['collapsed']>, touched: { readonly items: ReadonlySet<string>; readonly message: number | null } | null): string {
  const parts = [collapsed.waiting && `${collapsed.waiting} waiting`, collapsed.open && `${collapsed.open} open`,
    collapsed.progress && `${collapsed.progress} in progress`, collapsed.closed && `${collapsed.closed} closed`].filter(Boolean);
  const inside = touched ? collapsed.ids.filter(id => touched.items.has(id)).length : 0;
  return `${parts.join(' · ')} inside${inside && touched?.message ? ` · ${inside} touched in #${touched.message}` : ''}`;
}

export function badgeLabel(item: Immutable<Item>, later: boolean, status: DisplayStatus = item.status): string {
  if (item.status === 'open' && later) return 'Later';
  if (item.status === 'done' && item.type === 'explanation') return 'Explained';
  return STATUS[visual(status)].label;
}

export function treeModel(input: TreeInput): TreeModel {
  const { session, view, later, selectedId, revealId } = input, filters = view.filters;
  const indexes = indexSession(session), all = items(session);
  const explicitHidden = new Set(view.hidden_item_ids ?? []);
  const hidden = hiddenItems(session, explicitHidden);
  const hiddenGroups = new Set(input.expandedHiddenGroups ?? []);
  if (revealId) hiddenGroupsFor(session, explicitHidden, revealId).forEach(key => hiddenGroups.add(key));
  const terms = words(input.search);
  const chips = chipsOf(filters.statuses);
  const topics = topicList(session).filter(topic => filters.archived ? topic.archived_at !== null : topic.archived_at === null);
  const shown = new Set(topics.map(topic => topic.id));
  const live = all.filter(item => shown.has(item.topic_id));
  const base = (item: Immutable<Item>) => {
    if (filters.owners.length && !filters.owners.some(owner => sameOwner(owner, item.owner))) return false;
    if (filters.hide_later && later.has(item.id)) return false;
    if (!terms.length) return true;
    const text = normalizeSearch(`${item.question} ${item.outcome ?? ''}`);
    return terms.every(term => text.includes(term));
  };
  const shows = new Map(all.map(item => [item.id, displayStatus(session, item)]));
  const display = (item: Immutable<Item>) => shows.get(item.id) ?? item.status;
  const statusFiltered = !chips.has('all');
  const statusMatch = (item: Immutable<Item>) => !statusFiltered || statusIn(filters.statuses, display(item));
  const filtering = terms.length > 0 || statusFiltered || filters.owners.length > 0 || filters.hide_later;
  const scoped = live.filter(item => base(item));
  const counts = Object.fromEntries(CHIPS.map(({ chip: key }) => [key, scoped.filter(item => (!hidden.has(item.id) || key === 'waiting') && inChip(key, display(item))).length])) as Record<Chip, number>;

  // includeSets: matches, the forced reveal and selection, and their ancestors.
  const matched = new Set<string>(), forced = new Set<string>(), include = new Set<string>();
  const ancestors = (id: string) => { const out: string[] = []; for (let parent = session.items[id]?.parent; parent; parent = session.items[parent]?.parent) out.push(parent); return out; };
  if (filtering) {
    for (const id of [revealId, selectedId]) if (id && session.items[id] && !itemRemoved(session, id)) forced.add(id);
    for (const item of live) {
      const match = base(item) && statusMatch(item);
      if (match) matched.add(item.id);
      if (match || forced.has(item.id)) { include.add(item.id); ancestors(item.id).forEach(id => include.add(id)); }
    }
  }
  const expanded = matchExpansion(view.expanded_item_ids, input.temporaryExpanded,
    [...include].flatMap(ancestors), filtering, input.filterCollapsedItemIds);
  const revealTopic = revealId ? session.items[revealId]?.topic_id : undefined;
  if (revealId) ancestors(revealId).forEach(id => expanded.add(id));
  const kids = (id: string | null) => indexes.childrenByParent.get(id) ?? [];
  const rootsOf = (topicId: string) => kids(null).filter(item => item.topic_id === topicId);

  const built: (Omit<TopicRow, 'guides'> | Omit<ItemRow, 'guides'> | Omit<HiddenRow, 'guides'>)[] = [];
  for (const topic of topics) {
    const roots = rootsOf(topic.id);
    // A topic with no items yet (or none left) still shows its band; filters hide topics without a match.
    // A session with no items at all shows its empty state instead (frame 1g).
    if (filtering && !roots.some(item => include.has(item.id))) continue;
    const open = topic.id === revealTopic || (filtering ? !input.filterCollapsedTopicIds?.has(topic.id) : !input.collapsedTopics.has(topic.id));
    const topicItems = all.filter(item => item.topic_id === topic.id), statuses = topicItems.map(display);
    const chipValue = topicChip(session, topic, input.summaries, input.now);
    const delivery = deliveryLine(session, { topicId: topic.id, itemId: null }, input.presence, input.health);
    built.push({ kind: 'topic', key: topic.id, topic, depth: 0, expanded: open, first: built.length === 0, counts: topicCounts(statuses, topicItems.filter(item => ackTarget(session, item)).length),
      earlier: !topic.origin && !!chipValue, chip: chipValue, allClosed: !delivery && statuses.length > 0 && statuses.every(status => status !== 'waiting_on_agent' && closed(status)), delivery });
    if (!open) continue;
    const walk = (list: readonly Immutable<Item>[], depth: number) => {
      const eligible = list.filter(item => !filtering || include.has(item.id));
      const visibleSiblings = eligible.filter(item => !explicitHidden.has(item.id));
      const hiddenSiblings = eligible.filter(item => explicitHidden.has(item.id));
      const firstHidden = hiddenSiblings[0];
      const groupKey = hiddenGroupKey(topic.id, list[0]?.parent ?? null);
      const groupOpen = hiddenGroups.has(groupKey);
      for (const item of [...visibleSiblings, ...hiddenSiblings]) {
        if (item === firstHidden) {
          const below: Immutable<Item>[] = [];
          const gather = (value: Immutable<Item>) => { below.push(value); kids(value.id).forEach(gather); };
          hiddenSiblings.forEach(gather);
          built.push({ kind: 'hidden', key: groupKey, topicId: topic.id, parent: item.parent, depth,
            count: hiddenSiblings.length, waiting: below.some(value => display(value) === 'waiting_on_me'),
            expanded: groupOpen, delivery: null });
        }
        if (explicitHidden.has(item.id) && !groupOpen) continue;
        const children = kids(item.id);
        const open = children.length > 0 && expanded.has(item.id);
        let collapsed: ItemRow['collapsed'] = null;
        if (children.length && !open) {
          const below: Immutable<Item>[] = [];
          const gather = (id: string) => kids(id).forEach(child => { below.push(child); gather(child.id); });
          gather(item.id);
          collapsed = { waiting: below.filter(value => display(value) === 'waiting_on_me').length, open: below.filter(value => value.status === 'open').length,
            progress: below.filter(value => value.status === 'in_progress' || display(value) === 'waiting_on_agent').length, closed: below.filter(value => closed(value.status)).length, ids: below.map(value => value.id) };
        }
        const parked = item.status === 'open' && later.has(item.id);
        built.push({ kind: 'item', key: item.id, item, status: display(item), ack: ackTarget(session, item), depth, hasKids: children.length > 0, expanded: open,
          hidden: hidden.has(item.id), context: filtering && !matched.has(item.id) && !forced.has(item.id), later: parked, segments: segments(item.question, input.search),
          replacedBy: item.replaced_by && !itemRemoved(session, item.replaced_by) ? session.items[item.replaced_by] ?? null : null, rounds: indexes.roundsByItem.get(item.id)?.length ?? 0,
          relatedCount: relatedItems(session, item.id).length,
          collapsed, delivery: deliveryLine(session, { topicId: item.topic_id, itemId: item.id }, input.presence, input.health), badge: badgeLabel(item, parked, display(item)) });
        if (open) walk(children, depth + 1);
      }
    };
    walk(roots, 1);
  }

  // Guides and the accent thread to the selection (Ariadne.dc.html:1801-1817).
  const index = new Map(built.map((row, at) => [row.key, at]));
  const selected = selectedId ? session.items[selectedId] : undefined;
  const chain = selected ? [selected.topic_id, ...ancestors(selected.id).reverse(), selected.id] : [];
  const chainAt = chain.map(key => index.get(key));
  const threaded = chainAt.length > 0 && chainAt.every(value => value !== undefined);
  const cont = (at: number, depth: number) => {
    for (let next = at + 1; next < built.length; next++) {
      const d = built[next].depth;
      if (d <= depth) return false;
      if (d === depth + 1) return true;
    }
    return false;
  };
  const rows = built.map((row, at): Row => {
    const guides: Guide[] = [];
    const width = row.kind === 'item' && row.hasKids ? 14 : 36;
    for (let k = 0; k < row.depth; k++) {
      const x = 20 + k * 24, through = cont(at, k);
      if (k === row.depth - 1) guides.push({ kind: 'elbow', x, on: false, through, width });
      if (through) guides.push({ kind: 'line', x, on: false, through, width });
      if (threaded && k + 1 < chainAt.length && chainAt[k]! < at && at <= chainAt[k + 1]!) {
        guides.push(at === chainAt[k + 1] ? { kind: 'elbow', x, on: true, through: false, width } : { kind: 'line', x, on: true, through: false, width });
      }
    }
    return { ...row, guides } as Row;
  });

  // hasReveal (Ariadne.dc.html:2169): only a reveal raises the banner, not a plain selection.
  const outside = filtering && rows.length > 0 && !!revealId && forced.has(revealId) && !matched.has(revealId);
  return { rows, filtering, searchCount: scoped.filter(item => !hidden.has(item.id) && statusMatch(item)).length, hiddenCount: scoped.filter(item => hidden.has(item.id) && statusMatch(item)).length, itemCount: live.filter(item => !hidden.has(item.id)).length, outside, noMatch: live.length > 0 && rows.length === 0, empty: Object.keys(session.items).length === 0 && !Object.values(session.topics).some(topic => topic?.removed_at), chips, counts };
}

/** The row ← moves to: the parent item, or the topic of a root item. */
export function parentKey(row: Row): string | null {
  if (row.kind === 'topic') return null;
  if (row.kind === 'hidden') return row.parent ?? row.topicId;
  return row.item.parent ?? row.item.topic_id;
}

/** The oldest item waiting on the owner in this session; one the owner already replied to waits on the agent. */
export function oldestWaiting(session: Immutable<Session>): Immutable<Item> | null {
  return items(session).filter(item => displayStatus(session, item) === 'waiting_on_me' && session.topics[item.topic_id]?.archived_at === null)
    .sort((a, b) => (a.waiting_since ?? a.created_at).localeCompare(b.waiting_since ?? b.created_at))[0] ?? null;
}
