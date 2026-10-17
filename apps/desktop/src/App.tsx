import { useImplicitCaughtUp } from './ui/changes/useCaughtUp';
import { RecentPopover } from './ui/navigation/Recent';
import { useSeenDwell } from './ui/changes/useSeenDwell';
import { useReadingSeen } from './state/preferences/reading';
import { waitForLifecycleReady } from './ui/shared/lifecycleReady';
import { itemRemoved } from './selectors/removed';
import { hasStatusFilter } from './selectors/tree/folds';
import { AgentRemovalNotices } from './ui/remove/AgentRemovalNotices';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createDesktopService, type RendererService } from './data/service';
import { DiscoveryController } from './data/discovery';
import { useSession, type Immutable, type SessionStore } from './data/session-store';
import type { RevealedItem } from './data/routes';
import { navigationFailure } from './data/plain';
import type { ItemRoute, SessionPreferences, SessionRef } from './generated/core';
import { NavigationStore, useNavigation } from './state/navigation/store';
import { viewOf } from './state/navigation/view';
import { OwnerDraftStore, useOwnerDrafts } from './state/drafts/store';
import { readFolded } from './state/details/column';
import { WaitingStore } from './selectors/waiting/store';
import { NavigationWorkspace, type AdapterChoice, type OpenedSessionView } from './components/navigation/NavigationWorkspace';
import { NavigationGraph } from './ui/graph/NavigationGraph';
import type { OwnerFocusRequest, PendingSubmission } from './ui/answer/useSubmit';
import { agentNotRunning } from './ui/answer/notRunning';
import { ConversationView } from './ui/detail/ConversationView';
import { conversationDivider } from './ui/detail/conversationSeen';
import { DetailPath, ItemDetail } from './ui/detail/ItemDetail';
import { RailStatus } from './ui/detail/RailStatus';
import { AnswerDock } from './ui/dock/AnswerDock';
import { DockProvider } from './ui/dock/api';
import { WaitingSync } from './ui/dock/WaitingSync';
import { PeekProvider } from './ui/peek/Peek';
import { ItemRefSession } from './ui/peek/context';
import { navigationVisits } from './ui/navigation/visits';
import { attachAckAll, stopAckAll } from './ui/navigation/ackAllController';
import { UnsentMessageNotices } from './ui/answer/UnsentMessageNotices';
import { SessionActionControllers } from './components/bindings/actions';
import { RecoveryPanel, recoveryTargets } from './components/recovery/RecoveryPanel';
import { CopiedProvenance } from './components/history-actions/CopiedProvenance';
import { SessionNotice } from './components/edge-states/EdgeState';
import { DraftConflictNotices } from './components/edge-states/DraftConflictNotices';
import { hiddenItems, hiddenParentSource, hiddenSource } from './ui/tree/hidden';
import { TreeView, type RowIntent } from './ui/tree/TreeView';
import type { MapSearchStatus } from './ui/tree/mapSearch';
import { AgentNotRunningHost } from './ui/dialogs/AgentNotRunning';
import { ContinueTopicHost } from './ui/dialogs/ContinueTopicDialog';
import type { RemoveHandler, RemoveSubject, RemoveTarget } from './ui/dialogs/remove';
import { RemoveDialog } from './ui/dialogs/RemoveDialog';
import { notices } from './ui/pages/notices';
import { isViewConflict } from './ui/shared/conflictNotice';
import { RemovalContext, RemovalQueue } from './ui/remove/queue';
import { nextSelection, removeSubject, subtree, targetSession } from './ui/remove/model';
import { themeToggle } from './ui/shell/model';
import { useAppliedTheme } from './ui/shell/theme';
import { useWindowKeys } from './ui/shell/windowKeys';
import { nextTextSize, textSize, useAppliedTextSize, type TextSize } from './ui/shell/textScale';
import { ItemHistoryContext, useItemHistory, type HistoryDirection } from './ui/shell/itemHistory';
import { acknowledge, ackBlocked, ackFailure, ackTarget } from './ui/shared/ack';
import { earlierAgent } from './ui/shared/excerpt';
import { FileRefs, LinkOpener } from './ui/shared/MarkdownText';
import { fileOpener, linkOpener, listenForLinkFailures } from './ui/shared/openers';
import { useWorkspaceKeys } from './ui/keys';
import { itemIntents, workspaceKeys, type ItemIntentApp, type TreeRemoveTarget } from './ui/shell/workspaceKeys';
import { useIntents } from './ui/intents';
import { useConversation } from './ui/detail/useConversation';

const adapters: readonly AdapterChoice[] = [
  { adapter_id: 'claude_code_mod', label: 'Claude Code Mod', configuration: { namespace: 'claude_code_mod', values: {} } },
  { adapter_id: 'codex', label: 'Codex', configuration: { namespace: 'codex', values: {} } },
];
const routeKey = (route: SessionRef) => JSON.stringify([route.project_id, route.session_id]);
const recordViewed = (result: RevealedItem) => { if (result.kind === 'item') navigationVisits.record(result.route, result.route.item_id, 'viewed'); };
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
const sameSession = (a: SessionRef, b: SessionRef) => a.project_id === b.project_id && a.session_id === b.session_id;
const clearedFilters = (filters: { readonly archived: boolean }): SessionPreferences['filters'] =>
  ({ search: '', statuses: [], owners: [], topic_id: null, hide_later: false, archived: filters.archived });
