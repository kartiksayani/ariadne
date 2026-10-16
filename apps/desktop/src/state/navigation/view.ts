// C7: the one current view. A session's Map, a page, or the first-run page; there are no tabs.
// Only a session is saved (as `selected_navigation`, with `tab_open: true` on its view, so older releases
// still read ui.json). Pages and first-run live in memory: a restart opens the last session again.
import { createContext, createElement, useCallback, useContext, useMemo, type ReactNode } from 'react';
import type { NavigationSelection, SessionRef } from '../../generated/core';
import { useWaiting, type WaitingStore } from '../../selectors/waiting/store';
import { useHidden } from '../../ui/remove/queue';
import { NavigationStore, useNavigation, type NavigationState } from './store';
import { switcherData, type SwitcherData } from './switcher';

export type SessionRoute = SessionRef;
export type PageName = 'projects' | 'sessions' | 'archive';
export type PageView = { readonly kind: 'page'; readonly page: PageName; /** A single project's sessions page (15.2). */ readonly projectId?: string };
export type View =
  | { readonly kind: 'session'; readonly route: SessionRoute }
  | PageView
  | { readonly kind: 'first-run' };

/** A page an older release saved as the selection; read once, never written. */
function savedPage(selection: NavigationSelection): PageView {
  if (selection.kind === 'all_sessions') return { kind: 'page', page: 'sessions' };
  if (selection.kind === 'project') return { kind: 'page', page: 'sessions', projectId: selection.project_id };
  return { kind: 'page', page: 'projects' };
}

/** The view a navigation state shows. `hiddenProject` drops projects whose removal is pending. */
export function viewOf(state: Pick<NavigationState, 'page' | 'preferences' | 'projects'>, hiddenProject: (id: string) => boolean = () => false): View {
  const projects = state.projects?.projects.items;
  if (projects && !projects.some(project => !hiddenProject(project.project_id))) return { kind: 'first-run' };
  if (state.page) return state.page;
  const selection = state.preferences?.global.selected_navigation ?? { kind: 'projects' };
  return selection.kind === 'session' ? { kind: 'session', route: selection.session } : savedPage(selection);
}

/** The session a page returns to, and whose questions the page chip counts. */
export function currentSession(state: Pick<NavigationState, 'lastSession' | 'preferences'>): SessionRoute | null {
  const selection = state.preferences?.global.selected_navigation;
  return selection?.kind === 'session' ? selection.session : state.lastSession;
}

export const sameView = (a: View, b: View) => JSON.stringify(a) === JSON.stringify(b);

interface Stores { readonly navigation: NavigationStore; readonly waiting: WaitingStore }
const NavigationContext = createContext<Stores | null>(null);

/** Gives `useView`, `useNavigate` and `useSwitcherData` the app's navigation and waiting stores. */
export function NavigationProvider({ store, waiting, children }: { readonly store: NavigationStore; readonly waiting: WaitingStore; readonly children?: ReactNode }) {
  const value = useMemo(() => ({ navigation: store, waiting }), [store, waiting]);
  return createElement(NavigationContext.Provider, { value }, children);
}

function useStores(): Stores {
  const stores = useContext(NavigationContext);
  if (!stores) throw new Error('useView, useNavigate and useSwitcherData need a NavigationProvider');
  return stores;
}
const useStore = () => useStores().navigation;

export function useView(): View {
  const hidden = useHidden();
  return viewOf(useNavigation(useStore()), id => hidden.project(id));
}

/** The switcher's projects and sessions, and the waiting counts the top bar shows (C7). */
export function useSwitcherData(now: number = Date.now()): SwitcherData {
  const { navigation, waiting } = useStores();
  const state = useNavigation(navigation), captured = useWaiting(waiting), hidden = useHidden();
  const projects = (state.projects?.projects.items ?? []).filter(project => !hidden.project(project.project_id));
  return switcherData({ projects, sessions: captured.sessions, waiting: captured.waiting, current: currentSession(state), now,
    hiddenSession: route => hidden.session(route) });
}

/** Shows a view. A session is saved as the selection; a page or first-run is not. Resolves once it shows. */
export function navigateTo(store: NavigationStore, view: View): Promise<boolean> {
  if (view.kind === 'session') return store.navigate({ kind: 'session', session: { project_id: view.route.project_id, session_id: view.route.session_id } });
  if (view.kind === 'page') return Promise.resolve(store.openPage(view));
  return Promise.resolve(true);
}

export function useNavigate(): (view: View) => Promise<boolean> {
  const store = useStore();
  return useCallback((view: View) => navigateTo(store, view), [store]);
}
