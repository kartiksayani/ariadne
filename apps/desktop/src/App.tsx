import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { createDesktopService, type RendererService } from './data/service';
import { DiscoveryController } from './data/discovery';
import { useSession, type SessionState, type SessionStore } from './data/session-store';
import type { RevealedItem } from './data/routes';
import { plainFailure } from './data/plain';
import type { ItemRoute, SessionPreferences, SessionRef } from './generated/core';
import { NavigationStore, useNavigation } from './state/navigation/store';
import { OwnerDraftStore, useOwnerDrafts } from './state/drafts/store';
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
import { hiddenItems } from './ui/tree/hidden';
import { TreeView, type RowIntent } from './ui/tree/TreeView';
import { ArchivePage } from './ui/pages/ArchivePage';
import { useSessionSnapshots } from './ui/pages/snapshots';
import { AgentNotRunningHost } from './ui/dialogs/AgentNotRunning';
import { ContinueTopicHost } from './ui/dialogs/ContinueTopicDialog';
import type { RemoveHandler, RemoveSubject, RemoveTarget } from './ui/dialogs/remove';
import { RemoveDialog } from './ui/dialogs/RemoveDialog';
import { notices } from './ui/pages/notices';
import { RemovalContext, RemovalQueue } from './ui/remove/queue';
import { nextSelection, removeSubject, subtree, targetSession } from './ui/remove/model';
import { agentName, hostApp, themeToggle, type SessionFacts } from './ui/shell/model';
import { useAppliedTheme } from './ui/shell/theme';
import { useWindowKeys } from './ui/shell/windowKeys';
import { nextTextSize, textSize, useAppliedTextSize, type TextSize } from './ui/shell/textScale';
import { ItemHistoryContext, useItemHistory, type HistoryDirection } from './ui/shell/itemHistory';
import { connectionOf } from './ui/shared/connection';
import { acknowledge, ackBlocked, ackFailure, ackTarget } from './ui/shared/ack';
import { displayStatus } from './selectors/waiting/replied';
import { earlierAgent } from './ui/shared/excerpt';
import { FileRefs, LinkOpener } from './ui/shared/MarkdownText';
import { fileOpener, linkOpener } from './ui/shared/openers';
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
  removals: RemovalQueue;
}
type TreeRemoveTarget = Extract<RemoveTarget, { kind: 'item' | 'topic' }>;
const sameSession = (a: SessionRef, b: SessionRef) => a.project_id === b.project_id && a.session_id === b.session_id;
/** Header facts for the selected session, from its loaded snapshot. */
function sessionFacts(state: SessionState | null, projectName: (projectId: string) => string): SessionFacts | null {
  const session = state?.snapshot?.session;
  if (!state || !session) return null;
  const binding = session.active_binding_id ? session.bindings[session.active_binding_id] : null;
  const last = session.messages.at(-1);
  return { projectName: projectName(session.project_id), createdAt: Date.parse(session.created_at), messageCount: session.messages.length,
    agent: binding ? agentName(binding.adapter_id) : null, where: hostApp(binding?.host_location),
    connection: connectionOf(binding, binding ? state.presence[binding.id] : null),
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
  readonly quickAnswer: (target: ItemRoute, index?: number) => boolean;
  readonly ack: (target: ItemRoute, repeat: boolean) => boolean;
  readonly queueBring: (target: ItemRoute) => Promise<void>;
  readonly toggleHidden: (target: ItemRoute) => boolean;
  readonly toggleLater: (target: ItemRoute, itemId: string) => boolean;
  readonly archiveTopic: (topicId: string) => boolean;
  readonly toggleGraph: () => void;
  readonly toggleRail: () => void;
  readonly closeDetail: () => void;
  readonly clearFilters?: () => void;
  readonly askRemove: (target: TreeRemoveTarget) => boolean;
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
      if (focused && app.ack(focused.target, event.repeat)) return true;
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
    'choose-send': onItem(({ item, target }, intent) => item.status === 'waiting_on_me' && intent.kind === 'choose-send' && app.quickAnswer(target, intent.index)),
    'answer-words': onItem(({ item, target }) => item.status === 'waiting_on_me' && app.quickAnswer(target)),
    hide: onItem(({ target }, _intent, event) => event.repeat ? true : app.toggleHidden(target)),
    later: onItem(({ item, target }) => app.toggleLater(target, item.id)),
    archive: onItem(({ item }) => app.archiveTopic(item.topic_id)),
    graph: () => { if (!app.store) return false; app.toggleGraph(); return true; },
    messages: () => { if (!app.store) return false; app.toggleRail(); return true; },
    // The Waiting column's own fold button owns the fold (saved layout, narrow-window peek); the key presses it.
    waiting: () => {
      const control = document.querySelector<HTMLButtonElement>('[data-shortcut-waiting-fold]');
      if (!control || control.disabled) return false;
      control.click(); return true;
    },
    // ⌫/Delete away from a row: ask to remove the focused or selected item (rows handle their own).
    remove: onItem(({ target }) => app.askRemove({ kind: 'item', item: target })),
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
  readonly historyReveal: RevealedItem | null;
  readonly highlightedItems: ReadonlySet<string>; readonly highlightedMessages: ReadonlySet<string>;
  readonly onHoverItem: (itemId: string | null) => void; readonly onSelected: (result: RevealedItem, openDetail?: boolean) => void;
  readonly onDismissReveal: () => void; readonly onResume: () => void; readonly onAct: (intent: RowIntent, target: ItemRoute, onReveal?: (result: RevealedItem) => void) => void;
  readonly onClearFilters: () => void; readonly onClearSearch: () => void; readonly onShowArchive: () => void;
  readonly onRemove: (target: TreeRemoveTarget) => void; readonly onRemoveTarget: RemoveHandler;
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
    notices={notice || recovering ? <div className="tree-notices">{notice}{recovering && <RecoveryPanel actions={actions} />}</div> : null}
    graph={graph && !view.preferences?.filters.archived ? <NavigationGraph navigation={application.navigation} store={view.store}
      tight={props.detailOpen || props.railOpen} onReveal={props.onSelected} onHoverItem={props.onHoverItem} /> : null} />;
}
function Workspace({ application }: { application: Application }) {
  const navigation = application.navigation, state = useNavigation(navigation);
  const removals = application.removals;
  const hidden = useSyncExternalStore(removals.subscribe, removals.getSnapshot, removals.getSnapshot);
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
  const draftState = useOwnerDrafts(application.drafts);
  const ownerReady = draftState.ready && sessionState?.status === 'ready' && !sessionState.error && !!sessionState.snapshot;
  const route = sessionState?.route, key = route ? routeKey(route) : '';
  const earlier = route ? earlierAgent(route, state.sessions?.sessions.items ?? []) : null;
  const preferences = state.preferences, view = preferences?.sessions.find(value => route && routeKey(value.session) === key);
  const shortcutSequence = useRef(0), bringing = useRef(new Set<string>());
  const quickRequests = useRef(new Map<string, number>());
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
  useEffect(() => {
    if (ownerReady) {
      setRouteError(error => error === "Ariadne is still loading this session's latest changes. Try again." ? null : error);
    }
  }, [ownerReady, sessionState?.snapshot]);
  const graph = graphModes[key] ?? false;
  const currentReveal = localReveal?.store === store ? localReveal : state.reveal?.store === store ? state.reveal : null;
  const treeReveal = currentReveal === dismissedReveal ? null : currentReveal;
  const selectedId = currentReveal?.kind === 'item' ? currentReveal.route.item_id : view?.selected_item_id ?? null;
  const ackRequest = useRef(0);
  const ackActions = store ? application.actions.forSession(store) : null;
  const ackState = useSyncExternalStore(ackActions?.subscribe ?? noSubscription, ackActions?.getSnapshot ?? noSession, ackActions?.getSnapshot ?? noSession);
  useEffect(() => {
    ++ackRequest.current;
    notices.dismiss('ack-save-failed');
    return () => { ++ackRequest.current; };
  }, [key, selectedId]);
  useEffect(() => {
    const receipt = ackState?.receipt;
    if (receipt && 'data' in receipt && receipt.data.kind === 'item_ack') {
      ++ackRequest.current;
      notices.dismiss('ack-save-failed');
    }
  }, [ackState?.receipt]);
  const historyReveal = useRef<RevealedItem | null>(null);
  const historySession = sessionState?.snapshot?.session;
  const existsInHistory = useCallback((id: string) => !!route && !!historySession?.items[id] && !hidden.item(route, historySession, id),
    [route, historySession, hidden]);
  const itemHistory = useItemHistory(key, selectedId, existsInHistory);
  // The tree stops forcing a dismissed reveal's row into the filtered view ("Resume filtered view"); the detail keeps it.
  const treeSelectedId = treeReveal?.kind === 'item' ? treeReveal.route.item_id : view?.selected_item_id ?? null;
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
  const invalidateOwnerRequest = () => { ++shortcutSequence.current; quickRequests.current.clear(); setOwnerFocus(null); };
  const consumeOwnerRequest = (token: number) => {
    for (const [target, request] of quickRequests.current) if (request === token) quickRequests.current.delete(target);
    setOwnerFocus(current => current?.token === token ? null : current);
  };
  const reveal = async (result: RevealedItem, ownerToken?: number, fromHistory = false): Promise<number | null> => {
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
    historyReveal.current = fromHistory ? result : null;
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
    historyReveal.current = null;
    invalidateOwnerRequest(); setLocalReveal(result);
    if (openDetail) { detailDismissedAt.current = null; setDetailOpen(true); }
  };
  const revealItem = (target: ItemRoute) => {
    setRouteError(null);
    void navigation.routes.revealItem(target).then(result => { if (result) reveal(result); })
      .catch((error: unknown) => setRouteError(plainFailure(error, 'This registered item could not be opened.')));
  };
  const navigateHistory = (direction: HistoryDirection) => {
    if (!route || state.writing || state.pendingOperationId !== null) return false;
    return itemHistory.navigate(direction, async id => {
      const token = ++shortcutSequence.current, request = navigation.getNavigationRequest();
      setOwnerFocus(null); setRouteError(null);
      try {
        const result = await navigation.routes.revealItem({ ...route, item_id: id });
        if (result?.kind !== 'item' || shortcutSequence.current !== token || navigation.getNavigationRequest() !== request) return false;
        return await reveal(result, token, true) !== null;
      } catch (error: unknown) {
        if (shortcutSequence.current === token) setRouteError(plainFailure(error, 'This registered item could not be opened.'));
        return false;
      }
    });
  };
  const historyControls = { canBack: itemHistory.canBack && !state.writing && state.pendingOperationId === null,
    canForward: itemHistory.canForward && !state.writing && state.pendingOperationId === null,
    back: () => navigateHistory('back'), forward: () => navigateHistory('forward') };
  // Send while the session's agent isn't running asks first (1ad); see ui/answer/notRunning.
  const onAgentNotRunning = (submission: PendingSubmission) => {
    void agentNotRunning({ navigation, drafts: application.drafts, reveal: revealItem })(submission);
  };
  const focusOwner = (target: ItemRoute, intent: OwnerFocusRequest['intent'], optionIndex?: number, onReveal?: (result: RevealedItem) => void, quick?: 'send' | 'words', answerTarget?: OwnerFocusRequest['answerTarget']) => {
    const token = ++shortcutSequence.current, navigationRequest = navigation.getNavigationRequest();
    const identity = JSON.stringify(target);
    let published = false;
    quickRequests.current.clear();
    if (quick) quickRequests.current.set(identity, token);
    setOwnerFocus(null);
    void navigation.routes.revealItem(target).then(async result => {
      if (!result || result.kind !== 'item' || shortcutSequence.current !== token || navigation.getNavigationRequest() !== navigationRequest) return;
      onReveal?.(result);
      const openedRequest = await reveal(result, token);
      if (openedRequest === null || shortcutSequence.current !== token || navigation.getNavigationRequest() !== openedRequest) return;
      published = true;
      setOwnerFocus({ route: routeKey(target), itemId: target.item_id, intent, token, optionIndex, sendOption: quick === 'send', ownWords: quick === 'words', answerTarget });
    }).catch((error: unknown) => setRouteError(plainFailure(error, 'This registered item could not be opened.'))).finally(() => {
      if (quickRequests.current.get(identity) === token && (!published || shortcutSequence.current !== token)) quickRequests.current.delete(identity);
    });
  };
  const quickAnswer = (target: ItemRoute, index?: number) => {
    const current = store && route && sameSession(route, target) ? store.getSnapshot() : application.waiting.sessionState(target);
    const session = current?.snapshot?.session, item = session?.items[target.item_id];
    const draftState = application.drafts.getSnapshot(), entry = application.drafts.find(target, target.item_id, 'answer');
    if (session && item && (current?.status !== 'ready' || current.error)) {
      notices.push({ id: 'quick-answer-not-ready', icon: 'ph ph-warning-circle', iconColor: 'var(--a-danger)', dismissible: true,
        text: "Ariadne is still loading this session's latest changes. Try again." });
      return true;
    }
    notices.dismiss('quick-answer-not-ready');
    if (!session || !item || current?.status !== 'ready' || current.error || session.state !== 'active'
      || session.topics[item.topic_id]?.archived_at !== null || displayStatus(session, item) !== 'waiting_on_me'
      || state.writing || state.pendingOperationId !== null || !draftState.ready || draftState.preferenceUncertain
      || quickRequests.current.has(JSON.stringify(target))
      || Object.values(draftState.entries).some(value => sameSession(value.draft.session, target) && value.draft.target.item_id === item.id && (value.saving || value.uncertain))
      || entry?.receipt
      || index !== undefined && !item.options[index]) return false;
    focusOwner(target, 'answer', index, undefined, index === undefined ? 'words' : 'send', index === undefined ? undefined : {
      optionId: item.options[index]!.id, revision: item.revision, questionRevision: item.question_revision, bindingId: session.active_binding_id,
    });
    return true;
  };
  const queueBring = async (target: ItemRoute, onReveal?: (result: RevealedItem) => void) => {
    const identity = JSON.stringify(target);
    if (bringing.current.has(identity)) return;
    bringing.current.add(identity);
    setRouteError(null);
    const token = ++shortcutSequence.current, navigationRequest = navigation.getNavigationRequest();
    setOwnerFocus(null);
    try {
      const result = await navigation.routes.revealItem(target);
      if (!result || result.kind !== 'item' || shortcutSequence.current !== token || navigation.getNavigationRequest() !== navigationRequest) return;
      onReveal?.(result);
      const openedRequest = await reveal(result, token);
      if (openedRequest === null) return;
      await application.drafts.load();
      if (shortcutSequence.current !== token || navigation.getNavigationRequest() !== openedRequest) return;
      const current = result.store.getSnapshot(), session = current.snapshot?.session;
      if (!session || current.status !== 'ready' || current.error) {
        setRouteError("Ariadne is still loading this session's latest changes. Try again.");
        return;
      }
      const existing = application.drafts.find(target, target.item_id, 'bring');
      if (shortcutSequence.current === token) setOwnerFocus({ route: routeKey(target), itemId: target.item_id, intent: 'bring', token });
      // An existing draft, attempted operation or receipt always needs review.
      if (existing) return;
      const operation = application.drafts.begin(session, target.item_id, 'bring');
      if (!operation) return;
      application.drafts.edit(operation, { text: 'Bring this up.' });
      await application.drafts.submit(operation);
    } catch (error: unknown) { setRouteError(plainFailure(error, 'This registered item could not be opened.')); }
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
  const [textSizeTarget, setTextSizeTarget] = useState<TextSize | null>(null);
  const textSizeIntent = useRef<TextSize | null>(null);
  const shownTextSize = useAppliedTextSize(textSizeTarget ?? preferences?.global.text_scale);
  useEffect(() => {
    if (textSizeTarget === textSize(preferences?.global.text_scale) && !state.writing && state.pendingOperationId === null) {
      textSizeIntent.current = null;
      setTextSizeTarget(null);
    }
  }, [textSizeTarget, preferences?.global.text_scale, state.writing, state.pendingOperationId]);
  const restoreRefusedTextSize = useCallback((saved: boolean, size: TextSize) => {
    const latest = navigation.getSnapshot();
    if (!saved && !latest.writing && latest.pendingOperationId === null && !navigation.hasQueuedTextScale() && textSizeIntent.current === size) {
      textSizeIntent.current = null;
      setTextSizeTarget(null);
    }
  }, [navigation]);
  useEffect(() => {
    if (textSizeTarget === null) return;
    // Reconciliation can resume a queued size after its original promise has settled.
    const completion = navigation.getWritingCompletion();
    if (completion) void completion.then(saved => restoreRefusedTextSize(saved, textSizeTarget));
  }, [navigation, textSizeTarget, state.writing, state.pendingOperationId, restoreRefusedTextSize]);
  const changeTextSize = (size: TextSize) => {
    const current = navigation.getSnapshot();
    if (!current.preferences) return;
    const replacingTarget = textSizeIntent.current !== null;
    textSizeIntent.current = size;
    setTextSizeTarget(size);
    if (replacingTarget || current.writing || current.pendingOperationId !== null || size !== textSize(current.preferences.global.text_scale)) {
      void navigation.saveTextScale(size, current.preferences.revision).then(saved => restoreRefusedTextSize(saved, size));
    }
  };
  const projectName = (projectId: string) => state.projects?.projects.items.find(project => project.project_id === projectId)?.project?.display_name ?? 'Unavailable project';
  const archived = view?.filters.archived ?? false;
  // The archive is kept per project (1x), so the label counts the project's archived topics.
  const archivedTopics = route ? state.projects?.projects.items.find(project => project.project_id === route.project_id)?.counts.archived_topics ?? 0 : 0;
  // Remove (handoff README "Remove"): ask, then hide at once and run after the undo window (ui/remove/queue).
  const [asking, setAsking] = useState<{ target: RemoveTarget; subject: RemoveSubject } | null>(null);
  const askRemove = (target: TreeRemoveTarget): boolean => {
    const at = targetSession(target), session = navigation.opened.open(at).getSnapshot().snapshot?.session;
    if (!session) return false;
    if (target.kind === 'item' ? hidden.item(at, session, target.item.item_id) : hidden.topic(at, target.topic_id)) return false;
    const subject = removeSubject(session, target);
    if (!subject) return false;
    setAsking({ target, subject }); return true;
  };
  // The selection moves to the next row, else the parent, else none; detail closes when it showed what goes.
  const moveSelection = (at: SessionRef, next: string | null) => {
    if (!view || !preferences || !sameSession(at, view.session)) return;
    setLocalReveal(null);
    if (next) void navigation.routes.revealItem({ ...at, item_id: next }).then(result => { if (result?.kind === 'item') selected(result, false); }).catch(() => {});
    saveView({ selected_item_id: next });
  };
  const removeTarget: RemoveHandler = (target, subject) => {
    let restore: (() => void) | undefined;
    if (target.kind === 'item' || target.kind === 'topic') {
      const at = targetSession(target), session = navigation.opened.open(at).getSnapshot().snapshot?.session;
      const shown = route && sameSession(at, route) && selectedId ? selectedId : null;
      const gone = !!session && !!shown && (target.kind === 'item'
        ? subtree(session, target.item.item_id).some(item => item.id === shown) : session.items[shown]?.topic_id === target.topic_id);
      if (gone && session && view && shown) {
        const wasOpen = detailOpen;
        closeDetail();
        moveSelection(at, target.kind === 'item' ? nextSelection(session, view, target.item.item_id) : null);
        restore = () => { const back = { ...at, item_id: shown }; if (wasOpen) revealItem(back); else moveSelection(at, shown); };
      }
    } else if (target.kind === 'project') {
      const current = state.preferences?.global.selected_navigation;
      if (current?.kind === 'project' && current.project_id === target.project_id) {
        void navigation.navigate({ kind: 'projects' });
        restore = () => { void navigation.navigate({ kind: 'project', project_id: target.project_id }); };
      }
    }
    removals.schedule(target, subject, { restore });
  };
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
  const toggleHidden = (target: ItemRoute) => {
    const current = navigation.getSnapshot();
    if (!current.preferences || current.writing || current.pendingOperationId !== null) return false;
    const session = navigation.opened.open(target).getSnapshot().snapshot?.session ?? application.waiting.sessionState(target)?.snapshot?.session;
    const saved = current.preferences.sessions.find(value => routeKey(value.session) === routeKey(target));
    const isHidden = !!session && hiddenItems(session, new Set(saved?.hidden_item_ids ?? [])).has(target.item_id);
    setDismissedReveal(currentReveal);
    void navigation.setHidden(target, !isHidden, current.preferences.revision).then(saved => {
      if (!saved) notices.push({ id: 'hide-save-failed', icon: 'ph ph-warning-circle', iconColor: 'var(--a-danger)', dismissible: true,
        text: 'The hidden items preference could not be saved. Try again.' });
    });
    return true;
  };
  const selectedHidden = !!sessionState?.snapshot?.session && !!selectedId
    && hiddenItems(sessionState.snapshot.session, new Set(view?.hidden_item_ids ?? [])).has(selectedId);
  const keys = useWorkspaceKeys<HTMLDivElement>(workspaceKeys({
    store: !!store, closeDetail, focusOwner, quickAnswer, queueBring, ack: (target, repeat) => {
      const store = navigation.opened.open(target), session = store.getSnapshot().snapshot?.session, item = session?.items[target.item_id];
      if (!session || !item || !ackTarget(session, item)) return false;
      const actions = application.actions.forSession(store);
      if (repeat) return true;
      const blocked = ackBlocked(actions);
      if (blocked) {
        notices.push({ id: 'ack-save-failed', icon: 'ph ph-warning-circle', iconColor: 'var(--a-danger)', dismissible: true, text: blocked });
        return true;
      }
      const attempted = ++ackRequest.current;
      notices.dismiss('ack-save-failed');
      void acknowledge(actions, item.id, () => attempted !== ackRequest.current).then(saved => {
        const error = actions.getSnapshot().error;
        if (attempted === ackRequest.current && !saved && error) notices.push({ id: 'ack-save-failed', icon: 'ph ph-warning-circle', iconColor: 'var(--a-danger)', dismissible: true, text: ackFailure(error) });
      }).catch(error => {
        if (attempted === ackRequest.current) notices.push({ id: 'ack-save-failed', icon: 'ph ph-warning-circle', iconColor: 'var(--a-danger)', dismissible: true, text: ackFailure(error) });
      });
      return true;
    }, archiveTopic: topicId => {
      const control = document.querySelector<HTMLButtonElement>(`[data-shortcut-archive-topic="${topicId}"]`);
      if (!control || control.disabled) return false;
      control.focus(); control.click(); return true;
    },
    focused: event => {
      const card = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-waiting-item]') : null;
      if (card) {
        const target = { project_id: card.dataset.projectId!, session_id: card.dataset.sessionId!, item_id: card.dataset.waitingItem! };
        const session = application.waiting.sessionState(target)?.snapshot?.session, item = session?.items[target.item_id];
        return session && item && !hidden.item(target, session, item.id) ? { item, target } : null;
      }
      const focusedId = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-item-id]')?.dataset.itemId : undefined;
      const session = sessionState?.snapshot?.session, item = session?.items[focusedId ?? selectedId ?? ''];
      return route && session && item && !hidden.item(route, session, item.id) ? { item, target: { ...route, item_id: item.id } } : null;
    },
    askRemove,
    oldestWaiting: () => application.waiting.getSnapshot().waiting[0]?.route,
    toggleLater, toggleHidden,
    toggleGraph: () => setGraphModes(previous => ({ ...previous, [key]: !graph })), toggleRail,
    clearFilters: detailOpen && !!selectedId || !view || !filtering(view.filters) && !query ? undefined : clearFilters,
  }), { scope: 'workspace' });
  // Keys pressed while focus is on <body> (after launch or a click on a non-focusable area) still reach the keymap.
  const appRoot = useRef<HTMLDivElement>(null);
  useWindowKeys(appRoot, historyControls, intent => changeTextSize(nextTextSize(textSizeIntent.current ?? navigation.getSnapshot().preferences?.global.text_scale, intent)));
  return <ItemHistoryContext.Provider value={historyControls}><RemovalContext.Provider value={removals}><div ref={appRoot} className="product-app" onKeyDown={keys}>
    <NavigationWorkspace store={navigation} adapterChoices={adapterChoices} discovery={application.discovery} actions={application.actions}
      onRemoveTarget={removeTarget}
      session={store ? sessionFacts(sessionState, projectName) : undefined}
      chrome={{ query, views, railOn: !!store && !!view && view.rail !== 'hidden', theme: shown,
        textSize: shownTextSize, onTextSizeChange: changeTextSize,
        // A new search is a filter change: it drops the temporary reveal (the selection stays as its own row).
        onQueryChange: view ? text => { setSearchEdit({ route: key, text, attempted: false }); setDismissedReveal(currentReveal); } : undefined,
        onToggleRail: view ? toggleRail : undefined,
        onToggleTheme: () => { if (preferences) void navigation.saveTheme(themeToggle(shown).next, preferences.revision); } }}
      hidden={selectedHidden} onHide={route && selectedId ? () => { toggleHidden({ ...route, item_id: selectedId }); } : undefined}
      onRemove={() => { if (route && selectedId) askRemove({ kind: 'item', item: { ...route, item_id: selectedId } }); }}
      waitingContent={<WaitingColumn drafts={application.drafts} store={application.waiting} revealItem={revealItem} onAgentNotRunning={onAgentNotRunning}
        selected={route && selectedId ?{ ...route, item_id: selectedId } : null}
        notice={routeError && <p className="waiting-notice waiting-notice-warn" role="alert">{routeError}</p>}
        openSession={target => { void navigation.navigate({ kind: 'session', session: target }); }} />}
      detailPath={store && selectedId && detailOpen && route ? <DetailPath store={store} itemId={selectedId} onOpenItem={itemId => revealItem({ ...route, item_id: itemId })} /> : undefined}
      detail={store && selectedId && detailOpen && route ? <ItemDetail key={`${key}:${selectedId}`} drafts={application.drafts} store={store} itemId={selectedId}
        onFocusRequestConsumed={consumeOwnerRequest} focusRequest={ownerFocus?.route === key && ownerFocus.itemId === selectedId ? ownerFocus : undefined}
        onOpenItem={itemId => revealItem({ ...route, item_id: itemId })} onBring={() => { void queueBring({ ...route, item_id: selectedId }); }}
        highlightedMessageIds={highlightedMessages} later={later} onAgentNotRunning={onAgentNotRunning} earlierAgent={earlier}
        hiddenItemIds={view?.hidden_item_ids}
        onLater={value => preferences ? navigation.setLater({ ...route, item_id: selectedId }, value, preferences.revision) : Promise.resolve(false)}
        provenance={<CopiedProvenance store={store} itemId={selectedId}
          projectPath={projectId => state.projects?.projects.items.find(project => project.project_id === projectId)?.canonical_root ?? null} revealItem={async target => {
          const result = await navigation.routes.revealItem(target); if (result) reveal(result);
        }} />} /> : undefined}
      onCloseDetail={closeDetail}
      railContent={store && view && view.rail !== 'hidden' ? <MessageRail key={key} service={application.service} store={store} drafts={application.drafts}
        selectedItemId={selectedId} hoveredItemId={hoveredItem} onHighlight={(items, messages) => { setHighlightedItems(items); setHighlightedMessages(messages); }} onClose={toggleRail} closeDisabled={state.writing || state.pendingOperationId !== null} earlierAgent={earlier} /> : undefined}
      renderSession={opened => <SessionCenter application={application} view={opened} graph={graph} query={query} reveal={treeReveal}
        historyReveal={historyReveal.current === treeReveal ? historyReveal.current : null}
        selectedId={treeSelectedId} detailOpen={detailOpen && !!selectedId} railOpen={!!view && view.rail !== 'hidden'}
        highlightedItems={highlightedItems} highlightedMessages={highlightedMessages} onHoverItem={hoverItem} onSelected={selected}
        onDismissReveal={() => setDismissedReveal(currentReveal)} onResume={() => { setDismissedReveal(currentReveal); closeDetail(); }}
        onAct={(intent, target, onReveal) => {
          if (intent === 'bring') void queueBring(target, onReveal);
          else if (intent === 'hide') toggleHidden(target);
          else if (intent === 'later') toggleLater(target, target.item_id);
          else focusOwner(target, intent, undefined, onReveal);
        }}
        onClearSearch={() => {
          setSearchEdit({ route: key, text: '', attempted: false }); setDismissedReveal(currentReveal);
          if (view) saveView({ filters: { ...structuredClone(view.filters), search: '' } as SessionPreferences['filters'] });
        }}
        onClearFilters={clearFilters} onShowArchive={() => showView('archive')}
        onRemove={target => { askRemove(target); }} onRemoveTarget={removeTarget} onAgentNotRunning={onAgentNotRunning} />} />
    {asking && <RemoveDialog subject={asking.subject} onCancel={() => setAsking(null)} onConfirm={() => removeTarget(asking.target, asking.subject)} />}
    <ContinueTopicHost navigation={navigation} actions={application.actions} onSent={target => {
      // The continued topic now lives in the target session: show it there in the tree.
      if (route && routeKey(target) === key && archived) showView('tree');
    }} />
    <AgentNotRunningHost navigation={navigation} />
  </div></RemovalContext.Provider></ItemHistoryContext.Provider>;
}

