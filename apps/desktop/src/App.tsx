import { useEffect, useState, useSyncExternalStore } from 'react';
import { createDesktopService, type RendererService } from './data/service';
import { useSession, type SessionState, type SessionStore } from './data/session-store';
import type { RevealedItem } from './data/routes';
import type { ItemRoute, SessionPreferences, SessionRef, Theme } from './generated/core';
import { NavigationStore, useNavigation } from './state/navigation/store';
import { OwnerDraftStore } from './state/drafts/store';
import { WaitingStore } from './selectors/waiting/store';
import { NavigationWorkspace, type AdapterChoice, type OpenedSessionView } from './components/navigation/NavigationWorkspace';
import { NavigationSentenceTree } from './components/tree/NavigationSentenceTree';
import { NavigationTopicGraph } from './components/graph/NavigationTopicGraph';
import { OwnerItemDetail } from './components/inputs/OwnerItemDetail';
import { OwnerWaitingPanel } from './components/inputs/OwnerWaitingPanel';
import { MessageRail } from './components/rail/MessageRail';
import { SessionActionControllers } from './components/bindings/actions';
import { BindingControls } from './components/bindings/BindingControls';
import { qualifiedPresence } from './components/bindings/presence';
import { RecoveryPanel } from './components/recovery/RecoveryPanel';
import { EdgeState, SessionNotice } from './components/edge-states/EdgeState';

