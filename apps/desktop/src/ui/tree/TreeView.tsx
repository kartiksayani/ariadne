import { AgentBin } from '../remove/AgentBin';
import { itemRemoved } from '../../selectors/removed';
// The session tree column (handoff "Session tree"): session bar, status menu,
// banners, topic bands and item rows, with the tree keyboard, inline answering
// and the empty and loading states. Selection, expansion, topic folds and filters
// persist through navigation's preference writer.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { OwnFailure, plainFailure, useSession, type Immutable, type SessionStore } from '../../data';
import type { RevealedItem } from '../../data/routes';
import type { ItemRoute, SessionPreferences } from '../../generated/core';
import type { Input, SessionSummary } from '../../generated/domain/models';
import { NavigationStore, useNavigation } from '../../state/navigation/store';
import { useReadingSeen } from '../../state/preferences/reading';
import { OwnerDraftStore, useOwnerDrafts } from '../../state/drafts/store';
import type { SessionActions } from '../../components/bindings/actions';
import { DispatchChip } from '../../components/bindings/DispatchChip';
import { useSupervisorHealth } from '../../components/bindings/health';
import { DispatchDialog } from '../pages/SessionDialogs';
import { useWorkspaceKeys, type WorkspaceIntent } from '../keys';
import { AnswerControl } from '../answer/AnswerControl';
import type { PendingSubmission } from '../answer/useSubmit';
import { notices as noticeStore } from '../pages/notices';
import { chipsOf, closed, collapsedNote, mapChanges, nextMarkedItem, oldestWaiting, parentKey, sessionBar, toggleChip, treeModel, type Chip, type ItemRow as ItemRowModel, type Row } from './model';
import { HiddenRow } from './HiddenRow';
import { hiddenGroupKey, hiddenGroupsFor } from './hidden';
import { HideIcon } from '../shared/HideIcon';
import { ackTarget, ackTitle, useAck } from '../shared/ack';
import { ItemRow, type RowAction } from './ItemRow';
import { TopicRow, type TopicAction } from './TopicRow';
import { TopicReply } from '../answer/TopicReply';
import { StuckNote } from '../answer/StuckNote';
import { editQueued, inEditor } from '../answer/held';
import { InlineRecovery } from '../../components/recovery/RecoveryPanel';
import { Banner, SessionBar } from './SessionBar';
import { FilterBar } from './FilterBar';
import { useLifecycle } from './Lifecycle';
import { ItemRefs } from '../shared/MarkdownText';
import { shortLabel } from '../shared/short';
import { peekNames } from '../peek/names';
import { nearestDelta, openingTop } from './scroll';
import { displayStatus } from '../../selectors/waiting/replied';
import { sessionEnded, sessionClosedReason, sessionAnswerBlocked } from '../../selectors/sessionClosed';
import { useUnfolded } from './unfold';
import type { RemoveTarget } from '../dialogs/remove';
import { ContinuePicker, continueTargets, openContinueTopic } from '../dialogs/ContinueTopicDialog';
import { useHidden } from '../remove/queue';
import { visibleSession } from '../remove/model';
import { reconnectingNote } from '../shared/connection';
import { useFilterFolds } from '../shared/filterFolds';
import { isViewConflict } from '../shared/conflictNotice';
import { TreeFonts, useTreeFonts } from './fonts';
import { branchItems, breadcrumbItems, focusedRows } from './gettingAround';
import { usePeek } from '../peek/Peek';
import { RecentDialog, RecentTrail } from '../navigation/Recent';
import { navigationVisits } from '../navigation/visits';
import { AckAll } from '../navigation/AckAll';
import { ackAllItems } from '../navigation/ackAllController';
import './tree.css';

export type RowIntent = 'bring' | 'reply' | 'drop' | 'note' | 'followup' | 'reopen' | 'later' | 'hide';
export interface TreeViewProps {
  readonly navigation: NavigationStore;
  readonly store: SessionStore;
  readonly actions: SessionActions;
  readonly drafts: OwnerDraftStore;
  /** The header search as typed. */
  readonly query: string;
  /** An item revealed from a link or the waiting panel; null once dismissed. */
  readonly reveal: RevealedItem | null;
  /** The latest Back/Forward reveal; retained alongside ordinary external reveals. */
  readonly historyReveal?: RevealedItem | null;
  readonly selectedId: string | null;
  readonly detailOpen: boolean;
  /** Conversation covers the retained tree; its global shortcuts pause until Map returns. */
  readonly covered?: boolean;
  /** Graph content shown in place of the rows. */
  readonly graph?: ReactNode;
  /** Notices above the rows: stale data, recovery. */
  readonly notices?: ReactNode;
  /** Expanded topic information below its sticky header, above the item rows. */
  readonly topicContent?: (topicId: string) => ReactNode;
  readonly summaries: readonly Immutable<SessionSummary>[];
  readonly now?: () => number;
  /** The tree selected an item; restoration preserves the current detail state. */
  readonly onSelected: (result: RevealedItem, openDetail?: boolean) => void;
  readonly onDismissReveal: () => void;
  /** "Resume filtered view": drop the reveal and close its detail. */
  readonly onResume: () => void;
  readonly onAct: (intent: RowIntent, target: ItemRoute, onReveal?: (result: RevealedItem) => void) => void;
  readonly onClearFilters: () => void;
  readonly onClearSearch?: () => void;
  readonly onShowArchive: () => void;
  /** Called instead of sending when the agent is not running; without it the send queues. */
  readonly onAgentNotRunning?: (submission: PendingSubmission) => void;
  /** Asks to remove an item (and everything below it) or a topic: row trash, topic Remove, ⌫/Delete. */
  readonly onRemove: (target: Extract<RemoveTarget, { kind: 'item' | 'topic' }>) => void;
}

/** Most folded topics a session view keeps (the saved `collapsed_topic_ids` bound); the oldest folds drop first. */
const FOLDS_KEPT = 256;
// A row ending at the sticky edge can peek out by a sub-pixel without being the reading row.
const READING_EDGE_CLEARANCE = 1;
/** A saved reading offset, or the initial selection centred while the view loads. */
interface Anchor { readonly key: string; readonly offset: number | null }
const SKELETON = [
  { pad: 12, width: '38%', badge: 0, top: 16 }, { pad: 36, width: '64%', badge: 64, top: 12 }, { pad: 36, width: '52%', badge: 64, top: 12 },
  { pad: 60, width: '58%', badge: 84, top: 12 }, { pad: 36, width: '70%', badge: 64, top: 12 }, { pad: 12, width: '30%', badge: 0, top: 24 },
  { pad: 36, width: '60%', badge: 64, top: 12 }, { pad: 60, width: '48%', badge: 96, top: 12 },
];

