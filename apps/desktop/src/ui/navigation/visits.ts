import type { RecentAction, SessionRef } from '../../generated/core';
import type { Immutable } from '../../data/session-store';
import type { NavigationStore } from '../../state/navigation/store';
import { notices } from '../pages/notices';
import { recordRecent } from './Recent';

export interface NavigationVisit {
  readonly session: Immutable<SessionRef>;
  readonly itemId: string;
  readonly action: RecentAction;
  readonly visitedAt: string;
}
const listeners = new Set<(visit: NavigationVisit) => void>();
const queued = new Map<string, NavigationVisit[]>();
const routeKey = (session: Immutable<SessionRef>) => JSON.stringify([session.project_id, session.session_id]);
interface Writer { refs: number; flight: boolean; failed: boolean; misses: number; unsubscribe: () => void; schedule: () => void }
const writers = new Map<NavigationStore, Writer>();
/** All navigation surfaces share the canonical writer, including visits to another session. */
export const navigationVisits = {
  bind(navigation: NavigationStore) {
    let writer = writers.get(navigation);
    if (!writer) {
      const owned: Writer = { refs: 0, flight: false, failed: false, misses: 0, unsubscribe: () => {}, schedule: () => {} };
      const retry = async () => {
        if (navigation.getSnapshot().pendingOperationId && !await navigation.retryMutation()) return;
        owned.failed = false; owned.misses = 0; notices.dismiss('recent-save'); owned.schedule();
      };
      const drain = async () => {
        if (owned.flight || owned.failed || owned.refs === 0) return;
        const state = navigation.getSnapshot();
        if (state.writing || state.pendingOperationId || !state.preferences) return;
        const batch = [...queued.values()].find(values => values.length > 0);
        if (!batch) return;
        const captured = [...batch], session = captured[0]!.session;
        const view = state.preferences.sessions.find(value => routeKey(value.session) === routeKey(session));
        let recentItems = [...view?.recent_items ?? []];
        for (const visit of [...captured].reverse()) recentItems = recordRecent(recentItems, visit.itemId, visit.action, visit.visitedAt);
        owned.flight = true;
        let saved = false;
        try {
          saved = await navigation.saveRecentItems(structuredClone(session), recentItems, state.preferences.revision);
          if (saved) { owned.misses = 0; captured.forEach(visit => navigationVisits.acknowledge(visit)); }
          else {
            const after = navigation.getSnapshot();
            // Not admitted behind another writer is not a failed save. Only this writer's own unsettled
            // write, or a rejection with nothing pending, counts as a miss.
            const own = !after.writing && (navigation.isRecentPending() || !after.pendingOperationId && !!after.error);
            if (own) {
              // The first miss is retried quietly: the exact operation if one is unconfirmed, else a fresh save.
              owned.misses++;
              if (owned.misses === 1 && navigation.isRecentPending() && await navigation.retryMutation()) {
                saved = true; owned.misses = 0; captured.forEach(visit => navigationVisits.acknowledge(visit));
              } else if (owned.misses > 1 || navigation.isRecentPending()) {
                owned.failed = true;
                notices.push({ id: 'recent-save', icon: 'ph ph-warning', tone: 'problem', dismissible: false,
                  text: 'Recent visits could not be saved yet. Your visits are still waiting to be saved.',
                  actions: [{ label: 'Retry recent save', run: () => { void retry(); } }] });
              }
            } else owned.misses = 0;
          }
        } finally {
          owned.flight = false;
          const current = navigation.getSnapshot();
          if (saved || !owned.failed && !current.writing && !current.pendingOperationId && (owned.misses > 0 || current.preferences?.revision !== state.preferences.revision)) owned.schedule();
        }
      };
      owned.schedule = () => { void Promise.resolve().then(drain); };
      owned.unsubscribe = navigation.subscribe(owned.schedule);
      writers.set(navigation, owned); writer = owned;
    }
    writer.refs++;
    writer.schedule();
    const bound = writer;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--bound.refs === 0) { bound.unsubscribe(); writers.delete(navigation); }
    };
  },
  subscribe(listener: (visit: NavigationVisit) => void, session?: Immutable<SessionRef>) {
    listeners.add(listener);
    if (session) [...queued.get(routeKey(session)) ?? []].reverse().forEach(listener);
    return () => { listeners.delete(listener); };
  },
  acknowledge(visit: NavigationVisit) {
    const key = routeKey(visit.session);
    const remaining = (queued.get(key) ?? []).filter(value => value !== visit);
    if (remaining.length) queued.set(key, remaining); else queued.delete(key);
  },
  record(session: Immutable<SessionRef>, itemId: string, action: RecentAction, now = new Date().toISOString()) {
    const visit = { session, itemId, action, visitedAt: now };
    const key = routeKey(session);
    queued.set(key, [visit, ...(queued.get(key) ?? []).filter(value => value.itemId !== itemId)].slice(0, 15));
    listeners.forEach(listener => listener(visit));
    writers.forEach(writer => writer.schedule());
  },
};
