import type { PreferencesPatchEntry, PreferencesSnapshot, SessionRef, SessionSeen } from '../../generated/core';
import type { Immutable } from '../../data/session-store';

export type SeenPatch = Extract<PreferencesPatchEntry, { kind: 'mark_seen' }>;
const sameSession = (a: SessionRef, b: SessionRef) => a.project_id === b.project_id && a.session_id === b.session_id;

/** Seen state is read through the existing navigation preference subscription. */
export function sessionSeen(preferences: Immutable<PreferencesSnapshot> | null, session: SessionRef): Immutable<SessionSeen> | null {
  return preferences?.seen?.find(value => sameSession(value.session, session)) ?? null;
}

/** Reflect a confirmed monotonic patch without waiting for the next preferences read. */
export function applySeen(preferences: PreferencesSnapshot, entry: SeenPatch): void {
  const seen = preferences.seen ??= [];
  let current = seen.find(value => sameSession(value.session, entry.session));
  if (!current) {
    current = { session: structuredClone(entry.session), since: entry.at, items: [], topics: [] };
    seen.push(current);
  }
  mergeSeen(current, entry);
}

function mergeSeen(current: Pick<SessionSeen, 'items' | 'topics'>, entry: SeenPatch): void {
  for (const item of entry.items) {
    const saved = current.items.find(value => value.item_id === item.item_id);
    if (saved) saved.revision = Math.max(saved.revision, item.revision);
    else current.items.push(structuredClone(item));
  }
  for (const topic of entry.topics) {
    const saved = current.topics.find(value => value.topic_id === topic.topic_id);
    if (saved) { if (Date.parse(topic.at) > Date.parse(saved.at)) saved.at = topic.at; }
    else current.topics.push(structuredClone(topic));
  }
}

/** One entry per session; the first queued time remains the initial baseline. */
export function queueSeen(queue: Map<string, SeenPatch>, entry: SeenPatch): void {
  const key = JSON.stringify([entry.session.project_id, entry.session.session_id]);
  const current = queue.get(key);
  if (!current) { queue.set(key, structuredClone(entry)); return; }
  // Use the same upward-only merge for repeated item/topic observations.
  mergeSeen(current, entry);
}
