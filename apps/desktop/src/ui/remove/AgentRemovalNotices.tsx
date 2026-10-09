import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { Immutable } from '../../data';
import type { Session } from '../../generated/domain/models';
import type { SessionRef } from '../../generated/core';
import type { SessionActionControllers } from '../../components/bindings/actions';
import type { NavigationStore } from '../../state/navigation/store';
import type { WaitingStore } from '../../selectors/waiting/store';
import { waitForLifecycleReady } from '../shared/lifecycleReady';
import { notices } from '../pages/notices';
import { binView, removalNotice, restoreRemoved } from './AgentBin';

interface Props {
  readonly waiting: WaitingStore;
  readonly controllers: SessionActionControllers;
  readonly navigation: NavigationStore;
  readonly selectedSession: Immutable<Session> | null;
  readonly onTree: (route: SessionRef) => void;
}
const sameSession = (a: SessionRef, b: SessionRef) => a.project_id === b.project_id && a.session_id === b.session_id;
/** Observe all loaded sessions without rerendering the selected workspace on other sessions' updates. */
export function AgentRemovalNotices({ waiting, controllers, navigation, selectedSession, onTree }: Props) {
  const waitingState = useSyncExternalStore(waiting.subscribe, waiting.getSnapshot);
  const seenRemovals = useRef(new Set<string>());
  useEffect(() => {
    const sessions = new Map<string, typeof waitingState.sessions[number]['session']>();
    for (const session of [...waitingState.sessions.map(value => value.session), ...(selectedSession ? [selectedSession] : [])]) {
      if (!sessions.has(session.id) || sessions.get(session.id)!.revision <= session.revision) sessions.set(session.id, session);
    }
    const currentRemovals = new Set<string>();
    for (const session of sessions.values()) for (const group of Object.values(session.operation_receipts)) for (const receipt of group ?? []) {
      if (receipt.result.data.kind !== 'apply') continue;
      for (const removal of receipt.result.data.agent_removals ?? []) {
        const id = `${session.id}:${removal.message_id}`;
        const source = removal.item_id ? session.items[removal.item_id] : session.topics[removal.topic_id];
        if (!source?.removed_at || source.removed_by?.message_id !== removal.message_id) continue;
        currentRemovals.add(id);
        if (seenRemovals.current.has(id)) continue;
        seenRemovals.current.add(id);
        const route = { project_id: session.project_id, session_id: session.id };
        notices.push({ id, icon: 'ph ph-trash', text: removalNotice(session, removal), dismissible: true, actions: [
          { label: 'Restore', run: () => {
            const actions = controllers.forSession(navigation.opened.open(route));
            void restoreRemoved(actions, removal.topic_id, removal.item_id).then(error => {
              if (error) notices.push({ id: `${id}:error`, icon: 'ph ph-warning-circle', text: error, dismissible: true });
              else notices.dismiss(id);
            });
          } },
          { label: 'View', run: () => {
            void navigation.navigate({ kind: 'session', session: route }).then(async saved => {
              if (!saved) return;
              const actions = controllers.forSession(navigation.opened.open(route));
              const ready = await waitForLifecycleReady(actions);
              if (!ready.ok) { if (ready.error) notices.push({ id: `${id}:error`, icon: 'ph ph-warning-circle', text: ready.error, dismissible: true }); return; }
              const topic = ready.session.topics[removal.topic_id], scope = removal.item_id && !topic?.removed_at ? removal.topic_id : null;
              onTree(route);
              const preferences = navigation.getSnapshot().preferences;
              const view = preferences?.sessions.find(value => sameSession(value.session, route));
              if (!preferences || !view || !await navigation.saveSessionView({ ...structuredClone(view),
                expanded_item_ids: [...view.expanded_item_ids], hidden_item_ids: view.hidden_item_ids ? [...view.hidden_item_ids] : undefined,
                collapsed_topic_ids: view.collapsed_topic_ids ? [...view.collapsed_topic_ids] : undefined, filters: {
                ...structuredClone(view.filters), archived: scope !== null && topic?.archived_at != null,
                topic_id: null, statuses: [], owners: [], search: '', hide_later: false,
              } }, preferences.revision)) {
                notices.push({ id: `${id}:error`, icon: 'ph ph-warning-circle', text: 'The bin could not be opened. Try View again.', dismissible: true }); return;
              }
              binView.reveal(route, scope);
            });
          } },
        ] });
      }
    }
    for (const id of seenRemovals.current) {
      if ([...sessions.keys()].some(sessionId => id.startsWith(`${sessionId}:`)) && !currentRemovals.has(id)) notices.dismiss(id);
    }
  }, [controllers, navigation, waitingState.sessions, selectedSession, onTree]);

  return null;
}
