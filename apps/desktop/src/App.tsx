import { useImplicitCaughtUp } from './ui/changes/useCaughtUp';
import { RecentPopover } from './ui/navigation/Recent';
import { useSeenDwell } from './ui/changes/useSeenDwell';
import { useReadingSeen } from './state/preferences/reading';
import { waitForLifecycleReady } from './ui/shared/lifecycleReady';
import { itemRemoved } from './selectors/removed';
import { hasStatusFilter } from './selectors/tree/folds';
import { filterCount, type LocalChip } from './selectors/tree/filter';
import { useLocalChips } from './ui/tree/useLocalChips';
import { AgentRemovalNotices } from './ui/remove/AgentRemovalNotices';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
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
import { displayStatus } from './selectors/waiting/replied';
import { NavigationWorkspace, type AdapterChoice, type OpenedSessionView } from './components/navigation/NavigationWorkspace';
import { NavigationGraph } from './ui/graph/NavigationGraph';
import type { OwnerFocusRequest, PendingSubmission } from './ui/answer/useSubmit';
import { agentNotRunning } from './ui/answer/notRunning';
import { ConversationView } from './ui/detail/ConversationView';
import { conversationBaseline, conversationDivider, messagesLoaded } from './ui/detail/conversationSeen';
import { DetailPath, ItemDetail } from './ui/detail/ItemDetail';
import type { DetailHeadControls } from './ui/shell/DetailHead';
import { actionsOf, reportActions, type ReportedActions } from './ui/detail/itemActions';
import { useDetailTarget, type OpenTopicInDetails } from './ui/shell/detailTarget';
import { TopicConversation } from './ui/detail/TopicConversation';
import { NoticeHooks } from './ui/answer/NoticeHooks';
import type { SessionActions } from './components/bindings/actions';
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
import { hiddenItems, hiddenSource } from './ui/tree/hidden';
import { TreeView, type RowIntent } from './ui/tree/TreeView';
import { hideViewFor } from './ui/tree/hideMove';
import { useLatest } from './ui/shared/latest';
import type { MapSearchStatus } from './ui/tree/mapSearch';
import { AgentNotRunningHost } from './ui/dialogs/AgentNotRunning';
import { ContinueTopicHost } from './ui/dialogs/ContinueTopicDialog';
import type { RemoveHandler, RemoveSubject, RemoveTarget } from './ui/dialogs/remove';
import { RemoveDialog, type FamilyState, type RemoveReview } from './ui/dialogs/RemoveDialog';
import { againRequests, archiveRequests } from './ui/remove/requests';
import { draftsSettled, removeReview } from './ui/remove/review';
import { readWords } from './ui/remove/words';
import type { Pinned } from './ui/remove/queue';
import { notices } from './ui/pages/notices';
import { toasts } from './ui/shell/toast';
import { shortLabel } from './ui/shared/short';
import { RemovalContext, RemovalQueue } from './ui/remove/queue';
import { nextSelection, subtree, targetSession } from './ui/remove/model';
import { themeToggle } from './ui/shell/model';
import { useAppliedTheme } from './ui/shell/theme';
import { useWindowKeys } from './ui/shell/windowKeys';
import { SwipeNavigation } from './ui/shell/SwipeNavigation';
import { nextTextSize, textSize, useAppliedTextSize, type TextSize } from './ui/shell/textScale';
import { ItemHistoryContext, useItemHistory, type HistoryDirection } from './ui/shell/itemHistory';
import { ackHoldFor, ackTarget, attachAckHolds, flushAckHold, stopAckHolds } from './ui/shared/ack';
import { earlierAgent } from './ui/shared/excerpt';
import { FileRefs, LinkOpener } from './ui/shared/MarkdownText';
import { fileOpener, linkOpener, listenForLinkFailures } from './ui/shared/openers';
import { useWorkspaceKeys } from './ui/keys';
import { itemIntents, workspaceKeys, type ItemIntentApp, type TreeRemoveTarget } from './ui/shell/workspaceKeys';
import { dispatchIntent, useIntents } from './ui/intents';
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
const filtering = (filters: Immutable<SessionPreferences['filters']>, local: readonly LocalChip[]) => !!filters.search.trim() || hasStatusFilter(filters.statuses)
  || filters.owners.length > 0 || filters.hide_later || local.length > 0;
/**
 * What a hide moved, for its Undo (R7): the selection before it, whether Details was open, the selection count after the move, and
 * the focused root when the hide ended Focus.
 */