// Construction happens in an effect, so StrictMode's discarded render creates
// no timers/listeners. Effect replay closes the first lifetime before starting
// another; tabs and their views never own application resources.
export function DesktopApp({ service }: { service: RendererService }) {
  const [application, setApplication] = useState<Application | null>(null);
  useEffect(() => {
    const navigation = new NavigationStore(service), waiting = new WaitingStore(service, navigation.opened);
    const removals = new RemovalQueue({ service, notices,
      read: async route => {
        const store = navigation.opened.open(route);
        await store.refresh();
        const current = store.getSnapshot();
        if (!current.snapshot && current.error) throw current.error;
        return current.snapshot?.session ?? null;
      },
      // After the command: the tree drops the rows, removed sessions lose their tabs, the pages recount.
      removed: async target => {
        if (target.kind === 'item' || target.kind === 'topic') await navigation.opened.open(targetSession(target)).refresh();
        else {
          const views = navigation.getSnapshot().preferences?.sessions.filter(view => view.tab_open && (target.kind === 'project'
            ? view.session.project_id === target.project_id : sameSession(view.session, target.session))) ?? [];
          for (const view of views) await navigation.closeTab(view.session);
        }
        await navigation.refresh();
        void waiting.refresh();
      } });
    const next: Application = { service, navigation, waiting, removals,
      drafts: new OwnerDraftStore(service), actions: new SessionActionControllers(service), discovery: new DiscoveryController(service) };
    const detach = removals.attach();
    setApplication(next);
    // Leaving the app runs the removals still in their window rather than dropping them.
    return () => { detach(); void removals.flush(); next.discovery.dispose(); next.waiting.stop(); next.navigation.stop(); };
  }, [service]);
  // Links in agent text open in the system browser; a failure leaves the app where it is and says so.
  const openLink = useMemo(() => linkOpener(service), [service]);
  // Files named in agent text open in the owner's text editor, only when they sit inside the item's project folder.
  const files = useMemo(() => fileOpener(service), [service]);
  return application ? <LinkOpener.Provider value={openLink}><FileRefs.Provider value={files}><Workspace application={application} /></FileRefs.Provider></LinkOpener.Provider> : <p role="status">Opening Ariadne…</p>;
}
export default function App() {
  const [service] = useState(() => createDesktopService());
  return <DesktopApp service={service} />;
}