const adapters: readonly AdapterChoice[] = [
  { adapter_id: 'claude_code_mod', label: 'Claude Code Mod', configuration: { namespace: 'claude_code_mod', values: {} } },
  { adapter_id: 'codex', label: 'Codex', configuration: { namespace: 'codex', values: {} } },
];
const routeKey = (route: SessionRef) => JSON.stringify([route.project_id, route.session_id]);
const noSubscription = () => () => {};
const noSession = () => null;
interface Application {
  service: RendererService;
  navigation: NavigationStore;
  waiting: WaitingStore;
  drafts: OwnerDraftStore;
  actions: SessionActionControllers;
}
function bindingContext(state: SessionState | null): string {
  const session = state?.snapshot?.session;
  const binding = session?.active_binding_id ? session.bindings[session.active_binding_id] : null;
  if (!binding) return 'No selected binding';
  if (binding.owner_paused) return `${binding.adapter_id} · owner paused`;
  if (binding.dispatch_state === 'recovery_required') return `${binding.adapter_id} · recovery required`;
  if (binding.connection_state !== 'connected') return `${binding.adapter_id} · host unavailable`;
  return `${binding.adapter_id} · ${qualifiedPresence(binding, state?.presence[binding.id]).label}`;
}
function ThemeAppearance({ theme }: { theme: Theme }) {
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const update = () => { document.documentElement.dataset.theme = theme === 'system' ? media?.matches === false ? 'light' : 'dark' : theme; };
    update();
    if (theme === 'system') media?.addEventListener('change', update);
    return () => { if (theme === 'system') media?.removeEventListener('change', update); };
  }, [theme]);
  return null;
}
function SessionCenter({ application, view, graph, onReveal, switchToTree }: {
  application: Application; view: OpenedSessionView; graph: boolean; onReveal: (result: RevealedItem) => void; switchToTree: () => void;
}) {
  const state = useSession(view.store), session = state.snapshot?.session;
  const actions = application.actions.forSession(view.store);
  const topics = Object.values(session?.topics ?? {}).filter((topic): topic is NonNullable<typeof topic> => !!topic && (view.preferences?.filters.archived ? topic.archived_at !== null : topic.archived_at === null)
    && (!view.preferences?.filters.topic_id || topic.id === view.preferences.filters.topic_id)).sort((a, b) => a.order - b.order);
  return <section className="app-session" aria-label="Session workspace">
    <SessionNotice state={state} refresh={() => { void view.store.refresh(); }} />
    <BindingControls actions={actions} />
    <RecoveryPanel actions={actions} />
    {session && Object.keys(session.items).length === 0 && <EdgeState kind="empty" />}
    {graph ? topics.map(topic => <NavigationTopicGraph key={topic.id} navigation={application.navigation} store={view.store}
      topicId={topic.id} onReveal={onReveal} onSwitchToTree={switchToTree} />)
      : <NavigationSentenceTree navigation={application.navigation} store={view.store} onReveal={onReveal} />}
  </section>;
}
function Workspace({ application }: { application: Application }) {
  const navigation = application.navigation, state = useNavigation(navigation);
  const store: SessionStore | null = navigation.selectedSession();
  const sessionState = useSyncExternalStore(store?.subscribe ?? noSubscription, store?.getSnapshot ?? noSession, store?.getSnapshot ?? noSession);
  const route = sessionState?.route, key = route ? routeKey(route) : '';
  const preferences = state.preferences, view = preferences?.sessions.find(value => route && routeKey(value.session) === key);
  const [graphModes, setGraphModes] = useState<Readonly<Record<string, boolean>>>({});
  const [detailOpen, setDetailOpen] = useState(true);
  const [localReveal, setLocalReveal] = useState<RevealedItem | null>(null);
  const [highlightedMessages, setHighlightedMessages] = useState<ReadonlySet<string>>(new Set());
  const [searchEdit, setSearchEdit] = useState<{ route: string; text: string; attempted: boolean } | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const graph = graphModes[key] ?? false;
  const currentReveal = localReveal?.store === store ? localReveal : state.reveal?.store === store ? state.reveal : null;
  const selectedId = currentReveal?.kind === 'item' ? currentReveal.route.item_id : view?.selected_item_id ?? null;
  const theme = preferences?.global.theme ?? 'system';
  const query = searchEdit?.route === key ? searchEdit.text : view?.filters.search ?? '';
  useEffect(() => { setDetailOpen(true); setLocalReveal(null); setHighlightedMessages(new Set()); }, [key]);
  useEffect(() => { setDetailOpen(true); }, [view?.selected_item_id, state.reveal]);
  useEffect(() => { setLocalReveal(null); }, [state.reveal]);
  // The header uses navigation's existing serialized preference writer. Keep
  // the last typed search while a write/reconciliation is pending.
  useEffect(() => {
    if (!searchEdit || searchEdit.route !== key || !view || !preferences || state.writing || state.pendingOperationId) return;
    if (view.filters.search === searchEdit.text) { setSearchEdit(null); return; }
    if (searchEdit.attempted) return;
    const timer = setTimeout(() => {
      setSearchEdit(current => current?.route === key && current.text === searchEdit.text ? { ...current, attempted: true } : current);
      void navigation.saveSessionView({ ...structuredClone(view), filters: { ...structuredClone(view.filters), search: searchEdit.text } } as SessionPreferences,
        preferences.revision);
    }, 250);
    return () => { clearTimeout(timer); };
  }, [navigation, searchEdit, key, view, preferences, state.writing, state.pendingOperationId]);
  const reveal = (result: RevealedItem) => {
    const target = result.kind === 'item' ? result.route : result.session;
    setLocalReveal(result); setDetailOpen(true);
    void navigation.navigate({ kind: 'session', session: { project_id: target.project_id, session_id: target.session_id } }, result);
  };
  // Tree and graph already save their own selection through navigation.
  const selected = (result: RevealedItem) => { setLocalReveal(result); setDetailOpen(true); };
  const revealItem = (target: ItemRoute) => {
    setRouteError(null);
    void navigation.routes.revealItem(target).then(result => { if (result) reveal(result); })
      .catch((error: unknown) => setRouteError(error instanceof Error ? error.message : 'This registered item could not be opened.'));
  };
  const saveView = (change: Partial<SessionPreferences>) => {
    if (view && preferences) void navigation.saveSessionView({ ...structuredClone(view), ...change } as SessionPreferences, preferences.revision);
  };
  const closeDetail = () => setDetailOpen(false);
  const toggleRail = () => saveView({ rail: view?.rail === 'hidden' ? 'activity' : 'hidden' });
  const switchToTree = () => setGraphModes(previous => ({ ...previous, [key]: false }));
  const later = route && selectedId ? preferences?.later.some(item => routeKey(item) === key && item.item_id === selectedId) ?? false : false;
  return <div className="product-app" onKeyDown={event => {
    if (event.target instanceof HTMLElement && event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Escape') closeDetail();
    if (store && event.key === 'g') { event.preventDefault(); setGraphModes(previous => ({ ...previous, [key]: !graph })); }
    if (store && event.key === 'm') { event.preventDefault(); toggleRail(); }
    if (store && event.key === '/') { event.preventDefault(); document.querySelector<HTMLInputElement>('.ref-search input')?.focus(); }
  }}>
    <ThemeAppearance theme={theme} />
    <NavigationWorkspace store={navigation} adapterChoices={adapters}
      context={store ? { session: sessionState?.snapshot?.session.title ?? 'Loading session', binding: bindingContext(sessionState) } : undefined}
      chrome={{ query, views: store ? ['Tree', 'Graph'].map((label, index) => ({ label, icon: index ? 'ph ph-tree-structure' : 'ph ph-list', title: label,
        background: graph === Boolean(index) ? 'color-mix(in srgb, var(--color-text) 10%, transparent)' : 'transparent', color: 'var(--color-text)',
        selected: graph === Boolean(index), onSelect: () => setGraphModes(previous => ({ ...previous, [key]: Boolean(index) })) })) : [],
      railColor: view?.rail !== 'hidden' && store ? 'var(--color-accent)' : 'var(--color-text)', themeIcon: theme === 'light' ? 'ph ph-sun' : 'ph ph-moon',
      themeTitle: `Theme: ${theme}` }}
      onQueryChange={view ? text => setSearchEdit({ route: key, text, attempted: false }) : undefined}
      onToggleRail={view ? toggleRail : undefined}
      onThemeChange={() => { if (preferences) void navigation.saveTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system', preferences.revision); }}
      waitingContent={<div className="app-waiting">{routeError && <p role="alert">{routeError}</p>}<OwnerWaitingPanel drafts={application.drafts} store={application.waiting} revealItem={revealItem}
        openSession={target => { void navigation.navigate({ kind: 'session', session: target }); }} /></div>}
      detail={store && selectedId && detailOpen ? <OwnerItemDetail key={`${key}:${selectedId}`} drafts={application.drafts} service={application.service} store={store}
        itemId={selectedId} routes={navigation.routes} onReveal={reveal} highlightedMessageIds={highlightedMessages} later={later}
        onLater={value => route && preferences ? navigation.setLater({ ...route, item_id: selectedId }, value, preferences.revision) : Promise.resolve(false)} /> : undefined}
      onCloseDetail={closeDetail}
      railContent={store && view && view.rail !== 'hidden' ? <MessageRail key={key} service={application.service} store={store} routes={navigation.routes}
        selectedItemId={selectedId} onHighlight={(_items, messages) => setHighlightedMessages(messages)} onReveal={reveal} onClose={toggleRail} /> : undefined}
      renderSession={opened => <SessionCenter application={application} view={opened} graph={graph} onReveal={selected} switchToTree={switchToTree} />} />
  </div>;
}

// Construction happens in an effect, so StrictMode's discarded render creates
// no timers/listeners. Effect replay closes the first lifetime before starting
// another; tabs and their views never own application resources.
export function DesktopApp({ service }: { service: RendererService }) {
  const [application, setApplication] = useState<Application | null>(null);
  useEffect(() => {
    const navigation = new NavigationStore(service);
    const next: Application = { service, navigation, waiting: new WaitingStore(service, navigation.opened),
      drafts: new OwnerDraftStore(service), actions: new SessionActionControllers(service) };
    setApplication(next);
    return () => { next.waiting.stop(); next.navigation.stop(); };
  }, [service]);
  return application ? <Workspace application={application} /> : <p role="status">Opening Ariadne…</p>;
}
export default function App() {
  const [service] = useState(() => createDesktopService());
  return <DesktopApp service={service} />;
}
