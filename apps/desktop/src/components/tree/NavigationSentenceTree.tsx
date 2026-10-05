import { SentenceTree } from './SentenceTree';
import { NavigationStore, useNavigation } from '../../state/navigation/store';
import type { SessionStore } from '../../data/session-store';
import type { RevealedItem } from '../../data/routes';

// Composition reuses navigation's preferences revision, operation replay and
// registered router. It does not own a second preferences writer or session.
export function NavigationSentenceTree({ navigation, store, onReveal, highlightedItemIds, onHoverItem }: {
  navigation: NavigationStore; store: SessionStore; onReveal: (reveal: RevealedItem) => void;
  highlightedItemIds?: ReadonlySet<string>; onHoverItem?: (itemId: string | null) => void;
}) {
  const state = useNavigation(navigation), route = store.getSnapshot().route;
  const preferences = state.preferences;
  const view = preferences?.sessions.find(view => view.session.project_id === route.project_id && view.session.session_id === route.session_id);
  if (!preferences || !view) return <p role="status">The saved view preferences are unavailable. Refresh registered navigation.</p>;
  const later = new Set(preferences.later.filter(item => item.project_id === route.project_id && item.session_id === route.session_id).map(item => item.item_id));
  return <SentenceTree store={store} routes={navigation.routes} view={view} later={later} reveal={state.reveal} highlightedItemIds={highlightedItemIds} onHoverItem={onHoverItem}
    preferencesBusy={state.writing || state.pendingOperationId !== null}
    saveView={next => navigation.saveSessionView(next, preferences.revision)}
    saveLater={(itemId, value) => navigation.setLater({ ...route, item_id: itemId }, value, preferences.revision)} onReveal={onReveal} />;
}
