import { useCallback, useEffect, useState } from 'react';
import type { ItemRef } from '../../generated/domain/primitives/ItemRef';

/**
 * What Details shows (alpha.21 E5): the selected item, or a topic's own conversation. A topic is a separate mode, not a
 * selection: the Map's selection stays where it was.
 */
export type DetailTarget = { readonly kind: 'item'; readonly id: ItemRef } | { readonly kind: 'topic'; readonly topicId: string };

/** Opens Details in topic mode on `topicId`, in the session on screen. Passed to the Tree and to the notice hooks. */
export type OpenTopicInDetails = (topicId: string) => void;

export interface DetailTargetState {
  /** The item or topic Details shows; null when no item is selected and no topic is open. */
  readonly target: DetailTarget | null;
  readonly openTopicInDetails: OpenTopicInDetails;
  /** Leaves topic mode for the selected item. A session switch or a new selection does this already. */
  readonly showItem: () => void;
}

interface TopicMode { readonly route: string; readonly topicId: string; readonly selected: string | null }

/**
 * The Details target for the session `routeKey`, with `selectedId` the Map's selection. Topic mode belongs to the session it
 * was opened in and to the selection it was opened beside: switching session, or selecting another item, returns to item
 * mode. The topic's draft is kept by the draft store, so nothing typed is lost either way.
 */
export function useDetailTarget(routeKey: string, selectedId: string | null): DetailTargetState {
  const [topic, setTopic] = useState<TopicMode | null>(null);
  const active = topic && topic.route === routeKey && topic.selected === selectedId ? topic : null;
  useEffect(() => { if (topic && !active) setTopic(null); }, [topic, active]);
  const openTopicInDetails = useCallback<OpenTopicInDetails>(topicId => setTopic({ route: routeKey, topicId, selected: selectedId }), [routeKey, selectedId]);
  const showItem = useCallback(() => setTopic(null), []);
  const target: DetailTarget | null = active ? { kind: 'topic', topicId: active.topicId } : selectedId ? { kind: 'item', id: selectedId } : null;
  return { target, openTopicInDetails, showItem };
}
