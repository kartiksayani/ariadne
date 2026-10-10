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
import { OwnerDraftStore, useOwnerDrafts } from '../../state/drafts/store';
import type { SessionActions } from '../../components/bindings/actions';
import { DispatchChip } from '../../components/bindings/DispatchChip';
import { useSupervisorHealth } from '../../components/bindings/health';
import { DispatchDialog } from '../pages/SessionDialogs';
import { useWorkspaceKeys, type WorkspaceIntent } from '../keys';
import { AnswerControl } from '../answer/AnswerControl';
import type { PendingSubmission } from '../answer/useSubmit';
import { notices as noticeStore } from '../pages/notices';
import { chipsOf, closed, collapsedNote, oldestWaiting, parentKey, sessionBar, toggleChip, treeModel, type Chip, type ItemRow as ItemRowModel, type Row } from './model';
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
import { displayStatus } from '../../selectors/waiting/replied';
import { useUnfolded } from './unfold';
import type { RemoveTarget } from '../dialogs/remove';
import { ContinuePicker, continueTargets, openContinueTopic } from '../dialogs/ContinueTopicDialog';
import { useHidden } from '../remove/queue';
import { visibleSession } from '../remove/model';
import { reconnectingNote } from '../shared/connection';
import { useFilterFolds } from '../shared/filterFolds';
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
  readonly railOpen: boolean;
  /** Graph content shown in place of the rows. */
  readonly graph?: ReactNode;
  /** Notices above the rows: stale data, recovery. */
  readonly notices?: ReactNode;
  readonly highlightedItems: ReadonlySet<string>;
  readonly highlightedMessages: ReadonlySet<string>;
  readonly summaries: readonly Immutable<SessionSummary>[];
  readonly now?: () => number;
  readonly onHoverItem: (itemId: string | null) => void;
  /** The tree selected an item; open its detail. */
  readonly onSelected: (result: RevealedItem) => void;
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
/** Where the tree holds still while the view settles: a row centred, or a row at a fixed offset from the top. */
interface Anchor { readonly key: string; readonly offset: number | null }
const SKELETON = [
  { pad: 12, width: '38%', badge: 0, top: 16 }, { pad: 36, width: '64%', badge: 64, top: 12 }, { pad: 36, width: '52%', badge: 64, top: 12 },
  { pad: 60, width: '58%', badge: 84, top: 12 }, { pad: 36, width: '70%', badge: 64, top: 12 }, { pad: 12, width: '30%', badge: 0, top: 24 },
  { pad: 36, width: '60%', badge: 64, top: 12 }, { pad: 60, width: '48%', badge: 96, top: 12 },
];

