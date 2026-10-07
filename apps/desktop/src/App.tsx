import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { createDesktopService, type RendererService } from './data/service';
import { DiscoveryController } from './data/discovery';
import { useSession, type SessionState, type SessionStore } from './data/session-store';
import type { RevealedItem } from './data/routes';
import type { ItemRoute, SessionPreferences, SessionRef } from './generated/core';
import { NavigationStore, useNavigation } from './state/navigation/store';
import { OwnerDraftStore } from './state/drafts/store';
import { WaitingStore } from './selectors/waiting/store';
import { NavigationWorkspace, type AdapterChoice, type OpenedSessionView } from './components/navigation/NavigationWorkspace';
import { NavigationGraph } from './ui/graph/NavigationGraph';
import type { OwnerFocusRequest, PendingSubmission } from './ui/answer/useSubmit';
import { agentNotRunning } from './ui/answer/notRunning';
import { DetailPath, ItemDetail } from './ui/detail/ItemDetail';
import { WaitingColumn } from './ui/waiting/WaitingColumn';
import { MessageRail } from './ui/rail/MessageRail';
import { SessionActionControllers } from './components/bindings/actions';
import { RecoveryPanel, recoveryTargets } from './components/recovery/RecoveryPanel';
import { CopiedProvenance } from './components/history-actions/CopiedProvenance';
import { SessionNotice } from './components/edge-states/EdgeState';
import { TreeView, type RowIntent } from './ui/tree/TreeView';
import { ArchivePage } from './ui/pages/ArchivePage';
import { useSessionSnapshots } from './ui/pages/snapshots';
import { AgentNotRunningHost } from './ui/dialogs/AgentNotRunning';
import { ContinueTopicHost } from './ui/dialogs/ContinueTopicDialog';
import type { RemoveHandler } from './ui/dialogs/remove';
import { agentName, hostApp, themeToggle, type SessionFacts } from './ui/shell/model';
import { useAppliedTheme } from './ui/shell/theme';
import type { ViewTab } from './ui/shell/Header';
import { useWorkspaceKeys, type WorkspaceHandlers, type WorkspaceIntent } from './ui/keys';

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
  discovery: DiscoveryController;
}
/** Header facts for the selected session, from its loaded snapshot. */
function sessionFacts(state: SessionState | null, projectName: (projectId: string) => string): SessionFacts | null {
  const session = state?.snapshot?.session;
  if (!state || !session) return null;
  const binding = session.active_binding_id ? session.bindings[session.active_binding_id] : null;
  const last = session.messages.at(-1);
  return { projectName: projectName(session.project_id), createdAt: Date.parse(session.created_at), messageCount: session.messages.length,
    agent: binding ? agentName(binding.adapter_id) : null, where: hostApp(binding?.host_location),
    connection: !binding ? 'none' : binding.connection_state === 'connected' ? 'connected' : binding.connection_state === 'reconnecting' ? 'reconnecting' : 'not_running',
    lastMessage: last ? { number: last.number, createdAt: Date.parse(last.created_at) } : null };
}
const clearedFilters = (filters: { readonly archived: boolean }): SessionPreferences['filters'] =>
  ({ search: '', statuses: [], owners: [], topic_id: null, hide_later: false, archived: filters.archived });
const filtering = (filters: { readonly search: string; readonly statuses: readonly unknown[]; readonly owners: readonly unknown[];
  readonly topic_id: string | null; readonly hide_later: boolean }) => !!filters.search || filters.statuses.length > 0 || filters.owners.length > 0
  || filters.topic_id !== null || filters.hide_later;
