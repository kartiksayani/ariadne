import { useEffect, useMemo } from 'react';
import type { Immutable } from '../../data/session-store';
import type { Session } from '../../generated/domain/models';
import type { SeenState } from '../../selectors/changes/seen';
import { activeItems } from '../../selectors/removed';
import type { NavigationStore } from '../../state/navigation/store';

/** One topic observation pass, independent of topic folds or filtered rows. */
export function caughtUpTopics(session: Immutable<Session>, seen: SeenState): readonly string[] {
  if (!seen) return [];
  const reads = new Map(seen.items.map(item => [item.item_id, item.revision]));
  const marks = new Map(seen.topics.map(topic => [topic.topic_id, Date.parse(topic.at)]));
  const changed = new Set<string>(), unseen = new Set<string>();
  const since = Date.parse(seen.since);
  for (const item of activeItems(session)) {
    if (session.topics[item.topic_id]?.archived_at != null) continue;
    const at = marks.get(item.topic_id) ?? since;
    if (Date.parse(item.created_at) > at) {
      changed.add(item.topic_id);
      if (!reads.has(item.id)) unseen.add(item.topic_id);
    }
    for (const record of item.changes ?? []) if (!record.wording_only && Date.parse(record.at) > at) {
      changed.add(item.topic_id);
      if (record.revision > (reads.get(item.id) ?? 0)) unseen.add(item.topic_id);
    }
  }
  return [...changed].filter(id => !unseen.has(id));
}

export function useImplicitCaughtUp(navigation: NavigationStore, session: Immutable<Session> | undefined, seen: SeenState, ready = true) {
  const topics = useMemo(() => session && ready ? caughtUpTopics(session, seen) : [], [session, seen, ready]);
  useEffect(() => {
    if (!session) return;
    const route = { project_id: session.project_id, session_id: session.id };
    for (const topic of topics) if (!navigation.reading.undoToken(route, topic)) navigation.markTopicCaughtUp(route, topic, session.revision);
  }, [navigation, session, topics]);
}