export function TreeView(props: TreeViewProps) {
  const { navigation, store, actions, drafts, query, reveal, selectedId, detailOpen, railOpen, graph, notices, highlightedItems, highlightedMessages,
    summaries, onHoverItem, onSelected, onDismissReveal, onResume, onAct, onClearFilters, onClearSearch, onShowArchive,
    onAgentNotRunning, onRemove } = props;
  const state = useSession(store), raw = state.snapshot?.session ?? null;
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
  const later = useMemo(() => new Set(preferences?.later.filter(item => item.project_id === route.project_id && item.session_id === route.session_id)
    .map(item => item.item_id) ?? []), [preferences, route.project_id, route.session_id]);
  const savedFolds = view?.collapsed_topic_ids;
  const closedTopics = useMemo(() => new Set(savedFolds ?? []), [savedFolds]);
  const hiddenFocus = useRef<string | null>(null);
  const [expandedHiddenGroups, setExpandedHiddenGroups] = useState<ReadonlySet<string>>(new Set());
  const [focusKey, setFocusKey] = useState<string | null>(selectedId);
  const [kbd, setKbd] = useState(false);
  const [answering, setAnswering] = useState<string | null>(null);
  const [continuing, setContinuing] = useState<string | null>(null);
  const [replying, setReplying] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  useOwnerDrafts(drafts, raw);
  const lifecycle = useLifecycle(actions);
  const ack = useAck(actions, selectedId);
  const elements = useRef(new Map<string, HTMLDivElement>()), scroller = useRef<HTMLDivElement>(null);
  const mounted = useRef(true), request = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++request.current; }; }, [store]);
  // Unmounting or swapping the rows for the graph leaves no row to fire mouseleave.
  const graphShown = !!graph;
  useEffect(() => () => onHoverItem(null), [onHoverItem, graphShown]);

  const minute = Math.floor((props.now ?? Date.now)() / 60_000) * 60_000;
  const binding = session?.active_binding_id ? session.bindings[session.active_binding_id] ?? null : null;
  const presence = binding ? state.presence[binding.id] ?? null : null;
  const health = useSupervisorHealth(actions.service, binding?.id, binding?.generation);
  const revealId = reveal?.kind === 'item' ? reveal.route.item_id : null;
  const temporary = reveal?.kind === 'item' ? reveal.temporaryExpandedItemIds : null;
  const model = useMemo(() => session && view ? treeModel({ session, view, search: query, later, collapsedTopics: closedTopics, selectedId, revealId,
    filterCollapsedItemIds: filterFolds.items, filterCollapsedTopicIds: filterFolds.topics,
    expandedHiddenGroups, temporaryExpanded: temporary ?? [], presence, health, summaries, now: minute }) : null,
  [session, view, query, expandedHiddenGroups, later, closedTopics, filterFolds.items, filterFolds.topics, selectedId, revealId, temporary, presence, health, summaries, minute]);
  const summary = summaries.find(value => value.project_id === route.project_id && value.session_id === route.session_id) ?? null;
  const bar = sessionBar(session, summary, presence);
  const rows = useMemo(() => model?.rows ?? [], [model]);
  const sections = useMemo(() => {
    const groups: { topic: Extract<Row, { kind: 'topic' }>; items: Exclude<Row, { kind: 'topic' }> [] }[] = [];
    for (const row of rows) {
      if (row.kind === 'topic') groups.push({ topic: row, items: [] });
      else groups.at(-1)?.items.push(row);
    }
    return groups;
  }, [rows]);
  const latest = useRef({ view, preferences, rows, session });
  latest.current = { view, preferences, rows, session };

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
  const select = (id: string, fromRow = true) => {
    if (viewBusy) return;
    const call = ++request.current;
    setFocusKey(id);
    noticeStore.dismiss('tree-reveal-failed');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const loading = () => new OwnFailure({ code: 'snapshot_changed', message: "Ariadne is still loading this session's latest changes. Try again.", hint: '', retryable: true, field_errors: [] });
    const reveal = async () => {
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
      // Opening the clicked row holds still; a preview link reveals a different row.
      clickedReveal.current = fromRow ? result : null;
      onSelected(result);
      if (result.kind === 'item' && latest.current.view?.selected_item_id !== id) void saveView(next => { next.selected_item_id = id; });
    }).catch((error: unknown) => {
      if (!mounted.current || call !== request.current) return;
      noticeStore.push({ id: 'tree-reveal-failed', icon: 'ph ph-warning-circle', iconColor: 'var(--a-danger)', dismissible: true,
        text: `Item #${id} could not be opened. ${plainFailure(error, 'Try again.')}` });
    }).finally(() => { clearTimeout(timeout); });
  };
  const toggleItem = (id: string) => {
    const row = latest.current.rows.find(value => value.key === id);
    if (!row || row.kind !== 'item' || !row.hasKids) return;
    if (model?.filtering) filterFolds.setFold('items', id, row.expanded);
    if (row.expanded) onDismissReveal();
    void saveView(next => {
      const expanded = new Set(next.expanded_item_ids);
      if (row.expanded) expanded.delete(id); else expanded.add(id);
      next.expanded_item_ids = [...expanded];
    });
  };
  const toggleTopic = (id: string) => {
    const expanded = latest.current.rows.find(row => row.kind === 'topic' && row.key === id)?.expanded ?? !closedTopics.has(id);
    if (expanded) onDismissReveal();
    if (model?.filtering) filterFolds.setFold('topics', id, expanded);
    const next = new Set(closedTopics);
    if (expanded) next.add(id); else next.delete(id);
    const kept = [...next].slice(-FOLDS_KEPT);
    void saveView(saved => { saved.collapsed_topic_ids = kept; });
  };
  const setChip = (chip: Chip) => {
    onDismissReveal();
    void saveView(next => { next.filters.statuses = toggleChip(next.filters.statuses, chip); });
  };
  const resume = () => {
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
  const blocked = session?.archived_at != null ? 'This session is archived. Restore it, then reopen it to answer.'
    : session?.state !== 'active' ? 'This session is closed. Reopen it to answer.'
    : bar?.connection === 'reconnecting' ? reconnectingNote(bar.agent) : null;
  const focusRow = (key: string) => { setFocusKey(key); elements.current.get(key)?.focus({ preventScroll: true }); };
  const send = (change: { selected_option_id: string | null; text: string }) => {
    if (!entry || entry.saving || blocked) return;
    const id = entry.draft.op_id, itemKey = answering, item = answerRow?.item;
    // The change is saved only when the input goes out: a cancelled "not running" dialog keeps the draft as typed.
    const submit = () => { drafts.edit(id, change); return drafts.submit(id).then(saved => {
      if (saved && mounted.current) {
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
    warn={entry?.error ? plainFailure(entry.error) : undefined} blocked={blocked ?? undefined} locked={!entry || entry.saving}
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
    answer: onRow((row, _index, _intent, event) => {
      if (row.kind === 'item' && session && ackTarget(session, row.item)) {
        if (!event.repeat) {
          if (viewBusy) noticeStore.push({ id: 'tree-ack-view-saving', icon: 'ph ph-warning-circle', dismissible: true,
            text: 'Another view change is being saved. Wait for it, then try Ack again.' });
          else void ack.run(row.item.id);
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
  // scrollToSel (Ariadne.dc.html:990): centre on open and on a reveal, else keep the focus in view.
  const center = (key: string | null) => {
    const box = scroller.current, element = key ? elements.current.get(key) : undefined;
    if (!box || !element) return;
    const a = box.getBoundingClientRect(), b = element.getBoundingClientRect();
    box.scrollTop += (b.top + Math.min(b.height, 120) / 2) - (a.top + headerHeight(element) + (a.height - headerHeight(element)) / 2);
  };
  // Puts the anchor row back where it belongs: centred, or at its saved offset from the top.
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
    const top = a.top + headerHeight(element) + margin;
    if (b.top < top) box.scrollTop -= top - b.top;
    else if (b.bottom > a.bottom - margin) box.scrollTop += Math.min(b.bottom - a.bottom + margin, b.top - top);
  };
  const inView = (key: string) => {
    const box = scroller.current, element = elements.current.get(key);
    if (!box || !element) return false;
    const a = box.getBoundingClientRect(), b = element.getBoundingClientRect();
    return b.top >= a.top + headerHeight(element) && b.top + Math.min(b.height, 120) <= a.bottom;
  };
  const centered = useRef(false), settled = useRef(false);
  // Show more / Show less on a long preview. The owner is steering, so the view stops holding its anchor; folding
  // a preview the owner has read down to its end keeps that row's top in sight rather than leaving the tree below it.
  const { isUnfolded, toggle: toggleUnfolded } = useUnfolded(route.project_id, route.session_id);
  const folding = useRef<string | null>(null);
  const unfold = (id: string) => {
    settled.current = true;
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
    centered.current = true;
    const key = revealId ?? selectedId, saved = latest.current.view?.scroll;
    // A saved reading position wins over centring the selection; only a reveal overrides it.
    const restored: Anchor | null = !revealId && saved?.item_id && elements.current.has(saved.item_id) ? { key: saved.item_id, offset: saved.offset } : null;
    let target: Anchor | null = restored ?? (key ? { key, offset: null } : null);
    place(target);
    // The open item stays in sight: a reading position that leaves it off-screen gives way to centring it.
    if (restored && key && detailOpen && !inView(key)) { target = { key, offset: null }; place(target); }
    setAnchor(target);
    // Web fonts change row heights after this first layout; the anchor row holds its place through them.
    void document.fonts?.ready.then(() => { if (mounted.current && !settled.current) place(target); });
    // Only the first rows of this session view place the anchor; later changes keep the reading position.
  }, [rows.length, graph]);
  const previousSelection = useRef({ reveal, selectedId, detailOpen, railOpen });
  useLayoutEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = { reveal, selectedId, detailOpen, railOpen };
    if (!centered.current || graph) return;
    const selectionChanged = selectedId !== previous.selectedId || (reveal?.kind === 'item' && reveal !== previous.reveal);
    const panelOpened = (detailOpen && !previous.detailOpen) || (railOpen && !previous.railOpen);
    const id = reveal?.kind === 'item' ? reveal.route.item_id : selectedId;
    if (!id || (!selectionChanged && !panelOpened)) return;
    const clicked = clickedReveal.current;
    // A tree click's immediate selection and its workspace reveal echo share the same result.
    const clickEcho = selectionChanged && clicked?.kind === 'item' && clicked.route.item_id === id
      && (reveal === clicked || reveal === previous.reveal);
    if (!clickEcho && !inView(id)) {
      settled.current = true; nearest(id); setAnchor(null);
    }
    if (reveal?.kind === 'item' && reveal !== previous.reveal) { setKbd(false); focusRow(id); }
  }, [reveal, selectedId, detailOpen, railOpen, graph]);
  // The prototype re-centres a while after mount (Ariadne.dc.html:976); here the anchor row stays put
  // while the view settles (fonts loading, detail or rail opening, rows arriving or folding, the row's
  // answer opening) until the owner scrolls, clicks in the tree or moves the focus.
  useEffect(() => {
    const box = scroller.current, row = anchor ? elements.current.get(anchor.key) : undefined;
    if (!box || !anchor || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { if (!settled.current) place(anchor); });
    const content = box.querySelector('.tree-rows');
    observer.observe(box); if (row) observer.observe(row); if (content) observer.observe(content);
    const settle = () => { settled.current = true; };
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
  const held = useRef<{ readonly key: string; readonly offset: number; readonly scrollTop: number } | null>(null);
  const placed = useRef<Anchor | null>(null);
  placed.current = anchor;
  const remembering = () => {
    const box = scroller.current;
    if (!box) { held.current = null; return; }
    const top = readingTop(), list = latest.current.rows.filter(row => row.kind === 'item');
    // Rows are stacked in order, so the first one ending below the tree's top is found by halving.
    let low = 0, high = list.length;
    while (low < high) {
      const middle = (low + high) >> 1, element = elements.current.get(list[middle]!.key);
      if (!element || element.getBoundingClientRect().bottom > top) high = middle; else low = middle + 1;
    }
    const key = list[low]?.key, element = key ? elements.current.get(key) : undefined;
    held.current = key && element ? { key, offset: element.getBoundingClientRect().top - top, scrollTop: box.scrollTop } : null;
  };
  const holding = () => {
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
    const first = latest.current.rows.find(row => row.kind === 'item' && (elements.current.get(row.key)?.getBoundingClientRect().bottom ?? -Infinity) > top);
    const element = first && elements.current.get(first.key);
    if (!first || !element) return;
    // Save in the same target-header coordinates used by place, even during topic push-out.
    const scroll = { item_id: first.key, offset: element.getBoundingClientRect().top - box.getBoundingClientRect().top - headerHeight(element) }, current = latest.current.view?.scroll;
    if (current?.item_id !== scroll.item_id || current.offset !== scroll.offset) void saveView(next => { next.scroll = scroll; });
  };

  const selectedForResize = useRef(selectedId);
  selectedForResize.current = selectedId;
  const previousQuery = useRef(query);
  const topicKeys = JSON.stringify(sections.map(section => section.topic.key));
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box || graph) return;
    const keepSelected = () => {
      const id = selectedForResize.current;
      if (id && !inView(id)) nearest(id);
    };
    if (previousQuery.current !== query) keepSelected();
    previousQuery.current = query;
    if (!query || typeof ResizeObserver === 'undefined') return;
    const selectedHeaderHeight = () => {
      const element = selectedForResize.current ? elements.current.get(selectedForResize.current) : undefined;
      return element ? headerHeight(element) : 0;
    };
    let height = box.getBoundingClientRect().height, topicHeight = selectedHeaderHeight();
    // The search line changes the viewport; a wrapped sticky topic changes its reading top.
    const observer = new ResizeObserver(() => {
      const next = box.getBoundingClientRect().height, nextTopic = selectedHeaderHeight();
      if (next !== height || nextTopic !== topicHeight) { height = next; topicHeight = nextTopic; keepSelected(); }
    });
    observer.observe(box);
    box.querySelectorAll('.tree-topic').forEach(header => observer.observe(header));
    return () => observer.disconnect();
  }, [query, graph, topicKeys]);

  // ------------------------------------------------------------ rows
  const running = bar?.running ?? false;
  const touchedMessage = highlightedMessages.size && session ? session.messages.find(message => highlightedMessages.has(message.id))?.number ?? null : null;
  const itemActions = (row: ItemRowModel): RowAction[] => {
    const item = row.item, target = { ...route, item_id: item.id }, list: RowAction[] = [];
    const ackTo = row.ack;
    if (ackTo) list.push({ icon: 'ph ph-check', title: ackTitle(ackTo, item.status), persistent: true, disabled: viewBusy || ack.busy, run: () => { void ack.run(item.id); } });
    const act = (intent: RowIntent) => () => onAct(intent, target, result => { clickedReveal.current = result; });
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
  const tree = model && rows.length > 0 && <ItemRefs.Provider value={{ lookup: id => {
    const item = session?.items[id];
    return item && session && !itemRemoved(session, item.id) ? { label: shortLabel(item), status: displayStatus(session, item) } : null;
  }, onOpenItem: id => select(id, false) }}><div role="tree" aria-label="Session items" aria-busy={state.status === 'loading'} className="tree-rows" onBlur={saveScroll}>
    {sections.map(({ topic: row, items }) => <div key={row.key} className="tree-topic-group" role="presentation">
      <TopicRow row={row} focused={focusKey === row.key} actions={topicActions(row)}
        prompt={row.allClosed && !archivedMode ? () => lifecycle.archive(row.topic.id) : null}
        remember={remember} onFocus={setFocusKey} onKeyDown={keys} onToggle={toggleTopic}
        reply={replying === row.topic.id && !archivedMode ? <TopicReply drafts={drafts} store={store} actions={actions} topicId={row.topic.id}
          agent={bar?.agent ?? 'the agent'} onClose={() => { setReplying(null); focusRow(row.key); }} /> : null} fix={fixOf(row)} />
      {items.map(row => row.kind === 'hidden'
        ? <HiddenRow key={row.key} row={row} focused={focusKey === row.key} remember={remember} onFocus={setFocusKey} onKeyDown={keys} onToggle={toggleHiddenGroup} />
        : <ItemRow key={row.key} row={row} selected={selectedId === row.key} focused={focusKey === row.key} disabled={viewBusy}
        highlight={highlightedItems.has(row.key) ? 'strong' : row.collapsed?.ids.some(id => highlightedItems.has(id)) ? 'weak' : null}
        note={row.collapsed ? collapsedNote(row.collapsed, { items: highlightedItems, message: touchedMessage }) : null}
        actions={itemActions(row)} answer={answering === row.key ? answerControl : null} fix={fixOf(row)}
        unfolded={isUnfolded(row.key)} onUnfold={unfold}
        remember={remember} onFocus={setFocusKey} onKeyDown={keys} onSelect={select} onToggle={toggleItem} onJump={id => select(id, false)} onHover={onHoverItem} />)}
      {session && <AgentBin session={session} actions={actions} topicId={row.topic.id} onRemove={onRemove} />}
    </div>)}
  </div></ItemRefs.Provider>;

  const loading = !session && state.status === 'loading';
  // Stopped deliveries answered on a row the owner can see; the recovery banner lists the rest
  // (none in the graph, which has no rows; a filtered-out or folded row is not here).
  const inline: ReadonlySet<string> = new Set(graph && !loading ? [] : rows.flatMap(row => row.delivery?.stuck ? [row.delivery.stuck.input.id] : []));
  const filtersShown = !archivedMode;
  const counts = model?.counts ?? { all: 0, waiting: 0, open: 0, progress: 0, closed: 0 };
  const archived = lifecycle.archived;
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

  return <section className="tree-column" aria-label="Session tree" data-session-status={state.status} data-kbd={kbd || undefined}
    onKeyDownCapture={() => { if (!kbd) setKbd(true); }} onMouseDownCapture={() => { if (kbd) setKbd(false); }}>
    {bar && !archivedMode && <SessionBar bar={bar} busy={lifecycle.busy || !session} onClose={lifecycle.session}
      onRename={session ? lifecycle.rename : undefined}
      dispatch={<DispatchChip actions={actions} onDetails={() => setSending(true)} />} />}
    {sending && <DispatchDialog store={actions.session} actions={actions} agent={bar?.agent ?? 'the agent'} onClose={() => setSending(false)} />}
    {filtersShown && <FilterBar chips={model?.chips ?? chipsOf([])} counts={counts}
      disabled={nav.pendingOperationId !== null && !nav.writing} dismissKey={route.session_id} onChip={setChip} />}
    {model && !graph && (!!query || !model.chips.has('all')) && <Banner icon={query ? 'ph ph-magnifying-glass' : 'ph ph-funnel'} actions={<><span aria-hidden="true">·</span><button type="button" className="btn btn-ghost" disabled={nav.writing || nav.pendingOperationId !== null} onClick={query ? onClearSearch : onClearFilters}>{query ? 'Clear search' : 'Clear filters'}</button></>}>
      Showing {model.searchCount} of {model.itemCount} items{query ? ` matching “${query}”` : ''}{model.hiddenCount > 0 ? ` (${model.hiddenCount} hidden)` : ''}{!model.chips.has('all') ? ' in the statuses you picked' : ''}</Banner>}
    {model?.outside && <Banner icon="ph ph-funnel" actions={<button type="button" className="btn btn-ghost" onClick={resume}>Resume filtered view</button>}>
      Showing an item outside your current filters.</Banner>}
    {archived && <Banner icon="ph ph-archive" actions={<>
      <button type="button" className="btn btn-ghost" disabled={lifecycle.busy} onClick={lifecycle.undo}>Undo</button>
      <button type="button" className="btn btn-ghost" onClick={() => { lifecycle.dismiss(); onShowArchive(); }}>View archive</button></>}>
      Archived “{archived.name}”.{archived.waiting ? ` Its ${archived.waiting} waiting question${archived.waiting > 1 ? 's' : ''} left your panel.` : ''}
      {archived.cancelled ? ` ${archived.cancelled} unsent message${archived.cancelled > 1 ? 's were' : ' was'} cancelled.` : ''}</Banner>}
    {lifecycle.pending && <Banner icon="ph ph-warning" alert actions={<button type="button" className="btn btn-ghost" onClick={lifecycle.reconcile}>Check again</button>}>
      {lifecycle.pending}. Check whether your last change was saved before making another.</Banner>}
    {ack.error && <Banner icon="ph ph-warning-circle" alert>{ack.error}</Banner>}
    {lifecycle.error && <Banner icon="ph ph-warning-circle" alert>{lifecycle.error}</Banner>}
    <InlineRecovery.Provider value={inline}>{notices}</InlineRecovery.Provider>
    {/* The graph keeps its own scroller so its legend stays sticky (ui/graph/graph.css). */}
    {graph && !loading ? graph : <div ref={scroller} className="tree-scroll" onScroll={remembering}>{body}</div>}
    {session && <AgentBin session={session} actions={actions} onRemove={onRemove} />}
    {lifecycle.dialog}
    {continuing && <ContinuePicker topicName={session?.topics[continuing]?.name ?? 'this topic'} targets={continueTargets(route, summaries)}
      onCancel={() => setContinuing(null)}
      onPick={target => { setContinuing(null); openContinueTopic({ source: route, topicId: continuing, target }); }} />}
  </section>;
}
