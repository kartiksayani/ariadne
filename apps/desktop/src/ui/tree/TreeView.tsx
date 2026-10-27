import { binView } from '../remove/AgentBin';
import { BinDialog } from '../remove/BinDialog';
import { archiveRequests } from '../remove/requests';
import { toasts } from '../shell/toast';
import { activeItems, itemRemoved, removedRoots, removedSubtree } from '../../selectors/removed';
// The session tree column (handoff "Session tree"): session bar, status menu,
// banners, topic bands and item rows, with the tree keyboard
// and the empty and loading states. Selection, expansion, topic folds and filters
// persist through navigation's preference writer.
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { OwnFailure, plainFailure, useSession, type Immutable, type SessionStore } from '../../data';
import type { RevealedItem } from '../../data/routes';
import type { ItemRoute, SessionPreferences } from '../../generated/core';
import type { SessionSummary } from '../../generated/domain/models';
import { NavigationStore, useNavigation } from '../../state/navigation/store';
import { useViewEdits, viewEditsFor, type ViewChange, type ViewSubject } from '../../state/navigation/viewEdits';
import { useReadingSeen } from '../../state/preferences/reading';
import { OwnerDraftStore, useOwnerDrafts } from '../../state/drafts/store';
import { useSessionActions, type SessionActions } from '../../components/bindings/actions';
import { useSupervisorHealth } from '../../components/bindings/health';
import { useWorkspaceKeys, type WorkspaceIntent } from '../keys';
import { useIntents } from '../intents';
import { notices as noticeStore } from '../pages/notices';
import { collapsedNote, mapChanges, nextMarkedItem, parentKey, sessionBar, stripAnchorFor, treeModel, type ItemRow as ItemRowModel, type Row, type SearchReveal, type StripRow } from './model';
import { alsoMatching, matchCount, searchTerms, type MapMatch } from '../../selectors/tree/search';
import { MapSearchContext, type MapSearch, type MapSearchStatus } from './mapSearch';
import { Keycap } from '../parts/parts';
import { Strip } from './Strip';
import { hiddenGroupKey, hiddenGroupsFor, hiddenSource } from './hidden';
import { ackHoldFor, ackTarget, useAckHeld } from '../shared/ack';
import { useLatest } from '../shared/latest';
import { ItemRow, type RowCommand } from './ItemRow';
import { TopicRow, type BandSlots, type TopicAction } from './TopicRow';
import { ContinueButton } from './band/ContinueButton';
import { FocusButton } from './band/FocusButton';
import { NextUnseen } from './band/NextUnseen';
import { ChangesOpener } from '../changes/ChangesOpener';
import { TopicMenu } from './band/TopicMenu';
import type { OpenTopicInDetails } from '../shell/detailTarget';
import { Banner } from './Banner';
import { FilterRow, chipLabel, type HiddenNote } from './FilterRow';
import { DrawnHiddenContext } from '../graph/drawnHidden';
import { useLocalChips } from './useLocalChips';
import { useArchiveBridge } from './archiveBridge';
import { chipCounts, filterActive, filterOf, filterSignature, hiddenChipCounts, hiddenMatchIds, isLocalChip, pickedChips, savedChipEdit, summaryCounts, toggleLocalChip, type Chip, type FilterScope } from '../../selectors/tree/filter';
import { useSessionLifecycleFor } from '../shared/SessionLifecycleOwner';
import { ConnectionLineShown } from '../shared/connection';
import { UnreadableMap } from './UnreadableMap';
import { ItemRefs } from '../shared/MarkdownText';
import { shortLabel } from '../shared/short';
import { peekNames } from '../peek/names';
import { nearestDelta, openingTop, type BackPill } from './scroll';
import { keyStopsLanding, landingMoves, reachable, startLanding, WheelStream, type Landing } from '../shared/landing';
import { useDockInset } from '../shell/dockInset';
import { displayStatus } from '../../selectors/waiting/replied';
import { sessionAnswerBlocked } from '../../selectors/sessionClosed';
import { useUnfolded } from './unfold';
import type { RemoveTarget } from '../dialogs/remove';
import { openContinueTopic } from '../dialogs/ContinueTopicDialog';
import { RemovalContext, useHidden } from '../remove/queue';
import { hiddenKey, placeStrips, subtree, visibleSession } from '../remove/model';
import { hideViews, selectionAfterHide, shownItems, type HideMove } from './hideMove';
import { useFilterFolds } from '../shared/filterFolds';
import { isViewConflict } from '../shared/conflictNotice';
import { TreeFonts, useTreeFonts } from './fonts';
import { branchItems } from './gettingAround';
import { usePeek } from '../peek/Peek';
import { navigationVisits } from '../navigation/visits';
import { AckAll } from '../navigation/AckAll';
import { ackAllItems } from '../navigation/ackAllController';
import './tree.css';
import './tree-rows.css';
import './tree-boxes.css';
import './tree-band.css';
import './tree-filter.css';

export type RowIntent = 'bring' | 'reply' | 'drop' | 'note' | 'followup' | 'reopen' | 'later' | 'hide';
export interface TreeViewProps {
  readonly navigation: NavigationStore;
  readonly store: SessionStore;
  readonly actions: SessionActions;
  readonly drafts: OwnerDraftStore;
  /** The header search as typed. */
  readonly query: string;
  readonly filterOpen?: boolean;
  /** Clear in the chip row also closes it (SPEC 6.10). */
  readonly onCloseFilter?: () => void;
  /** An item revealed from a link or the waiting panel; null once dismissed. */
  readonly reveal: RevealedItem | null;
  /** The latest Back/Forward reveal; retained alongside ordinary external reveals. */
  readonly historyReveal?: RevealedItem | null;
  readonly selectedId: string | null;
  readonly detailOpen: boolean;
  /** Conversation covers the retained tree; its global shortcuts pause until Map returns. */
  readonly covered?: boolean;
  /** The bigger view's item while it covers the tree: Focus (⇧F) and Continue (c) act on it, not the Map's selection. */
  readonly actingId?: string | null;
  /** Shows an item picked from Recent while the bigger view covers the tree (it leaves the bigger view). */
  readonly onOpenItem?: (itemId: string) => void;
  /** "Reply to topic" and an Edit on a stuck topic reply open Details on the topic (alpha.21 E6). */
  readonly onOpenTopic?: OpenTopicInDetails;
  /** Graph content shown in place of the rows. */
  readonly graph?: ReactNode;
  /** Notices above the rows: stale data, recovery. */
  readonly notices?: ReactNode;
  readonly summaries: readonly Immutable<SessionSummary>[];
  readonly now?: () => number;
  /** The tree selected an item; restoration preserves the current detail state. */
  readonly onSelected: (result: RevealedItem, openDetail?: boolean) => void;
  readonly onDismissReveal: () => void;
  /** The owner ended this reveal's "outside your filter" notice from the Graph (a fold or unfold); the Map still draws the item. */
  readonly bannerDismissed?: boolean;
  /** "Hide it again" on the outside-filter notice: drop the reveal and close its detail. */
  readonly onResume: () => void;
  readonly onAct: (intent: RowIntent, target: ItemRoute, onReveal?: (result: RevealedItem) => void) => void;
  readonly onClearFilters: () => void;
  /** Clears the header search (the search's own ×, esc, or MapSearch.clear). */
  readonly onClearSearch?: () => void;
  /** The top bar's count, arrows and "Also matching" note while a search is on; null when it is off or the Map goes. */
  readonly onSearchStatus?: (status: MapSearchStatus | null) => void;
  readonly onShowArchive: () => void;
  /** Asks to remove an item (and everything below it) or a topic: row trash, topic Remove, ⌫/Delete. */
  readonly onRemove: (target: Extract<RemoveTarget, { kind: 'item' | 'topic' }>) => void;
}

/** Most folded topics a session view keeps (the saved `collapsed_topic_ids` bound); the oldest folds drop first. */
const FOLDS_KEPT = 256;
/** How long a clicked row waits for an in-flight automatic Recent save before it opens regardless. */
const RECENT_WAIT_MS = 1000;
// A row ending at the sticky edge can peek out by a sub-pixel without being the reading row.
const READING_EDGE_CLEARANCE = 1;
const NO_ROWS: readonly Row[] = Object.freeze([]);
const NO_MATCHES: readonly MapMatch[] = Object.freeze([]);
/** A saved reading offset, or the initial selection centred while the view loads. */
interface Anchor { readonly key: string; readonly offset: number | null }
const SKELETON = [
  { pad: 12, width: '38%', badge: 0, top: 16 }, { pad: 36, width: '64%', badge: 64, top: 12 }, { pad: 36, width: '52%', badge: 64, top: 12 },
  { pad: 60, width: '58%', badge: 84, top: 12 }, { pad: 36, width: '70%', badge: 64, top: 12 }, { pad: 12, width: '30%', badge: 0, top: 24 },
  { pad: 36, width: '60%', badge: 64, top: 12 }, { pad: 60, width: '48%', badge: 96, top: 12 },
];

