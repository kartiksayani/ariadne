import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { PreferencesSnapshot, SessionRef, SessionSeen } from '../../generated/core';
import type { Immutable } from '../../data/session-store';
import { queueSeen, sessionSeen, type SeenPatch } from './seen';

const key = (route: SessionRef) => JSON.stringify([route.project_id, route.session_id]);
const EMPTY: readonly SeenPatch[] = Object.freeze([]);
/** How long Mark all caught up can be undone before it is saved (SPEC 6.6). */
export const CATCH_UP_UNDO_MS = 8000;

/** Immediate shared display of background reads; catch-up can be undone before its monotonic write. */
export class ReadingLane {
  private readonly marked = new Map<string, SeenPatch>();
  private readonly pending = new Map<string, { entry: SeenPatch; timer: ReturnType<typeof setTimeout> }>();
  private readonly listeners = new Set<() => void>();
  private snapshot: readonly SeenPatch[] = EMPTY;
  private markedSnapshot: readonly SeenPatch[] = EMPTY;
  constructor(private readonly save: (entry: SeenPatch) => void) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  /** Real reads and completed catch-up only; a pending Undo never suppresses dwell. */
  getMarkedSnapshot = () => this.markedSnapshot;
  private publish() {
    const marked = [...this.marked.values()];
    if (marked.length !== this.markedSnapshot.length || marked.some((entry, index) => entry !== this.markedSnapshot[index])) this.markedSnapshot = marked;
    this.snapshot = [...marked, ...[...this.pending.values()].map(value => value.entry)];
    this.listeners.forEach(listener => listener());
  }
  reconcile(preferences: Immutable<PreferencesSnapshot> | null) {
    let changed = false;
    for (const [sessionKey, entry] of this.marked) {
      const stored = sessionSeen(preferences, entry.session);
      if (!stored) continue;
      const reads = new Map(stored.items.map(item => [item.item_id, item.revision]));
      const topics = new Map(stored.topics.map(topic => [topic.topic_id, Date.parse(topic.at)]));
      const items = entry.items.filter(item => (reads.get(item.item_id) ?? 0) < item.revision);
      const remainingTopics = entry.topics.filter(topic => (topics.get(topic.topic_id) ?? -Infinity) < Date.parse(topic.at));
      if (items.length === entry.items.length && remainingTopics.length === entry.topics.length) continue;
      changed = true;
      if (items.length || remainingTopics.length) this.marked.set(sessionKey, { ...entry, items, topics: remainingTopics });
      else this.marked.delete(sessionKey);
    }
    if (changed) this.publish();
  }
  mark(entry: SeenPatch) {
    const previous = this.marked.get(key(entry.session));
    if (previous) {
      const reads = new Map(previous.items.map(item => [item.item_id, item.revision]));
      const topics = new Map(previous.topics.map(topic => [topic.topic_id, Date.parse(topic.at)]));
      if (Date.parse(entry.at) >= Date.parse(previous.at)
        && entry.items.every(item => (reads.get(item.item_id) ?? 0) >= item.revision)
        && entry.topics.every(topic => (topics.get(topic.topic_id) ?? -Infinity) >= Date.parse(topic.at))) return false;
    }
    queueSeen(this.marked, entry);
    this.publish();
    this.save(entry);
    return true;
  }
  catchUp(entry: SeenPatch, topicId = entry.topics[0]?.topic_id): string {
    const token = `${key(entry.session)}:${topicId}`;
    // A second shortcut commits the first action rather than silently dropping it.
    this.finish(token);
    const timer = setTimeout(() => this.finish(token), CATCH_UP_UNDO_MS);
    this.pending.set(token, { entry, timer });
    this.publish();
    return token;
  }
  undoToken(route: SessionRef, topicId: string): string | null {
    const token = `${key(route)}:${topicId}`;
    return this.pending.has(token) ? token : null;
  }
  canUndo(token: string) { return this.pending.has(token); }
  undo(token: string) {
    const value = this.pending.get(token);
    if (!value) return;
    clearTimeout(value.timer);
    this.pending.delete(token);
    this.publish();
  }
  private finish(token: string) {
    const value = this.pending.get(token);
    if (!value) return;
    clearTimeout(value.timer);
    this.pending.delete(token);
    if (!this.mark(value.entry)) this.publish();
  }
  stop() {
    // Preserve an authorized action when the app closes during Undo's window.
    for (const token of this.pending.keys()) this.finish(token);
    this.listeners.clear();
  }
}

export function useReadingSeen(lane: ReadingLane | undefined, preferences: Immutable<PreferencesSnapshot> | null, route: SessionRef, includePending = true): Immutable<SessionSeen> | null {
  const patches = useSyncExternalStore(lane?.subscribe ?? (() => () => {}), (includePending ? lane?.getSnapshot : lane?.getMarkedSnapshot) ?? (() => EMPTY), (includePending ? lane?.getSnapshot : lane?.getMarkedSnapshot) ?? (() => EMPTY));
  const projectId = route.project_id, sessionId = route.session_id;
  useEffect(() => { lane?.reconcile(preferences); }, [lane, preferences]);
  return useMemo(() => {
    const session = { project_id: projectId, session_id: sessionId };
    const stored = sessionSeen(preferences, session);
    if (!stored) return null; // Keep the upgrade baseline owned by navigation.
    const relevant = patches.filter(patch => key(patch.session) === key(session));
    if (!relevant.length) return stored;
    const items = new Map(stored.items.map(item => [item.item_id, item.revision]));
    const topics = new Map(stored.topics.map(topic => [topic.topic_id, topic.at]));
    for (const patch of relevant) {
      for (const item of patch.items) items.set(item.item_id, Math.max(items.get(item.item_id) ?? 0, item.revision));
      for (const topic of patch.topics) if (Date.parse(topic.at) > Date.parse(topics.get(topic.topic_id) ?? '') || !topics.has(topic.topic_id)) topics.set(topic.topic_id, topic.at);
    }
    return { ...stored, items: [...items].map(([item_id, revision]) => ({ item_id, revision })),
      topics: [...topics].map(([topic_id, at]) => ({ topic_id, at })) };
  }, [preferences, patches, projectId, sessionId]);
}
