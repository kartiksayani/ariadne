import { removedSubtree, itemRemoved, removedRoots } from '../../selectors/removed';
import type { PlaceStrip } from '../tree/model';
import type { Archived } from '../shared/useSessionLifecycle';
// Remove (handoff README "Remove", Ariadne.dc.html:1255-1368) as data: what a
// pending removal hides, the dialog subject of an item or topic, the note's
// label and the row selected after an item goes. Nothing here touches React.
import { indexSession, type Immutable } from '../../data';
import type { SessionPreferences, SessionRef } from '../../generated/core';
import type { Input, Item, Session, Topic } from '../../generated/domain/models';
import type { RemoveSubject, RemoveTarget, RemoveTell, RemoveUnsent } from '../dialogs/remove';
import { agentName, sessionPhrase } from '../shell/model';
import { shortLabel } from '../shared/short';
import { waitingOnOwner } from '../../selectors/sessionClosed';

const sessionPart = (route: SessionRef) => `${route.project_id}/${route.session_id}`;
/** The key a pending removal hides; an item key hides everything below it too. */
export const hiddenKey = {
  project: (projectId: string) => `p:${projectId}`,
  session: (route: SessionRef) => `s:${sessionPart(route)}`,
  topic: (route: SessionRef, topicId: string) => `t:${sessionPart(route)}/${topicId}`,
  item: (route: SessionRef, itemId: string) => `i:${sessionPart(route)}/${itemId}`,
};

export function targetKey(target: RemoveTarget): string {
  if (target.kind === 'project') return hiddenKey.project(target.project_id);
  if (target.kind === 'session') return hiddenKey.session(target.session);
  if (target.kind === 'topic') return hiddenKey.topic(target.session, target.topic_id);
  return hiddenKey.item(target.item, target.item.item_id);
}
export const targetSession = (target: Exclude<RemoveTarget, { kind: 'project' }>): SessionRef =>
  target.kind === 'item' ? { project_id: target.item.project_id, session_id: target.item.session_id } : target.session;

/** What the pending removals hide until they run or are undone. */
export class Hidden {
  constructor(readonly keys: ReadonlySet<string> = new Set()) {}
  get empty(): boolean { return this.keys.size === 0; }
  project(projectId: string): boolean { return this.keys.has(hiddenKey.project(projectId)); }
  session(route: SessionRef): boolean { return this.project(route.project_id) || this.keys.has(hiddenKey.session(route)); }
  topic(route: SessionRef, topicId: string): boolean { return this.session(route) || this.keys.has(hiddenKey.topic(route, topicId)); }
  /** The item, an item above it or its topic is being removed. */
  item(route: SessionRef, session: Immutable<Session>, itemId: string): boolean {
    const item = session.items[itemId];
    if (!item) return this.session(route) || this.keys.has(hiddenKey.item(route, itemId));
    if (this.topic(route, item.topic_id)) return true;
    for (let id: string | null = itemId; id; id = session.items[id]?.parent ?? null) if (this.keys.has(hiddenKey.item(route, id))) return true;
    return false;
  }
}
export const NOTHING_HIDDEN = new Hidden();

/** The session without the items and topics a pending removal hides; the same object when it hides none. */
export function visibleSession(session: Immutable<Session>, route: SessionRef, hidden: Hidden): Immutable<Session> {
  if (hidden.empty) return session;
  const items = Object.entries(session.items).filter(([id]) => !hidden.item(route, session, id));
  const topics = Object.entries(session.topics).filter(([id]) => !hidden.topic(route, id));
  if (items.length === Object.keys(session.items).length && topics.length === Object.keys(session.topics).length) return session;
  return { ...session, items: Object.fromEntries(items), topics: Object.fromEntries(topics) } as Immutable<Session>;
}

const itemList = (session: Immutable<Session>) => Object.values(session.items).filter((item): item is Immutable<Item> => !!item);
/** The item and every item below it. */
export function subtree(session: Immutable<Session>, itemId: string): readonly Immutable<Item>[] {
  return removedSubtree(session, itemId);
}

/** How the session's agent learns about an item or topic removal (Ariadne.dc.html:1276 rmTell). */
export function tellOf(session: Immutable<Session>): NonNullable<RemoveTell> {
  const binding = session.active_binding_id ? session.bindings[session.active_binding_id] : null;
  const agent = binding ? agentName(binding.adapter_id) : 'the agent';
  return { agent, mode: session.state === 'closed' ? 'closed' : binding?.connection_state === 'connected' ? 'tell' : 'queued' };
}

const waitingCount = (session: Immutable<Session>, items: readonly Immutable<Item>[]) => items.filter(item => waitingOnOwner(session, item)).length;
const topicName = (topic: Immutable<Topic>) => topic.short?.trim() || topic.name;

/** Queued messages are cancelled; words already cancelled by agent removal are permanently deleted. */
export function unsentOf(sessions: readonly Immutable<Session>[], within: (input: Immutable<Input>) => boolean = () => true): RemoveUnsent {
  const agents = new Set<string>();
  let count = 0, cancelled = 0;
  for (const session of sessions) for (const input of Object.values(session.inputs)) {
    if (!input || !within(input)) continue;
    if (input.kind !== 'removed' && input.state === 'cancelled' && input.cancel_cause === 'agent_removed') cancelled++;
    if (input.state !== 'queued') continue;
    count++;
    const binding = session.bindings[input.binding_id];
    agents.add(binding ? agentName(binding.adapter_id) : 'the agent');
  }
  return { count, agent: agents.size === 1 ? [...agents][0]! : 'the agent', ...(cancelled ? { cancelled } : {}) };
}