export function TreeView(props: TreeViewProps) {
  const { navigation, store, actions, drafts, query, reveal, selectedId, detailOpen, covered = false, graph, notices,
    summaries, onSelected, onDismissReveal, onResume, onAct, onClearFilters, onClearSearch, onShowArchive,
    onAgentNotRunning, onRemove } = props;
  const state = useSession(store), raw = state.snapshot?.session ?? null;
  const fontEpoch = useTreeFonts();
  const peek = usePeek();
  const nav = useNavigation(navigation), preferences = nav.preferences;
  const route = state.route;
  // Rows of a pending removal are gone at once; Undo brings them back.
  const hidden = useHidden();
  const session = useMemo(() => raw && visibleSession(raw, route, hidden), [raw, route, hidden]);
  const savedView = preferences?.sessions.find(value => value.session.project_id === route.project_id && value.session.session_id === route.session_id) ?? null;
  type Edit = { change: (next: SessionPreferences) => void; done: (saved: boolean) => void };
  const [pendingEdits, setPendingEdits] = useState<readonly Edit[]>([]);
  const [writingEdits, setWritingEdits] = useState<readonly Edit[]>([]);
  const writingBase = useRef(savedView);
  const view = useMemo(() => {
    if (!savedView || (!pendingEdits.length && !writingEdits.length)) return savedView;
    const next = structuredClone(savedView) as SessionPreferences;
    [...(savedView === writingBase.current ? writingEdits : []), ...pendingEdits].forEach(edit => edit.change(next));
    return next;
  }, [savedView, pendingEdits, writingEdits]);
  // The graph has its own optimistic node edits; both mounted views use its saved
  // status scope while the tree's filter queue waits for persistence.
  // The composed graph reads saved statuses; both views must share the same fold scope during writes.
  const filterFolds = useFilterFolds(navigation.routes, route, (graph ? savedView : view)?.filters, query);
  const viewBusy = nav.writing || nav.pendingOperationId !== null;
  const archivedMode = view?.filters.archived ?? false;
  const savedLater = preferences?.later;
  const later = useMemo(() => new Set(savedLater?.filter(item => item.project_id === route.project_id && item.session_id === route.session_id)
    .map(item => item.item_id) ?? []), [savedLater, route.project_id, route.session_id]);
  const savedFolds = view?.collapsed_topic_ids;
  const closedTopics = useMemo(() => new Set(savedFolds ?? []), [savedFolds]);
  const hiddenFocus = useRef<string | null>(null);
  const [expandedHiddenGroups, setExpandedHiddenGroups] = useState<ReadonlySet<string>>(new Set());
  const [focusKey, setFocusKey] = useState<string | null>(selectedId);
  const [nextTarget, setNextTarget] = useState<{ readonly id: string; readonly step: number } | null>(null);
  const [nextRevealId, setNextRevealId] = useState<string | null>(null);
  const [nextPulse, setNextPulse] = useState(false);
  const [noUnseen, setNoUnseen] = useState(false);
  const nextScroll = useRef<string | null>(null);
  const seen = useReadingSeen(navigation.reading, preferences, route);
  const changes = useMemo(() => session ? mapChanges(session, seen) : null, [session, seen]);
  const [kbd, setKbd] = useState(false);
  const [answering, setAnswering] = useState<string | null>(null);
  const [continuing, setContinuing] = useState<string | null>(null);
  const [replying, setReplying] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
  useEffect(() => navigationVisits.bind(navigation), [navigation]);
  useOwnerDrafts(drafts, raw);
  const lifecycle = useLifecycle(actions);
  const ack = useAck(actions, selectedId);
  const [ackItemId, setAckItemId] = useState<string | null>(null);
  const runAck = (itemId: string) => { setAckItemId(itemId); return ack.run(itemId).then(saved => {
    if (saved) navigationVisits.record(route, itemId, 'acked');
    return saved;
  }); };
  const noticeCallbacks = useRef({ lifecycle, onShowArchive });
  noticeCallbacks.current = { lifecycle, onShowArchive };
  const archivedNotice = lifecycle.archived;
  const archiveNoticeId = JSON.stringify(['tree-archived', route.project_id, route.session_id, archivedNotice?.topicId]);
  useEffect(() => () => noticeStore.dismiss(archiveNoticeId), [archiveNoticeId]);
  useEffect(() => {
    if (!archivedNotice) { noticeStore.dismiss(archiveNoticeId); return; }
    noticeStore.push({ id: archiveNoticeId, icon: 'ph ph-archive', dismissible: true,
      text: `Archived “${archivedNotice.name}”.`
        + (archivedNotice.waiting ? ` Its ${archivedNotice.waiting} waiting question${archivedNotice.waiting > 1 ? 's' : ''} left your panel.` : '')
        + (archivedNotice.cancelled ? ` ${archivedNotice.cancelled} unsent message${archivedNotice.cancelled > 1 ? 's were' : ' was'} cancelled.` : ''),
      onDismiss: () => noticeCallbacks.current.lifecycle.dismiss(),
      actions: [{ label: 'Undo', disabled: lifecycle.busy, run: () => { if (!noticeCallbacks.current.lifecycle.busy) noticeCallbacks.current.lifecycle.undo(); } },
        { label: 'View archive', dismissOnRun: true, run: () => { noticeCallbacks.current.lifecycle.dismiss(); noticeCallbacks.current.onShowArchive(); } }] });
  }, [archiveNoticeId, archivedNotice]);
  useEffect(() => {
    const notice = noticeStore.getSnapshot().find(value => value.id === archiveNoticeId);
    if (notice && notice.actions?.[0]?.disabled !== lifecycle.busy) noticeStore.push({ ...notice,
      actions: notice.actions?.map(action => action.label === 'Undo' ? { ...action, disabled: lifecycle.busy } : action) });
  }, [archiveNoticeId, lifecycle.busy]);
  const actionState = actions.getSnapshot();
  const controllerFailure = !actionState.pending && isViewConflict(actionState.error) ? plainFailure(actionState.error) : null;
  const ackNotice = ack.error === controllerFailure ? null : ack.error;
  const lifecycleNotice = lifecycle.dialog || lifecycle.error === controllerFailure ? null : lifecycle.error;
  const ackNoticeId = JSON.stringify(['item-ack', route.project_id, route.session_id, ackItemId]);
  const lifecycleNoticeId = JSON.stringify(['tree-lifecycle', route.project_id, route.session_id]);
  useEffect(() => () => noticeStore.dismiss(ackNoticeId), [ackNoticeId]);
  useEffect(() => {
    if (!ackNotice) { noticeStore.dismiss(ackNoticeId); return; }
    noticeStore.push({ id: ackNoticeId, icon: 'ph ph-warning-circle', tone: 'problem', dismissible: true, text: ackNotice });
  }, [ackNoticeId, ackNotice]);
  useEffect(() => () => noticeStore.dismiss(lifecycleNoticeId), [lifecycleNoticeId]);
  useEffect(() => {
    if (!lifecycleNotice) { noticeStore.dismiss(lifecycleNoticeId); return; }
    noticeStore.push({ id: lifecycleNoticeId, icon: 'ph ph-warning-circle', tone: 'problem', dismissible: true, text: lifecycleNotice });
  }, [lifecycleNoticeId, lifecycleNotice]);
  const elements = useRef(new Map<string, HTMLDivElement>()), scroller = useRef<HTMLDivElement>(null);
  const scrollRequested = useRef<string | null>(null);
  const revealedAnchor = useRef<{ readonly key: string; readonly offset: number } | null>(null);
  const focusRequested = useRef<string | null>(null);
  const mounted = useRef(true), request = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++request.current; }; }, [store]);
  // Unmounting or swapping the rows for the graph leaves no row to fire mouseleave.

  const minute = Math.floor((props.now ?? Date.now)() / 60_000) * 60_000;
  const binding = session?.active_binding_id ? session.bindings[session.active_binding_id] ?? null : null;
  const presence = binding ? state.presence[binding.id] ?? null : null;
  const health = useSupervisorHealth(actions.service, binding?.id, binding?.generation);
  const revealId = reveal?.kind === 'item' ? reveal.route.item_id : null;
  const temporary = reveal?.kind === 'item' ? reveal.temporaryExpandedItemIds : null;
  const model = useMemo(() => session && view ? treeModel({ session, view, search: query, later, collapsedTopics: closedTopics, selectedId, revealId,
    filterCollapsedItemIds: filterFolds.items, filterCollapsedTopicIds: filterFolds.topics,
    attentionRevealId: nextRevealId, expandedHiddenGroups, temporaryExpanded: temporary ?? [], presence, health, summaries, now: minute }) : null,
  [session, view, query, expandedHiddenGroups, later, closedTopics, filterFolds.items, filterFolds.topics, selectedId, revealId, temporary, nextRevealId, presence, health, summaries, minute]);
  const summary = summaries.find(value => value.project_id === route.project_id && value.session_id === route.session_id) ?? null;
  const bar = sessionBar(session, summary, presence);
  const focusedItem = view?.focused_item_id ? session?.items[view.focused_item_id] : null;
  const focusedId = focusedItem && !focusedItem.parent && session && !itemRemoved(session, focusedItem.id) ? focusedItem.id : null;
  const focusedBranch = useMemo(() => session && focusedId ? branchItems(session, focusedId) : null, [session, focusedId]);
  const rows = useMemo(() => session ? focusedRows(model?.rows ?? [], session, focusedId) : model?.rows ?? [], [model, session, focusedId]);
  const names = useMemo(() => session ? peekNames(session) : new Map<string, string>(), [session]);
  const sections = useMemo(() => {
    const groups: { topic: Extract<Row, { kind: 'topic' }>; items: Exclude<Row, { kind: 'topic' }> [] }[] = [];
    for (const row of rows) {
      if (row.kind === 'topic') groups.push({ topic: row, items: [] });
      else groups.at(-1)?.items.push(row);
    }
    return groups;
  }, [rows]);
  const latest = useRef({ view, preferences, rows, session, selectedId, answering });
  latest.current = { view, preferences, rows, session, selectedId, answering };

  const hiddenSelection = useRef<{ sessionId?: string; selectedId: string | null }>({ selectedId: null });
  useEffect(() => {
    const current = latest.current;
    if (!current.session) return;
    const previous = hiddenSelection.current;
    hiddenSelection.current = { sessionId: current.session.id, selectedId };
    const selectionChanged = previous.sessionId !== current.session.id || previous.selectedId !== selectedId;
    const ids = [selectionChanged ? selectedId : null, reveal?.kind === 'item' ? reveal.route.item_id : null,
      props.historyReveal?.kind === 'item' ? props.historyReveal.route.item_id : null];
    const explicit = new Set(current.view?.hidden_item_ids ?? []);
    setExpandedHiddenGroups(previous => {
      const next = new Set(previous);
      ids.forEach(id => { if (id) hiddenGroupsFor(current.session!, explicit, id).forEach(key => next.add(key)); });
      return next.size === previous.size ? previous : next;
    });
  }, [session?.id, selectedId, reveal, props.historyReveal]);
  const toggleHiddenGroup = (key: string) => {
    setNextRevealId(null);
    onDismissReveal();
    setExpandedHiddenGroups(previous => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const hideItem = (row: ItemRowModel) => {
    const current = navigation.getSnapshot();
    if (!current.preferences || current.writing || current.pendingOperationId !== null) return;
    onDismissReveal();
    const element = elements.current.get(row.key);
    const groupKey = hiddenGroupKey(row.item.topic_id, row.item.parent);
    if (!row.hidden && !expandedHiddenGroups.has(groupKey) && element?.contains(document.activeElement)) hiddenFocus.current = groupKey;
    void navigation.setHidden({ ...route, item_id: row.item.id }, !row.hidden, current.preferences.revision).then(saved => {
      if (!saved) { hiddenFocus.current = null; noticeStore.push({ id: 'hide-save-failed', icon: 'ph ph-warning-circle', iconColor: 'var(--a-danger)', dismissible: true,
        text: 'The hidden items preference could not be saved. Try again.' }); }
    });
  };

  // ------------------------------------------------------------ writes
  const saveView = (change: (next: SessionPreferences) => void) => {
    const snapshot = navigation.getSnapshot();
    if (!latest.current.view || snapshot.pendingOperationId !== null && !snapshot.writing) return Promise.resolve(false);
    return new Promise<boolean>(done => { setPendingEdits(previous => [...previous, { change, done }]); });
  };
  useEffect(() => {
    if (!pendingEdits.length || writingEdits.length || viewBusy || !savedView || !preferences) return;
    const edits = pendingEdits, next = structuredClone(savedView) as SessionPreferences;
    edits.forEach(edit => edit.change(next));
    writingBase.current = savedView;
    setPendingEdits([]); setWritingEdits(edits);
    void navigation.saveSessionView(next, preferences.revision).then(saved => {
      if (!saved && mounted.current && navigation.getSnapshot().writing) {
        // Another preference writer won admission. Rebase these unsubmitted
        // edits on its saved view once navigation is idle.
        setPendingEdits(previous => [...edits, ...previous]);
        return;
      }
      edits.forEach(edit => edit.done(saved));
      if (!saved && mounted.current) noticeStore.push({ id: 'tree-view-save-failed', icon: 'ph ph-warning-circle', dismissible: true,
        text: 'The view preference could not be saved. Try again.' });
    }).finally(() => { if (mounted.current) setWritingEdits([]); });
  }, [pendingEdits, writingEdits, viewBusy, savedView, preferences, navigation]);
  const clickedReveal = useRef<RevealedItem | null>(null);
  const select = (id: string, fromRow = true, opening = false) => {
    if (fromRow && viewBusy && !navigation.isWritingRecent()) return false;
    releaseReveal();
    const call = ++request.current;
    focusRequested.current = null;
    openingRequest.current = opening ? call : null;
    if (!opening) { centered.current = true; settled.current = true; openingPlacement.current = null; setAnchor(null); }
    scrollRequested.current = null;
    setKbd(false);
    setFocusKey(id);
    noticeStore.dismiss('tree-reveal-failed');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const loading = () => new OwnFailure({ code: 'snapshot_changed', message: "Ariadne is still loading this session's latest changes. Try again.", hint: '', retryable: true, field_errors: [] });
    const reveal = async () => {
      while (navigation.getSnapshot().writing) {
        const completion = navigation.getWritingCompletion();
        if (!completion) break;
        await completion;
        if (expired || !mounted.current || call !== request.current) return null;
      }
      if (store.getSnapshot().status !== 'ready' || store.getSnapshot().error) await store.refresh(true);
      if (expired || !mounted.current || call !== request.current) return null;
      if (store.getSnapshot().status !== 'ready' || store.getSnapshot().error) throw loading();
      const current = navigation.getSnapshot();
      if (current.writing || current.pendingOperationId !== null) throw new OwnFailure({ code: 'store_busy',
        message: 'Another view change is being saved. Wait for it, then try again.', hint: '', retryable: true, field_errors: [] });
      return navigation.routes.revealItem({ ...route, item_id: id });
    };
    // Bound both the readiness wait and route read; only the latest click can select a row.
    void Promise.race([reveal(), new Promise<null>((_resolve, reject) => { timeout = setTimeout(() => { expired = true; reject(loading()); }, 5000); })]).then(result => {
      if (!mounted.current || call !== request.current || !result) return;
      clickedReveal.current = fromRow || opening ? result : null;
      if (opening) {
        openingRequest.current = null;
        if (result.kind === 'item' && !settled.current) openingPlacement.current = result.route.item_id;
      }
      onSelected(result, !opening);
      if (!opening && result.kind === 'item') navigationVisits.record(route, id, 'viewed');
      if (result.kind === 'item') void saveView(next => {
        next.selected_item_id = id;
        if (!opening && !fromRow && focusedBranch && !focusedBranch.has(id)) delete next.focused_item_id;
      });
    }).catch((error: unknown) => {
      if (opening || !mounted.current || call !== request.current) return;
      focusRequested.current = null;
      noticeStore.push({ id: 'tree-reveal-failed', icon: 'ph ph-warning-circle', iconColor: 'var(--a-danger)', dismissible: true,
        text: `“${latest.current.session?.items[id] ? shortLabel(latest.current.session.items[id]!) : 'This item'}” could not be opened. ${plainFailure(error, 'Try again.')}` });
    }).finally(() => {
      clearTimeout(timeout);
      if (opening && mounted.current && call === request.current) {
        openingRequest.current = null;
        centered.current = true;
        setOpeningFinished(previous => previous + 1);
      }
    });
    return true;
  };
  const focusBranch = (id: string | null) => {
    if (viewBusy && !navigation.isWritingRecent()) return;
    if (id && (!session?.items[id] || session.items[id]!.parent)) return;
    settled.current = true; openingPlacement.current = null; setAnchor(null);
    void saveView(next => {
      if (id) next.focused_item_id = id; else delete next.focused_item_id;
      if (id && session?.items[id]) {
        if (!next.expanded_item_ids.includes(id)) next.expanded_item_ids.push(id);
        next.collapsed_topic_ids = next.collapsed_topic_ids?.filter(topic => topic !== session.items[id]!.topic_id);
      }
    });
    if (id) focusRow(id);
  };
  // Deliberate navigation can leave Focus; ordinary saved selection is independent of it.
  const focusReveal = useRef<RevealedItem | null>(null);
  useEffect(() => {
    if (focusReveal.current === reveal) return;
    focusReveal.current = reveal;
    if (!focusedBranch || !revealId || focusedBranch.has(revealId) || reveal === clickedReveal.current) return;
    void saveView(next => { delete next.focused_item_id; });
  }, [reveal, revealId, focusedId]);
  useEffect(() => {
    const id = view?.focused_item_id;
    if (state.status !== 'ready' || !raw || !id) return;
    const item = raw.items[id];
    if (!item || item.parent || itemRemoved(raw, id)) void saveView(next => { delete next.focused_item_id; });
  }, [view?.focused_item_id, state.status, raw]);
  const toggleItem = (id: string) => {
    const row = latest.current.rows.find(value => value.key === id);
    if (!row || row.kind !== 'item' || !row.hasKids) return;
    setNextRevealId(null);
    if (model?.filtering) filterFolds.setFold('items', id, row.expanded);
    if (row.expanded) onDismissReveal();
    void saveView(next => {
      const expanded = new Set(next.expanded_item_ids);
      if (row.expanded) expanded.delete(id); else expanded.add(id);
      next.expanded_item_ids = [...expanded];
    });
  };
  const toggleTopic = (id: string) => {
    setNextRevealId(null);
    const expanded = latest.current.rows.find(row => row.kind === 'topic' && row.key === id)?.expanded ?? !closedTopics.has(id);
    if (expanded) onDismissReveal();
    if (model?.filtering) filterFolds.setFold('topics', id, expanded);
    const next = new Set(closedTopics);
    if (expanded) next.add(id); else next.delete(id);
    const kept = [...next].slice(-FOLDS_KEPT);
    void saveView(saved => { saved.collapsed_topic_ids = kept; });
  };
  const setChip = (chip: Chip) => {
    setNextRevealId(null);
    onDismissReveal();
    void saveView(next => { next.filters.statuses = toggleChip(next.filters.statuses, chip); });
  };
  const resume = () => {
    setNextRevealId(null);
    const outsideSelected = selectedId !== null && selectedId === revealId;
    onResume();
    if (outsideSelected) void saveView(next => { next.selected_item_id = null; });
  };

  // ------------------------------------------------------------ answering
  const answerable = (row: Row | undefined): row is ItemRowModel => row?.kind === 'item' && row.item.status === 'waiting_on_me'
    && (!row.delivery || row.delivery.failed) && !archivedMode;
  const openAnswer = (id: string) => {
    setAnswering(id);
    const begin = () => {
      const current = store.getSnapshot().snapshot?.session;
      if (!current || !mounted.current) return;
      const existing = drafts.find(route, id, 'answer');
      if (existing?.receipt) drafts.another(existing.draft.op_id, current);
      else if (!existing) drafts.begin(current, id, 'answer');
    };
    if (drafts.getSnapshot().ready) begin(); else void drafts.load().then(begin);
  };
  // Answering ends once the item has an answer on its way or stops waiting.
  const answerRow = rows.find((row): row is ItemRowModel => row.key === answering && answerable(row));
  const entry = answerRow ? drafts.find(route, answerRow.item.id, 'answer') : undefined;
  const options = answerRow?.item.options ?? [];
  const pickedIndex = entry?.draft.selected_option_id ? options.findIndex(option => option.id === entry.draft.selected_option_id) : -1;
  const chosen = pickedIndex >= 0 ? pickedIndex : options.findIndex(option => option.recommended);
  const blocked = session && sessionEnded(session) ? sessionAnswerBlocked(session)
    : session?.state !== 'active' ? sessionClosedReason
    : bar?.connection === 'reconnecting' ? reconnectingNote(bar.agent) : null;
  const focusRow = (key: string) => { setFocusKey(key); elements.current.get(key)?.focus({ preventScroll: true }); };
  const send = (change: { selected_option_id: string | null; text: string }) => {
    if (!entry || entry.saving || blocked) return;
    const id = entry.draft.op_id, itemKey = answering, item = answerRow?.item;
    // The change is saved only when the input goes out: a cancelled "not running" dialog keeps the draft as typed.
    const submit = () => { drafts.edit(id, change); return drafts.submit(id).then(saved => {
      if (saved && mounted.current) {
        if (itemKey) navigationVisits.record(route, itemKey, 'answered');
        setAnswering(current => current === itemKey ? null : current);
        if (itemKey) focusRow(itemKey);
      }
      return saved;
    }); };
    if (item && bar?.connection !== 'connected' && onAgentNotRunning) {
      const label = change.selected_option_id ? item.options.find(option => option.id === change.selected_option_id)?.label ?? '' : change.text;
      onAgentNotRunning({ route: { ...route, item_id: item.id }, intent: 'answer', question: item.question, label, agent: bar?.agent ?? 'the agent', change, queue: submit });
    } else void submit();
  };
  const sendOption = (index: number, note?: string) => {
    const option = options[index];
    if (entry && option) send({ selected_option_id: option.id, text: note ?? drafts.getSnapshot().entries[entry.draft.op_id]?.draft.text ?? entry.draft.text });
  };
  const answerControl = answerRow ? <AnswerControl variant="full" selected={chosen} draft={entry?.draft.text ?? ''}
    options={options.map(option => ({ id: option.id, label: option.label, consequence: option.consequence, recommended: option.recommended }))}
    warn={entry?.error ? plainFailure(entry.error) : undefined} blocked={blocked ?? undefined} locked={!entry || entry.saving || !!session && sessionEnded(session)}
    onSelect={index => { if (entry && options[index]) drafts.edit(entry.draft.op_id, { selected_option_id: options[index].id }); focusRow(answerRow.key); }}
    onDraft={text => { if (entry) drafts.edit(entry.draft.op_id, { text }); }}
    onSendOption={sendOption} onSendText={text => send({ selected_option_id: null, text })}
    onEscape={() => { setAnswering(null); focusRow(answerRow.key); }} /> : null;
  useEffect(() => { if (answering && !answerRow) setAnswering(null); }, [answering, answerRow]);

  // ------------------------------------------------------------ keyboard
  const onRow = (act: (row: Row, index: number, intent: WorkspaceIntent, event: KeyboardEvent<HTMLDivElement>) => boolean | void) => (intent: WorkspaceIntent, event: KeyboardEvent<HTMLDivElement>) => {
    const visible = latest.current.rows, index = visible.findIndex(row => row.key === event.currentTarget.dataset.row);
    return index >= 0 ? act(visible[index], index, intent, event) : false;
  };
  const move = (to: (index: number, visible: readonly Row[]) => number) => onRow((_row, index) => {
    const visible = latest.current.rows, next = visible[Math.max(0, Math.min(visible.length - 1, to(index, visible)))];
    if (next) focusRow(next.key);
    return true;
  });
  const topicOnly = onRow(row => row.kind === 'topic');
  const keys = useWorkspaceKeys<HTMLDivElement>({
    'move-down': move(index => index + 1), 'move-up': move(index => index - 1), first: move(() => 0), last: move((_index, visible) => visible.length - 1),
    unfold: onRow((row, index) => {
      const next = latest.current.rows[index + 1];
      if (row.kind === 'hidden' && !row.expanded) toggleHiddenGroup(row.key);
      else if (row.kind === 'topic' && !row.expanded) toggleTopic(row.topic.id);
      else if (row.kind === 'item' && row.hasKids && !row.expanded) toggleItem(row.item.id);
      else if (row.expanded && next && (next.depth > row.depth || row.kind === 'hidden' && next.kind === 'item' && next.hidden)) focusRow(next.key);
      return true;
    }),
    fold: onRow(row => {
      if (row.kind === 'topic') { if (row.expanded) toggleTopic(row.topic.id); return true; }
      if (row.kind === 'hidden') { if (row.expanded) toggleHiddenGroup(row.key); else { const parent = parentKey(row); if (parent) focusRow(parent); } return true; }
      if (row.hasKids && row.expanded) { toggleItem(row.item.id); return true; }
      const parent = parentKey(row);
      if (parent && latest.current.rows.some(value => value.key === parent)) focusRow(parent);
      return true;
    }),
    enter: onRow(row => {
      if (row.kind === 'topic') { toggleTopic(row.topic.id); return true; }
      if (row.kind === 'hidden') { toggleHiddenGroup(row.key); return true; }
      if (answering === row.key && chosen >= 0) { sendOption(chosen); return true; }
      select(row.item.id); return true;
    }),
    peek: onRow((row, _index, _intent, event) => {
      if (row.kind !== 'item' || !peek) return false;
      if (!event.repeat) peek.open({ ...route, item_id: row.item.id }, event.currentTarget);
      return true;
    }),
    recent: () => { setRecentOpen(true); return true; },
    answer: onRow((row, _index, _intent, event) => {
      if (row.kind === 'item' && session && ackTarget(session, row.item)) {
        if (!event.repeat) {
          if (viewBusy) noticeStore.push({ id: 'tree-ack-view-saving', icon: 'ph ph-warning-circle', dismissible: true,
            text: 'Another view change is being saved. Wait for it, then try Ack again.' });
          else void runAck(row.item.id);
        }
        return true;
      }
      if (answerable(row)) { if (answering === row.key) setAnswering(null); else openAnswer(row.key); return true; }
      const oldest = session ? oldestWaiting(session) : null, target = oldest ? latest.current.rows.find(value => value.key === oldest.id) : undefined;
      if (!answerable(target)) return false;
      focusRow(target.key); openAnswer(target.key); return true;
    }),
    choose: onRow((row, _index, intent) => {
      if (row.kind !== 'item') return true;
      if (answering !== row.key || intent.kind !== 'choose') return false;
      if (entry && options[intent.index]) drafts.edit(entry.draft.op_id, { selected_option_id: options[intent.index].id });
      return true;
    }),
    escape: onRow(row => { if (answering !== row.key) return false; setAnswering(null); return true; }),
    archive: onRow(row => {
      const topicId = row.kind === 'topic' ? row.topic.id : row.kind === 'hidden' ? row.topicId : row.item.topic_id;
      if (archivedMode) lifecycle.restore(topicId); else lifecycle.archive(topicId);
      return true;
    }),
    bring: topicOnly, respond: topicOnly, drop: topicOnly, reopen: topicOnly, later: topicOnly,
    hide: (intent, event) => event.repeat ? true : onRow(row => { if (row.kind === 'item') hideItem(row); return true; })(intent, event),
    remove: onRow(row => {
      if (row.kind === 'hidden') return true;
      onRemove(row.kind === 'topic' ? { kind: 'topic', session: route, topic_id: row.topic.id } : { kind: 'item', item: { ...route, item_id: row.item.id } });
      return true;
    }),
  }, { scope: 'row' });

  // ------------------------------------------------------------ focus and scroll
  const remember = useRef((key: string, element: HTMLDivElement | null) => {
    if (element) elements.current.set(key, element); else elements.current.delete(key);
  }).current;
  useEffect(() => { if (selectedId) { setKbd(false); setFocusKey(selectedId); } }, [selectedId]);
  useLayoutEffect(() => {
    const hiddenTarget = hiddenFocus.current;
    if (hiddenTarget && rows.some(row => row.key === hiddenTarget)) {
      hiddenFocus.current = null;
      setFocusKey(hiddenTarget); elements.current.get(hiddenTarget)?.focus({ preventScroll: true });
      return;
    }
    if (!rows.length || (focusKey && rows.some(row => row.key === focusKey))) return;
    let candidate: string | null = focusKey && session?.items[focusKey] ? session.items[focusKey]!.parent ?? session.items[focusKey]!.topic_id : null;
    while (candidate && !rows.some(row => row.key === candidate)) candidate = session?.items[candidate]?.parent ?? session?.items[candidate]?.topic_id ?? null;
    const next = candidate ?? rows[0].key, hadFocus = !!scroller.current?.contains(document.activeElement);
    setFocusKey(next);
    if (hadFocus) elements.current.get(next)?.focus({ preventScroll: true });
  }, [rows, focusKey, session]);
  // Reserve the target topic's actual height, including wrapped names and delivery lines.
  const headerHeight = (element: HTMLElement) => element.classList.contains('tree-topic') ? 0
    : element.closest('.tree-topic-group')?.querySelector('.tree-topic')?.getBoundingClientRect().height ?? 0;
  const readingTop = () => {
    const box = scroller.current;
    if (!box) return 0;
    const top = box.getBoundingClientRect().top;
    let height = 0;
    for (const header of box.querySelectorAll<HTMLElement>('.tree-topic')) {
      const rect = header.getBoundingClientRect();
      if (rect.top <= top && rect.bottom > top) height = Math.max(height, rect.bottom - top);
    }
    box.style.setProperty('--tree-header-height', `${height}px`);
    return top + height;
  };
  const center = (key: string) => {
    const box = scroller.current, element = elements.current.get(key);
    if (!box || !element) return;
    const a = box.getBoundingClientRect(), b = element.getBoundingClientRect();
    box.scrollTop += b.top - a.top - openingTop(a.height, b.height, headerHeight(element));
  };
  // Saved reading positions win on session restoration; otherwise place the initial selection once.
  const place = (target: Anchor | null) => {
    const box = scroller.current, element = target ? elements.current.get(target.key) : undefined;
    if (!box || !element || !target) return;
    if (target.offset === null) center(target.key);
    else box.scrollTop += element.getBoundingClientRect().top - box.getBoundingClientRect().top - headerHeight(element) - target.offset;
  };
  // The least scrolling that brings a row into view (`block: 'nearest'`): none when it is in view already; a row
  // taller than the tree lines up its top instead of running past it.
  const nearest = (key: string, margin = 0) => {
    const box = scroller.current, element = elements.current.get(key);
    if (!box || !element) return;
    const a = box.getBoundingClientRect(), b = element.getBoundingClientRect();
    box.scrollTop += nearestDelta(a.height, b.top - a.top, b.height, headerHeight(element), margin);
  };
  const centered = useRef(false), settled = useRef(false), openingReveal = useRef<string | null>(null);
  const openingPlacement = useRef<string | null>(null);
  const openingRequest = useRef<number | null>(null);
  const [openingFinished, setOpeningFinished] = useState(0);
  // Show more / Show less on a long preview. The owner is steering, so the view stops holding its anchor; folding
  // a preview the owner has read down to its end keeps that row's top in sight rather than leaving the tree below it.
  const { isUnfolded, toggle: toggleUnfolded } = useUnfolded(route.project_id, route.session_id);
  const folding = useRef<string | null>(null);
  const unfold = (id: string) => {
    settled.current = true;
    held.current = null; revealedAnchor.current = null;
    if (isUnfolded(id)) folding.current = id;
    toggleUnfolded(id);
  };
  useLayoutEffect(() => {
    const id = folding.current;
    folding.current = null;
    if (id) nearest(id);
  });
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  useLayoutEffect(() => {
    if (centered.current || !rows.length || graph) return;
    const saved = latest.current.view?.scroll;
    // Ordinary session restoration keeps its reading anchor; an explicit item route goes to its target.
    const restored: Anchor | null = !revealId && saved?.item_id && elements.current.has(saved.item_id) ? { key: saved.item_id, offset: saved.offset } : null;
    const key = revealId ?? selectedId;
    // Hidden selections may mount after their group is exposed; wait before consuming the opening placement.
    if (!restored && key && !elements.current.has(key)) {
      // A saved selection may be behind a folded ancestor/topic. The normal reveal route
      // exposes its ancestry temporarily, without changing the saved expansion preferences.
      if (!viewBusy && openingReveal.current !== key) { openingReveal.current = key; select(key, false, true); }
      return;
    }
    centered.current = true;
    openingPlacement.current = null;
    const target: Anchor | null = restored ?? (key && elements.current.has(key) ? { key, offset: null } : null);
    place(target);
    setAnchor(target);
    // Web fonts change row heights after this first layout; the anchor row holds its place through them.
    void document.fonts?.ready.then(() => { if (mounted.current && !settled.current) place(target); });
    // Only the first rows of this session view place the anchor; later changes keep the reading position.
  }, [rows.length, graph, viewBusy]);
  useLayoutEffect(() => {
    const key = openingPlacement.current;
    if (!centered.current || !key || graph) return;
    if (!elements.current.has(key)) { openingPlacement.current = null; return; }
    openingPlacement.current = null;
    const target: Anchor = { key, offset: null };
    place(target); setAnchor(target);
    void document.fonts?.ready.then(() => { if (mounted.current && !settled.current) place(target); });
  }, [rows, openingFinished, graph]);
  const previousSelection = useRef({ reveal, selectedId });
  useLayoutEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = { reveal, selectedId };
    const changed = selectedId !== previous.selectedId || reveal?.kind === 'item' && reveal !== previous.reveal;
    const id = reveal?.kind === 'item' ? reveal.route.item_id : selectedId;
    if (!changed || !id) return;
    // The opening layout may already have placed a newly mounted external target. Cancel its old
    // read independently of centered, so a late restoration cannot replace a deliberate reveal.
    if (openingRequest.current !== null && (id !== openingReveal.current || reveal !== previous.reveal && reveal !== clickedReveal.current)) {
      centered.current = true; ++request.current;
      openingRequest.current = null; openingPlacement.current = null;
    }
    if (graph) return;
    if (!centered.current) return;
    const clicked = clickedReveal.current;
    // A row click's immediate selection and the workspace's exact-result echo both stay put.
    // Every other deliberate reveal (including the same item again) brings its target into view.
    const clickEcho = clicked?.kind === 'item' && clicked.route.item_id === id
      && (reveal === clicked || reveal === previous.reveal);
    if (!clickEcho) {
      clickedReveal.current = null;
      openingPlacement.current = null;
      scrollRequested.current = id;
    }
    // Leaving Focus can mount the target on the next render. Keep the handoff until its row exists.
    if (reveal?.kind === 'item' && reveal !== previous.reveal) { setKbd(false); focusRequested.current = id; }
  }, [reveal, selectedId, graph]);
  // Hold the saved reading position while fonts and initial rows settle. Selection or panel changes
  // end this restoration, as do the owner's scrolling, clicking or keyboard navigation.
  useEffect(() => {
    const box = scroller.current, row = anchor ? elements.current.get(anchor.key) : undefined;
    if (!box || !anchor || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { if (!settled.current) place(anchor); });
    const content = box.querySelector('.tree-rows');
    observer.observe(box); if (row) observer.observe(row); if (content) observer.observe(content);
    const settle = () => { settled.current = true; openingPlacement.current = null; };
    box.addEventListener('wheel', settle, { passive: true }); box.addEventListener('pointerdown', settle);
    return () => { observer.disconnect(); box.removeEventListener('wheel', settle); box.removeEventListener('pointerdown', settle); };
  }, [anchor]);
  useLayoutEffect(() => {
    if (!focusKey || !kbd) return;
    if (focusKey !== anchor?.key) settled.current = true;
    // Keyboard moves scroll only when the new row is off-screen, and by the least amount.
    nearest(focusKey, 8);
  }, [focusKey]);
  // The tree never jumps on its own: what the owner is reading stays put when rows above it grow, shrink, arrive or
  // leave (a live edit, a message landing, fonts loading). WKWebView has no `overflow-anchor`, so the first visible row
  // is remembered with its offset (and the scroll position it was seen at) and put back after every layout change.
  const held = useRef<{ readonly key: string; readonly offset: number; readonly top: number; readonly scrollTop: number } | null>(null);
  const panelTarget = useRef<{ readonly key: string; readonly top: number; readonly scrollTop: number } | null>(null);
  const [breadcrumb, setBreadcrumb] = useState<readonly string[]>([]);
  const placed = useRef<Anchor | null>(null);
  placed.current = anchor;
  const remembering = () => {
    const box = scroller.current;
    if (!box) { held.current = null; return; }
    const before = held.current, element = before ? elements.current.get(before.key) : undefined;
    // An observer, layout effect or delayed programmatic scroll event can arrive between
    // reflows. With no owner scroll, restore the held row before adopting the new layout.
    if (before && element && before.scrollTop > 0 && box.scrollTop === before.scrollTop && (settled.current || !placed.current)) {
      const delta = element.getBoundingClientRect().top - box.getBoundingClientRect().top - before.top;
      if (Math.abs(delta) >= 1) box.scrollTop += delta;
    }
    const top = readingTop(), list = latest.current.rows.filter(row => row.kind === 'item');
    const panelKey = latest.current.answering ?? latest.current.selectedId;
    const panelRect = panelKey ? elements.current.get(panelKey)?.getBoundingClientRect() : undefined;
    panelTarget.current = panelKey && panelRect && panelRect.top >= top && panelRect.top < box.getBoundingClientRect().bottom
      ? { key: panelKey, top: panelRect.top, scrollTop: box.scrollTop } : null;
    // Rows are stacked in order. Skip predecessors ending within a pixel of the sticky edge.
    let low = 0, high = list.length;
    while (low < high) {
      const middle = (low + high) >> 1, element = elements.current.get(list[middle]!.key);
      if (!element || element.getBoundingClientRect().bottom > top + READING_EDGE_CLEARANCE) high = middle; else low = middle + 1;
    }
    const key = list[low]?.key;
    // A deliberate reveal holds its own row through detail-width and preview-clamp changes.
    // The previous row may still peek out below the sticky header's eight-pixel margin.
    if (revealedAnchor.current && !elements.current.has(revealedAnchor.current.key)) revealedAnchor.current = null;
    const revealed = revealedAnchor.current;
    const holdKey = revealed?.key ?? key, holdElement = holdKey ? elements.current.get(holdKey) : undefined;
    // Edge/breadcrumb observation may run before reflow correction. Preserve the
    // reveal's original offset instead of adopting its temporarily obscured top.
    const holdRect = holdElement?.getBoundingClientRect();
    held.current = holdKey && holdRect ? { key: holdKey, offset: revealed?.offset ?? holdRect.top - top,
      top: holdRect.top - box.getBoundingClientRect().top, scrollTop: box.scrollTop } : null;
    // Reading keeps a partially visible row anchored, but breadcrumb names belong to
    // the first complete row below the pinned topic, not that clipped predecessor.
    const first = key ? elements.current.get(key) : undefined;
    const completeKey = list[low + (first && first.getBoundingClientRect().top >= top ? 0 : 1)]?.key;
    const complete = completeKey ? elements.current.get(completeKey)?.getBoundingClientRect() : undefined;
    const breadcrumbKey = complete && complete.top >= top && complete.bottom <= Math.min(box.getBoundingClientRect().bottom, window.innerHeight)
      ? completeKey : null;
    const currentSession = latest.current.session;
    const next = breadcrumbKey && currentSession ? breadcrumbItems(currentSession, breadcrumbKey).filter(id => {
      const ancestor = elements.current.get(id);
      return !ancestor || ancestor.getBoundingClientRect().top < top;
    }) : [];
    setBreadcrumb(previous => previous.length === next.length && previous.every((id, index) => id === next[index]) ? previous : next);
  };
  const layoutState = useRef({ selectedId, reveal, detailOpen });
  const releaseReveal = () => {
    if (!revealedAnchor.current) return;
    revealedAnchor.current = null;
    remembering();
  };
  layoutState.current = { selectedId, reveal, detailOpen };
  const previousLayout = useRef(layoutState.current);
  const previousWidth = useRef<number | null>(null);
  const holding = () => {
    const previous = previousLayout.current, current = layoutState.current;
    previousLayout.current = current;
    const width = scroller.current?.getBoundingClientRect().width ?? null;
    const resized = previousWidth.current !== null && previousWidth.current !== width;
    previousWidth.current = width;
    // Closing detail widens previews above the selected/answered row. Preserve
    // that row's last screen position rather than the earlier reading anchor.
    const target = panelTarget.current;
    if (previous.detailOpen && !current.detailOpen && target && target.key === (latest.current.answering ?? current.selectedId)) {
      const offset = Math.max(target.top, readingTop() + 8) - readingTop();
      revealedAnchor.current = { key: target.key, offset };
      held.current = { key: target.key, offset, top: readingTop() + offset - (scroller.current?.getBoundingClientRect().top ?? 0), scrollTop: target.scrollTop };
    }
    if (resized || previous.selectedId !== current.selectedId || previous.reveal !== current.reveal || previous.detailOpen !== current.detailOpen) {
      settled.current = true; setAnchor(null);
    }
    const box = scroller.current, before = held.current, element = before ? elements.current.get(before.key) : undefined;
    // At the very top the owner wants the newest rows; a different scroll position means the view was moved on purpose
    // (a scroll, a reveal, the keyboard), and the opening placement holds its own row until the owner steers.
    if (box && before && element && before.scrollTop > 0 && box.scrollTop === before.scrollTop && (settled.current || !placed.current)) {
      const delta = element.getBoundingClientRect().top - readingTop() - before.offset;
      if (Math.abs(delta) >= 1) box.scrollTop += delta;
    }
    remembering();
  };
  useLayoutEffect(holding);
  const hasRows = rows.length > 0 && !graph;
  useEffect(() => {
    const content = scroller.current?.querySelector('.tree-rows');
    if (!content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(holding);
    observer.observe(content);
    content.querySelectorAll('.tree-topic').forEach(header => observer.observe(header));
    return () => observer.disconnect();
  }, [hasRows]);
  // Leaving the tree saves the first visible row as the session's reading position.
  const saveScroll = (event: FocusEvent<HTMLDivElement>) => {
    const box = scroller.current;
    if (!box || event.currentTarget.contains(event.relatedTarget)) return;
    const top = readingTop();
    const first = latest.current.rows.find(row => row.kind === 'item' && (elements.current.get(row.key)?.getBoundingClientRect().bottom ?? -Infinity) > top + READING_EDGE_CLEARANCE);
    const element = first && elements.current.get(first.key);
    if (!first || !element) return;
    // Save in the same target-header coordinates used by place, even during topic push-out.
    const scroll = { item_id: first.key, offset: element.getBoundingClientRect().top - box.getBoundingClientRect().top - headerHeight(element) }, current = latest.current.view?.scroll;
    if (current?.item_id !== scroll.item_id || current.offset !== scroll.offset) void saveView(next => { next.scroll = scroll; });
  };

  const [selectedEdge, setSelectedEdge] = useState<'above' | 'below' | null>(null);
  const updateEdge = () => {
    remembering();
    const box = scroller.current, element = selectedId ? elements.current.get(selectedId) : null;
    let edge: 'above' | 'below' | null = null;
    if (box && element && !graph) {
      const a = box.getBoundingClientRect(), b = element.getBoundingClientRect();
      if (b.top < readingTop()) edge = 'above';
      else if (b.top >= a.bottom) edge = 'below';
    }
    if (box && !element && selectedId && session?.items[selectedId] && !graph) edge = 'below';
    setSelectedEdge(previous => previous === edge ? previous : edge);
  };
  useLayoutEffect(updateEdge);
  const retainReveal = (key: string) => {
    const element = elements.current.get(key);
    revealedAnchor.current = element ? { key, offset: element.getBoundingClientRect().top - readingTop() } : null;
    remembering(); updateEdge();
  };
  const revealSelected = (returnFocus = false) => {
    if (!selectedId || graph) return;
    if (!elements.current.has(selectedId)) {
      // Reuse the temporary reveal route when the owner has folded the selection away.
      if (select(selectedId, false) && returnFocus) focusRequested.current = selectedId;
      return;
    }
    settled.current = true; setAnchor(null); nearest(selectedId, 8); retainReveal(selectedId);
    if (returnFocus) focusRow(selectedId);
  };
  useLayoutEffect(() => {
    const target = focusRequested.current;
    if (!target) return;
    if (selectedId !== target) { focusRequested.current = null; return; }
    if (!elements.current.has(target)) return;
    focusRequested.current = null;
    focusRow(target);
  }, [rows, selectedId, reveal]);
  useLayoutEffect(() => {
    const target = scrollRequested.current;
    if (!target || graph) return;
    if (selectedId !== target) { scrollRequested.current = null; return; }
    if (!elements.current.has(target)) return;
    scrollRequested.current = null;
    settled.current = true; setAnchor(null); nearest(target, 8); retainReveal(target);
  }, [rows, selectedId, reveal, graph]);
  const nextCallbacks = useRef<() => void>(() => {});
  nextCallbacks.current = () => {
    if (!changes || !session || state.status !== 'ready') return;
    releaseReveal();
    const after = nextTarget?.id ?? (focusKey && session.items[focusKey] ? focusKey : selectedId);
    const id = nextMarkedItem(changes.order, changes.markers, after);
    settled.current = true; centered.current = true; setAnchor(null);
    scrollRequested.current = null;
    setNoUnseen(id === null);
    setNextRevealId(id);
    if (!id) {
      setNextTarget(null); setNextPulse(false); nextScroll.current = null;
      noticeStore.push({ id: 'tree-no-unseen', icon: 'ph ph-check', dismissible: true, text: 'No unseen items.' });
      return;
    }
    noticeStore.dismiss('tree-no-unseen');
    if (focusedBranch && !focusedBranch.has(id)) void saveView(next => { delete next.focused_item_id; });
    nextScroll.current = id;
    setKbd(true);
    setNextPulse(false);
    setNextTarget(previous => ({ id, step: (previous?.step ?? 0) + 1 }));
  };
  useLayoutEffect(() => {
    const id = nextScroll.current;
    if (!id || graph || !elements.current.has(id)) return;
    nextScroll.current = null;
    focusRow(id); nearest(id, 8); retainReveal(id);
  }, [rows, nextTarget, graph]);
  useEffect(() => {
    if (!nextTarget) return;
    const start = setTimeout(() => setNextPulse(true), 0);
    const timer = setTimeout(() => setNextPulse(false), 900);
    return () => { clearTimeout(start); clearTimeout(timer); };
  }, [nextTarget]);
  useEffect(() => {
    setNextTarget(null); setNextRevealId(null); setNextPulse(false); setNoUnseen(false); nextScroll.current = null;
    return () => noticeStore.dismiss('tree-no-unseen');
  }, [route.project_id, route.session_id]);
  useEffect(() => {
    if (graph || covered) return;
    const shortcut = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.key.toLowerCase() !== 'n') return;
      if (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="dialog"],[role="alertdialog"]')) return;
      event.preventDefault();
      if (!event.repeat) nextCallbacks.current();
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [graph, covered]);
  const edgeCallbacks = useRef({ updateEdge, revealSelected, holding });
  edgeCallbacks.current = { updateEdge, revealSelected, holding };
  const topicKeys = JSON.stringify(sections.map(section => section.topic.key));
  useEffect(() => {
    const box = scroller.current;
    if (!box || graph || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (previousWidth.current !== box.getBoundingClientRect().width) edgeCallbacks.current.holding();
      edgeCallbacks.current.updateEdge();
    });
    observer.observe(box);
    const content = box.querySelector('.tree-rows');
    if (content) observer.observe(content);
    box.querySelectorAll('.tree-topic').forEach(header => observer.observe(header));
    return () => observer.disconnect();
  }, [hasRows, graph, topicKeys]);
  useEffect(() => {
    if (covered) return;
    const shortcut = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j') {
        event.preventDefault(); edgeCallbacks.current.revealSelected();
      }
      if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'e'
        && !(event.target instanceof Element && event.target.closest('[role="dialog"],[role="alertdialog"]'))) {
        event.preventDefault(); setRecentOpen(true);
      }
    };
    window.addEventListener('keydown', shortcut, true);
    return () => window.removeEventListener('keydown', shortcut, true);
  }, [graph, covered]);

  // ------------------------------------------------------------ rows
  const running = bar?.running ?? false;
  const itemActions = (row: ItemRowModel): RowAction[] => {
    const item = row.item, target = { ...route, item_id: item.id }, list: RowAction[] = [];
    const ackTo = row.ack;
    if (ackTo) list.push({ icon: 'ph ph-check', title: ackTitle(ackTo, item.status), persistent: true, disabled: viewBusy || ack.busy, run: () => { void runAck(item.id); } });
    const act = (intent: RowIntent) => () => {
      ++request.current; centered.current = true; settled.current = true; setAnchor(null);
      scrollRequested.current = null;
      onAct(intent, target, result => { clickedReveal.current = result; });
    };
    if (item.status !== 'waiting_on_me' && (!row.delivery || row.delivery.failed || closed(item.status)) && running && !archivedMode && session?.state === 'active') {
      const bring = { icon: 'ph ph-megaphone-simple', title: 'Bring it up (b)', run: act('bring') };
      if (item.status === 'open') list.push(bring, ...row.later ? [{ icon: 'ph ph-arrow-u-up-left', title: 'Unpark (z)', run: act('later') }]
        : [{ icon: 'ph ph-chat-text', title: 'Reply (r)', run: act('reply') }, { icon: 'ph ph-x-circle', title: 'Drop (d)', run: act('drop') },
          { icon: 'ph ph-clock', title: 'Later (z)', run: act('later') }]);
      else if (item.status === 'in_progress') list.push({ icon: 'ph ph-chat-text', title: 'Add a note (r)', run: act('note') });
      else {
        list.push({ icon: 'ph ph-chat-text', title: 'Follow up (r)', run: act('followup') });
        if (item.status !== 'replaced') list.push({ icon: 'ph ph-arrow-counter-clockwise', title: 'Back to Open (o)', run: act('reopen') });
      }
    }
    list.push({ icon: '', glyph: <HideIcon hidden={row.hidden} />, title: row.hidden ? 'Unhide (x)' : 'Hide (x)', run: () => hideItem(row) });
    list.push({ icon: 'ph ph-trash', title: 'Remove (⌫)', run: () => onRemove({ kind: 'item', item: target }) });
    return list;
  };
  const topicActions = (row: Extract<Row, { kind: 'topic' }>): TopicAction[] => {
    const id = row.topic.id;
    if (archivedMode) return [{ icon: 'ph ph-arrow-counter-clockwise', label: 'Restore', title: 'Restore topic (e)', run: () => lifecycle.restore(id), archive: true }];
    const remove = { icon: 'ph ph-trash', label: 'Remove', title: 'Remove topic (⌫)', run: () => onRemove({ kind: 'topic', session: route, topic_id: id }) };
    // Archive is always offered: open items stay as they are and unsent messages are cancelled (ADR-0090).
    const archive = { icon: 'ph ph-archive', label: 'Archive', title: 'Archive topic (e)', run: () => lifecycle.archive(id), archive: true };
    // While a topic reply is on its way to the agent, the topic takes no new reply or continuation.
    if (row.delivery) return [archive, remove];
    return [
      ...session?.state === 'active' && session.active_binding_id ? [{ icon: 'ph ph-chat-text', label: 'Reply to topic', title: 'Tell the agent something about this whole topic', run: () => setReplying(id) }] : [],
      // Continuation is a core workflow: every topic without an origin offers it,
      // not only earlier-session ones as the prototype draws (main, P8.3 WP1).
      ...!row.topic.origin ? [{ icon: 'ph ph-arrow-bend-down-right', label: 'Continue here', title: `Continue this topic with ${bar?.agent ?? 'this session'}`, run: () => setContinuing(id) }] : [],
      archive,
      remove,
    ];
  };
  // A stopped delivery, or a topic reply not sent yet, is answered on its row; keys there stay off the tree's shortcuts.
  // Edit puts a topic reply back in the topic's reply box and opens it.
  const editTopicReply = (input: Immutable<Input>) => async () => {
    const outcome = await editQueued(drafts, store.getSnapshot().snapshot?.session, input, actions);
    if (inEditor(outcome)) setReplying(input.target.topic_id);
    return outcome;
  };
  const fixOf = (row: Row) => row.delivery?.stuck ? <div className="tree-fix" onKeyDown={event => event.stopPropagation()}>
    <StuckNote actions={actions} input={row.delivery.stuck.input} stuck={row.delivery.stuck.note}
      onEdit={row.kind === 'topic' ? editTopicReply(row.delivery.stuck.input) : undefined} /></div> : null;
  const tree = model && rows.length > 0 && <TreeFonts.Provider value={fontEpoch}><ItemRefs.Provider value={{ route: id => ({ ...route, item_id: id }), lookup: id => {
    const item = session?.items[id];
    return item && session && !itemRemoved(session, item.id) ? { label: names.get(id) ?? shortLabel(item), status: displayStatus(session, item) } : null;
  }, onOpenItem: id => select(id, false) }}><div role="tree" aria-label="Session items" aria-busy={state.status === 'loading'} className="tree-rows" onBlur={saveScroll}>
    {sections.map(({ topic: row, items }) => {
      const eligible = !archivedMode && session ? ackAllItems(session, row.topic.id) : [];
      return <div key={row.key} className="tree-topic-group" role="presentation">
      <TopicRow row={row} focused={focusKey === row.key} actions={topicActions(row)}
        ackAllCount={eligible.length}
        ackAll={!archivedMode ? <AckAll actions={actions} topicId={row.topic.id} topicName={row.topic.name} items={eligible} disabled={viewBusy} /> : undefined}
        prompt={row.allClosed && !archivedMode ? () => lifecycle.archive(row.topic.id) : null}
        remember={remember} onFocus={setFocusKey} onKeyDown={keys} onToggle={toggleTopic}
        reply={replying === row.topic.id && !archivedMode ? <TopicReply drafts={drafts} store={store} actions={actions} topicId={row.topic.id}
          agent={bar?.agent ?? 'the agent'} onClose={() => { setReplying(null); focusRow(row.key); }} /> : null} fix={fixOf(row)} />
      {row.expanded && props.topicContent?.(row.topic.id)}
      {items.map(row => row.kind === 'hidden'
        ? <HiddenRow key={row.key} row={row} focused={focusKey === row.key} remember={remember} onFocus={setFocusKey} onKeyDown={keys} onToggle={toggleHiddenGroup} />
        : <ItemRow key={row.key} row={row} selected={selectedId === row.key} focused={focusKey === row.key} disabled={viewBusy && !navigation.isWritingRecent()} closedReason={session ? sessionAnswerBlocked(session) : undefined}
        changeMarker={changes?.markers.get(row.key)} nextUnseen={nextTarget?.id === row.key} nextUnseenPulse={nextPulse && nextTarget?.id === row.key}
        note={row.collapsed ? collapsedNote(row.collapsed) : null}
        actions={itemActions(row)} answer={answering === row.key ? answerControl : null} fix={fixOf(row)}
        unfolded={isUnfolded(row.key)} onUnfold={unfold}
        onFocusBranch={focusBranch} names={names}
        onPeekHover={(id, event) => { const handlers = peek?.chipProps({ ...route, item_id: id });
          if (event.type === 'mouseenter') handlers?.onMouseEnter(event); else handlers?.onMouseMove(event);
        }}
        onPeekLeave={() => peek?.chipProps({ ...route, item_id: '' }).onMouseLeave?.()}
        remember={remember} onFocus={setFocusKey} onKeyDown={keys} onSelect={select} onToggle={toggleItem} />)}
      {session && <AgentBin session={session} actions={actions} topicId={row.topic.id} onRemove={onRemove} />}
    </div>; })}
  </div></ItemRefs.Provider></TreeFonts.Provider>;

  const loading = !session && state.status === 'loading';
  // Stopped deliveries answered on a row the owner can see; the recovery banner lists the rest
  // (none in the graph, which has no rows; a filtered-out or folded row is not here).
  const inline: ReadonlySet<string> = new Set(graph && !loading ? [] : rows.flatMap(row => row.delivery?.stuck ? [row.delivery.stuck.input.id] : []));
  const filtersShown = !archivedMode;
  const counts = model?.counts ?? { all: 0, waiting: 0, open: 0, progress: 0, closed: 0 };
  const queryText = query.trim();
  let body: ReactNode;
  if (loading) {
    body = <div className="tree-loading" aria-busy="true">
      {SKELETON.map((row, index) => <div key={index} className="tree-skeleton" style={{ paddingLeft: row.pad, paddingTop: row.top }}>
        <span className="tree-skeleton-dot" /><span className="tree-skeleton-bar" style={{ width: row.width }} />
        <span className="tree-skeleton-badge" style={{ width: row.badge }} /></div>)}
      <div className="tree-loading-text" role="status"><i className="ph ph-circle-notch" />Reading the session…</div>
    </div>;
  } else if (graph) body = null;
  else if (model?.empty && !archivedMode) {
    body = <div className="tree-empty" role="status">
      <i className="ph ph-spiral" />
      <div className="tree-empty-title">No items yet</div>
      <p>Ariadne is following this session. Questions, decisions and findings appear here as the agent writes them, grouped by topic.</p>
      <div className="tree-empty-connection" data-running={running || undefined}><span className="tree-run-dot" />
        {running ? `Connected to ${bar?.agent ?? 'the agent'}${bar?.where ? ` in ${bar.where}` : ''} · waiting for the agent’s first message`
          : `${bar?.agent ?? 'The agent'} is not running · items appear when it writes`}</div>
    </div>;
  } else if (model?.noMatch) {
    body = <div className="tree-no-match">
      <div className="tree-no-match-title">{queryText ? `Nothing matches “${queryText}”.` : 'No items match these filters.'}</div>
      <button type="button" className="btn btn-secondary" onClick={onClearFilters}>Clear search and filters</button>
    </div>;
  } else if (model && archivedMode && !rows.length) {
    body = <div className="tree-no-match"><div className="tree-no-match-title">No archived topics in this session.</div></div>;
  } else body = tree;

  const selectedTag = !graph && <div className="tree-selected-slot" role="group" aria-label="Selected item navigation">
    {selectedEdge && selectedId && session?.items[selectedId] && <button type="button" className="tree-selected-edge" data-edge={selectedEdge}
      aria-label={`${selectedEdge === 'above' ? '↑' : '↓'} Selected: ${session.items[selectedId]!.question}`}
      title={`Reveal selected item · ⌘J · ${session.items[selectedId]!.question}`} onClick={() => revealSelected(true)}>
      <span>{selectedEdge === 'above' ? '↑' : '↓'} Selected:</span>{' '}
      <span className="tree-selected-label">{names.get(selectedId)}</span></button>}
  </div>;

  return <section className="tree-column" aria-label="Session tree" data-session-status={state.status} data-kbd={kbd || undefined}
    onKeyDownCapture={event => {
      // Window capture has already positioned the selection for Cmd+J. That
      // same event must not cancel the reveal before its preview reflows.
      const retainedJump = event.defaultPrevented && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j';
      if (!retainedJump) releaseReveal();
      if (!kbd) setKbd(true);
    }}
    onPointerDownCapture={releaseReveal} onWheelCapture={releaseReveal}
    onMouseDownCapture={() => { if (kbd) setKbd(false); }}>
    <span role="status" className="tree-unseen-announcement">{noUnseen ? 'No unseen items.' : ''}</span>
    {bar && !archivedMode && <SessionBar bar={bar} busy={lifecycle.busy || !session} onClose={lifecycle.session}
      onRename={session ? lifecycle.rename : undefined}
      dispatch={<DispatchChip actions={actions} onDetails={() => setSending(true)} />} />}
    {session && !archivedMode && !graph && <div className="tree-recent"><RecentTrail session={session} entries={view?.recent_items}
      nextWaiting={oldestWaiting(session)} onReveal={id => select(id, false)} />
      <button type="button" className="btn btn-ghost" title="Recent (⌘E)" onClick={() => setRecentOpen(true)}>Recent</button></div>}
    {session && recentOpen && <RecentDialog session={session} entries={view?.recent_items}
      seen={seen}
      onReveal={id => select(id, false)} onClose={() => setRecentOpen(false)} />}
    {sending && <DispatchDialog store={actions.session} actions={actions} agent={bar?.agent ?? 'the agent'} onClose={() => setSending(false)} />}
    {filtersShown && <FilterBar chips={model?.chips ?? chipsOf([])} counts={counts}
      disabled={nav.pendingOperationId !== null && !nav.writing} dismissKey={route.session_id} onChip={setChip}>{selectedTag}</FilterBar>}
    {!filtersShown && !graph && <div className="tree-filters">{selectedTag}</div>}
    {focusedId && !graph && <Banner icon="ph ph-tree-structure" actions={<button type="button" className="btn btn-ghost" aria-label="Leave Focus" disabled={viewBusy} onClick={() => focusBranch(null)}>×</button>}>
      Focused: {names.get(focusedId)}</Banner>}
    {model && !graph && (!!query || !model.chips.has('all')) && <Banner icon={query ? 'ph ph-magnifying-glass' : 'ph ph-funnel'} actions={<><span aria-hidden="true">·</span><button type="button" className="btn btn-ghost" disabled={nav.writing || nav.pendingOperationId !== null} onClick={query ? onClearSearch : onClearFilters}>{query ? 'Clear search' : 'Clear filters'}</button></>}>
      Showing {model.searchCount} of {model.itemCount} items{query ? ` matching “${query}”` : ''}{model.hiddenCount > 0 ? ` (${model.hiddenCount} hidden)` : ''}{!model.chips.has('all') ? ' in the statuses you picked' : ''}</Banner>}
    {model?.outside && <Banner icon="ph ph-funnel" actions={<button type="button" className="btn btn-ghost" onClick={resume}>Resume filtered view</button>}>
      Showing an item outside your current filters.</Banner>}
    {lifecycle.pending && <Banner icon="ph ph-warning" alert actions={<button type="button" className="btn btn-ghost" onClick={lifecycle.reconcile}>Check again</button>}>
      {lifecycle.pending}. Check whether your last change was saved before making another.</Banner>}
    <InlineRecovery.Provider value={inline}>{notices}</InlineRecovery.Provider>
    {/* The graph keeps its own scroller so its legend stays sticky (ui/graph/graph.css). */}
    {graph && !loading ? graph : <div className="tree-scroll-shell">
      <nav className="tree-breadcrumb" aria-label="Map ancestors">{breadcrumb.map((id, index) => <span key={id}>
        {index > 0 && <span aria-hidden="true"> › </span>}<button type="button" title={session?.items[id]?.question} onClick={() => select(id, false)}>{names.get(id)}</button>
      </span>)}</nav>
      <div ref={scroller} className="tree-scroll" onScroll={() => {
        // At the held scrollTop this can be our own correction's delayed event;
        // remembering restores any intervening reflow before capturing again.
        if (held.current?.scrollTop !== scroller.current?.scrollTop) revealedAnchor.current = null;
        openingPlacement.current = null; settled.current = true; remembering(); updateEdge();
      }}>{body}</div>
    </div>}
    {session && <AgentBin session={session} actions={actions} onRemove={onRemove} />}
    {lifecycle.dialog}
    {continuing && <ContinuePicker topicName={session?.topics[continuing]?.name ?? 'this topic'} targets={continueTargets(route, summaries)}
      onCancel={() => setContinuing(null)}
      onPick={target => { setContinuing(null); openContinueTopic({ source: route, topicId: continuing, target }); }} />}
  </section>;
}
