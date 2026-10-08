import { GraphView } from './GraphView';
import { sessionChip } from './model';
import { agentName, ownerName, sessionWhen } from '../shell/model';
import { continuedLabel } from '../shared/continued';
import { NavigationStore, useNavigation } from '../../state/navigation/store';
import { useSession, type SessionStore } from '../../data/session-store';
import type { RevealedItem } from '../../data/routes';

// Composition reuses navigation's preferences revision and registered router,
// like the tree; it does not own a second preferences writer.
export function NavigationGraph({ navigation, store, tight, onReveal, onHoverItem, now = Date.now }: {
  navigation: NavigationStore; store: SessionStore; tight: boolean;
  onReveal: (result: RevealedItem, openDetail: boolean) => void; onHoverItem?: (itemId: string | null) => void; now?: () => number;
}) {
  const state = useNavigation(navigation), session = useSession(store).snapshot?.session, route = store.getSnapshot().route;
  const preferences = state.preferences;
  const view = preferences?.sessions.find(value => value.session.project_id === route.project_id && value.session.session_id === route.session_id);
  if (!preferences || !view) return <p role="status">The saved view preferences are unavailable. Refresh registered navigation.</p>;
  const later = new Set(preferences.later.filter(item => item.project_id === route.project_id && item.session_id === route.session_id).map(item => item.item_id));
  const binding = session?.active_binding_id ? session.bindings[session.active_binding_id] : null;
  const label = session ? sessionChip(ownerName(session) ?? (binding ? agentName(binding.adapter_id) : null), sessionWhen(Date.parse(session.created_at), now())) : null;
  const summaries = state.sessions?.sessions.items ?? [];
  return <GraphView store={store} routes={navigation.routes} view={view} later={later} reveal={state.reveal} tight={tight} sessionLabel={label}
    continuedFrom={topic => topic.origin ? continuedLabel(topic.origin, summaries, now()) : null}
    preferencesBusy={state.writing || state.pendingOperationId !== null}
    saveView={next => navigation.saveSessionView(next, preferences.revision)} onReveal={onReveal} onHoverItem={onHoverItem} />;
}