export function TreeView(props: TreeViewProps) {
  const { navigation, store, actions, drafts, query, reveal, selectedId, detailOpen, covered = false, graph, notices,
    summaries, onSelected, onDismissReveal, bannerDismissed = false, onResume, onAct, onClearFilters, onShowArchive,
    onRemove } = props;
  const state = useSession(store), raw = state.snapshot?.session ?? null;
  const fontEpoch = useTreeFonts();
  const peek = usePeek();
  const nav = useNavigation(navigation), preferences = nav.preferences;
  const route = state.route;
  // Rows of a pending removal are gone at once; Undo brings them back.
  const hidden = useHidden();
  const session = useMemo(() => raw && visibleSession(raw, route, hidden), [raw, route, hidden]);
  const savedView = preferences?.sessions.find(value => value.session.project_id === route.project_id && value.session.session_id === route.session_id) ?? null;
  // The session's effective view (E12): the saved view plus its queued and in-flight edits, kept per session outside the Map,
  // so a Map drawn again before a write settles shows what the owner chose.
  const edits = viewEditsFor(navigation), editsVersion = useViewEdits(edits, route);
  const view = useMemo(() => edits.view(route, savedView), [edits, route, savedView, editsVersion]);
  // The graph has its own optimistic node edits; both mounted views use its saved
  // status scope while the tree's filter queue waits for persistence.
  // The composed graph reads saved statuses; both views must share the same fold scope during writes.
  const localChips = useLocalChips(route.session_id);
  const foldView = graph ? savedView : view;
  const filterKey = foldView ? filterSignature({ view: foldView, local: localChips.chips }) : undefined;
  const filterFolds = useFilterFolds(navigation.routes, route, filterKey);
  const viewBusy = nav.writing || nav.pendingOperationId !== null;
  const focusDisabled = viewBusy && !navigation.isRecentPending();
  const archivedMode = view?.filters.archived ?? false;
  // The strip is on screen (Archive mode and the closed funnel suppress it); the filter's reveal lives only while it is.
  const filtersShown = !archivedMode && (props.filterOpen ?? true);
  const savedLater = preferences?.later;
  const later = useMemo(() => new Set(savedLater?.filter(item => item.project_id === route.project_id && item.session_id === route.session_id)
    .map(item => item.item_id) ?? []), [savedLater, route.project_id, route.session_id]);
  const savedFolds = view?.collapsed_topic_ids;
  const closedTopics = useMemo(() => new Set(savedFolds ?? []), [savedFolds]);
  const [expandedHiddenGroups, setExpandedHiddenGroups] = useState<ReadonlySet<string>>(new Set());
  // Search in place (SPEC §6.9). "Show them" opens the way to hidden and folded matches in memory until the search clears;
  // the current match is the first until the owner steps (or shows them), then the one stepped to.
  const terms = useMemo(() => searchTerms(query), [query]);
  const termsKey = terms.join(' ');
  const [searchShown, setSearchShown] = useState<SearchReveal | null>(null);
  const [searchCurrent, setSearchCurrent] = useState<MapMatch | null>(null);
  const [stepped, setStepped] = useState(0);
  const searchScroll = useRef<string | null>(null);
  useLayoutEffect(() => { setSearchCurrent(null); if (!termsKey) setSearchShown(null); }, [termsKey]);
  useLayoutEffect(() => { setSearchCurrent(null); setSearchShown(null); }, [route.project_id, route.session_id]);
  // The filter strip's "Show them" (alpha.24) opens the way to hidden matches in memory, as the search does, but in a set of its own
  // so neither clears the other. It ends with the session, any change of the filter (picked chips, owners, hide-later, archive), Clear
  // and the strip closing (its "Hide them" goes with it).
  const [filterShown, setFilterShown] = useState<SearchReveal | null>(null);
  useLayoutEffect(() => { setFilterShown(null); }, [route.project_id, route.session_id, filterKey, filtersShown]);
  // The hidden items the Graph draws, as it reports them (drawnHidden.ts): the strip's Graph note leaves them out.
  const [graphHidden, setGraphHidden] = useState<ReadonlySet<string> | null>(null);
  const reportGraphHidden = useCallback((ids: readonly string[] | null) => setGraphHidden(ids ? new Set(ids) : null), []);
  const [focusKey, setFocusKey] = useState<string | null>(selectedId);
  const [nextTarget, setNextTarget] = useState<{ readonly id: string; readonly step: number } | null>(null);
  const [nextRevealId, setNextRevealId] = useState<string | null>(null);
  const [nextPulse, setNextPulse] = useState(false);
  const [noUnseen, setNoUnseen] = useState(false);
  const nextScroll = useRef<string | null>(null);
  const seen = useReadingSeen(navigation.reading, preferences, route);
  const changes = useMemo(() => session ? mapChanges(session, seen) : null, [session, seen]);
  const [kbd, setKbd] = useState(false);
  /** The owner's last move here was a key, not the pointer: a selection it causes keeps the focus ring (R9). */
  const keyboardIntent = useRef(false);
  useEffect(() => {
    // A press or click anywhere is the pointer's: Details' links and the Graph's nodes included. (A row's Enter is a key, no click.)
    const pointer = () => { keyboardIntent.current = false; };
    document.addEventListener('mousedown', pointer, true);
    document.addEventListener('click', pointer, true);
    return () => { document.removeEventListener('mousedown', pointer, true); document.removeEventListener('click', pointer, true); };
  }, []);
  useEffect(() => navigationVisits.bind(navigation), [navigation]);
  useOwnerDrafts(drafts, raw);
  const lifecycle = useSessionLifecycleFor(actions);
  // A row's Ack and the `a` key start a 6 s hold in the session's hold store; the store saves it, or drops it on Undo.
  const hold = useMemo(() => ackHoldFor(route.session_id, actions), [route.session_id, actions]);
  const ackHeld = useAckHeld(route.session_id);
  const runAck = (itemId: string) => { const item = session?.items[itemId]; if (item) hold.ack(item); };
  const noticeCallbacks = useRef({ lifecycle, onShowArchive });
  noticeCallbacks.current = { lifecycle, onShowArchive };
  // E33: an archive leaves one strip in the topic's place with Undo, until Undo or a session switch, and a toast whose Undo
  // lasts as long as the strip does.
  const archivedNotice = lifecycle.archived;
  useEffect(() => {
    if (!archivedNotice) return undefined;
    const toast = toasts.show({ text: `Archived “${archivedNotice.name}”. It’s in Archive with all its history.`,
      undo: () => { if (!noticeCallbacks.current.lifecycle.busy) noticeCallbacks.current.lifecycle.undo(); } });
    return () => { toasts.expire(toast); };
  }, [archivedNotice]);
  // "Archive instead" in the Remove-topic dialog opens this session's Archive dialog for that topic.
  useEffect(() => archiveRequests.subscribe(request => {
    if (request.route.project_id === route.project_id && request.route.session_id === route.session_id) noticeCallbacks.current.lifecycle.archive(request.topicId);
  }), [route.project_id, route.session_id]);
  const actionState = useSessionActions(actions);
  const controllerFailure = !actionState.pending && isViewConflict(actionState.error) ? plainFailure(actionState.error) : null;
  const lifecycleNotice = lifecycle.reviewing || lifecycle.error === controllerFailure ? null : lifecycle.error;
  const lifecycleNoticeId = JSON.stringify(['tree-lifecycle', route.project_id, route.session_id]);
  useEffect(() => () => noticeStore.dismiss(lifecycleNoticeId), [lifecycleNoticeId]);
  useEffect(() => {
    if (!lifecycleNotice) { noticeStore.dismiss(lifecycleNoticeId); return; }
    noticeStore.push({ id: lifecycleNoticeId, icon: 'ph ph-warning-circle', tone: 'problem', text: lifecycleNotice });
  }, [lifecycleNoticeId, lifecycleNotice]);
  const elements = useRef(new Map<string, HTMLDivElement>()), scroller = useRef<HTMLDivElement>(null);
  const scrollRequested = useRef<string | null>(null);
  /** A row the app brought into view, held at `offset` below the reading edge while the scroller stays at `scrollTop` (or moves only by the hold's own correction). */
  const revealedAnchor = useRef<{ readonly key: string; readonly offset: number; readonly scrollTop: number } | null>(null);
  const focusRequested = useRef<string | null>(null);
  /** Set by a hide's move (or its Undo's) for the commit that shows it: nothing in that commit scrolls or takes focus for it. */
  const hideMove = useRef(false);
  /**
   * The hide commit's hold (S10): the nearest row above the hidden row, at its offset below the reading edge, so the rows above
   * stay still and the hidden row's space closes from below. A null key keeps the scroll position (nothing above it). `window`:
   * the offset is a window top instead (a hide that ends Focus, see `presentMove`).
   */
  const hideHold = useRef<{ readonly key: string | null; readonly offset: number; readonly window?: boolean } | null>(null);
  /** The landing on its way (alpha.24 P3): the row ⌘[ / ⌘] or `n` is bringing into view over a few frames (see `land`). */
  const landing = useRef<{ readonly key: string; readonly run: Landing } | null>(null);
  /** Stops a landing where it is: it retains nothing (Q7). */
  const stopLanding = () => { const current = landing.current; landing.current = null; current?.run.cancel(); };
  /** The wheel events over the Map, so a swipe's own trailing momentum never stops the landing the swipe started. */
  const wheels = useRef(new WheelStream()).current;
  const mounted = useRef(true), request = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++request.current; }; }, [store]);
  // Unmounting or swapping the rows for the graph leaves no row to fire mouseleave.

  const minute = Math.floor((props.now ?? Date.now)() / 60_000) * 60_000;
  const binding = session?.active_binding_id ? session.bindings[session.active_binding_id] ?? null : null;
  const presence = binding ? state.presence[binding.id] ?? null : null;
  const health = useSupervisorHealth(actions.service, binding?.id, binding?.generation);
  const revealId = reveal?.kind === 'item' ? reveal.route.item_id : null;
  const temporary = reveal?.kind === 'item' ? reveal.temporaryExpandedItemIds : null;
  const focusedItem = view?.focused_item_id ? raw?.items[view.focused_item_id] : null;
  const focusedId = view?.focused_item_id && (!raw || (focusedItem && !focusedItem.parent && !itemRemoved(raw, focusedItem.id))) ? view.focused_item_id : null;
  // The one filter of the Map (D17): the saved chips in the view, the local chips beside it. The Tree and the Graph read this scope.
  const scope = useMemo<FilterScope | null>(() => session && view ? { session, view, later, local: localChips.chips } : null,
    [session, view, later, localChips.chips]);
  const filter = useMemo(() => scope ? filterOf(scope) : null, [scope]);
  // E29: a strip stands where removed (in the Undo window), agent-removed (in the bin) and just-archived rows were.
  const removals = useContext(RemovalContext);
  // The owner's archive receipt lands with the session read that drops the topic, a render before the lifecycle keeps its
  // Undo (E12). Its strip stands from that render on, so the topic and its strip change places in one commit and the hold
  // hands the reading row to the strip, not to a row above. Once the lifecycle has kept it, that receipt bridges no more; a
  // receipt from before this visit to the session (a switch back, a return from a page) never bridges.
  const archivedTopic = useArchiveBridge(actionState, lifecycle.archived, raw, `${route.project_id}/${route.session_id}`);
  const places = useMemo(() => raw ? placeStrips(raw, route, hidden, archivedMode ? null : archivedTopic, archivedMode) : [],
    [raw, route, hidden, archivedTopic, archivedMode]);
  const onPlace = (row: StripRow) => {
    const place = row.place;
    if (!place) return;
    if (place.reason === 'removed') removals?.undoKey(place.itemId ? hiddenKey.item(route, place.itemId) : hiddenKey.topic(route, place.topicId));
    else if (place.reason === 'archived') { if (!lifecycle.busy) lifecycle.undo(); }
    else binView.reveal(route, place.itemId ? place.topicId : null);
  };
  // The last rows drawn: a rebuilt row that draws the same is that row again, so its memoised ItemRow does not redraw (F6c).
  const drawnRows = useRef<readonly Row[]>(NO_ROWS);
  const model = useMemo(() => session && view && filter ? treeModel({ session, view, filter, focusRootId: focusedId, ackHeld, search: query, searchShown, filterShown, later, collapsedTopics: closedTopics, selectedId, revealId,
    filterCollapsedItemIds: filterFolds.items, filterCollapsedTopicIds: filterFolds.topics,
    attentionRevealId: nextRevealId, expandedHiddenGroups, temporaryExpanded: temporary ?? [], presence, health, summaries, now: minute, places, previous: drawnRows.current }) : null,
  [session, view, filter, focusedId, ackHeld, query, searchShown, filterShown, expandedHiddenGroups, later, closedTopics, filterFolds.items, filterFolds.topics, selectedId, revealId, temporary, nextRevealId, presence, health, summaries, minute, places]);
  const summary = summaries.find(value => value.project_id === route.project_id && value.session_id === route.session_id) ?? null;
  const bar = sessionBar(session, summary, presence);
  const focusedBranch = useMemo(() => session && focusedId ? branchItems(session, focusedId) : null, [session, focusedId]);
  const rows = model?.rows ?? NO_ROWS;
  if (model) drawnRows.current = rows;
  // Every mounted item row would draw "✓ Acked · Undo" for a held Ack. Say so to the hold: a row folded away, filtered out or
  // gone with the Graph leaves the Undo to a notice (D11).
  const drawnItems = useMemo(() => graph ? '' : rows.flatMap(row => row.kind === 'item' ? [row.key] : []).join('\n'), [rows, graph]);
  useEffect(() => hold.showing(drawnItems ? drawnItems.split('\n') : []), [hold, drawnItems]);
  const names = useMemo(() => session ? peekNames(session) : new Map<string, string>(), [session]);
  const sections = useMemo(() => {
    const groups: ({ topic: Extract<Row, { kind: 'topic' }>; items: Exclude<Row, { kind: 'topic' }> [] } | { topic: null; place: StripRow })[] = [];
    for (const row of rows) {
      if (row.kind === 'topic') groups.push({ topic: row, items: [] });
      // A whole topic's strip stands in the topic's place, between topics.
      else if (row.kind === 'strip' && row.place && !row.place.itemId) groups.push({ topic: null, place: row });
      else { const last = groups.at(-1); if (last?.topic) last.items.push(row); }
    }
    return groups;
  }, [rows]);
  const latest = useRef({ view, preferences, rows, session, selectedId, focusedId });
  latest.current = { view, preferences, rows, session, selectedId, focusedId };

  // ------------------------------------------------------------ search in place
  // The count runs over the matches on the rows the owner can see, field by field, in Map order.
  // With no search the list is one shared empty list, so the search context stays the same object (F6d).
  const matches = useMemo(() => terms.length ? rows.flatMap(row => row.kind === 'item' ? row.matches.map(field => ({ id: row.key, field })) : []) : NO_MATCHES,
    [rows, terms]);
  const pinnedIndex = searchCurrent ? matches.findIndex(match => match.id === searchCurrent.id && match.field === searchCurrent.field) : -1;
  const matchIndex = Math.max(0, pinnedIndex), currentMatch = matches[matchIndex] ?? null;
  // Show more / Show less on a long question or preview: one flag per item opens both.
  const { isUnfolded, toggle: toggleUnfolded, open: openUnfolded } = useUnfolded(route.project_id, route.session_id);
  const stepSearch = (by: 1 | -1) => {
    if (!matches.length) return;
    const next = matches[(matchIndex + by + matches.length) % matches.length]!;
    setSearchCurrent(next); setStepped(value => value + 1);
    // A match on a folded row unfolds it, so the stepped word is on screen.
    openUnfolded(next.id);
    searchScroll.current = next.id;
    peek?.closeAll();
  };
  const showMatches = () => {
    const reveal = model?.search.reveal;
    if (!reveal || !reveal.items.length && !reveal.topics.length && !reveal.groups.length) return;
    setSearchCurrent(currentMatch);
    // Matches outside the focus are shown by leaving it.
    if (model?.search.outsideFocus) focusBranch(null);
    const join = (a: readonly string[] = [], b: readonly string[]) => [...new Set([...a, ...b])];
    setSearchShown(previous => ({ items: join(previous?.items, reveal.items), topics: join(previous?.topics, reveal.topics), groups: join(previous?.groups, reveal.groups) }));
  };
  const searchActions = useRef({ stepSearch, showMatches, clear: props.onClearSearch });
  searchActions.current = { stepSearch, showMatches, clear: props.onClearSearch };
  const hiddenMatches = terms.length ? model?.search.hidden ?? 0 : 0, collapsedMatches = terms.length ? model?.search.collapsed ?? 0 : 0;
  const mapSearch = useMemo<MapSearch>(() => ({ query: query.trim(), terms, matches, ids: new Set(matches.map(match => match.id)), current: currentMatch,
    stepped, hidden: hiddenMatches, collapsed: collapsedMatches, step: by => searchActions.current.stepSearch(by),
    showThem: () => searchActions.current.showMatches(), clear: () => searchActions.current.clear?.() }),
  [query, terms, matches, currentMatch, stepped, hiddenMatches, collapsedMatches]);
  const searchCount = terms.length ? matchCount(matchIndex, matches.length) : null;
  const outsideFocusMatches = terms.length ? model?.search.outsideFocus ?? 0 : 0;
  const searchNote = terms.length ? alsoMatching(hiddenMatches, collapsedMatches, outsideFocusMatches) : null;
  const onSearchStatus = props.onSearchStatus;
  useEffect(() => {
    onSearchStatus?.(searchCount === null ? null : { count: searchCount, onNext: () => searchActions.current.stepSearch(1), onPrev: () => searchActions.current.stepSearch(-1),
      note: searchNote ? { text: searchNote, action: 'Show them', onAction: () => searchActions.current.showMatches() } : null });
  }, [onSearchStatus, searchCount, searchNote]);
  useEffect(() => () => onSearchStatus?.(null), [onSearchStatus]);

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
  /** Folding a row "Show them" opened folds it: it leaves the search's in-memory reveal too. */
  const unshow = (kind: keyof SearchReveal, id: string) => {
    const without = (previous: SearchReveal | null) => previous?.[kind].includes(id)
      ? { ...previous, [kind]: previous[kind].filter(value => value !== id) } : previous;
    setSearchShown(without); setFilterShown(without);
  };
  const toggleHiddenGroup = (key: string) => {
    setNextRevealId(null);
    onDismissReveal();
    const open = expandedHiddenGroups.has(key) || !!searchShown?.groups.includes(key) || !!filterShown?.groups.includes(key);
    if (open) unshow('groups', key);
    setExpandedHiddenGroups(previous => {
      const next = new Set(previous);
      if (open) next.delete(key); else next.add(key);
      return next;
    });
  };
  /** A hidden strip opens or closes every hidden run under its parent. */
  const toggleStrip = (row: StripRow) => toggleHiddenGroup(hiddenGroupKey(row.topicId, row.parent));
  /** Hide or Unhide (`x`, the row's button): the App runs every hide path through one rule (alpha.24), asking this view (below). */
  const hideItem = (row: ItemRowModel) => { onAct('hide', { ...route, item_id: row.item.id }); };
  /**
   * The Map's rows as it will show `after` (the saved view a hide or its Undo writes), with `selected` and `revealed` as given: the
   * view on screen with `after`'s hidden items and Focus, or `after` itself for a session with no view yet.
   */
  const projectRows = (after: Immutable<SessionPreferences>, selected: string | null, revealed: string | null): readonly Row[] | null => {
    if (!session) return null;
    const next: Immutable<SessionPreferences> = { ...view ?? after, hidden_item_ids: after.hidden_item_ids ?? [], focused_item_id: after.focused_item_id };
    const focus = after.focused_item_id ? session.items[after.focused_item_id] : undefined;
    return treeModel({ session, view: next, filter: filterOf({ session, view: next, later, local: localChips.chips }),
      focusRootId: focus && !focus.parent && !itemRemoved(session, focus.id) ? focus.id : null, ackHeld, search: query, searchShown, filterShown, later,
      collapsedTopics: closedTopics, selectedId: selected, revealId: revealed, filterCollapsedItemIds: filterFolds.items,
      filterCollapsedTopicIds: filterFolds.topics, attentionRevealId: nextRevealId, expandedHiddenGroups, temporaryExpanded: temporary ?? [],
      presence, health, summaries, now: minute, places }).rows;
  };
  /** The Map as it will show once `itemId` is hidden (`after`: the saved view with the hide), and the item the rule selects in it. */
  const chooseAfterHide = useLatest((itemId: string, after: Immutable<SessionPreferences>) => {
    if (!session) return null;
    const going = new Set(subtree(session, itemId).map(item => item.id));
    const stays = (id: string | null | undefined) => id && !going.has(id) ? id : null;
    const rows = projectRows(after, stays(selectedId), stays(revealId));
    return rows && selectionAfterHide(session, itemId, shownItems(rows));
  });
  /** The nearest row above `itemId`'s, at its offset below the reading edge, while the row is on screen below the band. */
  const holdAbove = (itemId: string): { readonly key: string | null; readonly offset: number } | null => {
    const box = scroller.current, element = elements.current.get(itemId), rect = element?.getBoundingClientRect();
    if (!box || !rect) return null;
    const top = readingTop();
    // A row above the window (a Details or Graph hide) or below it changes nothing on screen: the reading row holds, as before.
    if (rect.bottom <= top + READING_EDGE_CLEARANCE || rect.top >= visibleBottom(box)) return null;
    const list = latest.current.rows, at = list.findIndex(row => row.key === itemId);
    for (let index = at - 1; index >= 0; index--) {
      const row = list[index]!, above = row.kind === 'topic' ? undefined : elements.current.get(row.key);
      if (above) return { key: row.key, offset: above.getBoundingClientRect().top - top };
    }
    return { key: null, offset: 0 };
  };
  /**
   * Where an unhidden item comes back (`rows`: the Map once it shows again): the nearest row on screen above that place holds its
   * offset below the reading edge, so the rows above stay and the rows below make room. A place above or below the window changes
   * nothing on screen: the reading row holds, as before. With no row above it, the scroll position stays at the top.
   */
  const holdBack = (itemId: string, rows: readonly Row[]): { readonly key: string | null; readonly offset: number } | null => {
    const box = scroller.current, at = rows.findIndex(row => row.key === itemId);
    if (!box || at < 0) return null;
    const top = readingTop();
    for (let index = at - 1; index >= 0; index--) {
      const row = rows[index]!, above = row.kind === 'topic' ? undefined : elements.current.get(row.key);
      if (!above) continue;
      const rect = above.getBoundingClientRect();
      return rect.bottom <= top + READING_EDGE_CLEARANCE || rect.top >= visibleBottom(box) ? null : { key: row.key, offset: rect.top - top };
    }
    return box.scrollTop < 1 ? { key: null, offset: 0 } : null;
  };
  /** A hide's move (or its Undo's), in the update that publishes its write: the reveal is this view's own, so nothing scrolls. */
  const presentMove = useLatest((move: HideMove) => {
    // Any hide or Undo stops a landing first, with a selection change or without one: the Map stays where it is (Q8).
    stopLanding();
    const next = move.own?.kind === 'item' ? move.own.route.item_id : null;
    const going = session ? subtree(session, move.itemId).map(item => item.id) : [move.itemId];
    const topic = session?.items[move.itemId]?.topic_id;
    if (move.kind === 'hide') {
      // A hide that ends Focus draws the other roots and topics again: the row it selects takes the hidden row's window place
      // (what comes back goes above it, off-screen), or with none selected the topic's band keeps its place.
      const ending = !!focusedId && going.includes(focusedId), place = elements.current.get(move.itemId)?.getBoundingClientRect().top;
      const band = topic ? elements.current.get(topic)?.getBoundingClientRect().top : undefined;
      hideHold.current = !ending ? holdAbove(move.itemId)
        : move.select && next && place !== undefined ? { key: next, offset: place, window: true }
        : topic && band !== undefined ? { key: topic, offset: band, window: true } : null;
    } else if (move.after) {
      // An Undo that brings Focus back is the hide's way back: the item takes the window place of the row its hide selected, or with
      // none selected the topic's band keeps its place. Any other unhide keeps the rows above where the item comes back still.
      const restoring = !!move.after.focused_item_id && move.after.focused_item_id !== focusedId;
      const place = restoring && selectedId ? elements.current.get(selectedId)?.getBoundingClientRect().top : undefined;
      const band = restoring && topic ? elements.current.get(topic)?.getBoundingClientRect().top : undefined;
      const rows = restoring ? null : projectRows(move.after, next ?? selectedId, revealId);
      hideHold.current = rows ? holdBack(move.itemId, rows)
        : place !== undefined ? { key: move.itemId, offset: place, window: true }
        : topic && band !== undefined ? { key: topic, offset: band, window: true } : null;
    }
    // A reveal held for the owner ends: the commit holds its own row, and a later scroll must not put the old one back.
    if (hideHold.current) revealedAnchor.current = null;
    if (!move.select) return;
    hideMove.current = true;
    clickedReveal.current = move.own;
    centered.current = true; settled.current = true; openingPlacement.current = null; setAnchor(null);
    scrollRequested.current = null; focusRequested.current = null;
    if (move.kind !== 'hide') return;
    // Focus follows only from a row that goes (R8); the roving focus goes to the new row, or the topic's row when none is selected.
    const hadFocus = going.some(id => !!elements.current.get(id)?.contains(document.activeElement));
    const to = next ?? (topic && elements.current.has(topic) ? topic : null);
    if (!to) return;
    setFocusKey(to);
    if (hadFocus) elements.current.get(to)?.focus({ preventScroll: true });
  });
  useEffect(() => {
    if (graph) return undefined;
    const answer = { route: { project_id: route.project_id, session_id: route.session_id }, choose: chooseAfterHide, present: presentMove };
    hideViews.add(answer);
    return () => { hideViews.delete(answer); };
  }, [graph, route.project_id, route.session_id, chooseAfterHide, presentMove]);

  // ------------------------------------------------------------ writes
  /**
   * Every owner view change. It queues in the session's edits store, which writes it once no other preferences write is
   * unsettled, rebased on the saved view then, after any edit queued before it. An unconfirmed Recent write is automatic and
   * the owner never waits on it; any other unconfirmed write is the owner's own and still refuses.
   */
  const saveView = (change: ViewChange, subject?: ViewSubject) => {
    const snapshot = navigation.getSnapshot();
    if (!latest.current.view || snapshot.pendingOperationId !== null && !snapshot.writing && !navigation.isRecentPending()) return Promise.resolve(false);
    return edits.queue(route, change, subject);
  };
  const clickedReveal = useRef<RevealedItem | null>(null);
  /** `loaded`: only the activation of a rendered row opens from the copy on screen; see RegisteredRoutes.revealLoaded. */
  const select = (id: string, fromRow = true, opening = false, options: { readonly loaded?: boolean } = {}) => {
    if (fromRow && viewBusy && !navigation.isRecentPending()) return false;
    if (fromRow) peek?.closeAll();
    releaseReveal();
    const call = ++request.current;
    focusRequested.current = null;
    openingRequest.current = opening ? call : null;
    if (!opening) { centered.current = true; settled.current = true; openingPlacement.current = null; setAnchor(null); }
    scrollRequested.current = null;
    if (!keyboardIntent.current) setKbd(false);
    setFocusKey(id);
    noticeStore.dismiss('tree-reveal-failed');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const loading = () => new OwnFailure({ code: 'snapshot_changed', message: "Ariadne is still loading this session's latest changes. Try again.", hint: '', retryable: true, field_errors: [] });
    const reveal = async () => {
      while (navigation.getSnapshot().writing) {
        const completion = navigation.getWritingCompletion();
        if (!completion) break;
        if (navigation.isRecentPending()) {
          // The Recent trail is automatic. A click waits for it only briefly and opens whatever its outcome.
          let wait: ReturnType<typeof setTimeout> | undefined;
          const finished = await Promise.race([completion.then(() => true, () => true),
            new Promise<boolean>(resolve => { wait = setTimeout(() => { resolve(false); }, RECENT_WAIT_MS); })]);
          clearTimeout(wait);
          if (expired || !mounted.current || call !== request.current) return null;
          if (!finished) break;
          continue;
        }
        await completion;
        if (expired || !mounted.current || call !== request.current) return null;
      }
      // A rendered row opens from the loaded copy, so a refresh in flight never blocks the click. Anything else reads first.
      // The busy check comes first here: a refused click must not reach revealLoaded, which supersedes a reveal still in flight.
      const refuseWhileSaving = () => {
        const current = navigation.getSnapshot();
        if ((current.writing || current.pendingOperationId !== null) && !navigation.isRecentPending()) throw new OwnFailure({ code: 'store_busy',
          message: 'Another view change is being saved. Wait for it, then try again.', hint: '', retryable: true, field_errors: [] });
      };
      if (options.loaded) refuseWhileSaving();
      const loadedReveal = options.loaded ? navigation.routes.revealLoaded({ ...route, item_id: id }, store) : null;
      if (!loadedReveal) {
        if (store.getSnapshot().status !== 'ready' || store.getSnapshot().error) await store.refresh(true);
        if (expired || !mounted.current || call !== request.current) return null;
        if (store.getSnapshot().status !== 'ready' || store.getSnapshot().error) throw loading();
        refuseWhileSaving();
      }
      return loadedReveal ?? navigation.routes.revealItem({ ...route, item_id: id });
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
      }, { itemId: id });
    }).catch((error: unknown) => {
      if (opening || !mounted.current || call !== request.current) return;
      focusRequested.current = null;
      noticeStore.push({ id: 'tree-reveal-failed', icon: 'ph ph-warning-circle', iconColor: 'var(--a-danger)',
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
  /** A pointer click or Enter on a rendered row. Every other caller of select() keeps the read path. */
  const activate = (id: string) => select(id, true, false, { loaded: true });
  const focusBranch = (id: string | null) => {
    if (focusDisabled) return;
    if (id && (!session?.items[id] || session.items[id]!.parent)) return;
    settled.current = true; openingPlacement.current = null; setAnchor(null);
    void saveView(next => {
      if (id) next.focused_item_id = id; else delete next.focused_item_id;
      if (id && session?.items[id]) {
        if (!next.expanded_item_ids.includes(id)) next.expanded_item_ids.push(id);
        next.collapsed_topic_ids = next.collapsed_topic_ids?.filter(topic => topic !== session.items[id]!.topic_id);
      }
    }, id ? { itemId: id } : undefined);
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
    if (!item || item.parent || itemRemoved(raw, id) || hiddenSource(raw, new Set(view?.hidden_item_ids ?? []), id)) {
      void saveView(next => { delete next.focused_item_id; });
    }
  }, [view?.focused_item_id, view?.hidden_item_ids, state.status, raw]);
  const toggleItem = (id: string) => {
    const row = latest.current.rows.find(value => value.key === id);
    if (!row || row.kind !== 'item' || !row.hasKids) return;
    setNextRevealId(null);
    if (model?.filtering) filterFolds.setFold('items', id, row.expanded);
    if (row.expanded) { onDismissReveal(); unshow('items', id); }
    void saveView(next => {
      const expanded = new Set(next.expanded_item_ids);
      if (row.expanded) expanded.delete(id); else expanded.add(id);
      next.expanded_item_ids = [...expanded];
    }, { itemId: id });
  };
  const toggleTopic = (id: string) => {
    setNextRevealId(null);
    const expanded = latest.current.rows.find(row => row.kind === 'topic' && row.key === id)?.expanded ?? !closedTopics.has(id);
    if (expanded) { onDismissReveal(); unshow('topics', id); }
    if (model?.filtering) filterFolds.setFold('topics', id, expanded);
    // Folds this one topic (or opens it) on whatever saved view is current when it is written: queued, it rebases.
    void saveView(saved => {
      const next = new Set(saved.collapsed_topic_ids ?? []);
      if (expanded) next.add(id); else next.delete(id);
      saved.collapsed_topic_ids = [...next].slice(-FOLDS_KEPT);
    }, { topicId: id });
  };
  const setChip = (chip: Chip) => {
    setNextRevealId(null);
    onDismissReveal();
    if (isLocalChip(chip)) { localChips.set(toggleLocalChip(localChips.chips, chip)); return; }
    // The chip's whole target is taken now, from the view the owner sees: a saved view that already carries this edit
    // (a refresh before its receipt) takes it again unchanged, never flipped back or filtered again.
    const edit = savedChipEdit(latest.current.view?.filters.statuses ?? [], chip);
    void saveView(next => { next.filters.statuses = edit(next.filters.statuses); });
  };
  // Clear empties everything that makes the filter active (the saved statuses, the local chips, the saved owners and
  // hide-later, which have no chip) so the row never offers a Clear that leaves the filter on. Search and the archive stay.
  const clearChips = () => {
    setNextRevealId(null);
    onDismissReveal();
    localChips.set([]);
    setFilterShown(null);
    const filters = view?.filters;
    if (filters && (filters.statuses.length || filters.owners.length || filters.hide_later)) {
      void saveView(next => { next.filters.statuses = []; next.filters.owners = []; next.filters.hide_later = false; });
    }
    props.onCloseFilter?.();
  };
  const resume = () => {
    setNextRevealId(null);
    const outsideSelected = selectedId !== null && selectedId === revealId;
    onResume();
    if (outsideSelected) void saveView(next => { next.selected_item_id = null; });
  };

  const focusRow = (key: string) => { setFocusKey(key); elements.current.get(key)?.focus({ preventScroll: true }); };

  // ⇧F and c act on the current view's selected item: the bigger view's item while it covers the tree.
  const actingItem = () => { const id = covered ? props.actingId ?? null : selectedId; return id ? session?.items[id] : undefined; };
  const toggleSelectedFocus = () => {
    if (focusDisabled) return false;
    if (focusedId) { focusBranch(null); return true; }
    let item = actingItem();
    while (item?.parent) item = session?.items[item.parent];
    if (!item) return false;
    focusBranch(item.id); return true;
  };
  const continueSelected = () => {
    const item = actingItem();
    if (!item || archivedMode) return false;
    // As the topic band offers it: not for a topic continued from elsewhere, nor while a topic reply is on its way.
    if (session?.topics[item.topic_id]?.origin) return false;
    if (latest.current.rows.some(row => row.kind === 'topic' && row.topic.id === item.topic_id && row.delivery)) return false;
    openContinueTopic({ source: route, topicId: item.topic_id }); return true;
  };
  useIntents({
    'focus.toggle': toggleSelectedFocus,
    'topic.continue': continueSelected,
    // n outlines the next unseen row; the Graph and the bigger view have none.
    'map.nextUnseen': ({ repeat }) => { if (graph || covered) return false; if (!repeat) nextCallbacks.current(); return true; },
    'map.backToSelected': () => { if (graph || covered || !selectedId) return false; revealSelected(true); return true; },
    // The Details path's topic segment: the Tree scrolls back to its top (the owner asked; the Map never does it by itself).
    'map.top': () => { if (graph || !scroller.current) return false; stopLanding(); scroller.current.scrollTop = 0; return true; },
  });

  // ------------------------------------------------------------ keyboard
  const onRow = (act: (row: Row, index: number, intent: WorkspaceIntent, event: KeyboardEvent<HTMLDivElement>) => boolean | void) => (intent: WorkspaceIntent, event: KeyboardEvent<HTMLDivElement>) => {
    const visible = latest.current.rows, index = visible.findIndex(row => row.key === event.currentTarget.dataset.row);
    return index >= 0 ? act(visible[index], index, intent, event) : false;
  };
  // A card the owner opened closes on every key that moves focus or changes the Map under it.
  const move = (to: (index: number, visible: readonly Row[]) => number) => onRow((_row, index) => {
    peek?.closeAll();
    const visible = latest.current.rows, next = visible[Math.max(0, Math.min(visible.length - 1, to(index, visible)))];
    if (next) focusRow(next.key);
    return true;
  });
  const topicOnly = onRow(row => row.kind === 'topic');
  const keys = useWorkspaceKeys<HTMLDivElement>({
    'move-down': move(index => index + 1), 'move-up': move(index => index - 1), first: move(() => 0), last: move((_index, visible) => visible.length - 1),
    unfold: onRow((row, index) => {
      peek?.closeAll();
      const next = latest.current.rows[index + 1];
      if (row.kind === 'strip' && row.reason === 'hidden' && !row.expanded) toggleStrip(row);
      else if (row.kind === 'topic' && !row.expanded) toggleTopic(row.topic.id);
      else if (row.kind === 'item' && row.hasKids && !row.expanded) toggleItem(row.item.id);
      else if (row.expanded && next && (next.depth > row.depth || row.kind === 'strip' && next.kind === 'item' && next.hidden)) focusRow(next.key);
      return true;
    }),
    fold: onRow(row => {
      peek?.closeAll();
      if (row.kind === 'topic') { if (row.expanded) toggleTopic(row.topic.id); return true; }
      if (row.kind === 'strip') { if (row.expanded) toggleStrip(row); else { const parent = parentKey(row); if (parent) focusRow(parent); } return true; }
      if (row.hasKids && row.expanded) { toggleItem(row.item.id); return true; }
      const parent = parentKey(row);
      if (parent && latest.current.rows.some(value => value.key === parent)) focusRow(parent);
      return true;
    }),
    enter: onRow(row => {
      if (row.kind === 'topic') { toggleTopic(row.topic.id); return true; }
      if (row.kind === 'strip') { if (row.reason === 'hidden') toggleStrip(row); return true; }
      activate(row.item.id); return true;
    }),
    peek: onRow((row, _index, _intent, event) => {
      if (row.kind !== 'item' || !peek) return false;
      if (!event.repeat) peek.toggle({ ...route, item_id: row.item.id }, event.currentTarget);
      return true;
    }),
    answer: onRow((row, _index, _intent, event) => {
      if (row.kind === 'item' && row.item.id === selectedId && session && ackTarget(session, row.item)) {
        if (!event.repeat) {
          if (viewBusy) noticeStore.push({ id: 'tree-ack-view-saving', icon: 'ph ph-warning-circle',
            text: 'Another view change is being saved. Wait for it, then try Ack again.' });
          else runAck(row.item.id);
        }
        return true;
      }
      return false;
    }),
    bring: topicOnly, respond: topicOnly, drop: topicOnly, reopen: topicOnly, later: topicOnly,
    hide: (intent, event) => onRow(row => { if (row.kind !== 'item' || row.item.id !== selectedId) return false; if (!event.repeat) hideItem(row); return true; })(intent, event),
    remove: onRow(row => {
      if (row.kind !== 'item' || row.item.id !== selectedId) return false;
      onRemove({ kind: 'item', item: { ...route, item_id: row.item.id } }); return true;
    }),
  }, { scope: 'row' });

  // ------------------------------------------------------------ focus and scroll
  const remember = useRef((key: string, element: HTMLDivElement | null) => {
    if (element) elements.current.set(key, element); else elements.current.delete(key);
  }).current;
  // A selection the keyboard made (`x`, `.`, Enter) keeps the focus ring; one the pointer made clears it (D6, R9).
  useEffect(() => { if (selectedId) { if (!keyboardIntent.current) setKbd(false); setFocusKey(selectedId); } }, [selectedId]);
  // Hover peek never shows on the selected row (D7): a card waiting for the row the selection lands on, or open on it, goes.
  useEffect(() => { if (selectedId) peek?.dropHover({ ...route, item_id: selectedId }); }, [selectedId]);
  useLayoutEffect(() => {
    if (!rows.length || (focusKey && rows.some(row => row.key === focusKey))) return;
    let candidate: string | null = focusKey && session?.items[focusKey] ? session.items[focusKey]!.parent ?? session.items[focusKey]!.topic_id : null;
    while (candidate && !rows.some(row => row.key === candidate)) candidate = session?.items[candidate]?.parent ?? session?.items[candidate]?.topic_id ?? null;
    const next = candidate ?? rows[0].key, hadFocus = !!scroller.current?.contains(document.activeElement);
    setFocusKey(next);
    if (hadFocus) elements.current.get(next)?.focus({ preventScroll: true });
  }, [rows, focusKey, session]);
  // The floating dock covers the bottom of the scroller: a row under it counts as hidden.
  const dockInset = useDockInset(), inset = useRef(dockInset);
  inset.current = dockInset;
  const visibleBottom = (box: HTMLElement) => box.getBoundingClientRect().bottom - inset.current;
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
    // The Back-to pill floats in the shell, beside the scroller, and clears the same band.
    box.parentElement?.style.setProperty('--tree-header-height', `${height}px`);
    return top + height;
  };
  const center = (key: string) => {
    const box = scroller.current, element = elements.current.get(key);
    if (!box || !element) return;
    const a = box.getBoundingClientRect(), b = element.getBoundingClientRect();
    box.scrollTop += b.top - a.top - openingTop(a.height, b.height, headerHeight(element), 8, inset.current);
  };
  // Saved reading positions win on session restoration; otherwise place the initial selection once.
  const place = (target: Anchor | null) => {
    const box = scroller.current, element = target ? elements.current.get(target.key) : undefined;
    if (!box || !element || !target) return;
    if (target.offset === null) center(target.key);
    else box.scrollTop += element.getBoundingClientRect().top - box.getBoundingClientRect().top - headerHeight(element) - target.offset;
  };
  // The Back-to pill floats over the edge it points at: a row the owner is taken to ends clear of it.
  const pillOver = (box: HTMLElement): BackPill | null => {
    const back = box.parentElement?.querySelector<HTMLElement>('.tree-back'), rect = back?.getBoundingClientRect(), top = box.getBoundingClientRect().top;
    const side = back?.dataset.edge === 'above' ? 'above' : back?.dataset.edge === 'below' ? 'below' : null;
    // A pill with no height is not laid out (no layout engine): it covers nothing.
    return rect && rect.height > 0 && side ? { edge: side, top: rect.top - top, bottom: rect.bottom - top } : null;
  };
  // The least scrolling that brings a row into view (`block: 'nearest'`): none when it is in view already; a row
  // taller than the tree lines up its top instead of running past it. Null when the row is not drawn. `pill`: the Back-to pill to
  // clear; by default the one on screen now (with a margin; none without).
  const nearestBy = (key: string, margin = 0, pill?: BackPill | null): number | null => {
    const box = scroller.current, element = elements.current.get(key);
    if (!box || !element) return null;
    const a = box.getBoundingClientRect(), b = element.getBoundingClientRect();
    const clear = pill !== undefined ? pill : margin > 0 ? pillOver(box) : null;
    return nearestDelta(a.height, b.top - a.top, b.height, headerHeight(element), margin, inset.current, clear);
  };
  const nearest = (key: string, margin = 0) => {
    const box = scroller.current, delta = nearestBy(key, margin);
    if (!box || !delta) return;
    // The app moving the Map for the owner at once is a new target: a landing on its way stops (Q1).
    stopLanding();
    box.scrollTop += delta;
  };
  /**
   * Takes the owner to `key` (alpha.24 P3, Q1): the least scrolling that shows it, 8px clear of the band, the dock and the Back-to pill,
   * then the row is retained as the reveal. `animate` (⌘[ / ⌘], `n`): over a few eased frames, unless motion is reduced; a landing
   * already on its way to `key` goes on, and any other stops where it is first. Every frame marks its move as the hold's own and
   * measures the way left again, so the reading-row hold refreshes on the way and its corrections are absorbed (Q2). The Back-to pill
   * it clears is the one on screen when it starts, as for the jump: a pill that comes or goes on the way (the selected row going out of
   * view, or arriving) moves the end no more than it moved the jump's. Only a landing that arrives retains its row (Q7).
   */
  const land = (key: string, animate: boolean) => {
    if (animate && landing.current?.key === key && landing.current.run.running()) return;
    stopLanding();
    releaseReveal();
    settled.current = true; setAnchor(null);
    const box = scroller.current;
    if (!animate || !box || !landingMoves()) { nearest(key, 8); retainReveal(key); return; }
    const pill = pillOver(box);
    let run: Landing | null = null;
    run = startLanding({
      remaining: () => {
        const delta = scroller.current === box ? nearestBy(key, 8, pill) : null;
        return delta === null ? null : reachable(box, { top: delta, left: 0 });
      },
      move: by => { box.scrollTop += by.top; ownScroll.current = box.scrollTop; },
      screen: () => ({ top: box.clientHeight, left: 0 }),
      landed: () => {
        if (run && landing.current?.run === run) landing.current = null;
        retainReveal(key);
      },
    });
    if (run.running()) { landing.current = { key, run }; wheels.carry(); }
  };
  const centered = useRef(false), settled = useRef(false), openingReveal = useRef<string | null>(null);
  const openingPlacement = useRef<string | null>(null);
  const openingRequest = useRef<number | null>(null);
  const [openingFinished, setOpeningFinished] = useState(0);
  // Show more / Show less on a long preview. The owner is steering, so the view stops holding its anchor; folding
  // a preview the owner has read down to its end keeps that row's top in sight rather than leaving the tree below it.
  // A Show less out of view, above the reading row, folds what is above it: the reading row stays put, as for Show more.
  const folding = useRef<string | null>(null);
  const unfold = (id: string) => {
    // The hold stays: Show more above the reading row grows what is above it, and the row the owner reads stays put.
    settled.current = true;
    // A row whose Show more is on screen holds its own window position through the height change, even when the band covers
    // its top (otherwise the first whole row below becomes the one held, and this row moves). A row whose buttons are out of
    // view (Show more above the reading row) leaves the hold on the reading row.
    const box = scroller.current, element = elements.current.get(id), rect = element?.getBoundingClientRect();
    const clicked = [...element?.querySelectorAll('.tree-more') ?? []].some(button => {
      const place = button.getBoundingClientRect();
      return place.bottom > readingTop() && place.top < visibleBottom(box!);
    });
    if (box && rect && clicked) {
      revealedAnchor.current = { key: id, offset: rect.top - readingTop(), scrollTop: box.scrollTop };
      remembering();
    }
    // Only a Show less on screen brings its row's top into sight (an app scroll for the owner, which ends that row's hold).
    if (clicked && isUnfolded(id)) folding.current = id;
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
    // Leaving Focus can mount the target on the next render. Keep the handoff until its row exists. A hide's move takes focus
    // only where focus was in what went (`presentMove`).
    if (reveal?.kind === 'item' && reveal !== previous.reveal && !hideMove.current) {
      if (!keyboardIntent.current) setKbd(false);
      focusRequested.current = id;
    }
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
    // A hide's move keeps the Map still even when the row it selects is off-screen (R3): the Back-to pill points at it.
    if (!focusKey || !kbd || hideMove.current) return;
    // A row ⌘[ / ⌘] or `n` is landing on comes into view by that landing (Q1).
    if (landing.current?.key === focusKey) return;
    if (focusKey !== anchor?.key) settled.current = true;
    // Keyboard moves scroll only when the new row is off-screen, and by the least amount, at once (held keys repeat).
    nearest(focusKey, 8);
  }, [focusKey]);
  // The Map never moves on its own (D24): what the owner is reading keeps its place in the window when rows above it grow,
  // shrink, arrive or leave (a live edit, a message landing, fonts loading, a filter) and when the scroller itself moves (a
  // row opening above the Map), at every scroll position. WKWebView has no `overflow-anchor`, so the reading row (the
  // selected row while on screen, else the first whole row) is remembered and put back after every layout change.
  // At `scrollTop = 0` a shrink at or above it lets the rows below rise; at the bottom a shrink leaves a spacer.
  interface Held {
    readonly key: string;
    /** Its top below the reading edge (the scroller's top plus the sticky band there), and its window top. */
    readonly offset: number; readonly y: number;
    /** The scroller's window top and scroll position then, and how far the scroller has carried the row down in the window (`carried`). */
    readonly boxTop: number; readonly scrollTop: number; readonly carried: number;
    /** The scroller's own height then: a taller window clamps at the end too, and that move is the window's. */
    readonly height: number;
    /** Where the row above it, clipped by the band, starts below the reading edge (negative); Infinity when none is clipped. */
    readonly lead: number;
    /** The session and rows then, and the offsets of the item rows on screen: a reading row that goes hands the hold on. */
    readonly sessionId: string | undefined; readonly rows: readonly Row[]; readonly offsets: ReadonlyMap<string, number>;
  }
  const held = useRef<Held | null>(null);
  /** The blank space added below the rows so a shrink at the bottom keeps the scroll extent; owner scrolls trim it. */
  const spacer = useRef(0);
  const panelTarget = useRef<{ readonly key: string; readonly top: number; readonly scrollTop: number } | null>(null);
  const placed = useRef<Anchor | null>(null);
  placed.current = anchor;
  /** The scroll position the hold's own correction last set, so the next `remembering` tells it from an owner's scroll. */
  const ownScroll = useRef<number | null>(null);
  /**
   * How far the held row goes down in the window with the scroller since it was last held, so the sticky band never covers
   * more of it than before: the new target is the larger of the row's old window y and the band's new bottom less what the
   * band covered of the row (`held`: its offset below the reading edge, negative when covered; the clipped row above it,
   * `lead`, counts too, as the band covers it first). A scroller that moves down by `moved`
   * takes the band with it, so a row `offset` clear of the band goes down by what is left of `moved` (none when it stays
   * clear), and a covered row by all of it. When the scroller comes back up the row returns the same, no more than it was
   * carried: a bar that opens above the Map and closes again leaves the row where it was.
   */
  const carried = (box: HTMLElement, before: Held, held: number) => {
    const moved = box.getBoundingClientRect().top - before.boxTop, offset = Math.min(held, before.lead);
    if (moved > 0) return offset < 0 ? moved : Math.max(0, moved - offset);
    return Math.max(moved, -before.carried);
  };
  /** The scroller width `holding` last held the reading row at. */
  const previousWidth = useRef<number | null>(null);
  /**
   * Puts the held row back at its offset below the reading edge. The sticky topic bar at that edge belongs to whichever
   * topic is under it at this scroll position: after a width change, rows reflow and another topic's bar (wrapped to a
   * different height) can sit there until the row is back, so settle against the bar the row ends under, measuring it
   * afresh on each of a few passes. The scroller's own move in the window is not subtracted: the row keeps its window place,
   * except for `carried`: the sticky band goes down with a scroller that moves down (a notice opens above the Map), and a row
   * the band already covers the top of goes down by as much instead of sliding further under it.
   * Where the rows no longer reach that far down, the bottom spacer grows to keep the scroll extent. Returns the carry it applied,
   * which is the one `remembering` records: a survivor's offset can differ from the gone row's.
   */
  const restoreHeld = (box: HTMLDivElement, before: Held, offset: number, element: HTMLElement, windowPlace = false): number => {
    const carry = carried(box, before, offset);
    for (let pass = 0; pass < 3; pass++) {
      // A whole topic's strip stands between topics, under no band of its own: it takes the row's window place instead.
      const delta = windowPlace ? element.getBoundingClientRect().top - before.y - carry
        : element.getBoundingClientRect().top - readingTop() - offset + box.getBoundingClientRect().top - before.boxTop - carry;
      if (Math.abs(delta) < 1) break;
      const short = box.scrollTop + delta + box.clientHeight - scrollEnd(box);
      if (short > 0 && box.clientHeight > 0) setSpacer(box, spacer.current + short);
      box.scrollTop += delta;
      ownScroll.current = box.scrollTop;
    }
    return carry;
  };
  /**
   * The scroll extent the rows themselves give, spacer included. A short Map (its rows end above the window's bottom)
   * reports a scroll height clamped to its own height, so there it is measured from where the rows end.
   */
  const scrollEnd = (box: HTMLDivElement) => {
    const rows = box.querySelector('.tree-rows');
    if (box.scrollHeight > box.clientHeight + 0.5 || !rows) return box.scrollHeight;
    return rows.getBoundingClientRect().bottom - box.getBoundingClientRect().top - box.clientTop + box.scrollTop
      + (Number.parseFloat(getComputedStyle(box).paddingBottom) || 0);
  };
  const setSpacer = (box: HTMLDivElement, height: number) => {
    const next = Math.max(0, Math.ceil(height)), rows = box.querySelector<HTMLElement>('.tree-rows');
    if (next === spacer.current) return;
    spacer.current = next;
    if (rows) rows.style.paddingBottom = next ? `${next}px` : '';
  };
  /** Keeps only the part of the bottom spacer still on screen, so trimming never moves the view; growing rows use it up. */
  const trimSpacer = (box: HTMLDivElement) => {
    if (spacer.current) setSpacer(box, Math.min(spacer.current, box.scrollTop + box.clientHeight - (scrollEnd(box) - spacer.current)));
  };
  /**
   * The held row, or when it went (filtered out, hidden or removed), the nearest surviving row below it, else above it.
   * A row the owner folded away under its topic or a parent is the owner's own move: nothing is held, as before D24.
   * A hide on screen holds the row above the hidden one instead (S10), whatever the reading row was: the rows above it stay,
   * and the rows below close its space (the selected row among them, when it was below).
   */
  const heldRow = (before: Held): { readonly element: HTMLElement; readonly offset: number; readonly windowPlace?: boolean; readonly y?: number } | null => {
    const hide = hideHold.current;
    hideHold.current = null;
    if (hide) {
      const above = hide.key ? elements.current.get(hide.key) : undefined;
      if (!above) return null;
      return hide.window ? { element: above, offset: 0, windowPlace: true, y: hide.offset } : { element: above, offset: hide.offset };
    }
    const element = elements.current.get(before.key);
    if (element) return { element, offset: before.offset };
    const { rows: now, session: current } = latest.current, item = current?.items[before.key];
    // A removed or archived row hands the hold to the strip now in its place (E29); at commit, to the nearest survivor.
    const anchor = current?.id === before.sessionId ? stripAnchorFor(now, before.key) : null, strip = anchor ? elements.current.get(anchor) : undefined;
    // The band the row was read under went with its topic: a whole topic's strip keeps the row's window place (E12).
    const wholeTopic = !!anchor && now.some(row => row.key === anchor && row.kind === 'strip' && !!row.place && !row.place.itemId);
    if (strip) return { element: strip, offset: before.offset, windowPlace: wholeTopic };
    if (!current || current.id !== before.sessionId) return null;
    // A strip that went on Undo hands the hold back to the row whose place it kept.
    const gone = before.rows.find(row => row.key === before.key);
    if (gone?.kind === 'strip' && gone.place) for (const key of gone.place.covers) {
      const back = elements.current.get(key);
      if (back) return { element: back, offset: before.offset };
    }
    const shown = new Map(now.map(row => [row.key, row]));
    for (let key = item ? item.parent ?? item.topic_id : null; key; key = current.items[key]?.parent ?? current.items[key]?.topic_id ?? null) {
      const row = shown.get(key);
      if (row?.kind === 'topic' ? !row.expanded : row?.kind === 'item' && row.hasKids && !row.expanded) return null;
    }
    // A strip that went at commit keeps its order here, so the hold goes to the survivor next to it.
    const keys = before.rows.flatMap(row => row.kind === 'item' || row.key === before.key ? [row.key] : []), at = keys.indexOf(before.key);
    for (const key of [...keys.slice(at + 1), ...keys.slice(0, Math.max(at, 0)).reverse()]) {
      const survivor = elements.current.get(key);
      if (survivor) return { element: survivor, offset: before.offsets.get(key) ?? before.offset };
    }
    return null;
  };
  const remembering = (restored?: number) => {
    const box = scroller.current;
    if (!box) { held.current = null; return; }
    // A new width not yet held: a scroll event is handled before the frame's resize observers, so it can arrive first.
    // The width change is `holding`'s (it keeps the row below the topic bar the row ends under), and it remembers after.
    if (previousWidth.current !== null && previousWidth.current !== box.getBoundingClientRect().width) { holding(); return; }
    const before = held.current, element = before ? elements.current.get(before.key) : undefined;
    // Rows that shrink at the Map's end with no render (a text-size step) clamp the scroll position, and that scroll event
    // also comes before the resize observers: the move is the browser's, so `holding` puts the row back first (E12). A
    // scroller grown taller (the window) clamps as well; that one stands, as before.
    if (!inHolding.current && clampedAtEnd(box, before) && box.clientHeight === before?.height) { holding(); return; }
    // An observer, layout effect or delayed programmatic scroll event can arrive between
    // reflows. With no owner scroll, restore the held row's window place before adopting the new layout.
    if (before && element && box.scrollTop === before.scrollTop && (settled.current || !placed.current)) {
      // Where the row was in the window, plus what the scroller carried it (see `restoreHeld`).
      const delta = element.getBoundingClientRect().top - before.y - carried(box, before, before.offset);
      if (Math.abs(delta) >= 1) { box.scrollTop += delta; ownScroll.current = box.scrollTop; }
    }
    // What the scroller has carried the row since: forgotten when the owner scrolled (the row is somewhere else now).
    const driven = before && (box.scrollTop === before.scrollTop || box.scrollTop === ownScroll.current);
    // A reveal holds while the scroller stays where the row was revealed, or moves by the hold's own correction. Any other move
    // is the owner's (a wheel, keys, the scrollbar, or the app's own scroll for the owner), even one whose scroll event has not
    // arrived yet when a render runs the hold: the reveal ends here, so no later render puts its row back.
    const pinned = revealedAnchor.current;
    if (pinned && box.scrollTop !== pinned.scrollTop && box.scrollTop !== ownScroll.current) revealedAnchor.current = null;
    ownScroll.current = null;
    const step = before && driven ? restored ?? carried(box, before, before.offset) : 0;
    const carry = before && driven ? Math.max(0, before.carried + step) : 0;
    // A revealed row keeps the offset it was revealed at, but the band it is measured from moves with the scroller: the part of
    // the move the row did not follow is distance the band gained (or lost) over it, so the offset takes it.
    if (revealedAnchor.current && before?.key === revealedAnchor.current.key && driven) {
      revealedAnchor.current = { ...revealedAnchor.current, offset: revealedAnchor.current.offset + step - (box.getBoundingClientRect().top - before.boxTop) };
    }
    if (revealedAnchor.current) revealedAnchor.current = { ...revealedAnchor.current, scrollTop: box.scrollTop };
    // An owner scroll back up (or rows growing into it) gives the spacer's room back; what is on screen stays.
    trimSpacer(box);
    // A strip in a removed or archived row's place (E29) can be the reading row too: Undo puts the row back where it is.
    const top = readingTop(), list = latest.current.rows.filter(row => row.kind === 'item' || row.kind === 'strip' && !!row.place);
    const panelKey = latest.current.selectedId;
    const panelRect = panelKey ? elements.current.get(panelKey)?.getBoundingClientRect() : undefined;
    panelTarget.current = panelKey && panelRect && panelRect.top >= top && panelRect.top < visibleBottom(box)
      ? { key: panelKey, top: panelRect.top, scrollTop: box.scrollTop } : null;
    // Rows are stacked in order. Skip predecessors ending within a pixel of the sticky edge.
    let low = 0, high = list.length;
    while (low < high) {
      const middle = (low + high) >> 1, element = elements.current.get(list[middle]!.key);
      if (!element || element.getBoundingClientRect().bottom > top + READING_EDGE_CLEARANCE) high = middle; else low = middle + 1;
    }
    const key = list[low]?.key;
    const first = key ? elements.current.get(key) : undefined, firstTop = first?.getBoundingClientRect().top;
    // The reading row: the selected row while any of it is on screen below the band, else the first row whole below the
    // band (the clipped predecessor only when nothing else starts on screen).
    const selectedShown = panelKey && panelRect && panelRect.bottom > top + READING_EDGE_CLEARANCE && panelRect.top < visibleBottom(box) ? panelKey : null;
    const candidate = list[low + (firstTop !== undefined && firstTop >= top - READING_EDGE_CLEARANCE ? 0 : 1)]?.key;
    const candidateTop = candidate ? elements.current.get(candidate)?.getBoundingClientRect().top : undefined;
    const whole = candidateTop !== undefined && candidateTop < visibleBottom(box) ? candidate : undefined;
    const reading = selectedShown ?? whole ?? key;
    // A deliberate reveal holds its own row through detail-width and preview-clamp changes.
    // The previous row may still peek out below the sticky header's eight-pixel margin.
    if (revealedAnchor.current && !elements.current.has(revealedAnchor.current.key)) revealedAnchor.current = null;
    const revealed = revealedAnchor.current;
    const holdKey = revealed?.key ?? reading, holdElement = holdKey ? elements.current.get(holdKey) : undefined;
    // Edge observation may run before reflow correction. Preserve the
    // reveal's original offset instead of adopting its temporarily obscured top.
    const holdRect = holdElement?.getBoundingClientRect();
    const offsets = new Map<string, number>(), screenEnd = visibleBottom(box);
    for (let index = Math.max(low - 1, 0); index < list.length; index++) {
      const rect = elements.current.get(list[index]!.key)?.getBoundingClientRect();
      if (!rect || rect.top >= screenEnd) break;
      offsets.set(list[index]!.key, rect.top - top);
    }
    // The row held is the first one whole below the band, which covers the top of the row above it: that top row's offset
    // (negative) counts for the carry too, so the band never covers more of it than before.
    const lead = !revealed && !selectedShown && firstTop !== undefined && firstTop < top - READING_EDGE_CLEARANCE && holdKey !== key ? firstTop - top : Infinity;
    held.current = holdKey && holdRect ? { key: holdKey, offset: revealed?.offset ?? holdRect.top - top, y: holdRect.top,
      boxTop: box.getBoundingClientRect().top, scrollTop: box.scrollTop, carried: carry, lead, height: box.clientHeight, sessionId: latest.current.session?.id, rows: latest.current.rows, offsets } : null;
  };
  /** True while `holding` remembers what it restored: that call never hands back to `holding`. */
  const inHolding = useRef(false);
  /**
   * The scroller sits at its end above where the hold left it: rows shrank at the end and the browser clamped the scroll
   * position. That is no move of the owner's. (A scroller with no layout yet, zero high, has no end to clamp to.)
   */
  const clampedAtEnd = (box: HTMLDivElement, before: Held | null) => !!before && box.clientHeight > 0
    && box.scrollTop < before.scrollTop && box.scrollTop >= box.scrollHeight - box.clientHeight - 1;
  const layoutState = useRef({ selectedId, reveal, detailOpen });
  const releaseReveal = () => {
    if (!revealedAnchor.current) return;
    revealedAnchor.current = null;
    remembering();
  };
  layoutState.current = { selectedId, reveal, detailOpen };
  const previousLayout = useRef(layoutState.current);
  const holding = () => {
    const previous = previousLayout.current, current = layoutState.current;
    previousLayout.current = current;
    const width = scroller.current?.getBoundingClientRect().width ?? null;
    const resized = previousWidth.current !== null && previousWidth.current !== width;
    previousWidth.current = width;
    // Closing detail widens previews above the selected row. Preserve
    // that row's last screen position rather than the earlier reading anchor.
    const target = panelTarget.current;
    if (previous.detailOpen && !current.detailOpen && target && target.key === current.selectedId) {
      const offset = Math.max(target.top, readingTop() + 8) - readingTop();
      revealedAnchor.current = { key: target.key, offset, scrollTop: target.scrollTop };
      held.current = { key: target.key, offset, y: readingTop() + offset, boxTop: scroller.current?.getBoundingClientRect().top ?? 0,
        // The carry stays while the scroller has not moved: closing Details re-places the row, not the band.
        carried: scroller.current?.scrollTop === target.scrollTop ? held.current?.carried ?? 0 : 0, lead: Infinity,
        scrollTop: target.scrollTop, height: scroller.current?.clientHeight ?? 0, sessionId: latest.current.session?.id, rows: latest.current.rows, offsets: new Map() };
    }
    if (resized || previous.selectedId !== current.selectedId || previous.reveal !== current.reveal || previous.detailOpen !== current.detailOpen) {
      settled.current = true; setAnchor(null);
    }
    const box = scroller.current, before = held.current;
    // A different scroll position means the view was moved on purpose (a scroll, a reveal, the keyboard), and the opening
    // placement holds its own row until the owner steers. A shrink at the bottom clamps the scroll position: that is no move.
    const clamped = !!box && clampedAtEnd(box, before);
    // A hide's commit is this view's own change: the browser may have clamped the scroll position part-way through it (a row
    // gone before its strip was laid out), so its hold applies whatever the position now.
    const hiding = !!hideHold.current;
    const back = box && before && (hiding || box.scrollTop === before.scrollTop || clamped) && (settled.current || !placed.current) ? heldRow(before) : null;
    const restored = box && before && back
      ? restoreHeld(box, back.y === undefined ? before : { ...before, y: back.y }, back.offset, back.element, back.windowPlace) : undefined;
    // A clamp that left the held row in place needed no correction, yet the scroller moved: that move is the browser's, not
    // the owner's, so a pinned reveal must not end on it (`remembering` ends the pin on any move the hold did not make).
    if (box && clamped && back) ownScroll.current = box.scrollTop;
    // A hide's hold is for its own commit only. The reading row held before it is not put back: the view the hide left is the
    // one remembered now, so no later scroll or resize restores the old place (S10).
    if (hiding && !hideHold.current) held.current = null;
    hideHold.current = null; hideMove.current = false;
    inHolding.current = true;
    try { remembering(restored); } finally { inHolding.current = false; }
  };
  useLayoutEffect(holding);
  const hasRows = rows.length > 0 && !graph;
  useEffect(() => {
    const box = scroller.current, content = box?.querySelector('.tree-rows');
    if (!box || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(holding);
    observer.observe(content);
    content.querySelectorAll('.tree-topic').forEach(header => observer.observe(header));
    // The scroller itself: a row opening or closing above the Map resizes it as it moves it in the window (D13).
    let frame = box.getBoundingClientRect();
    const moved = new ResizeObserver(() => {
      const now = box.getBoundingClientRect();
      if (now.top !== frame.top || now.height !== frame.height) holding();
      frame = now;
    });
    moved.observe(box);
    return () => { observer.disconnect(); moved.disconnect(); setSpacer(box, 0); };
  }, [hasRows, store]);
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
      else if (b.top >= a.bottom - inset.current) edge = 'below';
    }
    if (box && !element && selectedId && session?.items[selectedId] && !graph) edge = 'below';
    setSelectedEdge(previous => previous === edge ? previous : edge);
  };
  useLayoutEffect(updateEdge);
  const retainReveal = (key: string) => {
    const element = elements.current.get(key);
    revealedAnchor.current = element && scroller.current
      ? { key, offset: element.getBoundingClientRect().top - readingTop(), scrollTop: scroller.current.scrollTop } : null;
    remembering(); updateEdge();
  };
  const revealSelected = (returnFocus = false) => {
    if (!selectedId || graph) return;
    peek?.closeAll();
    if (!elements.current.has(selectedId)) {
      // Reuse the temporary reveal route when the owner has folded the selection away.
      if (select(selectedId, false) && returnFocus) focusRequested.current = selectedId;
      return;
    }
    land(selectedId, false);
    if (returnFocus) focusRow(selectedId);
    // Reveal selected also opens Details on the row (owner's pick, 2026-10-22). The reveal is built here from what is on screen:
    // no read, and `clickedReveal` marks it as this view's own so the selection effect does not scroll a second time.
    const own = Object.freeze({ kind: 'item' as const, route: Object.freeze({ ...route, item_id: selectedId }), store,
      temporaryExpandedItemIds: revealId === selectedId && temporary ? temporary : [] });
    clickedReveal.current = own;
    onSelected(own, true);
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
    // ⌘[ / ⌘] (and the swipe), a link, the waiting panel: the Map lands on the item (P3).
    land(target, true);
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
      noticeStore.push({ id: 'tree-no-unseen', icon: 'ph ph-check', text: 'No unseen items.' });
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
    focusRow(id); land(id, true);
  }, [rows, nextTarget, graph]);
  // A search step brings its match into view by the least scrolling, and only a step does (typing never scrolls). The
  // Graph scrolls its own node on `stepped`. Nothing is selected, focused or marked seen.
  useLayoutEffect(() => {
    const id = searchScroll.current;
    searchScroll.current = null;
    if (!id || graph || !elements.current.has(id)) return;
    land(id, false);
  }, [stepped, graph]);
  useEffect(() => {
    if (!nextTarget) return;
    const start = setTimeout(() => setNextPulse(true), 0);
    const timer = setTimeout(() => setNextPulse(false), 900);
    return () => { clearTimeout(start); clearTimeout(timer); };
  }, [nextTarget]);
  useEffect(() => {
    setNextTarget(null); setNextRevealId(null); setNextPulse(false); setNoUnseen(false); nextScroll.current = null;
    stopLanding();
    return () => noticeStore.dismiss('tree-no-unseen');
  }, [route.project_id, route.session_id]);
  // The Graph in the Map's place (its scroller goes) or the Map leaving: a landing stops (Q3).
  useEffect(() => stopLanding, [graph, store]);
  const edgeCallbacks = useRef({ updateEdge, holding });
  edgeCallbacks.current = { updateEdge, holding };
  const topicKeys = JSON.stringify(sections.map(section => section.topic ? section.topic.key : section.place.key));
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

  // ------------------------------------------------------------ rows
  const running = bar?.running ?? false;
  // The agent's slots on every row grey for this reason (D4); each row builds its own buttons (ItemRow `rowActions`).
  const stopped = archivedMode || session?.archived_at ? 'archived' : running && session?.state === 'active' ? null : 'the agent is not running';
  const ackBusy = viewBusy || actionState.writing || !!actionState.pending;
  // One stable dispatcher for every row's buttons (F6d). It acts on the row as the Map shows it when pressed, never on a row
  // object a memoised row kept, so Hide then Unhide on the same row toggles each way.
  const runRow = useLatest((command: RowCommand, id: string) => {
    if (command === 'ack') { runAck(id); return; }
    const target = { ...route, item_id: id };
    if (command === 'remove') { onRemove({ kind: 'item', item: target }); return; }
    if (command === 'hide') {
      const row = latest.current.rows.find(value => value.kind === 'item' && value.key === id);
      if (row?.kind === 'item') hideItem(row);
      return;
    }
    ++request.current; centered.current = true; settled.current = true; setAnchor(null);
    scrollRequested.current = null;
    onAct(command, target, result => { clickedReveal.current = result; });
  });
  // The rows' other callbacks, stable for the same reason; each calls this render's code.
  const selectRow = useLatest(activate), toggleRow = useLatest(toggleItem), unfoldRow = useLatest(unfold);
  const undoAck = useLatest((id: string) => { hold.undo(id); });
  // The selected row never hover-peeks (D7): asked when the pointer rests and again when the wait ends.
  const peekHover = useLatest((id: string, event: MouseEvent<HTMLDivElement>) => {
    if (!peek) return;
    if (event.type !== 'mouseenter') event.stopPropagation();
    peek.hoverStart({ ...route, item_id: id }, event.currentTarget, () => latest.current.selectedId === id);
  });
  const peekLeave = useLatest(() => peek?.chipProps({ ...route, item_id: '' }).onMouseLeave?.());
  const openReference = useLatest((id: string) => { select(id, false); });
  const itemRefs = useMemo(() => ({ route: (id: string) => ({ ...route, item_id: id }), lookup: (id: string) => {
    const item = session?.items[id];
    return item && session && !itemRemoved(session, item.id) ? { label: names.get(id) ?? shortLabel(item), status: displayStatus(session, item) } : null;
  }, onOpenItem: openReference }), [route, session, names, openReference]);
  // The archive view's only hover action is Restore; a live topic's actions are the band's buttons and its "…" menu.
  const topicActions = (row: Extract<Row, { kind: 'topic' }>): TopicAction[] => archivedMode
    ? [{ icon: 'ph ph-arrow-counter-clockwise', label: 'Restore', title: 'Restore topic', run: () => lifecycle.restore(row.topic.id), archive: true }] : [];
  /** Unseen items of one topic, in Map order: the band's Next steps through them. */
  const unseenIn = (topicId: string) => changes && session
    ? changes.order.filter(id => changes.markers.has(id) && session.items[id]?.topic_id === topicId) : [];
  const bandSlots = (row: Extract<Row, { kind: 'topic' }>): BandSlots => {
    if (archivedMode || !session) return {};
    const id = row.topic.id, unseen = unseenIn(id), at = nextTarget ? unseen.indexOf(nextTarget.id) : -1;
    const focusedName = focusedId ? names.get(focusedId) ?? (focusedItem ? shortLabel(focusedItem) : focusedId) : null;
    const focusedCount = focusedBranch ? [...focusedBranch].filter(itemId => !itemRemoved(session, itemId)).length : 0;
    // A reply on its way never blocks this: the topic's Details shows that reply with its status and Undo, and takes a second one behind it.
    const replyBlocked = session.state === 'active' && session.active_binding_id ? null : 'the agent is not running';
    const binItems = removedRoots(session, id).reduce((sum, item) => sum + removedSubtree(session, item.id).length, 0);
    return {
      // While focused, the counts line says so, in the counts' place (D9).
      counts: focusedName ? <span className="tree-count tree-focused"><i className="ph ph-crosshair-simple" aria-hidden="true" />
        Focused on “{focusedName}” · {focusedCount} item{focusedCount === 1 ? '' : 's'}</span> : undefined,
      changes: <ChangesOpener session={session} topicId={id} seen={seen} navigation={navigation}
        onOpenItem={itemId => { if (covered && props.onOpenItem) props.onOpenItem(itemId); else select(itemId, false); }} />,
      next: <NextUnseen position={at >= 0 ? at + 1 : null} total={unseen.length} onNext={() => nextCallbacks.current()} />,
      focus: <FocusButton focusedName={focusedName} canFocus={!!actingItem()} busy={focusDisabled} onToggle={() => { toggleSelectedFocus(); }} />,
      continue: row.topic.origin ? undefined
        : <ContinueButton disabled={!!row.delivery} title="A reply to this topic is on its way" onContinue={() => openContinueTopic({ source: route, topicId: id })} />,
      menu: <TopicMenu topicName={row.topic.name} dismissKey={row.key}
        reply={{ run: () => props.onOpenTopic?.(id), unavailable: replyBlocked }}
        bin={{ count: binItems, open: () => binView.reveal(route, id) }}
        archive={() => lifecycle.archive(id)}
        remove={{ run: () => onRemove({ kind: 'topic', session: route, topic_id: id }), items: activeItems(session).filter(item => item.topic_id === id).length }} />,
    };
  };
  const closedReason = session ? sessionAnswerBlocked(session) : undefined;
  const tree = model && rows.length > 0 && <TreeFonts.Provider value={fontEpoch}><ItemRefs.Provider value={itemRefs}><div role="tree" aria-label="Session items" aria-busy={state.status === 'loading'} className="tree-rows" onBlur={saveScroll}>
    {sections.map(section => {
      if (!section.topic) return <div key={section.place.key} className="tree-topic-group tree-topic-place" role="presentation">
        <Strip variant="row" row={section.place} focused={focusKey === section.place.key} remember={remember} onFocus={setFocusKey} onKeyDown={keys} onToggle={toggleStrip} onPlace={onPlace} />
      </div>;
      const { topic: row, items } = section;
      const eligible = !archivedMode && session ? ackAllItems(session, row.topic.id) : [];
      return <div key={row.key} className="tree-topic-group" role="presentation">
      <TopicRow row={row} focused={focusKey === row.key} actions={topicActions(row)} slots={bandSlots(row)}
        ackAll={!archivedMode ? <AckAll actions={actions} topicId={row.topic.id} topicName={shortLabel(row.topic)} items={eligible} disabled={viewBusy} /> : undefined}
        prompt={row.allClosed && !archivedMode ? () => lifecycle.archive(row.topic.id) : null}
        remember={remember} onFocus={setFocusKey} onKeyDown={keys} onToggle={toggleTopic}
        />
      {items.map(row => row.kind === 'strip'
        ? <Strip key={row.key} variant="row" row={row} focused={focusKey === row.key} remember={remember} onFocus={setFocusKey} onKeyDown={keys} onToggle={toggleStrip} onPlace={onPlace} />
        : <ItemRow key={row.key} row={row} selected={selectedId === row.key} focused={focusKey === row.key} disabled={focusDisabled} closedReason={closedReason}
        changeMarker={changes?.markers.get(row.key)} nextUnseen={nextTarget?.id === row.key} nextUnseenPulse={nextPulse && nextTarget?.id === row.key}
        note={row.collapsed ? collapsedNote(row.collapsed) : null}
        stopped={stopped} ackDisabled={!!row.ack && (ackBusy || ackHeld.has(row.key))} run={runRow}
        current={currentMatch?.id === row.key ? currentMatch.field : null} terms={row.matches.length ? terms : undefined}
        unfolded={isUnfolded(row.key)} onUnfold={unfoldRow}
        acked={ackHeld.has(row.key)} onUndoAck={undoAck} onPeekHover={peekHover} onPeekLeave={peekLeave}
        remember={remember} onFocus={setFocusKey} onKeyDown={keys} onSelect={selectRow} onToggle={toggleRow} />)}
    </div>; })}
  </div></ItemRefs.Provider></TreeFonts.Provider>;

  const loading = !session && state.status === 'loading';
  // No session and no read to show: the Map's place says so (SPEC 12.7); the line above carries the state.
  const unreadable = !session && state.status === 'inaccessible';
  // Where the line above the Map is on screen it reports an unsure save, and its "Try again" is the one place to check again.
  const lineShown = useContext(ConnectionLineShown);
  const graphShown = !!graph && !loading && !unreadable;
  const chips = useMemo(() => scope && filtersShown ? { counts: chipCounts(scope), hidden: hiddenChipCounts(scope), matches: hiddenMatchIds(scope),
    picked: pickedChips(scope), active: filterActive(scope), ...summaryCounts(scope) } : null, [scope, filtersShown]);
  // The Graph draws no hidden node except on the route to the selected or revealed item (graph/model.ts): the strip's note counts the
  // hidden matches the Graph reports it does not draw (G16, from its own model), and offers no reveal.
  const filterHidden = model?.filterHidden;
  const hiddenNote: HiddenNote | null = !chips?.active ? null : graphShown
    ? { remaining: chips.matches.filter(id => !graphHidden?.has(id)).length, shown: 0, outside: 0 }
    : filterHidden ? { remaining: filterHidden.remaining, shown: filterHidden.shown, outside: filterHidden.outside } : null;
  /** "Show them": opens, in memory only, what the hidden matches inside the Focus need. Neither the saved view nor the Focus changes. */
  const showHidden = () => {
    const reveal = model?.filterHidden.reveal;
    if (!reveal || !model?.filterHidden.remaining) return;
    const join = (a: readonly string[] = [], b: readonly string[]) => [...new Set([...a, ...b])];
    setFilterShown(previous => ({ items: join(previous?.items, reveal.items), topics: join(previous?.topics, reveal.topics), groups: join(previous?.groups, reveal.groups) }));
  };
  const filterRow = chips && <FilterRow counts={chips.counts} hidden={chips.hidden} picked={chips.picked} active={chips.active} shown={chips.shown} total={chips.total}
    empty={chips.hiddenTotal === 0} note={hiddenNote} disabled={nav.pendingOperationId !== null && !nav.writing} onChip={setChip} onClear={clearChips}
    onShowHidden={graphShown ? undefined : showHidden} onHideShown={graphShown ? undefined : () => setFilterShown(null)} />;
  let body: ReactNode;
  if (loading) {
    body = <div className="tree-loading" aria-busy="true">
      {SKELETON.map((row, index) => <div key={index} className="tree-skeleton" style={{ paddingLeft: row.pad, paddingTop: row.top }}>
        <span className="tree-skeleton-dot" /><span className="tree-skeleton-bar" style={{ width: row.width }} />
        <span className="tree-skeleton-badge" style={{ width: row.badge }} /></div>)}
      <div className="tree-loading-text" role="status"><i className="ph ph-circle-notch" />Reading the session…</div>
    </div>;
  } else if (unreadable) body = <UnreadableMap error={state.error ? plainFailure(state.error) : null} />;
  else if (graph) body = null;
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
    // Only the filters can empty the Map; a search never does. No band is drawn then, so while Focus is on this is the
    // one place left to leave it.
    body = <div className="tree-no-match">
      <div className="tree-no-match-title">{focusedId ? 'Nothing in the focus matches these filters.' : 'No items match these filters.'}</div>
      <div className="tree-no-match-actions">
        {focusedId && <button type="button" className="btn btn-secondary" disabled={focusDisabled} onClick={() => focusBranch(null)}>Unfocus</button>}
        <button type="button" className="btn btn-secondary" onClick={onClearFilters}>Clear filters</button>
      </div>
    </div>;
  } else if (model && archivedMode && !rows.length) {
    body = <div className="tree-no-match"><div className="tree-no-match-title">No archived topics in this session.</div></div>;
  } else body = tree;

  // SPEC 11.4: an item shown only because it was opened. The notice floats, so the Map never moves; the row carries the tag.
  const outsideRow = model?.rows.find(row => row.kind === 'item' && row.outside);
  const outsideName = outsideRow?.kind === 'item' ? names.get(outsideRow.item.id) ?? shortLabel(outsideRow.item) : null;
  const outsideFilter = scope ? pickedChips(scope).map(chipLabel).join(', ') : '';
  const outsideNoticeId = JSON.stringify(['tree-outside-filter', route.project_id, route.session_id]);
  const outsideCallbacks = useRef({ resume, clearChips });
  outsideCallbacks.current = { resume, clearChips };
  useEffect(() => () => noticeStore.dismiss(outsideNoticeId), [outsideNoticeId]);
  useEffect(() => {
    if (outsideName === null || bannerDismissed) { noticeStore.dismiss(outsideNoticeId); return; }
    noticeStore.push({ id: outsideNoticeId, icon: 'ph ph-funnel', tone: 'neutral',
      text: `Showing “${outsideName}”, which is outside your filter${outsideFilter ? ` (${outsideFilter})` : ''}.`,
      actions: [{ label: 'Hide it again', dismissOnRun: true, run: () => { outsideCallbacks.current.resume(); } },
        { label: 'Clear filter', dismissOnRun: true, run: () => { outsideCallbacks.current.clearChips(); } }] });
  }, [outsideNoticeId, outsideName, outsideFilter, bannerDismissed]);

  // "↓ Back to “name” ." (SPEC §5.8 8.5): floats over the Map while the selected row is out of view, at the top or above the
  // dock by the side it went; `.` does the same. It covers rows rather than moving them. Not in the Graph.
  const selectedItem = selectedId ? session?.items[selectedId] : undefined;
  const backPill = !graph && selectedEdge && selectedId && selectedItem && <button type="button" className="tree-back" data-edge={selectedEdge}
    aria-label={`Back to “${selectedItem.question}”`} title={`Back to the selected item ( . ) · ${selectedItem.question}`}
    onClick={() => revealSelected(true)}>
    <span className="tree-back-arrow" aria-hidden="true">{selectedEdge === 'above' ? '↑' : '↓'}</span>
    <span className="tree-back-label">Back to “{names.get(selectedId) ?? shortLabel(selectedItem)}”</span><Keycap>.</Keycap></button>;

  // data-session-busy: "true" while the session is loading or a lifecycle change (close, reopen, rename, archive) saves.
  return <MapSearchContext.Provider value={mapSearch}><section className="tree-column" aria-label="Session tree" data-session-status={state.status} data-session-busy={String(lifecycle.busy || !session)} data-kbd={kbd || undefined}
    onKeyDownCapture={event => {
      releaseReveal();
      // The owner's key stops a landing (Q3); a held key's repeats and a bare modifier (the ⌘ of the next ⌘[) do not.
      if (keyStopsLanding(event)) stopLanding();
      keyboardIntent.current = true;
      if (!kbd) setKbd(true);
    }}
    onPointerDownCapture={() => { releaseReveal(); stopLanding(); }}
    onWheelCapture={event => { releaseReveal(); if (scroller.current && wheels.stops(event, scroller.current)) stopLanding(); }}
    onMouseDownCapture={() => { keyboardIntent.current = false; if (kbd) setKbd(false); }}>
    <span role="status" className="tree-unseen-announcement">{noUnseen ? 'No unseen items.' : ''}</span>
    {/* The chip row sits in flow above both the Tree and the Graph (D13); the hold keeps the reading row's viewport place when it opens or closes. */}
    {filterRow}
    {lifecycle.pending && !lineShown && <Banner icon="ph ph-warning" alert actions={<button type="button" className="btn btn-ghost" onClick={lifecycle.reconcile}>Check again</button>}>
      {lifecycle.pending}. Check whether your last change was saved before making another.</Banner>}
    {notices}
    {/* The graph keeps its own scroller (ui/graph/graph.css). */}
    {graphShown ? <DrawnHiddenContext.Provider value={reportGraphHidden}>{graph}</DrawnHiddenContext.Provider> : <div className="tree-scroll-shell">
      <div ref={scroller} className="tree-scroll" data-testid="map-scroll" onScroll={() => {
        // At the held scrollTop this can be our own correction's delayed event; remembering restores any intervening reflow
        // before capturing again, and ends a reveal the owner scrolled away from.
        openingPlacement.current = null; settled.current = true; remembering(); updateEdge();
      }}>{body}</div>
      {backPill}
    </div>}
    {session && <BinDialog session={session} route={route} actions={actions} queue={removals} drafts={drafts} />}
    {lifecycle.dialog}
  </section></MapSearchContext.Provider>;
}