const filtering = (filters: Immutable<SessionPreferences['filters']>) => !!filters.search.trim() || hasStatusFilter(filters.statuses)
  || filters.owners.length > 0 || filters.hide_later;
interface CenterProps {
  readonly application: Application; readonly view: OpenedSessionView; readonly graph: boolean; readonly query: string;
  readonly reveal: RevealedItem | null; readonly selectedId: string | null; readonly detailOpen: boolean;
  readonly historyReveal: RevealedItem | null;
  readonly covered?: boolean;
  readonly actingId?: string | null;
  readonly onSelected: (result: RevealedItem, openDetail?: boolean) => void;
  readonly onDismissReveal: () => void; readonly onResume: () => void; readonly onAct: (intent: RowIntent, target: ItemRoute, onReveal?: (result: RevealedItem) => void) => void;
  readonly onOpenItem: (itemId: string) => void;
  readonly onClearFilters: () => void; readonly onClearSearch: () => void; readonly onShowArchive: () => void;
  readonly onRemove: (target: TreeRemoveTarget) => void;
  readonly filterOpen?: boolean;
  readonly onSearchStatus?: (status: MapSearchStatus | null) => void;
}
function SessionCenter({ application, view, graph, reveal, ...props }: CenterProps) {
  const state = useSession(view.store), session = state.snapshot?.session;
  const navigation = useNavigation(application.navigation);
  const actions = application.actions.forSession(view.store);
  const seen = useReadingSeen(application.navigation.reading, navigation.preferences, state.route);
  useImplicitCaughtUp(application.navigation, session, seen, state.status === 'ready' && state.snapshot?.freshness === 'fresh');
  const summaries = navigation.sessions?.sessions.items ?? [];
  const recovering = session ? recoveryTargets(session).length > 0 : false;
  const notice = state.status !== 'loading' && <SessionNotice state={state} refresh={() => { void view.store.refresh(); }} />;
  return <TreeView {...props} navigation={application.navigation} store={view.store} actions={actions} drafts={application.drafts}
    reveal={reveal?.store === view.store ? reveal : null} summaries={summaries}
    notices={notice || recovering ? <div className="tree-notices">{notice}{recovering && <RecoveryPanel actions={actions} />}</div> : null}
    graph={graph ? <NavigationGraph navigation={application.navigation} store={view.store}
      reveal={reveal} onReveal={props.onSelected} /> : null} />;
}
function Workspace({ application }: { application: Application }) {
  const navigation = application.navigation, state = useNavigation(navigation);
  useEffect(() => navigationVisits.bind(navigation), [navigation]);
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
  const showBinTree = useCallback((route: SessionRef) => setGraphModes(previous => ({ ...previous, [routeKey(route)]: false })), []);
  const invalidateOwnerRequest = () => { ++shortcutSequence.current; quickRequests.current.clear(); setOwnerFocus(null); };
  const { conversation, conversationOpen, showConversation, closeConversation } = useConversation(key, invalidateOwnerRequest);
  const [detailOpen, setDetailOpen] = useState(true);
  // Counts the owner's choices of an item to show in Details; each one unfolds a folded Details column.
  const [detailAsked, setDetailAsked] = useState(0);
  // The Details column's fold, as the column reports it: a folded column's item is not being seen.
  const [detailsFolded, setDetailsFolded] = useState(readFolded);
  const detailDismissedAt = useRef<number | null>(null);
  const [localReveal, setLocalReveal] = useState<RevealedItem | null>(null);
  // "Resume filtered view", a filter change or a fold drops the tree's temporary reveal.
  const [dismissedReveal, setDismissedReveal] = useState<RevealedItem | null>(null);
  const [searchEdit, setSearchEdit] = useState<{ route: string; text: string; attempted: boolean } | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const routeFailureCapture = useRef(sessionState?.snapshot);
  const reportRouteError = (error: string) => {
    routeFailureCapture.current = navigation.selectedSession()?.getSnapshot().snapshot;
    setRouteError(error);
  };
  useEffect(() => () => notices.dismiss('route-open-failed'), []);
  useEffect(() => {
    if (routeError) notices.push({ id: 'route-open-failed', icon: 'ph ph-warning-circle', iconColor: 'var(--a-warn)', text: routeError });
    else notices.dismiss('route-open-failed');
  }, [routeError]);
  useEffect(() => {
    // A ready effect can lag behind the store while a refusal is reported.
    // Only the current capture can clear it; an older effect must not win.
    if (ownerReady && sessionState?.snapshot === navigation.selectedSession()?.getSnapshot().snapshot
      && sessionState?.snapshot !== routeFailureCapture.current) {
      setRouteError(error => error === "Ariadne is still loading this session's latest changes. Try again." ? null : error);
    }
  }, [navigation, ownerReady, sessionState?.snapshot]);
  const graph = graphModes[key] ?? false;
  const currentReveal = localReveal?.store === store ? localReveal : state.reveal?.store === store ? state.reveal : null;
  const treeReveal = currentReveal === dismissedReveal ? null : currentReveal;
  const candidateId = currentReveal?.kind === 'item' ? currentReveal.route.item_id : view?.selected_item_id ?? null;
  const selectedId = candidateId && sessionState?.snapshot?.session.items[candidateId] && !itemRemoved(sessionState.snapshot.session, candidateId) ? candidateId : null;
  const readingId = conversation?.route === key ? conversation.itemId : selectedId;
  const seenRevision = readingId ? sessionState?.snapshot?.session.items[readingId]?.revision : null;
  const readingSeen = useReadingSeen(navigation.reading, state.preferences, route ?? { project_id: '', session_id: '' });
  const observedSeen = useReadingSeen(navigation.reading, state.preferences, route ?? { project_id: '', session_id: '' }, false);
  const detailNeedsRead = useMemo(() => readingId != null && seenRevision != null
    && (observedSeen?.items.find(item => item.item_id === readingId)?.revision ?? -1) < seenRevision,
  [observedSeen, readingId, seenRevision]);
  const observeDetail = useCallback(() => {
    if (route && readingId) navigation.markItemSeen(route, readingId, seenRevision ?? undefined);
  }, [navigation, route?.project_id, route?.session_id, readingId, seenRevision]);
  // Folded Details shows only its rail, so its item is not seen: the dwell waits, and starts from zero on unfold.
  useSeenDwell((!!conversation || detailOpen && !detailsFolded) && detailNeedsRead && route && readingId && sessionState?.status === 'ready' && !sessionState.error ? `${key}:${readingId}` : null, seenRevision, observeDetail);
  const openConversation = (itemId: string) => {
    const session = store?.getSnapshot().snapshot?.session;
    if (!session?.items[itemId] || !route) return;
    if (showConversation(itemId, () => conversationDivider(session, itemId, observedSeen))) navigationVisits.record(route, itemId, 'viewed');
  };
  const [answerJump, setAnswerJump] = useState<{ route: string; itemId: string; messageId: string; token: number } | null>(null);
  const answerJumpSequence = useRef(0);
  const consumeAnswerJump = useCallback((token: number) => setAnswerJump(previous => previous?.token === token ? null : previous), []);
  const ackRequest = useRef(0);
  const ackNoticeId = useRef<string | null>(null);
  const ackActions = store ? application.actions.forSession(store) : null;
  const ackState = useSyncExternalStore(ackActions?.subscribe ?? noSubscription, ackActions?.getSnapshot ?? noSession, ackActions?.getSnapshot ?? noSession);
  useEffect(() => {
    ++ackRequest.current;
    if (ackNoticeId.current) notices.dismiss(ackNoticeId.current);
    return () => {
      ++ackRequest.current;
      if (ackNoticeId.current) notices.dismiss(ackNoticeId.current);
    };
  }, [key, selectedId]);
  useEffect(() => {
    const receipt = ackState?.receipt;
    if (receipt && 'data' in receipt && receipt.data.kind === 'item_ack') {
      ++ackRequest.current;
      const route = ackActions?.session.getSnapshot().route;
      if (route) notices.dismiss(JSON.stringify(['item-ack', route.project_id, route.session_id, receipt.data.item_id]));
    }
  }, [ackState?.receipt, ackActions]);
  const historyReveal = useRef<RevealedItem | null>(null);
  const historySession = sessionState?.snapshot?.session;
  const existsInHistory = useCallback((id: string) => !!route && !!historySession?.items[id] && !itemRemoved(historySession, id) && !hidden.item(route, historySession, id),
    [route, historySession, hidden]);
  const itemHistory = useItemHistory(key, selectedId, existsInHistory);
  // The tree stops forcing a dismissed reveal's row into the filtered view ("Resume filtered view"); the detail keeps it.
  const treeCandidateId = treeReveal?.kind === 'item' ? treeReveal.route.item_id : view?.selected_item_id ?? null;
  const treeSelectedId = treeCandidateId && sessionState?.snapshot?.session.items[treeCandidateId] && !itemRemoved(sessionState.snapshot.session, treeCandidateId) ? treeCandidateId : null;
  const theme = preferences?.global.theme ?? 'system';
  const query = searchEdit?.route === key ? searchEdit.text : view?.filters.search ?? '';
  // Saved selection is authoritative, but its late receipt is not a newer
  // presentation intent than Escape. Deliberate navigation has a new epoch.
  useEffect(() => {
    if (detailDismissedAt.current !== navigation.getNavigationRequest()) setDetailOpen(true);
    setLocalReveal(null);
  }, [key, navigation]);
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
  const consumeOwnerRequest = (token: number) => {
    for (const [target, request] of quickRequests.current) if (request === token) quickRequests.current.delete(target);
    setOwnerFocus(current => current?.token === token ? null : current);
  };
  const reveal = async (target: ItemRoute, token: number, fromHistory = false, onReveal?: (result: RevealedItem) => void, requireItem = fromHistory, openDetail = true): Promise<{ request: number; result: RevealedItem } | null> => {
    let result: RevealedItem | null = null;
    let failure: unknown = null;
    // Reserve the destination at the click, before registered item resolution
    // yields. An older tab or link can no longer submit while this one loads.
    void navigation.navigate({ kind: 'session', session: { project_id: target.project_id, session_id: target.session_id } }, null,
      () => shortcutSequence.current === token, async () => {
        const resolved = await navigation.routes.revealItem(target);
        if (requireItem && resolved?.kind !== 'item') return null;
        if (resolved && shortcutSequence.current === token && navigation.getNavigationRequest() === request) {
          result = resolved;
          historyReveal.current = fromHistory ? resolved : null;
          onReveal?.(resolved);
        }
        return resolved;
      }, error => { failure = error; });
    const request = navigation.getNavigationRequest();
    // Closed Details stays closed through this navigation: its epoch is the one the owner dismissed Details at.
    if (!openDetail && !detailOpen) detailDismissedAt.current = request;
    const opened = navigation.getNavigationCompletion(request);
    const saved = await opened;
    if (navigation.getNavigationRequest() !== request || shortcutSequence.current !== token) return null;
    if (!saved) { if (failure) throw failure; return null; }
    if (!result) return null;
    recordViewed(result);
    setLocalReveal(result);
    // "Go to" in the peek selects and scrolls to the row; only the opening paths open Details.
    if (openDetail) { detailDismissedAt.current = null; setDetailOpen(true); setDetailAsked(count => count + 1); }
    // Continuations use this exact admitted request, including queued reveals.
    return { request, result };
  };
  // Tree and graph already save their own selection through navigation.
  // The graph's ↑/↓ and "−" move the selection without opening detail (Ariadne.dc.html `select`).
  const selected = (result: RevealedItem, openDetail = true) => {
    recordViewed(result);
    historyReveal.current = null;
    invalidateOwnerRequest(); setLocalReveal(result);
    if (openDetail) { detailDismissedAt.current = null; setDetailOpen(true); setDetailAsked(count => count + 1); }
  };
  const revealLinkedItem = (target: ItemRoute, openDetail = true) => {
    if (conversation) closeConversation();
    setRouteError(null);
    invalidateOwnerRequest();
    return reveal(target, shortcutSequence.current, false, undefined, false, openDetail);
  };
  const revealItem = (target: ItemRoute, openDetail = true) => {
    void revealLinkedItem(target, openDetail).catch((error: unknown) => reportRouteError(navigationFailure(error)));
  };
  const navigateHistory = (direction: HistoryDirection) => {
    if (conversation || !route || state.writing || state.pendingOperationId !== null) return false;
    return itemHistory.navigate(direction, async id => {
      const token = ++shortcutSequence.current;
      setOwnerFocus(null); setRouteError(null);
      try {
        return await reveal({ ...route, item_id: id }, token, true) !== null;
      } catch (error: unknown) {
        if (shortcutSequence.current === token) reportRouteError(navigationFailure(error));
        return false;
      }
    });
  };
  const historyControls = { canBack: itemHistory.canBack && !state.writing && state.pendingOperationId === null,
    canForward: itemHistory.canForward && !state.writing && state.pendingOperationId === null,
    back: () => navigateHistory('back'), forward: () => navigateHistory('forward') };
  // Send while the session's agent isn't running asks first (1ad); see ui/answer/notRunning.
  const onAgentNotRunning = (submission: PendingSubmission) => {
    void agentNotRunning()(submission);
  };
  const focusOwner = (target: ItemRoute, intent: OwnerFocusRequest['intent'], optionIndex?: number, onReveal?: (result: RevealedItem) => void, quick?: 'send' | 'words', answerTarget?: OwnerFocusRequest['answerTarget']) => {
    const token = ++shortcutSequence.current;
    const identity = JSON.stringify(target);
    let published = false;
    quickRequests.current.clear();
    if (quick) quickRequests.current.set(identity, token);
    setOwnerFocus(null);
    if (conversationOpen && conversation && route && sameSession(route, target) && conversation.itemId === target.item_id) {
      setOwnerFocus({ route: key, itemId: target.item_id, intent, token, optionIndex, sendOption: quick === 'send', ownWords: quick === 'words', answerTarget });
      return;
    }
    void reveal(target, token, false, onReveal, true).then(opened => {
      if (!opened || opened.result.kind !== 'item' || shortcutSequence.current !== token || navigation.getNavigationRequest() !== opened.request) return;
      published = true;
      setOwnerFocus({ route: routeKey(target), itemId: target.item_id, intent, token, optionIndex, sendOption: quick === 'send', ownWords: quick === 'words', answerTarget });
    }).catch((error: unknown) => reportRouteError(navigationFailure(error))).finally(() => {
      if (quickRequests.current.get(identity) === token && (!published || shortcutSequence.current !== token)) quickRequests.current.delete(identity);
    });
  };
  const queueBring = async (target: ItemRoute, onReveal?: (result: RevealedItem) => void) => {
    const identity = JSON.stringify(target);
    if (bringing.current.has(identity)) return;
    bringing.current.add(identity);
    setRouteError(null);
    const token = ++shortcutSequence.current;
    setOwnerFocus(null);
    try {
      if (conversationOpen && conversation && route && sameSession(route, target) && target.item_id === conversation.itemId) {
        await application.drafts.load();
        const current = store?.getSnapshot(), session = current?.snapshot?.session;
        if (shortcutSequence.current !== token || !session || current?.status !== 'ready' || current.error) return;
        const existing = application.drafts.find(target, target.item_id, 'bring');
        if (existing) return;
        const operation = application.drafts.begin(session, target.item_id, 'bring');
        if (operation) { application.drafts.edit(operation, { text: 'Bring this up.' }); await application.drafts.submit(operation); }
        return;
      }
      const opened = await reveal(target, token, false, onReveal, true);
      if (!opened || opened.result.kind !== 'item') return;
      const { result, request: openedRequest } = opened;
      await application.drafts.load();
      if (shortcutSequence.current !== token || navigation.getNavigationRequest() !== openedRequest) return;
      const current = result.store.getSnapshot(), session = current.snapshot?.session;
      if (!session || current.status !== 'ready' || current.error) {
        reportRouteError("Ariadne is still loading this session's latest changes. Try again.");
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
    } catch (error: unknown) { reportRouteError(navigationFailure(error)); }
    finally { bringing.current.delete(identity); }
  };
  const saveView = (change: Partial<SessionPreferences>) => {
    if (view && preferences) void navigation.saveSessionView({ ...structuredClone(view), ...change } as SessionPreferences, preferences.revision);
  };
  const closeDetail = () => { invalidateOwnerRequest(); detailDismissedAt.current = navigation.getNavigationRequest(); setDetailOpen(false); };
  const later = route && selectedId ? preferences?.later.some(item => routeKey(item) === key && item.item_id === selectedId) ?? false : false;
  // The waiting question Details (or the bigger view) is answering leaves the dock's list. A folded Details shows no
  // question, so it never claims one: the dock keeps it in view.
  const answeringId = conversationOpen ? conversation?.itemId ?? null : detailOpen && !detailsFolded ? selectedId : null;
  const answering = answeringId && sessionState?.snapshot?.session.items[answeringId]?.status === 'waiting_on_me' ? answeringId : null;
  // As the Waiting column did: with the conversation open, a dock path segment shows that item there and the Map stays.
  const openFromDock = (itemId: string) => {
    if (conversationOpen) openConversation(itemId);
    else if (route) revealItem({ ...route, item_id: itemId });
  };
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
  // A view saved by an older release may still show archived topics in the Tree; Tree or Graph leaves that.
  const archived = view?.filters.archived ?? false;
  const [filterOpen, setFilterOpen] = useState(false);
  // The Recent popover under the top bar's clock button; ⌘E and the button both toggle it (D19).
  const [recentOpen, setRecentOpen] = useState(false);
  // The Map publishes its search count, arrows and note here for the top bar.
  const [searchStatus, setSearchStatus] = useState<MapSearchStatus | null>(null);

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
      const shown = viewOf(state);
      if (shown.kind === 'page' && shown.projectId === target.project_id) {
        navigation.openPage({ kind: 'page', page: 'projects' });
        restore = () => { navigation.openPage({ kind: 'page', page: 'sessions', projectId: target.project_id }); };
      }
    }
    removals.schedule(target, subject, { restore });
  };
  const showView = (mode: 'tree' | 'graph' | 'archive') => {
    if (conversation) closeConversation();
    setGraphModes(previous => ({ ...previous, [key]: mode === 'graph' }));
    if (mode === 'archive') { navigation.openPage({ kind: 'page', page: 'archive' }); return; }
    if (view?.filters.archived) saveView({ filters: { ...structuredClone(view.filters), archived: false } } as Partial<SessionPreferences>);
  };
  const clearFilters = () => {
    if (!view) return;
    setSearchEdit(null); setDismissedReveal(currentReveal);
    saveView({ filters: clearedFilters(view.filters) });
  };
  // An explicit clear (the top bar's ×, esc, MapSearch.clear) saves at once, so a session switch never brings it back.
  const clearSearch = () => {
    setSearchEdit({ route: key, text: '', attempted: false });
    if (view?.filters.search) saveView({ filters: { ...structuredClone(view.filters), search: '' } as SessionPreferences['filters'] });
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
  const selectedSession = sessionState?.snapshot?.session;
  const explicitHidden = new Set(view?.hidden_item_ids ?? []);
  const hiddenBy = selectedSession && selectedId ? hiddenSource(selectedSession, explicitHidden, selectedId) : null;
  const selectedHidden = hiddenBy !== null;
  const hiddenParentId = selectedSession && selectedId ? hiddenParentSource(selectedSession, explicitHidden, selectedId) : null;
  const hiddenParent = hiddenParentId ? selectedSession?.items[hiddenParentId]?.question : null;
  const hiddenNotice = hiddenParent ? selectedId && explicitHidden.has(selectedId)
    ? `Hidden, along with its parent “${hiddenParent}”.` : `Hidden with its parent “${hiddenParent}”` : undefined;
  const intentApp: ItemIntentApp = {
    store: !!store, onPage: viewOf(state).kind !== 'session', toggleFilters: () => setFilterOpen(value => !value), closeDetail, closeConversation: conversationOpen ? closeConversation : undefined, focusOwner, queueBring, ack: (target, repeat) => {
      const store = navigation.opened.open(target), session = store.getSnapshot().snapshot?.session, item = session?.items[target.item_id];
      if (!session || !item || !ackTarget(session, item)) return false;
      const actions = application.actions.forSession(store);
      if (repeat) return true;
      const id = JSON.stringify(['item-ack', target.project_id, target.session_id, target.item_id]);
      ackNoticeId.current = id;
      const blocked = ackBlocked(actions);
      if (blocked) {
        notices.push({ id, icon: 'ph ph-warning-circle', iconColor: 'var(--a-danger)', dismissible: true, text: blocked });
        return true;
      }
      const attempted = ++ackRequest.current;
      notices.dismiss(id);
      void acknowledge(actions, item.id, () => attempted !== ackRequest.current).then(saved => {
        if (saved) navigationVisits.record(target, item.id, 'acked');
        const error = actions.getSnapshot().error;
        if (attempted === ackRequest.current && !saved && error && !isViewConflict(error)) notices.push({ id, icon: 'ph ph-warning-circle', iconColor: 'var(--a-danger)', dismissible: true, text: ackFailure(error) });
      }).catch(error => {
        if (attempted === ackRequest.current) notices.push({ id, icon: 'ph ph-warning-circle', iconColor: 'var(--a-danger)', dismissible: true, text: ackFailure(error) });
      });
      return true;
    },
    focused: () => {
      // While a page shows, the Map's selection is hidden behind it: item keys have nothing to act on.
      if (viewOf(state).kind !== 'session') return null;
      const session = sessionState?.snapshot?.session;
      // The bigger view's item, even when the Map selected another one meanwhile.
      if (conversationOpen && conversation && route) {
        const item = session?.items[conversation.itemId];
        return session && item && !itemRemoved(session, item.id) ? { item, target: { ...route, item_id: item.id } } : null;
      }
      const item = session?.items[selectedId ?? ''];
      return route && session && item && !itemRemoved(session, item.id) && !hidden.item(route, session, item.id) ? { item, target: { ...route, item_id: item.id } } : null;
    },
    askRemove,
    toggleLater, toggleHidden,
    toggleGraph: () => setGraphModes(previous => ({ ...previous, [key]: !graph })),
    clearFilters: detailOpen && !!selectedId || !view || !filtering(view.filters) && !query ? undefined : clearFilters,
  };
  useIntents(itemIntents(intentApp));
  useIntents({ 'recent.open': () => { if (!store || viewOf(state).kind !== 'session') return false; setRecentOpen(value => !value); return true; } });
  // Recent belongs to the session on screen: leaving it, or a page, closes it.
  const viewKind = viewOf(state).kind;
  useEffect(() => { setRecentOpen(false); }, [key, viewKind]);
  const keys = useWorkspaceKeys<HTMLDivElement>(workspaceKeys(intentApp), { scope: 'workspace' });
  // Keys pressed while focus is on <body> (after launch or a click on a non-focusable area) still reach the keymap.
  const appRoot = useRef<HTMLDivElement>(null);
  useWindowKeys(appRoot, historyControls, intent => changeTextSize(nextTextSize(textSizeIntent.current ?? navigation.getSnapshot().preferences?.global.text_scale, intent)));
  return <PeekProvider lookup={target => navigation.opened.open(target)} drafts={application.drafts} navigation={navigation} onGoTo={target => revealItem(target, false)} onOpenDetails={target => revealItem(target)} onAgentNotRunning={onAgentNotRunning}
    answerTarget={conversationOpen && conversation && route ? { ...route, item_id: conversation.itemId } : undefined}
    onVisit={(target, action) => { if (action !== 'opened') navigationVisits.record(target, target.item_id, action === 'peek' ? 'peeked' : 'answered'); }}>
    <ItemRefSession.Provider value={route ?? null}><ItemHistoryContext.Provider value={historyControls}><RemovalContext.Provider value={removals}><div ref={appRoot} className="product-app" onKeyDown={keys} onKeyDownCapture={event => {
      if (!conversationOpen) return;
      if (event.key === 'Escape' && !event.nativeEvent.isComposing && !event.metaKey && !event.ctrlKey && !event.altKey
        && !document.querySelector('[aria-modal="true"]')) {
        // An open top-bar menu owns Escape before a peek or the conversation does.
        const control = document.querySelector<HTMLElement>('.tb-pop');
        if (control) {
          const owner = control.closest('.tb-anchor') ?? control;
          if (!(event.target instanceof Node) || !owner.contains(event.target)) {
            event.preventDefault(); event.stopPropagation();
            control.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
          }
          return;
        }
        if (event.target instanceof Element && event.target.closest('.pw-note')) return;
        event.preventDefault(); event.stopPropagation();
        const peekClose = document.querySelector<HTMLButtonElement>('.item-peek [aria-label="Close peek"]');
        if (peekClose) peekClose.click(); else closeConversation();
      }
    }}>
    <UnsentMessageNotices waiting={application.waiting} drafts={application.drafts} opened={navigation.opened} navigation={navigation}
      selectedStore={store ?? null} />
    <DraftConflictNotices drafts={application.drafts} opened={navigation.opened} selectedSession={route ?? null} />
    <WaitingSync waiting={application.waiting} drafts={application.drafts} />
    <AgentRemovalNotices waiting={application.waiting} controllers={application.actions} navigation={navigation}
      selectedSession={sessionState?.snapshot?.session ?? null} onTree={showBinTree} />
    <NavigationWorkspace store={navigation} adapterChoices={adapterChoices} discovery={application.discovery} actions={application.actions}
      onRemoveTarget={removeTarget} waitingStore={application.waiting}
      chrome={{ query, searchStatus, graph: graph && !archived, onView: store ? showView : undefined, theme: shown, searchBlocked: conversationOpen,
        filter: store ? { active: filterOpen, count: view && hasStatusFilter(view.filters.statuses) ? view.filters.statuses.length : 0, onToggle: () => setFilterOpen(value => !value) } : undefined,
        onRecent: store ? () => setRecentOpen(value => !value) : undefined, recentOpen,
        recentPanel: recentOpen && store && route && sessionState?.snapshot?.session
          ? <RecentPopover session={sessionState.snapshot.session} entries={view?.recent_items}
            onReveal={itemId => revealItem({ ...route, item_id: itemId })}
            onClose={restoreFocus => { setRecentOpen(false); if (restoreFocus) document.querySelector<HTMLElement>('[data-popover-trigger="recent"]')?.focus(); }} /> : undefined,
        textSize: shownTextSize, onTextSizeChange: changeTextSize,
        // A search highlights in place (SPEC §6.9): typing keeps every row, including a temporary reveal's.
        onQueryChange: view ? text => { if (conversation) closeConversation(); setSearchEdit({ route: key, text, attempted: false }); } : undefined,
        onClearSearch: view ? clearSearch : undefined,
        onToggleTheme: () => { if (preferences) void navigation.saveTheme(themeToggle(shown).next, preferences.revision); } }}
      hidden={selectedHidden} hiddenNotice={hiddenNotice} onHide={route && selectedId ? () => { toggleHidden({ ...route, item_id: selectedId }); } : undefined}
      onRemove={() => { if (route && selectedId) askRemove({ kind: 'item', item: { ...route, item_id: selectedId } }); }}
      dockContent={store && route ? <AnswerDock store={store} waiting={application.waiting} drafts={application.drafts} answering={answering}
        onAgentNotRunning={onAgentNotRunning} onOpenItem={openFromDock}
        onSeen={(itemId, revision) => navigation.markItemSeen(route, itemId, revision)} /> : undefined}
      detailPath={store && selectedId && detailOpen && route ? <DetailPath store={store} itemId={selectedId} onOpenItem={itemId => revealItem({ ...route, item_id: itemId })} /> : undefined}
      detailAsked={detailAsked} onDetailsFolded={setDetailsFolded}
      detailRail={store && selectedId && detailOpen && route ? <RailStatus store={store} itemId={selectedId} seen={readingSeen} /> : undefined}
      detail={conversationOpen ? <div data-covered-detail="" /> : store && selectedId && detailOpen && route ? <ItemDetail key={`${key}:${selectedId}`} drafts={application.drafts} store={store} itemId={selectedId}
        onFocusRequestConsumed={consumeOwnerRequest} focusRequest={ownerFocus?.route === key && ownerFocus.itemId === selectedId ? ownerFocus : undefined}
        onOpenItem={itemId => revealItem({ ...route, item_id: itemId })} onBring={() => { void queueBring({ ...route, item_id: selectedId }); }}
        onOpenConversation={() => openConversation(selectedId)}
        later={later} onAgentNotRunning={onAgentNotRunning} earlierAgent={earlier}
        hiddenItemIds={view?.hidden_item_ids} seen={readingSeen}
        answerJump={answerJump?.route === key && answerJump.itemId === selectedId ? answerJump : undefined}
        onAnswerJumpConsumed={consumeAnswerJump}
        onOpenAnswer={(itemId, messageId) => { setAnswerJump({ route: key, itemId, messageId, token: ++answerJumpSequence.current }); revealItem({ ...route, item_id: itemId }); }}
        onLater={value => preferences ? navigation.setLater({ ...route, item_id: selectedId }, value, preferences.revision) : Promise.resolve(false)}
        provenance={<CopiedProvenance store={store} itemId={selectedId}
          projectPath={projectId => state.projects?.projects.items.find(project => project.project_id === projectId)?.canonical_root ?? null} revealItem={revealLinkedItem} />} /> : undefined}
      conversation={conversation?.route === key && store && route ? <ConversationView key={`${key}:${conversation.itemId}`} drafts={application.drafts}
        store={store} itemId={conversation.itemId} later={preferences?.later.some(value => sameSession(value, route) && value.item_id === conversation.itemId) ?? false}
        onClose={closeConversation} onBring={() => { void queueBring({ ...route, item_id: conversation.itemId }); }} onOpenItem={itemId => revealItem({ ...route, item_id: itemId })}
        dividerId={conversation.dividerId} seen={readingSeen} hiddenItemIds={view?.hidden_item_ids}
        focusRequest={ownerFocus?.route === key && ownerFocus.itemId === conversation.itemId ? ownerFocus : undefined}
        onFocusRequestConsumed={consumeOwnerRequest} onAgentNotRunning={onAgentNotRunning}
        onLater={value => preferences ? navigation.setLater({ ...route, item_id: conversation.itemId }, value, preferences.revision) : Promise.resolve(false)} /> : undefined}
      onCloseDetail={closeDetail}
      renderSession={opened => <SessionCenter filterOpen={filterOpen} application={application} view={opened} graph={graph} query={query} reveal={treeReveal}
        covered={conversationOpen} actingId={conversationOpen ? conversation?.itemId : null}
        historyReveal={historyReveal.current === treeReveal ? historyReveal.current : null}
        selectedId={treeSelectedId} detailOpen={conversationOpen || detailOpen && !!selectedId}
        onSelected={selected}
        onOpenItem={itemId => { if (route) revealItem({ ...route, item_id: itemId }); }}
        onDismissReveal={() => setDismissedReveal(currentReveal)} onResume={() => { setDismissedReveal(currentReveal); closeDetail(); }}
        onAct={(intent, target, onReveal) => {
          if (intent === 'bring') void queueBring(target, onReveal);
          else if (intent === 'hide') toggleHidden(target);
          else if (intent === 'later') toggleLater(target, target.item_id);
          else focusOwner(target, intent, undefined, onReveal);
        }}
        onSearchStatus={setSearchStatus}
        onClearSearch={clearSearch}
        onClearFilters={clearFilters} onShowArchive={() => showView('archive')}
        onRemove={target => { askRemove(target); }} />} />
    {asking && <RemoveDialog subject={asking.subject} onCancel={() => setAsking(null)} onConfirm={() => removeTarget(asking.target, asking.subject)} />}
    <ContinueTopicHost navigation={navigation} actions={application.actions} onSent={target => {
      // The continued topic now lives in the target session: show it there in the tree.
      if (route && routeKey(target) === key && archived) showView('tree');
    }} />
    <AgentNotRunningHost navigation={navigation} />
  </div></RemovalContext.Provider></ItemHistoryContext.Provider></ItemRefSession.Provider></PeekProvider>;
}