/** The Remove dialog subject of an item or topic in `session`; null when it is gone. */
export function removeSubject(session: Immutable<Session>, target: Extract<RemoveTarget, { kind: 'item' | 'topic' }>): RemoveSubject | null {
  if (target.kind === 'item') {
    const item = session.items[target.item.item_id];
    if (!item) return null;
    const items = subtree(session, item.id), ids = new Set(items.map(value => value.id)), removed = itemRemoved(session, item.id);
    return { kind: 'item', short: shortLabel(item), items: items.length, waiting: waitingCount(session, removed ? items : items.filter(value => !itemRemoved(session, value.id))), tell: tellOf(session), removed,
      unsent: unsentOf([session], input => !!input.target.item_id && ids.has(input.target.item_id)) };
  }
  const topic = session.topics[target.topic_id];
  if (!topic) return null;
  const items = itemList(session).filter(item => item.topic_id === topic.id);
  const removed = !!topic.removed_at;
  return { kind: 'topic', name: topicName(topic), items: items.length, waiting: waitingCount(session, removed ? items : items.filter(value => !itemRemoved(session, value.id))), tell: tellOf(session), removed,
    unsent: unsentOf([session], input => input.target.topic_id === topic.id) };
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const capital = (text: string) => text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
/** What the note names after "Removed " (Ariadne.dc.html:1299-1311 `label`). */
export function removeLabel(subject: RemoveSubject): string {
  if (subject.kind === 'item') return `“${capital(subject.short)}”${subject.items > 1 ? ` and ${plural(subject.items - 1, 'item')} below it` : ''}`;
  if (subject.kind === 'topic') return `the topic “${subject.name}”`;
  if (subject.kind === 'session') return sessionPhrase({ name: subject.name }, subject.agent, subject.when);
  return subject.name;
}

/**
 * The item selected once `itemId` goes: the row after it and everything below
 * it in the same topic, else its parent, else none. Rows follow the tree's
 * order and the view's expansion.
 */
export function nextSelection(session: Immutable<Session>, view: Immutable<SessionPreferences>, itemId: string): string | null {
  const item = session.items[itemId];
  if (!item) return null;
  const { childrenByParent } = indexSession(session), expanded = new Set(view.expanded_item_ids);
  const rows: Immutable<Item>[] = [];
  const walk = (list: readonly Immutable<Item>[]) => list.forEach(row => {
    rows.push(row);
    if (row.id === itemId || expanded.has(row.id)) walk(childrenByParent.get(row.id) ?? []);
  });
  walk((childrenByParent.get(null) ?? []).filter(root => root.topic_id === item.topic_id));
  const gone = new Set(subtree(session, itemId).map(value => value.id));
  const at = rows.findIndex(row => row.id === itemId);
  const next = rows.slice(at + 1).find(row => !gone.has(row.id));
  return next?.id ?? item.parent ?? null;
}

/**
 * The Map's strips in the place of rows it no longer shows (E29, E32, E33): items and topics in a pending removal's Undo
 * window, what the agent removed (while it is in the bin), and the topic archived this visit. `archivedView` (the
 * Archive filter) shows archived topics as rows, so no archive strip and no strips for removed topics there.
 */
export function placeStrips(session: Immutable<Session>, route: SessionRef, hidden: Hidden, archived: Archived | null, archivedView = false): readonly PlaceStrip[] {
  const binding = session.active_binding_id ? session.bindings[session.active_binding_id] : null;
  const agent = binding ? agentName(binding.adapter_id) : 'The agent';
  const topicItems = (topicId: string) => itemList(session).filter(item => item.topic_id === topicId);
  const topicPlace = (topic: Immutable<Topic>, reason: PlaceStrip['reason']): PlaceStrip => {
    const items = topicItems(topic.id);
    return { reason, topicId: topic.id, itemId: null, parent: null, order: topic.order, name: topicName(topic), count: items.length,
      ...(reason === 'agent-removed' ? { agent } : {}), covers: [topic.id, ...items.map(item => item.id)] };
  };
  const itemPlace = (item: Immutable<Item>, reason: PlaceStrip['reason']): PlaceStrip => {
    const below = subtree(session, item.id);
    return { reason, topicId: item.topic_id, itemId: item.id, parent: item.parent, order: item.ordinal, name: shortLabel(item), count: below.length,
      ...(reason === 'agent-removed' ? { agent } : {}), covers: below.map(value => value.id) };
  };
  const places: PlaceStrip[] = [];
  for (const topic of Object.values(session.topics)) {
    if (!topic) continue;
    if (hidden.topic(route, topic.id)) { if (!hidden.session(route)) places.push(topicPlace(topic, 'removed')); continue; }
    if (topic.removed_at) { if (!archivedView) places.push(topicPlace(topic, 'agent-removed')); continue; }
    if (archived?.topicId === topic.id && topic.archived_at !== null) { places.push(topicPlace(topic, 'archived')); continue; }
    if ((topic.archived_at !== null) !== archivedView) continue;
    for (const root of removedRoots(session, topic.id)) if (!hidden.item(route, session, root.id)) places.push(itemPlace(root, 'agent-removed'));
    // A pending removal's root: hidden, with no hidden ancestor (an ancestor's strip covers it).
    for (const item of topicItems(topic.id)) {
      if (itemRemoved(session, item.id) || !hidden.keys.has(hiddenKey.item(route, item.id))) continue;
      if (item.parent && hidden.item(route, session, item.parent)) continue;
      places.push(itemPlace(item, 'removed'));
    }
  }
  return places;
}
