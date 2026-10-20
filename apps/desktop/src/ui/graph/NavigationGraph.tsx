import { useMemo } from 'react';
import { GraphView } from './GraphView';
import { applyChange, type ViewChange } from './model';
import type { SessionPreferences } from '../../generated/core';
import { NavigationStore, useNavigation } from '../../state/navigation/store';
import { useReadingSeen } from '../../state/preferences/reading';
import { useSession, type SessionStore } from '../../data/session-store';
import type { RevealedItem } from '../../data/routes';
import { mapChanges } from '../tree/model';
import { useLocalChips } from '../tree/useLocalChips';

// Composition reuses navigation's preferences revision and registered router,
// like the tree; it does not own a second preferences writer.
export function NavigationGraph({ navigation, store, reveal, onReveal, onClearFilters, onDismissBanner, covered }: {
  navigation: NavigationStore; store: SessionStore;
  reveal?: RevealedItem | null; onClearFilters?: () => void; onDismissBanner?: () => void; covered?: boolean;
  onReveal: (result: RevealedItem, openDetail: boolean) => void;
}) {
  const state = useNavigation(navigation), session = useSession(store).snapshot?.session, route = store.getSnapshot().route;
  const local = useLocalChips(route.session_id).chips;
  const preferences = state.preferences;
  // The same New and Changed markers the Tree derives (ui/tree/model.ts), as diamonds on the nodes.
  const seen = useReadingSeen(navigation.reading, preferences, route);
  const markers = useMemo(() => session ? mapChanges(session, seen).markers : undefined, [session, seen]);
  const view = preferences?.sessions.find(value => value.session.project_id === route.project_id && value.session.session_id === route.session_id);
  if (!preferences || !view) return <p role="status">The saved view preferences are unavailable. Refresh registered navigation.</p>;
  const later = new Set(preferences.later.filter(item => item.project_id === route.project_id && item.session_id === route.session_id).map(item => item.item_id));
  const saveView = async (next: SessionPreferences) => {
    const before = new Set(view.expanded_item_ids), after = new Set(next.expanded_item_ids);
    const change: ViewChange = { selected: next.selected_item_id !== view.selected_item_id ? next.selected_item_id ?? undefined : undefined,
      expansion: [...[...before].filter(id => !after.has(id)).map(id => ({ kind: 'collapse' as const, id })),
        ...[...after].filter(id => !before.has(id)).map(id => ({ kind: 'expand' as const, id }))] };
    for (;;) {
      const snapshot = navigation.getSnapshot();
      if (snapshot.writing) {
        await new Promise<void>(resolve => {
          const stop = navigation.subscribe(() => { if (!navigation.getSnapshot().writing) { stop(); resolve(); } });
          if (!navigation.getSnapshot().writing) { stop(); resolve(); }
        });
        continue;
      }
      if (!snapshot.preferences || snapshot.pendingOperationId !== null) return false;
      const base = snapshot.preferences.sessions.find(value => value.session.project_id === route.project_id && value.session.session_id === route.session_id);
      if (!base) return false;
      const changed = applyChange(base, change);
      if (changed === base) return true;
      const saved = await navigation.saveSessionView(structuredClone(changed) as SessionPreferences, snapshot.preferences.revision);
      if (saved || !navigation.getSnapshot().writing) return saved;
      // A competing writer refused admission; retry only after it finishes.
    }
  };
  return <GraphView store={store} routes={navigation.routes} view={view} later={later} local={local} reveal={reveal === undefined ? state.reveal : reveal}
    revealAsks={state.revealAsks} markers={markers} preferencesBusy={state.writing || state.pendingOperationId !== null}
    saveView={saveView} onReveal={onReveal} onClearFilters={onClearFilters} onDismissBanner={onDismissBanner} covered={covered} />;
}