// Construction happens in an effect, so StrictMode's discarded render creates
// no timers/listeners. Effect replay closes the first lifetime before starting
// another; tabs and their views never own application resources.
export function DesktopApp({ service }: { service: RendererService }) {
  const [application, setApplication] = useState<Application | null>(null);
  useEffect(() => {
    const navigation = new NavigationStore(service), waiting = new WaitingStore(service, navigation.opened), actions = new SessionActionControllers(service);
    const removals = new RemovalQueue({ service, notices,
      read: async route => {
        const store = navigation.opened.open(route);
        const ready = await waitForLifecycleReady(actions.forSession(store), undefined, true);
        if (!ready.ok) throw new Error(ready.error ?? 'The latest changes could not be loaded.');
        return ready.session;
      },
      // After the command: the tree drops the rows, removed sessions lose their tabs, the pages recount.
      removed: async target => {
        if (target.kind === 'item' || target.kind === 'topic') await navigation.opened.open(targetSession(target)).refresh();
        else {
          const selected = navigation.getSnapshot().preferences?.global.selected_navigation;
          if (selected?.kind === 'session' && (target.kind === 'project' ? selected.session.project_id === target.project_id : sameSession(selected.session, target.session))) await navigation.navigate({ kind: 'projects' });
        }
        await navigation.refresh();
        void waiting.refresh();
      } });
    const next: Application = { service, navigation, waiting, removals,
      drafts: new OwnerDraftStore(service, undefined, navigation.preferenceWrites), actions, discovery: new DiscoveryController(service) };
    const detach = removals.attach();
    const detachAckAll = attachAckAll(service);
    const detachLinkFailures = listenForLinkFailures(service);
    setApplication(next);
    // Leaving the app runs the removals still in their window rather than dropping them.
    return () => { detachLinkFailures(); detach(); detachAckAll(); void removals.flush(); next.discovery.dispose(); next.waiting.stop(); void stopAckAll(service).finally(() => next.navigation.stop()); };
  }, [service]);
  // Links in agent text open in the system browser; a failure leaves the app where it is and says so.
  const openLink = useMemo(() => linkOpener(service), [service]);
  // Files named in agent text open in the owner's text editor, only when they sit inside the item's project folder.
  const files = useMemo(() => fileOpener(service), [service]);
  return application ? <LinkOpener.Provider value={openLink}><FileRefs.Provider value={files}><DockProvider><Workspace application={application} /></DockProvider></FileRefs.Provider></LinkOpener.Provider> : <p role="status">Opening Ariadne…</p>;
}
export default function App() {
  const [service] = useState(() => createDesktopService());
  return <DesktopApp service={service} />;
}