interface FocusedItem { readonly item: { readonly id: string; readonly status: string; readonly topic_id: string }; readonly target: ItemRoute }
/** The App's share of the workspace keymap: actions on the focused or selected item, views and Esc. */
function workspaceKeys(app: {
  readonly store: boolean;
  readonly focused: (event: KeyboardEvent<HTMLDivElement>) => FocusedItem | null;
  readonly oldestWaiting: () => ItemRoute | undefined;
  readonly focusOwner: (target: ItemRoute, intent: OwnerFocusRequest['intent'], optionIndex?: number) => void;
  readonly queueBring: (target: ItemRoute) => Promise<void>;
  readonly toggleLater: (target: ItemRoute, itemId: string) => boolean;
  readonly archiveTopic: (topicId: string) => boolean;
  readonly toggleGraph: () => void;
  readonly toggleRail: () => void;
  readonly closeDetail: () => void;
  readonly clearFilters?: () => void;
}): WorkspaceHandlers<HTMLDivElement> {
  const closed = ['done', 'decided', 'dropped'];
  const onItem = (act: (focused: FocusedItem, intent: WorkspaceIntent, event: KeyboardEvent<HTMLDivElement>) => boolean | void) =>
    (intent: WorkspaceIntent, event: KeyboardEvent<HTMLDivElement>) => { const focused = app.focused(event); return focused ? act(focused, intent, event) : false; };
  const search = () => {
    if (!app.store) return false;
    document.querySelector<HTMLInputElement>('[data-shell-search]')?.focus(); return true;
  };
  return {
    search,
    // Esc closes the answer box first (the editor stops it), then detail, then clears filters.
    escape: () => { app.closeDetail(); app.clearFilters?.(); return false; },
    answer: (_intent, event) => {
      const focused = app.focused(event);
      const question = focused && focused.item.status === 'waiting_on_me' ? focused.target : app.oldestWaiting();
      if (!question) return false;
      app.focusOwner({ ...question }, 'answer'); return true;
    },
    bring: onItem(({ target }, _intent, event) => { if (!event.repeat) void app.queueBring(target); return true; }),
    respond: onItem(({ item, target }) => {
      app.focusOwner(target, [...closed, 'replaced'].includes(item.status) ? 'followup' : item.status === 'in_progress' ? 'note' : 'reply'); return true;
    }),
    drop: onItem(({ target }) => { app.focusOwner(target, 'drop'); return true; }),
    reopen: onItem(({ item, target }) => { if (!closed.includes(item.status)) return false; app.focusOwner(target, 'reopen'); return true; }),
    choose: onItem(({ item, target }, intent) => {
      if (item.status !== 'waiting_on_me' || intent.kind !== 'choose') return false;
      app.focusOwner(target, 'answer', intent.index); return true;
    }),
    later: onItem(({ item, target }) => app.toggleLater(target, item.id)),
    archive: onItem(({ item }) => app.archiveTopic(item.topic_id)),
    graph: () => { if (!app.store) return false; app.toggleGraph(); return true; },
    messages: () => { if (!app.store) return false; app.toggleRail(); return true; },
    // TODO(WP6): ask, then remove the selected item or topic. A no-op until the remove command lands.
    remove: () => false,
  };
}
/** The archive (1x): archived topics of every session in the project. */
function SessionArchive({ application, view, onRemove }: { application: Application; view: OpenedSessionView; onRemove: RemoveHandler }) {
  const state = useSession(view.store), navigation = useNavigation(application.navigation);
  const route = state.route;
  const sessions = (navigation.sessions?.sessions.items ?? []).filter(summary => summary.project_id === route.project_id);
  const snapshots = useSessionSnapshots(application.service, sessions);
  const project = navigation.projects?.projects.items.find(value => value.project_id === route.project_id);
  return <section className="app-session" aria-label="Session workspace">
    <SessionNotice state={state} refresh={() => { void view.store.refresh(); }} />
    <ArchivePage navigation={application.navigation} actions={application.actions} projectName={project?.project?.display_name ?? 'this project'}
      sessions={sessions} snapshots={snapshots} target={route} query={view.preferences?.filters.search ?? ''} now={Date.now()} onRemove={onRemove} />
  </section>;
}
interface CenterProps {
  readonly application: Application; readonly view: OpenedSessionView; readonly graph: boolean; readonly query: string;
  readonly reveal: RevealedItem | null; readonly selectedId: string | null; readonly detailOpen: boolean; readonly railOpen: boolean;
  readonly highlightedItems: ReadonlySet<string>; readonly highlightedMessages: ReadonlySet<string>;
  readonly onHoverItem: (itemId: string | null) => void; readonly onSelected: (result: RevealedItem, openDetail?: boolean) => void;
  readonly onDismissReveal: () => void; readonly onResume: () => void; readonly onAct: (intent: RowIntent, target: ItemRoute) => void;
  readonly onClearFilters: () => void; readonly onShowArchive: () => void; readonly revealItem: (route: ItemRoute) => void;
  readonly onRemove: () => void; readonly onRemoveTarget: RemoveHandler;
  readonly onAgentNotRunning: (submission: PendingSubmission) => void;
}
function SessionCenter({ application, view, graph, reveal, onRemoveTarget, ...props }: CenterProps) {
  const state = useSession(view.store), session = state.snapshot?.session;
  const navigation = useNavigation(application.navigation);
  const actions = application.actions.forSession(view.store);
  if (view.preferences?.filters.archived) return <SessionArchive application={application} view={view} onRemove={onRemoveTarget} />;
  const summaries = navigation.sessions?.sessions.items ?? [];
  const recovering = session ? recoveryTargets(session).length > 0 : false;
  const notice = state.status !== 'loading' && <SessionNotice state={state} refresh={() => { void view.store.refresh(); }} />;
  return <TreeView {...props} navigation={application.navigation} store={view.store} actions={actions} drafts={application.drafts}
    reveal={reveal?.store === view.store ? reveal : null} summaries={summaries}
    continueTargets={summaries.map(target => ({ route: { project_id: target.project_id, session_id: target.session_id }, label: target.title }))}
    actionsForTarget={target => application.actions.forSession(application.navigation.opened.open(target))}
    openSession={target => { void application.navigation.navigate({ kind: 'session', session: target }); }}
    notices={notice || recovering ? <div className="tree-notices">{notice}{recovering && <RecoveryPanel actions={actions} />}</div> : null}
    graph={graph && !view.preferences?.filters.archived ? <NavigationGraph navigation={application.navigation} store={view.store}
      tight={props.detailOpen || props.railOpen} onReveal={props.onSelected} onHoverItem={props.onHoverItem} /> : null} />;
}
function Workspace({ application }: { application: Application }) {
  const navigation = application.navigation, state = useNavigation(navigation);
  // The configured Codex socket becomes the connect dialog's default; absent when Codex is unconfigured.
  const [codexSocket, setCodexSocket] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    application.service.codexDefaultEndpoint?.().then(path => { if (current) setCodexSocket(path); }, () => {});
    return () => { current = false; };
  }, [application.service]);
  const adapterChoices = useMemo(() => adapters.map(choice => choice.adapter_id === 'codex' && codexSocket ? { ...choice, default_socket_path: codexSocket } : choice), [codexSocket]);
  const store: SessionStore | null = navigation.selectedSession();
  const sessionState = useSyncExternalStore(store?.subscribe ?? noSubscription, store?.getSnapshot ?? noSession, store?.getSnapshot ?? noSession);
  const route = sessionState?.route, key = route ? routeKey(route) : '';
  const preferences = state.preferences, view = preferences?.sessions.find(value => route && routeKey(value.session) === key);
  const shortcutSequence = useRef(0), bringing = useRef(new Set<string>());
  const [ownerFocus, setOwnerFocus] = useState<(OwnerFocusRequest & { route: string; itemId: string }) | null>(null);
  const [graphModes, setGraphModes] = useState<Readonly<Record<string, boolean>>>({});
  const [detailOpen, setDetailOpen] = useState(true);
  const detailDismissedAt = useRef<number | null>(null);
  const [localReveal, setLocalReveal] = useState<RevealedItem | null>(null);
  // "Resume filtered view", a filter change or a fold drops the tree's temporary reveal.
  const [dismissedReveal, setDismissedReveal] = useState<RevealedItem | null>(null);
  const [highlightedItems, setHighlightedItems] = useState<ReadonlySet<string>>(new Set());
  const [hoveredItem, setHoveredItem] = useState<string | null>(null);
  const hoverItem = useCallback((itemId: string | null) => setHoveredItem(itemId), []);
  const [highlightedMessages, setHighlightedMessages] = useState<ReadonlySet<string>>(new Set());
  const [searchEdit, setSearchEdit] = useState<{ route: string; text: string; attempted: boolean } | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const graph = graphModes[key] ?? false;
  const currentReveal = localReveal?.store === store ? localReveal : state.reveal?.store === store ? state.reveal : null;
  const treeReveal = currentReveal === dismissedReveal ? null : currentReveal;
  const selectedId = currentReveal?.kind === 'item' ? currentReveal.route.item_id : view?.selected_item_id ?? null;
  const theme = preferences?.global.theme ?? 'system';
  const query = searchEdit?.route === key ? searchEdit.text : view?.filters.search ?? '';
  // Saved selection is authoritative, but its late receipt is not a newer
  // presentation intent than Escape. Deliberate navigation has a new epoch.
  useEffect(() => {
    if (detailDismissedAt.current !== navigation.getNavigationRequest()) setDetailOpen(true);
    setLocalReveal(null);
  }, [key, navigation]);
  useEffect(() => { setHighlightedItems(new Set()); setHighlightedMessages(new Set()); setHoveredItem(null); }, [key, view?.rail]);
  useEffect(() => {
    if (detailDismissedAt.current !== navigation.getNavigationRequest()) setDetailOpen(true);
  }, [view?.selected_item_id, state.reveal, navigation]);
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
  const invalidateOwnerRequest = () => { ++shortcutSequence.current; setOwnerFocus(null); };
  const consumeOwnerRequest = (token: number) => setOwnerFocus(current => current?.token === token ? null : current);
  const reveal = async (result: RevealedItem, ownerToken?: number): Promise<number | null> => {
    if (ownerToken === undefined) invalidateOwnerRequest();
    const token = ownerToken ?? shortcutSequence.current;
    const intent = navigation.getNavigationIntent(), completion = navigation.getWritingCompletion();
    const navigationRequest = navigation.getNavigationRequest();
    // Leaving the tree can save its scroll anchor while this enabled link is
    // being resolved. Retain only this current, unsubmitted navigation intent.
    if (completion) {
      const saved = await completion;
      const current = navigation.getSnapshot();
      // A write that definitely failed with revision_conflict was cleared and refreshed by the store,
      // so this one explicit click proceeds against current state. Everything else stays refused.
      if (!saved && !navigation.settledAsConflict(completion)) return null;
      if (current.writing || current.pendingOperationId !== null || (saved && current.error)) return null;
    }
    if (intent === null || navigation.getNavigationIntent() !== intent || navigation.getNavigationRequest() !== navigationRequest
      || shortcutSequence.current !== token) return null;
    const target = result.kind === 'item' ? result.route : result.session;
    const opened = navigation.navigate({ kind: 'session', session: { project_id: target.project_id, session_id: target.session_id } }, result, ownerToken === undefined ? undefined : () => shortcutSequence.current === ownerToken);
    const request = navigation.getNavigationRequest();
    if (!await opened || navigation.getNavigationRequest() !== request || shortcutSequence.current !== token) return null;
    detailDismissedAt.current = null; setLocalReveal(result); setDetailOpen(true);
    // Admission can follow an awaited write; continuations use this exact request.
    return request;
  };
  // Tree and graph already save their own selection through navigation.
  // The graph's ↑/↓ and "−" move the selection without opening detail (Ariadne.dc.html `select`).
  const selected = (result: RevealedItem, openDetail = true) => {
    invalidateOwnerRequest(); setLocalReveal(result);
    if (openDetail) { detailDismissedAt.current = null; setDetailOpen(true); }
  };
  const revealItem = (target: ItemRoute) => {
    setRouteError(null);
    void navigation.routes.revealItem(target).then(result => { if (result) reveal(result); })
      .catch((error: unknown) => setRouteError(error instanceof Error ? error.message : 'This registered item could not be opened.'));
  };
  // Send while the session's agent isn't running asks first (1ad); see ui/answer/notRunning.
  const onAgentNotRunning = (submission: PendingSubmission) => {
    void agentNotRunning({ navigation, drafts: application.drafts, reveal: revealItem })(submission);
  };
  const focusOwner = (target: ItemRoute, intent: OwnerFocusRequest['intent'], optionIndex?: number) => {
    const token = ++shortcutSequence.current, navigationRequest = navigation.getNavigationRequest();
    setOwnerFocus(null);
    void navigation.routes.revealItem(target).then(async result => {
      if (!result || result.kind !== 'item' || shortcutSequence.current !== token || navigation.getNavigationRequest() !== navigationRequest) return;
      const openedRequest = await reveal(result, token);
      if (openedRequest === null || shortcutSequence.current !== token || navigation.getNavigationRequest() !== openedRequest) return;
      setOwnerFocus({ route: routeKey(target), itemId: target.item_id, intent, token, optionIndex });
    }).catch((error: unknown) => setRouteError(error instanceof Error ? error.message : 'This registered item could not be opened.'));
  };
  const queueBring = async (target: ItemRoute) => {
    const identity = JSON.stringify(target);
    if (bringing.current.has(identity)) return;
    bringing.current.add(identity);
    const token = ++shortcutSequence.current, navigationRequest = navigation.getNavigationRequest();
    setOwnerFocus(null);
    try {
      const result = await navigation.routes.revealItem(target);
      if (!result || result.kind !== 'item' || shortcutSequence.current !== token || navigation.getNavigationRequest() !== navigationRequest) return;
      const openedRequest = await reveal(result, token);
      if (openedRequest === null) return;
      await application.drafts.load();
      if (shortcutSequence.current !== token || navigation.getNavigationRequest() !== openedRequest) return;
      const current = result.store.getSnapshot(), session = current.snapshot?.session;
      if (!session || current.status !== 'ready' || current.error) return;
      const existing = application.drafts.find(target, target.item_id, 'bring');
      if (shortcutSequence.current === token) setOwnerFocus({ route: routeKey(target), itemId: target.item_id, intent: 'bring', token });
      // An existing draft, attempted operation or receipt always needs review.
      if (existing) return;
      const operation = application.drafts.begin(session, target.item_id, 'bring');
      if (!operation) return;
      application.drafts.edit(operation, { text: 'Bring this up.' });
      await application.drafts.submit(operation);
    } catch (error: unknown) { setRouteError(error instanceof Error ? error.message : 'This registered item could not be opened.'); }
    finally { bringing.current.delete(identity); }
  };
  const saveView = (change: Partial<SessionPreferences>) => {
    if (view && preferences) void navigation.saveSessionView({ ...structuredClone(view), ...change } as SessionPreferences, preferences.revision);
  };
  const closeDetail = () => { invalidateOwnerRequest(); detailDismissedAt.current = navigation.getNavigationRequest(); setDetailOpen(false); };
  const toggleRail = () => {
    const current = navigation.getSnapshot();
    if (current.writing || current.pendingOperationId !== null) return;
    saveView({ rail: view?.rail === 'hidden' ? 'activity' : 'hidden' });
  };
  const later = route && selectedId ? preferences?.later.some(item => routeKey(item) === key && item.item_id === selectedId) ?? false : false;
  const shown = useAppliedTheme(theme);
  const projectName = (projectId: string) => state.projects?.projects.items.find(project => project.project_id === projectId)?.project?.display_name ?? 'Unavailable project';
  const archived = view?.filters.archived ?? false;
  // The archive is kept per project (1x), so the label counts the project's archived topics.
  const archivedTopics = route ? state.projects?.projects.items.find(project => project.project_id === route.project_id)?.counts.archived_topics ?? 0 : 0;
  // TODO(WP6b): remove the confirmed project, session, topic or item (RendererService.remove*, PR #125).
  const removeTarget: RemoveHandler = () => {};
  const showView = (mode: 'tree' | 'graph' | 'archive') => {
    setGraphModes(previous => ({ ...previous, [key]: mode === 'graph' }));
    if (view && archived !== (mode === 'archive')) saveView({ filters: { ...structuredClone(view.filters), archived: mode === 'archive' } } as Partial<SessionPreferences>);
  };
  const views: readonly ViewTab[] | null = store ? [
    { label: 'Tree', icon: 'ph ph-tree-view', title: 'Tree (g)', on: !graph && !archived, onSelect: () => showView('tree') },
    { label: 'Graph', icon: 'ph ph-graph', title: 'Graph (g)', on: graph && !archived, onSelect: () => showView('graph') },
    { label: archivedTopics ? `Archive ${archivedTopics}` : 'Archive', icon: 'ph ph-archive', title: 'Archived topics', on: archived, onSelect: () => showView('archive') },
  ] : null;
  const clearFilters = () => {
    if (!view) return;
    setSearchEdit(null); setDismissedReveal(currentReveal);
    saveView({ filters: clearedFilters(view.filters) });
  };
  const toggleLater = (target: ItemRoute, itemId: string) => {
    if (!preferences) return false;
    void navigation.setLater(target, !preferences.later.some(value => routeKey(value) === key && value.item_id === itemId), preferences.revision); return true;
  };
  const keys = useWorkspaceKeys<HTMLDivElement>(workspaceKeys({
    store: !!store, closeDetail, focusOwner, queueBring, archiveTopic: topicId => {
      const control = document.querySelector<HTMLButtonElement>(`[data-shortcut-archive-topic="${topicId}"]`);
      if (!control || control.disabled) return false;
      control.focus(); control.click(); return true;
    },
    focused: event => {
      const focusedId = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-item-id]')?.dataset.itemId : undefined;
      const item = sessionState?.snapshot?.session.items[focusedId ?? selectedId ?? ''];
      return route && item ? { item, target: { ...route, item_id: item.id } } : null;
    },
    oldestWaiting: () => application.waiting.getSnapshot().waiting[0]?.route,
    toggleLater,
    toggleGraph: () => setGraphModes(previous => ({ ...previous, [key]: !graph })), toggleRail,
    clearFilters: detailOpen && !!selectedId || !view || !filtering(view.filters) && !query ? undefined : clearFilters,
  }), { scope: 'workspace' });
  return <div className="product-app" onKeyDown={keys}>
    <NavigationWorkspace store={navigation} adapterChoices={adapterChoices} discovery={application.discovery} actions={application.actions}
      onRemoveTarget={removeTarget}
      session={store ? sessionFacts(sessionState, projectName) : undefined}
      chrome={{ query, views, railOn: !!store && !!view && view.rail !== 'hidden', theme: shown,
        onQueryChange: view ? text => setSearchEdit({ route: key, text, attempted: false }) : undefined,
        onToggleRail: view ? toggleRail : undefined,
        onToggleTheme: () => { if (preferences) void navigation.saveTheme(themeToggle(shown).next, preferences.revision); } }}
      // TODO(WP6): remove the selected item or topic after asking; the trash button is a no-op until then.
      onRemove={() => {}}
      waitingContent={<WaitingColumn drafts={application.drafts} store={application.waiting} revealItem={revealItem} onAgentNotRunning={onAgentNotRunning}
        selected={route && selectedId ?{ ...route, item_id: selectedId } : null}
        notice={routeError && <p className="waiting-notice waiting-notice-warn" role="alert">{routeError}</p>}
        openSession={target => { void navigation.navigate({ kind: 'session', session: target }); }} />}
      detailPath={store && selectedId && detailOpen && route ? <DetailPath store={store} itemId={selectedId} onOpenItem={itemId => revealItem({ ...route, item_id: itemId })} /> : undefined}
      detail={store && selectedId && detailOpen && route ? <><ItemDetail key={`${key}:${selectedId}`} drafts={application.drafts} store={store} itemId={selectedId}
        onFocusRequestConsumed={consumeOwnerRequest} focusRequest={ownerFocus?.route === key && ownerFocus.itemId === selectedId ? ownerFocus : undefined}
        onOpenItem={itemId => revealItem({ ...route, item_id: itemId })} onBring={() => { void queueBring({ ...route, item_id: selectedId }); }}
        highlightedMessageIds={highlightedMessages} later={later} onAgentNotRunning={onAgentNotRunning}
        onLater={value => preferences ? navigation.setLater({ ...route, item_id: selectedId }, value, preferences.revision) : Promise.resolve(false)} />
        <CopiedProvenance key={`source:${key}:${selectedId}`} store={store} itemId={selectedId} revealItem={async target => {
          const result = await navigation.routes.revealItem(target); if (result) reveal(result);
        }} /></> : undefined}
      onCloseDetail={closeDetail}
      railContent={store && view && view.rail !== 'hidden' ? <MessageRail key={key} service={application.service} store={store}
        selectedItemId={selectedId} hoveredItemId={hoveredItem} onReveal={itemId => { if (route) revealItem({ ...route, item_id: itemId }); }} onHighlight={(items, messages) => { setHighlightedItems(items); setHighlightedMessages(messages); }} onClose={toggleRail} closeDisabled={state.writing || state.pendingOperationId !== null} /> : undefined}
      renderSession={opened => <SessionCenter application={application} view={opened} graph={graph} query={query} reveal={treeReveal}
        selectedId={selectedId} detailOpen={detailOpen && !!selectedId} railOpen={!!view && view.rail !== 'hidden'}
        highlightedItems={highlightedItems} highlightedMessages={highlightedMessages} onHoverItem={hoverItem} onSelected={selected}
        onDismissReveal={() => setDismissedReveal(currentReveal)} onResume={() => { setDismissedReveal(currentReveal); closeDetail(); }}
        onAct={(intent, target) => {
          if (intent === 'bring') void queueBring(target);
          else if (intent === 'later') toggleLater(target, target.item_id);
          else focusOwner(target, intent);
        }}
        onClearFilters={clearFilters} onShowArchive={() => showView('archive')} revealItem={revealItem}
        // TODO(WP6): remove the item or topic after asking; a no-op until the remove command lands.
        onRemove={() => {}} onRemoveTarget={removeTarget} onAgentNotRunning={onAgentNotRunning} />} />
    <ContinueTopicHost navigation={navigation} actions={application.actions} onSent={target => {
      // The continued topic now lives in the target session: show it there in the tree.
      if (route && routeKey(target) === key && archived) showView('tree');
    }} />
    <AgentNotRunningHost navigation={navigation} />
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
      drafts: new OwnerDraftStore(service), actions: new SessionActionControllers(service), discovery: new DiscoveryController(service) };
    setApplication(next);
    return () => { next.discovery.dispose(); next.waiting.stop(); next.navigation.stop(); };
  }, [service]);
  return application ? <Workspace application={application} /> : <p role="status">Opening Ariadne…</p>;
}
export default function App() {
  const [service] = useState(() => createDesktopService());
  return <DesktopApp service={service} />;
}
