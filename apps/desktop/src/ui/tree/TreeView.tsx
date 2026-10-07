// The session tree column (handoff "Session tree"): session bar, status chips,
// banners, topic bands and item rows, with the tree keyboard, inline answering
// and the empty and loading states. Selection, expansion and filters persist
// through navigation's preference writer; topic collapse is local.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useSession, type Immutable, type SessionStore } from '../../data';
import type { RevealedItem } from '../../data/routes';
import type { ItemRoute, SessionPreferences, SessionRef } from '../../generated/core';
import type { SessionSummary } from '../../generated/domain/models';
import { NavigationStore, useNavigation } from '../../state/navigation/store';
import { OwnerDraftStore, useOwnerDrafts } from '../../state/drafts/store';
import type { SessionActions } from '../../components/bindings/actions';
import { ContinueDialog, type ContinueTarget } from '../../components/history-actions/ContinueDialog';
import { useWorkspaceKeys, type WorkspaceIntent } from '../keys';
import { AnswerControl } from '../answer/AnswerControl';
import { CHIPS, collapsedNote, oldestWaiting, parentKey, sessionBar, treeModel, type Chip, type ItemRow as ItemRowModel, type Row } from './model';
import { ItemRow, type RowAction } from './ItemRow';
import { TopicRow, type TopicAction } from './TopicRow';
import { Banner, SessionBar } from './SessionBar';
import { FilterBar } from './FilterBar';
import { useLifecycle } from './Lifecycle';
import './tree.css';

export type RowIntent = 'bring' | 'reply' | 'drop' | 'note' | 'followup' | 'reopen' | 'later';
export interface TreeViewProps {
  readonly navigation: NavigationStore;
  readonly store: SessionStore;
  readonly actions: SessionActions;
  readonly drafts: OwnerDraftStore;
  /** The header search as typed. */
  readonly query: string;
  /** An item revealed from a link or the waiting panel; null once dismissed. */
  readonly reveal: RevealedItem | null;
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
  readonly continueTargets: readonly ContinueTarget[];
  readonly actionsForTarget: (route: SessionRef) => SessionActions;
  readonly now?: () => number;
  readonly onHoverItem: (itemId: string | null) => void;
  /** The tree selected an item; open its detail. */
  readonly onSelected: (result: RevealedItem) => void;
  readonly onDismissReveal: () => void;
  /** "Resume filtered view": drop the reveal and close its detail. */
  readonly onResume: () => void;
  readonly onAct: (intent: RowIntent, target: ItemRoute) => void;
  readonly onClearFilters: () => void;
  readonly onShowArchive: () => void;
  readonly revealItem: (route: ItemRoute) => void;
  readonly openSession: (route: SessionRef) => void;
  /** TODO(WP6): ask, then remove. A no-op until the remove command lands. */
  readonly onRemove: () => void;
}

// Topic collapse is presentation only and is not persisted; it lasts for the app run.
const collapsedTopics = new Map<string, ReadonlySet<string>>();
const SKELETON = [
  { pad: 12, width: '38%', badge: 0, top: 16 }, { pad: 36, width: '64%', badge: 64, top: 12 }, { pad: 36, width: '52%', badge: 64, top: 12 },
  { pad: 60, width: '58%', badge: 84, top: 12 }, { pad: 36, width: '70%', badge: 64, top: 12 }, { pad: 12, width: '30%', badge: 0, top: 24 },
  { pad: 36, width: '60%', badge: 64, top: 12 }, { pad: 60, width: '48%', badge: 96, top: 12 },
];