interface HidMove { readonly prior: string; readonly detailOpen: boolean; readonly generation: number; readonly focused?: string }
interface CenterProps {
  readonly application: Application; readonly view: OpenedSessionView; readonly graph: boolean; readonly query: string;
  readonly reveal: RevealedItem | null; readonly selectedId: string | null; readonly detailOpen: boolean;
  /** The Graph's fold or unfold ends the "outside your filter" notice for this reveal without changing what the Map draws. */
  readonly onDismissBanner: () => void;
  readonly bannerDismissed: boolean;
  readonly historyReveal: RevealedItem | null;
  readonly covered?: boolean;
  readonly actingId?: string | null;
  readonly onSelected: (result: RevealedItem, openDetail?: boolean) => void;
  readonly onDismissReveal: () => void; readonly onResume: () => void; readonly onAct: (intent: RowIntent, target: ItemRoute, onReveal?: (result: RevealedItem) => void) => void;
  readonly onOpenItem: (itemId: string) => void;
  readonly onOpenTopic: OpenTopicInDetails;
  readonly onClearFilters: () => void; readonly onClearSearch: () => void; readonly onShowArchive: () => void;
  readonly onRemove: (target: TreeRemoveTarget) => void;
  readonly filterOpen?: boolean;
  readonly onCloseFilter?: () => void;
  readonly onSearchStatus?: (status: MapSearchStatus | null) => void;
}
function SessionCenter({ application, view, graph, reveal, onDismissBanner, ...props }: CenterProps) {
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
      reveal={reveal} onReveal={props.onSelected} onClearFilters={props.onClearFilters} onDismissBanner={onDismissBanner} covered={props.covered} /> : null} />;
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
  // The reveal whose "outside your filter" notice the owner ended with a Graph fold or unfold (the Map keeps drawing it).
  const [bannerDismissed, setBannerDismissed] = useState<RevealedItem | null>(null);
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
  // A hide that left nothing selected (R4) drops the navigation's reveal too, so it selects the hidden item no more.
  const [droppedReveal, setDroppedReveal] = useState<RevealedItem | null>(null);
  const currentReveal = localReveal?.store === store ? localReveal
    : state.reveal?.store === store && state.reveal !== droppedReveal ? state.reveal : null;
  const treeReveal = currentReveal === dismissedReveal ? null : currentReveal;
  const candidateId = currentReveal?.kind === 'item' ? currentReveal.route.item_id : view?.selected_item_id ?? null;
  const selectedId = candidateId && sessionState?.snapshot?.session.items[candidateId] && !itemRemoved(sessionState.snapshot.session, candidateId) ? candidateId : null;
  // Counts every selection change (and session switch) on screen: a hide's move, and its Undo, apply only while it has not
  // moved since they were asked for, so the owner's newer choice always wins (S3, S9). Counted in the commit that shows it.
  const selectionGeneration = useRef(0);
  useLayoutEffect(() => { ++selectionGeneration.current; }, [key, selectedId]);
  // Details shows the selected item, or (E5) a topic's own conversation: then the dock keeps its question and no dwell runs.
  const detailTarget = useDetailTarget(key, selectedId);
  const topicMode = detailTarget.target?.kind === 'topic' && !conversation;
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
  useSeenDwell((!!conversation || detailOpen && !detailsFolded && !topicMode) && detailNeedsRead && route && readingId && sessionState?.status === 'ready' && !sessionState.error ? `${key}:${readingId}` : null, seenRevision, observeDetail);
  // The "New since you last looked" divider and its time are worked out once per selection, from what was seen before this look
  // (the 1 s dwell would erase it), and kept for the pane, the bigger view and a round trip between them (E13).
  const dividers = useRef(new Map<string, { id: string | null; at: number | null }>());
  const dividerFor = (itemId: string) => {
    const at = `${key}:${itemId}`, kept = dividers.current.get(at), session = sessionState?.snapshot?.session;
    if (kept) return kept;
    if (!session?.items[itemId] || !observedSeen) return { id: null, at: null };
    const made = { id: conversationDivider(session, itemId, observedSeen), at: conversationBaseline(session, itemId, observedSeen) };
    // Worked out before the item's messages page has loaded, a divider is not final (a missing message gives null): do not keep it.
    if (messagesLoaded(session, itemId)) dividers.current.set(at, made);
    return made;
  };
  // Leaving an item drops its divider, so looking at it again works one out from what was seen since. The Details pane and the
  // bigger view of an item keep theirs while either shows it.
  const conversationItem = conversation?.route === key ? conversation.itemId : null;
  useEffect(() => {
    const live = new Set([selectedId, conversationItem].flatMap(id => id ? [`${key}:${id}`] : []));
    for (const at of [...dividers.current.keys()]) if (!live.has(at)) dividers.current.delete(at);
  }, [key, selectedId, conversationItem]);
  const openConversation = (itemId: string) => {
    const session = store?.getSnapshot().snapshot?.session;
    if (!session?.items[itemId] || !route) return;
    if (showConversation(itemId, () => dividerFor(itemId).id)) navigationVisits.record(route, itemId, 'viewed');
  };
  const [answerJump, setAnswerJump] = useState<{ route: string; itemId: string; messageId: string; token: number } | null>(null);
  const answerJumpSequence = useRef(0);
  const consumeAnswerJump = useCallback((token: number) => setAnswerJump(previous => previous?.token === token ? null : previous), []);
  const ackNoticeId = useRef<string | null>(null);
  const ackActions = store ? application.actions.forSession(store) : null;
  // The notice hooks stay mounted once a session has been shown, so a notice told once is not told again after a page.
  const lastActions = useRef<SessionActions | null>(null);
  if (ackActions) lastActions.current = ackActions;
  const noticeActions = ackActions ?? lastActions.current;
  const ackState = useSyncExternalStore(ackActions?.subscribe ?? noSubscription, ackActions?.getSnapshot ?? noSession, ackActions?.getSnapshot ?? noSession);
  useEffect(() => {
    if (ackNoticeId.current) notices.dismiss(ackNoticeId.current);
    return () => { if (ackNoticeId.current) notices.dismiss(ackNoticeId.current); };
  }, [key, selectedId]);
  // Leaving a session saves its held Acks now (D11). A Tree to Graph switch stays in the session and flushes nothing.
  const shownSessionId = route?.session_id ?? null, previousSessionId = useRef(shownSessionId);
  useEffect(() => {
    const before = previousSessionId.current;
    previousSessionId.current = shownSessionId;
    if (before && before !== shownSessionId) void flushAckHold(before);
  }, [shownSessionId]);
  useEffect(() => {
    const receipt = ackState?.receipt;
    if (receipt && 'data' in receipt && receipt.data.kind === 'item_ack') {
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
    if (openDetail) { detailTarget.showItem(); detailDismissedAt.current = null; setDetailOpen(true); setDetailAsked(count => count + 1); }
    // Continuations use this exact admitted request, including queued reveals.
    return { request, result };
  };
  // Tree and graph already save their own selection through navigation.
  // The graph's ↑/↓ and "−" move the selection without opening detail (Ariadne.dc.html `select`).
  const selected = (result: RevealedItem, openDetail = true) => {
    recordViewed(result);
    detailTarget.showItem();
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
  // One guard for the action and for what advertises it (the Back/Forward buttons, the swipe's arrow): where it refuses, nothing offers it.
  const historyOpen = !conversation && !!route && !state.writing && state.pendingOperationId === null;
  const navigateHistory = (direction: HistoryDirection) => {
    if (!historyOpen || !route) return false;
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
  const historyControls = { canBack: itemHistory.canBack && historyOpen, canForward: itemHistory.canForward && historyOpen,
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
  // ⌥N: open the question and send option N at once. The answer box in Details sends it with its own guards (stale read, item
  // changed, in flight); this only refuses to start while the session, drafts or a request are not ready.
  // In topic mode Details shows the topic's conversation, not the Map's selected item: the key is refused (and consumed) there,
  // so it never switches Details to that item and sends in one go.
  const quickAnswer = (target: ItemRoute, index: number) => {
    if (topicMode) return true;
    const current = store && route && sameSession(route, target) ? store.getSnapshot() : application.waiting.sessionState(target);
    const session = current?.snapshot?.session, item = session?.items[target.item_id];
    const draftState = application.drafts.getSnapshot(), entry = application.drafts.find(target, target.item_id, 'answer');
    if (session && item && (current?.status !== 'ready' || current.error)) {
      notices.push({ id: 'quick-answer-not-ready', icon: 'ph ph-warning-circle', iconColor: 'var(--a-danger)',
        text: "Ariadne is still loading this session's latest changes. Try again." });
      return true;
    }
    notices.dismiss('quick-answer-not-ready');
    if (!session || !item || current?.status !== 'ready' || current.error || session.state !== 'active'
      || itemRemoved(session, item.id) || session.topics[item.topic_id]?.archived_at !== null || displayStatus(session, item) !== 'waiting_on_me'
      || state.writing || state.pendingOperationId !== null || !draftState.ready || draftState.preferenceUncertain
      || quickRequests.current.has(JSON.stringify(target))
      || Object.values(draftState.entries).some(value => sameSession(value.draft.session, target) && value.draft.target.item_id === item.id && (value.saving || value.uncertain))
      || entry?.receipt
      || !item.options[index]) return false;
    focusOwner(target, 'answer', index, undefined, 'send', {
      optionId: item.options[index]!.id, revision: item.revision, questionRevision: item.question_revision, bindingId: session.active_binding_id,
    });
    return true;
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
  const closeDetail = () => { invalidateOwnerRequest(); detailDismissedAt.current = navigation.getNavigationRequest(); detailTarget.showItem(); setDetailOpen(false); };
  // "Reply to topic", and Edit on a stuck topic reply: Details shows the topic, unfolded. The dock keeps its question.
  const openTopic = (topicId: string) => {
    if (conversation) closeConversation();
    invalidateOwnerRequest(); detailDismissedAt.current = null; setDetailOpen(true); setDetailAsked(count => count + 1);
    detailTarget.openTopicInDetails(topicId);
  };
  const later = route && selectedId ? preferences?.later.some(item => routeKey(item) === key && item.item_id === selectedId) ?? false : false;
  // The waiting question Details (or the bigger view) is answering leaves the dock's list. A folded Details shows no
  // question, so it never claims one: the dock keeps it in view.
  const answeringId = conversationOpen ? conversation?.itemId ?? null : detailOpen && !detailsFolded && !topicMode ? selectedId : null;
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
  const localChips = useLocalChips(view?.session.session_id ?? '');
  // The Recent popover under the top bar's clock button; ⌘E and the button both toggle it (D19).
  const [recentOpen, setRecentOpen] = useState(false);
  // The Map publishes its search count, arrows and note here for the top bar.
  const [searchStatus, setSearchStatus] = useState<MapSearchStatus | null>(null);

  // Remove (E28, E34): a leaf with no waiting question and none of the owner's words goes at once; anything else asks,
  // quoting every word that goes. Either way the rows hide at once and the command runs after the undo window.
  const [asking, setAsking] = useState<{ readonly review: RemoveReview; readonly family: FamilyState | null } | null>(null);
  const askRemove = (target: TreeRemoveTarget): boolean => {
    const at = targetSession(target), session = navigation.opened.open(at).getSnapshot().snapshot?.session;
    if (!session) return false;
    if (target.kind === 'item' ? hidden.item(at, session, target.item.item_id) : hidden.topic(at, target.topic_id)) return false;
    const review = removeReview(session, target, application.drafts.getSnapshot());
    if (!review) return false;
    if (review.subject.kind === 'item' && review.subject.items === 1 && !review.subject.waiting && !review.words.length) {
      removeTarget(target, review.subject, review.pinned); return true;
    }
    const topic = target.kind === 'topic' ? session.topics[target.topic_id] : null;
    setAsking({ review, family: topic ? 'checking' : null });
    if (topic) {
      // E34: a continued topic can't be removed here. Archived sessions are read now, with a 5 s limit, and a waiting reader that is
      // still catching up is waited for, 20 s at most in all (queue.ts); unknown counts as family.
      void removals.family(topic, session).then(family => {
        setAsking(current => current?.review === review ? { review, family } : current);
      });
    }
    return true;
  };
  // The selection moves to the next row, else the parent, else none; detail closes when it showed what goes.
  const moveSelection = (at: SessionRef, next: string | null) => {
    if (!view || !preferences || !sameSession(at, view.session)) return;
    setLocalReveal(null);
    if (next) void navigation.routes.revealItem({ ...at, item_id: next }).then(result => { if (result?.kind === 'item') selected(result, false); }).catch(() => {});
    saveView({ selected_item_id: next });
  };
  const removeTarget = (target: RemoveTarget, subject: RemoveSubject, pinned?: Pinned) => {
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
    removals.schedule(target, subject, { restore, pinned });
  };
  const removeHandler: RemoveHandler = (target, subject) => removeTarget(target, subject);
  const asker = useRef(askRemove);
  asker.current = askRemove;
  // The Archive page's Remove of an archived topic takes the same flow (E34). Its session may not be read yet (an archived
  // session's): it is read first, and a session that still can't be read says so rather than doing nothing.
  const askRemoveFresh = (target: Extract<RemoveTarget, { kind: 'topic' }>) => {
    const store = navigation.opened.open(target.session);
    const ask = () => {
      // Asked, or read but nothing to ask about (gone, or already being removed).
      if (asker.current(target) || store.getSnapshot().snapshot) return;
      notices.push({ id: `remove-read-failed:${target.session.session_id}:${target.topic_id}`, icon: 'ph ph-warning-circle', tone: 'problem',
        text: 'Ariadne couldn’t read that session, so it can’t show what removing the topic deletes. Nothing was removed. Try again.' });
    };
    if (store.getSnapshot().snapshot) ask();
    else void store.refresh().then(ask, ask);
  };
  useEffect(() => { const again = (target: TreeRemoveTarget) => { asker.current(target); }; againRequests.add(again); return () => { againRequests.delete(again); }; }, []);
  const showView = (mode: 'tree' | 'graph' | 'archive') => {
    if (conversation) closeConversation();
    setGraphModes(previous => ({ ...previous, [key]: mode === 'graph' }));
    if (mode === 'archive') { navigation.openPage({ kind: 'page', page: 'archive' }); return; }
    if (view?.filters.archived) saveView({ filters: { ...structuredClone(view.filters), archived: false } } as Partial<SessionPreferences>);
  };
  const clearFilters = () => {
    if (!view) return;
    setSearchEdit(null); setDismissedReveal(currentReveal);
    localChips.set([]);
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
  // "Hid “x”." with an Undo that unhides (E19). It sets the state, so a late Undo never hides the item again.
  const announceHid = (target: ItemRoute, moved: HidMove | null) => {
    const item = navigation.opened.open(target).getSnapshot().snapshot?.session.items[target.item_id];
    const label = item ? shortLabel(item) : 'the item';
    toasts.show({ text: `Hid “${label}”.`, undo: () => {
      if (!toggleHidden(target, false, moved)) notices.push({ id: 'hide-undo-failed', icon: 'ph ph-warning-circle', iconColor: 'var(--a-warn)',
        text: `“${label}” could not be unhidden just now. Try Unhide again in a moment.` });
    } });
  };
  const latestConversation = useRef(conversation);
  latestConversation.current = conversation;
  /**
   * A hide's move as the selection (D4): Details follows it while open, and closes when nothing is selected, as for Remove. It is
   * no visit of the owner's: Recent records nothing, so the hide stays one write (R1).
   */
  const showMove = (reveal: RevealedItem | null, openDetail = false) => {
    historyReveal.current = null;
    invalidateOwnerRequest();
    if (!reveal) { setLocalReveal(null); setDroppedReveal(navigation.getSnapshot().reveal); closeDetail(); return; }
    setLocalReveal(reveal);
    if (openDetail) { detailTarget.showItem(); detailDismissedAt.current = null; setDetailOpen(true); }
  };
  // `want` sets the state instead of flipping it: Hide's Undo must not hide the item again after the owner unhid it some other way.
  // Hide moves on (alpha.24): hiding the selected item, or an ancestor of it, selects the next item on its level, else the previous,
  // else the parent (the view on screen says which, `hideViewFor`); the bigger view's item follows the same rule. The selection
  // rides in the hide's own write and shows in the update that publishes it (S1): a refused or failed save changes nothing, and an
  // unsure one moves nothing until a check confirms it. A selection the owner makes meanwhile wins (S3).
  const toggleHidden = (target: ItemRoute, want?: boolean, undo?: HidMove | null) => {
    const current = navigation.getSnapshot();
    if (!current.preferences || current.writing || current.pendingOperationId !== null) return false;
    const session = navigation.opened.open(target).getSnapshot().snapshot?.session ?? application.waiting.sessionState(target)?.snapshot?.session;
    const saved = current.preferences.sessions.find(value => routeKey(value.session) === routeKey(target));
    const isHidden = !!session && hiddenItems(session, new Set(saved?.hidden_item_ids ?? [])).has(target.item_id);
    if (want !== undefined && want === isHidden) return true;
    const dismissed = currentReveal, asked = selectionGeneration.current, unmoved = () => selectionGeneration.current === asked;
    const onScreen = !!route && sameSession(target, route);
    // The view's own reveal (a click echo: no scroll, no centring), keeping the Map's temporary unfolds.
    const temporary = currentReveal?.kind === 'item' ? currentReveal.temporaryExpandedItemIds : [];
    const own = (itemId: string): RevealedItem => Object.freeze({ kind: 'item' as const, store: navigation.opened.open(target), temporaryExpandedItemIds: temporary,
      route: Object.freeze({ project_id: target.project_id, session_id: target.session_id, item_id: itemId }) });
    const report = (written: boolean) => {
      if (!written) notices.push({ id: 'hide-save-failed', icon: 'ph ph-warning-circle', iconColor: 'var(--a-danger)',
        text: 'The hidden items preference could not be saved. Try again.' });
    };
    if (isHidden) {
      // Unhide never moves the selection. Undo selects again what its hide moved away from, and puts back the Focus it ended, while
      // nothing was selected since (R7). Either way the view on screen keeps the rows above where the item comes back still.
      const back = onScreen && undo && asked === undo.generation ? undo : null;
      let written: SessionPreferences | undefined;
      void navigation.setHidden(target, false, current.preferences.revision, {
        edit: view => {
          if (back && unmoved()) { view.selected_item_id = back.prior; if (back.focused) view.focused_item_id = back.focused; }
          written = view;
        },
        committing: land => flushSync(() => {
          setDismissedReveal(dismissed);
          const restore = back && unmoved() ? back : null, reveal = restore ? own(restore.prior) : null;
          if (onScreen) hideViewFor(target)?.present({ kind: 'unhide', itemId: target.item_id, own: reveal, select: !!restore, after: written });
          if (restore) showMove(reveal, restore.detailOpen);
          land();
        }),
      }).then(report);
      return true;
    }
    const going = new Set(session ? subtree(session, target.item_id).map(item => item.id) : [target.item_id]);
    const moves = onScreen && !!selectedId && going.has(selectedId);
    const follows = onScreen && conversation?.route === key && going.has(conversation.itemId);
    const prior = selectedId, detailWasOpen = detailOpen, answer = hideViewFor(target);
    // The view the hide writes (a new one for a session with none saved); hiding the focused root ends Focus in the same write (S4).
    const hiding = navigation.viewWithHidden(target, true);
    const ended = hiding?.focused_item_id && going.has(hiding.focused_item_id) ? hiding.focused_item_id : undefined;
    const after: SessionPreferences | null = hiding && { ...hiding, focused_item_id: ended ? undefined : hiding.focused_item_id };
    const next = (moves || follows) && answer && after ? answer.choose(target.item_id, after) : null;
    void navigation.setHidden(target, true, current.preferences.revision, {
      edit: view => {
        if (view.focused_item_id && going.has(view.focused_item_id)) delete view.focused_item_id;
        if (moves && answer && unmoved()) view.selected_item_id = next;
      },
      committing: land => {
        const select = moves && !!answer && unmoved(), shownNow = latestConversation.current;
        const follow = follows && !!answer && shownNow?.route === key && going.has(shownNow.itemId);
        // A choice the owner made in the view meanwhile stays selected instead of the hide's (S3). One reveal object for the view
        // and the App: the view knows it as its own echo.
        const newer = select ? answer?.newer?.(going) ?? null : null;
        const reveal = newer ? own(newer) : select && next ? own(next) : null;
        flushSync(() => {
          answer?.present({ kind: 'hide', itemId: target.item_id, own: reveal, select });
          if (select) showMove(reveal);
          if (follow) { if (next) openConversation(next); else closeConversation(); }
          setDismissedReveal(dismissed);
          land();
        });
        announceHid(target, select && !newer ? { prior: prior!, detailOpen: detailWasOpen, generation: selectionGeneration.current, focused: ended } : null);
      },
    }).then(report);
    return true;
  };
  const selectedSession = sessionState?.snapshot?.session;
  const explicitHidden = new Set(view?.hidden_item_ids ?? []);
  const hiddenBy = selectedSession && selectedId ? hiddenSource(selectedSession, explicitHidden, selectedId) : null;
  const selectedHidden = hiddenBy !== null;
  // The action list Details emits feeds the head's "…" menu (E2); it is the list the actions row shows.
  const [reportedActions, setReportedActions] = useState<ReportedActions | null>(null);
  const actionsFrom = (itemId: string) => (list: Parameters<typeof reportActions>[2]) => setReportedActions(held => reportActions(held, itemId, list));
  // The path's topic segment scrolls the Map to its top; from the bigger view, which covers the Map, it goes back to it first.
  const toTopicTop = () => { dispatchIntent('map.top'); if (conversationOpen) closeConversation(); };
  const focusControl = { on: !!view?.focused_item_id, toggle: () => { dispatchIntent('focus.toggle'); } };
  const columnHead: DetailHeadControls = topicMode ? { close: closeDetail }
    : { read: { open: false, toggle: () => { if (selectedId) openConversation(selectedId); } }, focus: focusControl, actions: actionsOf(reportedActions, selectedId), close: closeDetail };
  const biggerHead: DetailHeadControls = { read: { open: true, toggle: closeConversation }, focus: focusControl, actions: actionsOf(reportedActions, conversation?.itemId),
    close: () => { closeConversation(); closeDetail(); } };
  const hideItem = (itemId: string) => { if (route) toggleHidden({ ...route, item_id: itemId }); };
  const removeItem = (itemId: string) => { if (route) askRemove({ kind: 'item', item: { ...route, item_id: itemId } }); };
  const intentApp: ItemIntentApp = {
    store: !!store, onPage: viewOf(state).kind !== 'session', toggleFilters: () => setFilterOpen(value => !value), closeDetail, closeConversation: conversationOpen ? closeConversation : undefined, focusOwner, quickAnswer, queueBring, ack: (target, repeat) => {
      const store = navigation.opened.open(target), session = store.getSnapshot().snapshot?.session, item = session?.items[target.item_id];
      if (!session || !item || !ackTarget(session, item)) return false;
      const actions = application.actions.forSession(store);
      if (repeat) return true;
      ackNoticeId.current = JSON.stringify(['item-ack', target.project_id, target.session_id, target.item_id]);
      // The Map's rows and Details draw their own "Acked · Undo" and say so to the hold; where none does (the Graph, a folded
      // topic, a peek) the hold's notice is the Undo.
      ackHoldFor(target.session_id, actions).ack(item);
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
    clearFilters: detailOpen && !!selectedId || !view || !filtering(view.filters, localChips.chips) && !query ? undefined : clearFilters,
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
  // The Map's callbacks keep one identity for the life of the workspace (alpha.23 F6d); each runs this render's code when called.
  const map = {
    closeFilter: useLatest(() => { setFilterOpen(false); }),
    dismissBanner: useLatest(() => { setBannerDismissed(currentReveal); }),
    selected: useLatest(selected),
    openTopic: useLatest(openTopic),
    openItem: useLatest((itemId: string) => { if (route) revealItem({ ...route, item_id: itemId }); }),
    dismissReveal: useLatest(() => { setDismissedReveal(currentReveal); }),
    resume: useLatest(() => { setDismissedReveal(currentReveal); closeDetail(); }),
    act: useLatest((intent: RowIntent, target: ItemRoute, onReveal?: (result: RevealedItem) => void) => {
      if (intent === 'bring') void queueBring(target, onReveal);
      else if (intent === 'hide') toggleHidden(target);
      else if (intent === 'later') toggleLater(target, target.item_id);
      else focusOwner(target, intent, undefined, onReveal);
    }),
    clearSearch: useLatest(clearSearch),
    clearFilters: useLatest(clearFilters),
    showArchive: useLatest(() => { showView('archive'); }),
    remove: useLatest((target: TreeRemoveTarget) => { askRemove(target); }),
  };
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
    {noticeActions && <NoticeHooks session={sessionState?.status === 'ready' ? sessionState.snapshot?.session ?? null : null} actions={noticeActions} drafts={application.drafts}
      openItem={itemId => { if (route) revealItem({ ...route, item_id: itemId }); }} openTopic={openTopic} />}
    <DraftConflictNotices drafts={application.drafts} opened={navigation.opened} selectedSession={route ?? null} />
    <WaitingSync waiting={application.waiting} drafts={application.drafts} />
    <AgentRemovalNotices waiting={application.waiting} controllers={application.actions} navigation={navigation}
      selectedSession={sessionState?.snapshot?.session ?? null} onTree={showBinTree} />
    <NavigationWorkspace store={navigation} adapterChoices={adapterChoices} discovery={application.discovery} actions={application.actions}
      onRemoveTarget={removeHandler} onAskRemove={askRemoveFresh} waitingStore={application.waiting}
      onReadWords={target => readWords(application.service, () => application.drafts.getSnapshot(), target)}
      chrome={{ query, searchStatus, graph: graph && !archived, onView: store ? showView : undefined, theme: shown, searchBlocked: conversationOpen,
        filter: store ? { active: filterOpen, count: view ? filterCount({ view, local: localChips.chips }) : localChips.chips.length, onToggle: () => setFilterOpen(value => !value) } : undefined,
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
      hidden={selectedHidden} detailHead={columnHead}
      dockContent={store && route ? <AnswerDock store={store} waiting={application.waiting} drafts={application.drafts} answering={answering}
        onAgentNotRunning={onAgentNotRunning} onOpenItem={openFromDock} seen={readingSeen}
        onSeen={(itemId, revision) => navigation.markItemSeen(route, itemId, revision)} /> : undefined}
      detailPath={store && topicMode && detailOpen && route && detailTarget.target?.kind === 'topic' ? <DetailPath store={store} topicId={detailTarget.target.topicId}
        onOpenItem={itemId => revealItem({ ...route, item_id: itemId })} onTopic={toTopicTop} />
        : store && selectedId && detailOpen && route ? <DetailPath store={store} itemId={selectedId} onOpenItem={itemId => revealItem({ ...route, item_id: itemId })} onTopic={toTopicTop} /> : undefined}
      detailAsked={detailAsked} onDetailsFolded={setDetailsFolded}
      detailRail={topicMode && detailOpen ? <i className="ph ph-tree-structure" aria-hidden="true" />
        : store && selectedId && detailOpen && route ? <RailStatus store={store} itemId={selectedId} seen={readingSeen} /> : undefined}
      detail={conversationOpen ? <div data-covered-detail="" />
        : store && route && detailOpen && detailTarget.target?.kind === 'topic' ? <TopicConversation key={`${key}:topic:${detailTarget.target.topicId}`} drafts={application.drafts} store={store}
          topicId={detailTarget.target.topicId} onOpenItem={itemId => revealItem({ ...route, item_id: itemId })} />
        : store && selectedId && detailOpen && route ? <ItemDetail key={`${key}:${selectedId}`} drafts={application.drafts} store={store} itemId={selectedId} searchQuery={query}
        onFocusRequestConsumed={consumeOwnerRequest} focusRequest={ownerFocus?.route === key && ownerFocus.itemId === selectedId ? ownerFocus : undefined}
        onOpenItem={itemId => revealItem({ ...route, item_id: itemId })} onBring={() => { void queueBring({ ...route, item_id: selectedId }); }}
        onHide={() => hideItem(selectedId)} onRemove={() => removeItem(selectedId)} onActions={actionsFrom(selectedId)}
        dividerId={dividerFor(selectedId).id} dividerAt={dividerFor(selectedId).at}
        later={later} onAgentNotRunning={onAgentNotRunning} earlierAgent={earlier}
        hiddenItemIds={view?.hidden_item_ids} seen={readingSeen} onMarkSeen={(itemId, revision) => { navigation.markItemSeen(route, itemId, revision); }}
        answerJump={answerJump?.route === key && answerJump.itemId === selectedId ? answerJump : undefined}
        onAnswerJumpConsumed={consumeAnswerJump}
        onOpenAnswer={(itemId, messageId) => { setAnswerJump({ route: key, itemId, messageId, token: ++answerJumpSequence.current }); revealItem({ ...route, item_id: itemId }); }}
        onLater={value => preferences ? navigation.setLater({ ...route, item_id: selectedId }, value, preferences.revision) : Promise.resolve(false)}
        provenance={<CopiedProvenance store={store} itemId={selectedId}
          projectPath={projectId => state.projects?.projects.items.find(project => project.project_id === projectId)?.canonical_root ?? null} revealItem={revealLinkedItem} />} /> : undefined}
      conversation={conversation?.route === key && store && route ? <ConversationView key={`${key}:${conversation.itemId}`} drafts={application.drafts}
        store={store} itemId={conversation.itemId} later={preferences?.later.some(value => sameSession(value, route) && value.item_id === conversation.itemId) ?? false}
        onClose={closeConversation} head={biggerHead} onTopic={toTopicTop}
        onHide={() => hideItem(conversation.itemId)} onRemove={() => removeItem(conversation.itemId)} onActions={actionsFrom(conversation.itemId)}
        onBring={() => { void queueBring({ ...route, item_id: conversation.itemId }); }} onOpenItem={itemId => revealItem({ ...route, item_id: itemId })}
        dividerId={dividerFor(conversation.itemId).id ?? conversation.dividerId} dividerAt={dividerFor(conversation.itemId).at} seen={readingSeen} onMarkSeen={(itemId, revision) => { navigation.markItemSeen(route, itemId, revision); }} hiddenItemIds={view?.hidden_item_ids}
        focusRequest={ownerFocus?.route === key && ownerFocus.itemId === conversation.itemId ? ownerFocus : undefined}
        onFocusRequestConsumed={consumeOwnerRequest} onAgentNotRunning={onAgentNotRunning}
        onLater={value => preferences ? navigation.setLater({ ...route, item_id: conversation.itemId }, value, preferences.revision) : Promise.resolve(false)} /> : undefined}
      renderSession={opened => <SessionCenter filterOpen={filterOpen} onCloseFilter={map.closeFilter} application={application} view={opened} graph={graph} query={query} reveal={treeReveal}
        onDismissBanner={map.dismissBanner} bannerDismissed={treeReveal !== null && treeReveal === bannerDismissed}
        covered={conversationOpen} actingId={conversationOpen ? conversation?.itemId : null}
        historyReveal={historyReveal.current === treeReveal ? historyReveal.current : null}
        selectedId={treeSelectedId} detailOpen={conversationOpen || detailOpen && (!!selectedId || topicMode)}
        onSelected={map.selected} onOpenTopic={map.openTopic} onOpenItem={map.openItem}
        onDismissReveal={map.dismissReveal} onResume={map.resume} onAct={map.act}
        onSearchStatus={setSearchStatus}
        onClearSearch={map.clearSearch}
        onClearFilters={map.clearFilters} onShowArchive={map.showArchive}
        onRemove={map.remove} />} />
    {asking && <RemoveDialog review={asking.review} family={asking.family} onCancel={() => setAsking(null)}
      onConfirm={() => removeTarget(asking.review.target, asking.review.subject, asking.review.pinned)}
      onArchiveInstead={asking.review.target.kind === 'topic' ? (() => { const target = asking.review.target as Extract<RemoveTarget, { kind: 'topic' }>;
        archiveRequests.request({ route: target.session, topicId: target.topic_id }); }) : undefined} />}
    <ContinueTopicHost navigation={navigation} actions={application.actions} onSent={target => {
      // The continued topic now lives in the target session: show it there in the tree.
      if (route && routeKey(target) === key && archived) showView('tree');
    }} />
    <AgentNotRunningHost navigation={navigation} />
    <SwipeNavigation history={historyControls} />
  </div></RemovalContext.Provider></ItemHistoryContext.Provider></ItemRefSession.Provider></PeekProvider>;
}

// Construction happens in an effect, so StrictMode's discarded render creates
// no timers/listeners. Effect replay closes the first lifetime before starting
// another; tabs and their views never own application resources.
export function DesktopApp({ service }: { service: RendererService }) {
  const [application, setApplication] = useState<Application | null>(null);
  useEffect(() => {
    const navigation = new NavigationStore(service), waiting = new WaitingStore(service, navigation.opened), actions = new SessionActionControllers(service);
    const drafts = new OwnerDraftStore(service, undefined, navigation.preferenceWrites);
    const removals = new RemovalQueue({ service, notices,
      read: async route => {
        const store = navigation.opened.open(route);
        const ready = await waitForLifecycleReady(actions.forSession(store), undefined, true);
        if (!ready.ok) throw new Error(ready.error ?? 'The latest changes could not be loaded.');
        return ready.session;
      },
      // E28: the commit waits for any send being saved in the session, then compares a fresh read with the review.
      settled: route => draftsSettled(drafts, route), waiting: () => waiting.getSnapshot(),
      subscribeWaiting: waiting.subscribe, refreshWaiting: () => waiting.refresh(),
      review: (session, target) => removeReview(session, target, drafts.getSnapshot())?.pinned ?? null,
      again: target => { againRequests.forEach(ask => ask(target)); },
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
      drafts, actions, discovery: new DiscoveryController(service) };
    const detach = removals.attach();
    const detachAckAll = attachAckAll(service), detachAckHolds = attachAckHolds(service);
    const detachLinkFailures = listenForLinkFailures(service);
    setApplication(next);
    // Leaving the app runs the removals still in their window rather than dropping them.
    return () => { detachLinkFailures(); detach(); detachAckAll(); detachAckHolds(); void removals.flush(); next.discovery.dispose(); next.waiting.stop();
      void Promise.all([stopAckAll(service), stopAckHolds(service)]).finally(() => next.navigation.stop()); };
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
