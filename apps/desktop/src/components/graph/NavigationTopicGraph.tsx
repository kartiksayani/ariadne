import { SessionTopicGraph } from './SessionTopicGraph';
import { NavigationStore, useNavigation } from '../../state/navigation/store';
import type { SessionStore } from '../../data/session-store';
import type { RevealedItem } from '../../data/routes';
import type { SessionPreferences } from '../../generated/core';

export function NavigationTopicGraph({ navigation, store, topicId, onReveal, onSwitchToTree }: {
  navigation: NavigationStore; store: SessionStore; topicId: string;
  onReveal: (result: RevealedItem) => void; onSwitchToTree: () => void;
}) {
  const state = useNavigation(navigation), route = store.getSnapshot().route, preferences = state.preferences;
  const view = preferences?.sessions.find(value => value.session.project_id === route.project_id && value.session.session_id === route.session_id);
  if (!preferences || !view) return <p role="status">The saved view preferences are unavailable. Refresh registered navigation.</p>;
  const later = new Set(preferences.later.filter(item => item.project_id === route.project_id && item.session_id === route.session_id).map(item => item.item_id));
  return <SessionTopicGraph store={store} routes={navigation.routes} topicId={topicId} view={view} later={later} reveal={state.reveal}
    onReveal={onReveal} onSwitchToTree={onSwitchToTree} saveSelection={itemId => navigation.saveSessionView({
      ...structuredClone(view), selected_item_id:itemId,
    } as SessionPreferences, preferences.revision)} />;
}