export function TreeView(props: TreeViewProps) {
  const { navigation, store, actions, drafts, query, reveal, selectedId, detailOpen, railOpen, graph, notices, highlightedItems, highlightedMessages,
    summaries, continueTargets, actionsForTarget, onHoverItem, onSelected, onDismissReveal, onResume, onAct, onClearFilters, onShowArchive,
    revealItem, openSession, onRemove } = props;
  const state = useSession(store), session = state.snapshot?.session ?? null;
  const nav = useNavigation(navigation), preferences = nav.preferences;
  const route = state.route, routeId = `${route.project_id}/${route.session_id}`;
  const view = preferences?.sessions.find(value => value.session.project_id === route.project_id && value.session.session_id === route.session_id) ?? null;
  const busy = nav.writing || nav.pendingOperationId !== null || state.status !== 'ready';
  const archivedMode = view?.filters.archived ?? false;
  const later = useMemo(() => new Set(preferences?.later.filter(item => item.project_id === route.project_id && item.session_id === route.session_id)
    .map(item => item.item_id) ?? []), [preferences, route.project_id, route.session_id]);
  const [closedTopics, setClosedTopics] = useState<ReadonlySet<string>>(() => collapsedTopics.get(routeId) ?? new Set());
  const [focusKey, setFocusKey] = useState<string | null>(selectedId);
  const [kbd, setKbd] = useState(false);
  const [answering, setAnswering] = useState<string | null>(null);
  const [continuing, setContinuing] = useState<string | null>(null);
  useOwnerDrafts(drafts);
  const lifecycle = useLifecycle(actions, { revealItem, openSession });
  const elements = useRef(new Map<string, HTMLDivElement>()), scroller = useRef<HTMLDivElement>(null);
  const mounted = useRef(true), request = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++request.current; }; }, []);
  // Unmounting or swapping the rows for the graph leaves no row to fire mouseleave.
  const graphShown = !!graph;
  useEffect(() => () => onHoverItem(null), [onHoverItem, graphShown]);

  const minute = Math.floor((props.now ?? Date.now)() / 60_000) * 60_000;
  const binding = session?.active_binding_id ? session.bindings[session.active_binding_id] ?? null : null;
  const presence = binding ? state.presence[binding.id] ?? null : null;
  const revealId = reveal?.kind === 'item' ? reveal.route.item_id : null;
  const temporary = reveal?.kind === 'item' ? reveal.temporaryExpandedItemIds : null;
  const model = useMemo(() => session && view ? treeModel({ session, view, search: query, later, collapsedTopics: closedTopics, selectedId, revealId,
    temporaryExpanded: temporary ?? [], presence, summaries, now: minute }) : null,
  [session, view, query, later, closedTopics, selectedId, revealId, temporary, presence, summaries, minute]);
  const summary = summaries.find(value => value.project_id === route.project_id && value.session_id === route.session_id) ?? null;
  const bar = sessionBar(session, summary, minute, presence);
  const rows = useMemo(() => model?.rows ?? [], [model]);
  const latest = useRef({ view, preferences, rows, session });
  latest.current = { view, preferences, rows, session };

  // ------------------------------------------------------------ writes
  const saveView = (change: (next: SessionPreferences) => void) => {
    const { view: current, preferences: revision } = latest.current, snapshot = navigation.getSnapshot();
    if (!current || !revision || snapshot.writing || snapshot.pendingOperationId !== null) return Promise.resolve(false);
    const next = structuredClone(current) as SessionPreferences; change(next);
    return navigation.saveSessionView(next, revision.revision);
  };
  const select = (id: string) => {
    if (busy) return;
    const call = ++request.current;
    setFocusKey(id);
    void navigation.routes.revealItem({ ...route, item_id: id }).then(result => {
      if (!mounted.current || call !== request.current || !result) return;
      onSelected(result);
      if (result.kind === 'item' && latest.current.view?.selected_item_id !== id) void saveView(next => { next.selected_item_id = id; });
    }).catch(() => {});
  };
  const toggleItem = (id: string) => {
    const row = latest.current.rows.find(value => value.key === id);
    if (!row || row.kind !== 'item' || !row.hasKids || model?.filtering) return;
    void saveView(next => {
      const expanded = new Set(next.expanded_item_ids);
      if (row.expanded) expanded.delete(id); else expanded.add(id);
      next.expanded_item_ids = [...expanded];
    }).then(saved => { if (saved && row.expanded) onDismissReveal(); });
  };
  const toggleTopic = (id: string) => {
    if (!closedTopics.has(id)) onDismissReveal();
    setClosedTopics(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      collapsedTopics.set(routeId, next);
      return next;
    });
  };
  const setChip = (chip: Chip) => {
    onDismissReveal();
    void saveView(next => { next.filters.statuses = [...CHIPS.find(value => value.chip === chip)!.statuses]; });
  };
  const setTopic = (topicId: string | null) => { onDismissReveal(); void saveView(next => { next.filters.topic_id = topicId; }); };
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
  const blocked = session?.state !== 'active' ? 'This session is closed. Reopen it to answer.'
    : binding?.connection_state === 'reconnecting' ? `Reconnecting to ${bar?.agent ?? 'the agent'}. Your choice is kept; sending resumes when the connection is back.` : null;
  const focusRow = (key: string) => { setFocusKey(key); elements.current.get(key)?.focus({ preventScroll: true }); };
  const send = (change: { selected_option_id: string | null; text: string }) => {
    if (!entry || entry.saving || blocked) return;
    const id = entry.draft.op_id, itemKey = answering;
    drafts.edit(id, change);
    void drafts.submit(id).then(saved => {
      if (!saved || !mounted.current) return;
      setAnswering(current => current === itemKey ? null : current);
      if (itemKey) focusRow(itemKey);
    });
  };
  const sendOption = (index: number) => { const option = options[index]; if (option) send({ selected_option_id: option.id, text: '' }); };
  const answerControl = answerRow ? <AnswerControl variant="full" selected={chosen} draft={entry?.draft.text ?? ''}
    options={options.map(option => ({ id: option.id, label: option.label, consequence: option.consequence, recommended: option.recommended }))}
    warn={entry?.error?.message} blocked={blocked ?? undefined} locked={!entry || entry.saving}
    onSelect={index => { if (entry && options[index]) drafts.edit(entry.draft.op_id, { selected_option_id: options[index].id }); focusRow(answerRow.key); }}
    onDraft={text => { if (entry) drafts.edit(entry.draft.op_id, { text }); }}
    onSendOption={sendOption} onSendText={text => send({ selected_option_id: null, text })}
    onEscape={() => { setAnswering(null); focusRow(answerRow.key); }} /> : null;
  useEffect(() => { if (answering && !answerRow) setAnswering(null); }, [answering, answerRow]);

  // ------------------------------------------------------------ keyboard
  const onRow = (act: (row: Row, index: number, intent: WorkspaceIntent) => boolean | void) => (intent: WorkspaceIntent, event: KeyboardEvent<HTMLDivElement>) => {
    const visible = latest.current.rows, index = visible.findIndex(row => row.key === event.currentTarget.dataset.row);
    return index >= 0 ? act(visible[index], index, intent) : false;
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
      if (row.kind === 'topic' && !row.expanded) toggleTopic(row.topic.id);
      else if (row.kind === 'item' && row.hasKids && !row.expanded) toggleItem(row.item.id);
      else if (row.expanded && next && next.depth > row.depth) focusRow(next.key);
      return true;
    }),
    fold: onRow(row => {
      if (row.kind === 'topic') { if (row.expanded) toggleTopic(row.topic.id); return true; }
      if (row.hasKids && row.expanded && !model?.filtering) { toggleItem(row.item.id); return true; }
      const parent = parentKey(row);
      if (parent && latest.current.rows.some(value => value.key === parent)) focusRow(parent);
      return true;
    }),
    enter: onRow(row => {
      if (row.kind === 'topic') { toggleTopic(row.topic.id); return true; }
      if (answering === row.key && chosen >= 0) { sendOption(chosen); return true; }
      select(row.item.id); return true;
    }),
    answer: onRow(row => {
      if (answerable(row)) { if (answering === row.key) setAnswering(null); else openAnswer(row.key); return true; }
      const oldest = session ? oldestWaiting(session) : null, target = oldest ? latest.current.rows.find(value => value.key === oldest.id) : undefined;
      if (!answerable(target)) return false;
      focusRow(target.key); openAnswer(target.key); return true;
    }),
    choose: onRow((row, _index, intent) => {
      if (row.kind === 'topic') return true;
      if (answering !== row.key || intent.kind !== 'choose') return false;
      if (entry && options[intent.index]) drafts.edit(entry.draft.op_id, { selected_option_id: options[intent.index].id });
      return true;
    }),
    escape: onRow(row => { if (answering !== row.key) return false; setAnswering(null); return true; }),
    archive: onRow(row => {
      const topicId = row.kind === 'topic' ? row.topic.id : row.item.topic_id;
      if (archivedMode) lifecycle.restore(topicId); else lifecycle.archive(topicId);
      return true;
    }),
    bring: topicOnly, respond: topicOnly, drop: topicOnly, reopen: topicOnly, later: topicOnly,
  }, { scope: 'row' });

  // ------------------------------------------------------------ focus and scroll
  const remember = useRef((key: string, element: HTMLDivElement | null) => {
    if (element) elements.current.set(key, element); else elements.current.delete(key);
  }).current;
  useEffect(() => { if (selectedId) setFocusKey(selectedId); }, [selectedId]);
  useLayoutEffect(() => {
    if (!rows.length || (focusKey && rows.some(row => row.key === focusKey))) return;
    let candidate: string | null = focusKey && session?.items[focusKey] ? session.items[focusKey]!.parent ?? session.items[focusKey]!.topic_id : null;
    while (candidate && !rows.some(row => row.key === candidate)) candidate = session?.items[candidate]?.parent ?? session?.items[candidate]?.topic_id ?? null;
    const next = candidate ?? rows[0].key, hadFocus = !!scroller.current?.contains(document.activeElement);
    setFocusKey(next);
    if (hadFocus) elements.current.get(next)?.focus({ preventScroll: true });
  }, [rows, focusKey, session]);
  // scrollToSel (Ariadne.dc.html:990): centre on open and on a reveal, else keep the focus in view.
  const center = (key: string | null) => {
    const box = scroller.current, element = key ? elements.current.get(key) : undefined;
    if (!box || !element) return;
    const a = box.getBoundingClientRect(), b = element.getBoundingClientRect();
    box.scrollTop += (b.top + Math.min(b.height, 120) / 2) - (a.top + a.height / 2);
  };
  const centered = useRef(false), settled = useRef(false);
  const [anchor, setAnchor] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (centered.current || !rows.length || graph) return;
    centered.current = true;
    const key = revealId ?? selectedId, saved = latest.current.view?.scroll, box = scroller.current;
    const restored = !key && saved?.item_id ? elements.current.get(saved.item_id) : undefined;
    if (box && restored) box.scrollTop += restored.getBoundingClientRect().top - box.getBoundingClientRect().top - saved!.offset;
    center(key); setAnchor(key);
    void document.fonts?.ready.then(() => { if (mounted.current && !settled.current) center(key); });
    // Only the first rows of this session view centre; later changes keep the reading position.
  }, [rows.length, graph]);
  useLayoutEffect(() => {
    if (reveal?.kind !== 'item' || !centered.current) return;
    settled.current = false; center(reveal.route.item_id); setAnchor(reveal.route.item_id);
  }, [reveal]);
  // The prototype re-centres a while after mount (Ariadne.dc.html:976); here the centred row stays put
  // while the view settles (detail or rail opening, rows arriving or folding, the row's answer opening)
  // until the owner scrolls, clicks in the tree or moves the focus.
  useEffect(() => {
    const box = scroller.current, row = anchor ? elements.current.get(anchor) : undefined;
    if (!box || !anchor || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { if (!settled.current) center(anchor); });
    const content = box.querySelector('.tree-rows');
    observer.observe(box); if (row) observer.observe(row); if (content) observer.observe(content);
    const settle = () => { settled.current = true; };
    box.addEventListener('wheel', settle, { passive: true }); box.addEventListener('pointerdown', settle);
    return () => { observer.disconnect(); box.removeEventListener('wheel', settle); box.removeEventListener('pointerdown', settle); };
  }, [anchor]);
  useLayoutEffect(() => {
    const box = scroller.current, element = focusKey ? elements.current.get(focusKey) : undefined;
    if (!box || !element || !kbd) return;
    if (focusKey !== anchor) settled.current = true;
    const a = box.getBoundingClientRect(), b = element.getBoundingClientRect();
    if (b.top < a.top + 8) box.scrollTop -= a.top + 8 - b.top;
    else if (b.bottom > a.bottom - 8) box.scrollTop += Math.min(b.bottom - a.bottom + 8, b.top - a.top - 8);
  }, [focusKey]);
  // Leaving the tree saves the first visible row as the session's reading position.
  const saveScroll = (event: FocusEvent<HTMLDivElement>) => {
    const box = scroller.current;
    if (!box || event.currentTarget.contains(event.relatedTarget)) return;
    const top = box.getBoundingClientRect().top;
    const first = latest.current.rows.find(row => row.kind === 'item' && (elements.current.get(row.key)?.getBoundingClientRect().bottom ?? -Infinity) > top);
    const element = first && elements.current.get(first.key);
    if (!first || !element) return;
    const scroll = { item_id: first.key, offset: element.getBoundingClientRect().top - top }, current = latest.current.view?.scroll;
    if (current?.item_id !== scroll.item_id || current.offset !== scroll.offset) void saveView(next => { next.scroll = scroll; });
  };

  // ------------------------------------------------------------ rows
  const running = bar?.running ?? false;
  const touchedMessage = highlightedMessages.size && session ? session.messages.find(message => highlightedMessages.has(message.id))?.number ?? null : null;
  const itemActions = (row: ItemRowModel): RowAction[] => {
    const item = row.item, target = { ...route, item_id: item.id }, list: RowAction[] = [];
    const act = (intent: RowIntent) => () => onAct(intent, target);
    if (item.status !== 'waiting_on_me' && (!row.delivery || row.delivery.failed) && running && !archivedMode && session?.state === 'active') {
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
    list.push({ icon: 'ph ph-trash', title: 'Remove (⌫)', run: onRemove });
    return list;
  };
  const topicActions = (row: Extract<Row, { kind: 'topic' }>): TopicAction[] => {
    const id = row.topic.id;
    if (archivedMode) return [{ icon: 'ph ph-arrow-counter-clockwise', label: 'Restore', title: 'Restore topic (e)', run: () => lifecycle.restore(id), archive: true }];
    if (row.delivery) return [];
    return [
      // Continuation is a core workflow: every topic without an origin offers it,
      // not only earlier-session ones as the prototype draws (main, P8.3 WP1).
      ...!row.topic.origin ? [{ icon: 'ph ph-arrow-bend-down-right', label: 'Continue here', title: `Continue this topic with ${bar?.agent ?? 'this session'}`, run: () => setContinuing(id) }] : [],
      { icon: 'ph ph-archive', label: 'Archive', title: 'Archive topic (e)', run: () => lifecycle.archive(id), archive: true },
      { icon: 'ph ph-trash', label: 'Remove', title: 'Remove topic (⌫)', run: onRemove },
    ];
  };
  const tree = model && rows.length > 0 && <div role="tree" aria-label="Session items" aria-busy={state.status === 'loading'} className="tree-rows" onBlur={saveScroll}>
    {rows.map(row => row.kind === 'topic'
      ? <TopicRow key={row.key} row={row} focused={focusKey === row.key} actions={topicActions(row)}
        prompt={row.allClosed && !archivedMode ? () => lifecycle.archive(row.topic.id) : null}
        remember={remember} onFocus={setFocusKey} onKeyDown={keys} onToggle={toggleTopic} />
      : <ItemRow key={row.key} row={row} selected={selectedId === row.key} focused={focusKey === row.key} disabled={busy}
        highlight={highlightedItems.has(row.key) ? 'strong' : row.collapsed?.ids.some(id => highlightedItems.has(id)) ? 'weak' : null}
        note={row.collapsed ? collapsedNote(row.collapsed, { items: highlightedItems, message: touchedMessage }) : null}
        actions={itemActions(row)} answer={answering === row.key ? answerControl : null}
        remember={remember} onFocus={setFocusKey} onKeyDown={keys} onSelect={select} onToggle={toggleItem} onJump={select} onHover={onHoverItem} />)}
  </div>;

  const loading = !session && state.status === 'loading';
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

  return <section className="tree-column" aria-label="Session tree" data-kbd={kbd || undefined}
    onKeyDownCapture={() => { if (!kbd) setKbd(true); }} onMouseDownCapture={() => { if (kbd) setKbd(false); }}>
    {bar && !archivedMode && <SessionBar bar={bar} busy={lifecycle.busy || !session} onClose={lifecycle.session} />}
    {filtersShown && <FilterBar chip={model ? model.chip : 'all'} counts={counts} topics={model?.topics ?? []} topicId={view?.filters.topic_id ?? null}
      showTopics={!(detailOpen && railOpen)} disabled={nav.writing || nav.pendingOperationId !== null} onChip={setChip} onTopic={setTopic} />}
    {model?.outside && <Banner icon="ph ph-funnel" actions={<button type="button" className="btn btn-ghost" onClick={resume}>Resume filtered view</button>}>
      Showing an item outside your current filters.</Banner>}
    {archived && <Banner icon="ph ph-archive" actions={<>
      <button type="button" className="btn btn-ghost" disabled={lifecycle.busy} onClick={lifecycle.undo}>Undo</button>
      <button type="button" className="btn btn-ghost" onClick={() => { lifecycle.dismiss(); onShowArchive(); }}>View archive</button></>}>
      Archived “{archived.name}”.{archived.waiting ? ` Its ${archived.waiting} waiting question${archived.waiting > 1 ? 's' : ''} left your panel.` : ''}</Banner>}
    {lifecycle.pending && <Banner icon="ph ph-warning" alert actions={<button type="button" className="btn btn-ghost" onClick={lifecycle.reconcile}>Reconcile saved action</button>}>
      The saved {lifecycle.pending} is not confirmed. Reconcile it before another change.</Banner>}
    {lifecycle.error && <Banner icon="ph ph-warning-circle" alert>{lifecycle.error}</Banner>}
    {notices}
    {/* The graph keeps its own scroller so its legend stays sticky (ui/graph/graph.css). */}
    {graph && !loading ? graph : <div ref={scroller} className="tree-scroll">{body}</div>}
    {lifecycle.dialog}
    {continuing && <ContinueDialog actions={actions} topicId={continuing} targets={continueTargets} actionsForTarget={actionsForTarget}
      revealItem={revealItem} onCancel={() => setContinuing(null)} />}
  </section>;
}
