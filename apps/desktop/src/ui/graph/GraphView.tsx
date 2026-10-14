// The session's Graph view (handoff README §7, frames 1d, 1f, 1aa), ported from
// the Ariadne.dc.html graph template: a sticky legend with Reveal selected, then
// one card per topic with 190×66 nodes, Bezier edges, "+N" and "−".
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { SessionPreferences } from '../../generated/core';
import type { Topic } from '../../generated/domain/models';
import { useSession, type Immutable, type SessionStore } from '../../data/session-store';
import type { RegisteredRoutes, RevealedItem } from '../../data/routes';
import { plainFailure } from '../../data/plain';
import { ackTitle } from '../shared/ack';
import { useWorkspaceKeys } from '../keys';
import { useHidden } from '../remove/queue';
import { visibleSession } from '../remove/model';
import { GraphFilter } from '../tree/FilterBar';
import { hiddenGroupKey, hiddenGroupsFor } from '../tree/hidden';
import { applyChange, mergeChange, relatedEdgePath, sessionGraph, statusVisual, STUB_HEIGHT, STUB_WIDTH, type GraphNode, type GraphStub, type RelatedEdge, type TopicGraph, type ViewChange } from './model';
import './graph.css';
import { useFilterFolds } from '../shared/filterFolds';
import { notices } from '../pages/notices';

export interface GraphViewProps {
  readonly store: SessionStore;
  readonly routes: RegisteredRoutes;
  readonly view: Immutable<SessionPreferences>;
  readonly later: ReadonlySet<string>;
  /** The current header search, before its debounced preference write. */
  readonly search?: string;
  /** The navigation's current reveal (a link, waiting card or tree selection). */
  readonly reveal: RevealedItem | null;
  /** Detail is open: the prototype's tighter grid. */
  readonly tight: boolean;
  /** Session chip shown on every topic card ("codex · yesterday"), or null. */
  readonly sessionLabel: string | null;
  /** "Continued from codex · yesterday" for a topic continued from another session; replaces the session chip. */
  readonly continuedFrom?: (topic: Immutable<Topic>) => string | null;
  readonly preferencesBusy?: boolean;
  readonly saveView: (view: SessionPreferences) => Promise<boolean>;
  /** Selection reached the item; `openDetail` is false for ↑/↓ moves and "−". */
  readonly onReveal: (result: RevealedItem, openDetail: boolean) => void;
}

/** Scrolls `element` into the scroller: centred (Reveal selected, links) or just into view (Ariadne.dc.html:990). */
function scrollToNode(scroller: HTMLElement, element: Element, center: boolean) {
  const a = scroller.getBoundingClientRect(), b = element.getBoundingClientRect();
  if (center) {
    scroller.scrollTop += (b.top + Math.min(b.height, 120) / 2) - (a.top + a.height / 2);
    scroller.scrollLeft += (b.left + b.width / 2) - (a.left + a.width / 2);
    return;
  }
  const top = 48;
  if (b.top < a.top + top) scroller.scrollTop -= a.top + top - b.top;
  else if (b.bottom > a.bottom - 8) scroller.scrollTop += Math.min(b.bottom - a.bottom + 8, b.top - a.top - top);
}

interface NodeProps {
  readonly node: GraphNode;
  readonly focusable: boolean;
  readonly onOpen: (node: GraphNode) => void;
  readonly onCollapse: (node: GraphNode) => void;
}
const Node = memo(function Node({ node, focusable, onOpen, onCollapse }: NodeProps) {
  const visual = statusVisual[node.status];
  const className = ['graph-node', node.status === 'waiting' && 'is-waiting', node.onThread && 'is-thread', node.selected && 'is-selected',
    node.closed && 'is-closed', node.dimmed && 'is-dimmed', node.hidden && 'is-hidden'].filter(Boolean).join(' ');
  // Only what expanding can draw is counted; a branch of hidden items has its own stub and is named when nothing else is below.
  const belowTitle = node.below > 0 ? `${node.below} items below, collapsed · click to open the next tier`
    : `${node.hiddenBelow} ${node.hiddenBelow === 1 ? 'item' : 'items'} hidden below, collapsed · click to open the next tier`;
  return <div className={className} role="treeitem" aria-selected={node.selected} aria-expanded={node.below ? !node.collapsed : undefined}
    aria-label={`${node.short}: ${node.item.question}${node.hidden ? ' (hidden)' : ''}`} title={node.item.question} tabIndex={focusable ? 0 : -1}
    data-item-id={node.item.id} data-row={node.item.id} style={{ left: node.x, top: node.y }}
    onClick={() => onOpen(node)}>
    <div className="graph-node-head">
      <i className={`graph-node-icon ${visual.icon}`} role="img" aria-label={visual.label} title={visual.label} style={{ color: `var(--st-${node.status})` }} />
      <span className="graph-node-title">{node.short}</span>
      {node.ack && <span className="graph-node-ack" title={`${ackTitle(node.ack, node.item.status)} · open details`}>{ackTitle(node.ack, node.item.status)}</span>}
      {node.collapsed && <span className="graph-node-below" title={belowTitle}>{node.below > 0 ? `+${node.below}` : `${node.hiddenBelow} hidden`}</span>}
      {node.canCollapse && <button type="button" className="graph-node-collapse" title="Collapse branches" aria-label="Collapse branches" tabIndex={-1}
        onClick={(event: MouseEvent) => { event.stopPropagation(); onCollapse(node); }}><i className="ph ph-minus" aria-hidden="true" /></button>}
    </div>
    <div className="graph-node-question">{node.item.question}</div>
  </div>;
});

/** The Map's "N items hidden" row, as a small stub: Enter or a click shows the hidden items, and again folds them. */
const Stub = memo(function Stub({ stub, onToggle }: { readonly stub: GraphStub; readonly onToggle: (stub: GraphStub) => void }) {
  const label = `${stub.count} ${stub.count === 1 ? 'item' : 'items'} hidden${stub.waiting ? ', waiting on you' : ''}`;
  return <button type="button" role="treeitem" className="graph-stub" aria-expanded={stub.expanded} aria-label={label}
    title={`${label} · ${stub.expanded ? 'fold them again' : 'show them'}`} data-stub={stub.key}
    style={{ left: stub.x, top: stub.y, width: STUB_WIDTH, height: STUB_HEIGHT }} onClick={() => onToggle(stub)}>
    <i className={stub.expanded ? 'ph ph-caret-down' : 'ph ph-caret-right'} aria-hidden="true" />
    <span className="graph-stub-text">{stub.count} hidden</span>
    {stub.waiting && <i className="ph-fill ph-question graph-stub-waiting" aria-hidden="true" />}
  </button>;
});

function TopicCard({ graph, sessionLabel, marker, focusId, onOpen, onCollapse, onToggleStub }: {
  readonly graph: TopicGraph; readonly sessionLabel: string | null; readonly marker: string; readonly focusId: string | null;
  readonly onOpen: NodeProps['onOpen']; readonly onCollapse: NodeProps['onCollapse']; readonly onToggleStub: (stub: GraphStub) => void;
}) {
  return <section className="graph-card" aria-label={graph.topic.name}>
    <div className="graph-card-head">
      <span className="graph-card-name">{graph.topic.name}</span>
      {sessionLabel && <span className="graph-card-session"><i className="ph ph-clock-counter-clockwise" aria-hidden="true" />{sessionLabel}</span>}
      <span className="graph-card-counts">{graph.counts}</span>
    </div>
    <div className="graph-canvas" role="tree" aria-label={`${graph.topic.name} graph`} style={{ width: graph.width, height: graph.height }}>
      <svg className="graph-edges" width={graph.width} height={graph.height} aria-hidden="true">
        <defs><marker id={marker} viewBox="0 0 8 8" refX="4" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L8 4 L0 8 z" className="graph-arrow" /></marker></defs>
        {graph.related.map(edge => <path key={edge.id} data-edge={edge.id} d={edge.d} className="graph-related" />)}
        {graph.edges.map(edge => <path key={edge.id} data-edge={edge.id} d={edge.d} className={edge.on ? 'graph-edge is-on' : 'graph-edge'} />)}
        {graph.replacements.map(arc => <g key={arc.id} data-edge={arc.id}>
          <path d={arc.d} className="graph-replaced" markerEnd={`url(#${marker})`} />
          <text x={arc.labelX} y={arc.labelY} textAnchor="middle" className="graph-replaced-label">replaced by</text>
        </g>)}
      </svg>
      {graph.nodes.map(node => <Node key={node.item.id} node={node} focusable={node.item.id === focusId} onOpen={onOpen} onCollapse={onCollapse} />)}
      {graph.stubs.map(stub => <Stub key={stub.key} stub={stub} onToggle={onToggleStub} />)}
    </div>
  </section>;
}

/** Topic headers can wrap, so cross-topic connections use the mounted nodes' actual positions. */
function CrossTopicLinks({ edges }: { readonly edges: readonly RelatedEdge[] }) {
  const overlay = useRef<SVGSVGElement>(null);
  const [paths, setPaths] = useState<readonly { id: string; d: string }[]>([]);
  useLayoutEffect(() => {
    const cards = overlay.current?.parentElement;
    if (!cards) return;
    const nodes = new Map<string, HTMLElement>();
    const endpointCards = new Set<Element>();
    for (const id of new Set(edges.flatMap(edge => [edge.from, edge.to]))) {
      const node = cards.querySelector<HTMLElement>(`.graph-node[data-item-id="${CSS.escape(id)}"]`);
      if (!node) continue;
      nodes.set(id, node);
      const card = node.closest('.graph-card');
      if (card) endpointCards.add(card);
    }
    const measure = () => {
      const bounds = cards.getBoundingClientRect();
      const next = edges.flatMap(edge => {
        const from = nodes.get(edge.from)?.getBoundingClientRect(), to = nodes.get(edge.to)?.getBoundingClientRect();
        if (!from?.width || !from.height || !to?.width || !to.height) return [];
        return [{ id: edge.id, d: relatedEdgePath({ x: from.left - bounds.left, y: from.top - bounds.top },
          { x: to.left - bounds.left, y: to.top - bounds.top }) }];
      });
      setPaths(previous => previous.length === next.length && previous.every((path, i) => path.id === next[i].id && path.d === next[i].d) ? previous : next);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    endpointCards.forEach(card => observer?.observe(card));
    nodes.forEach(node => observer?.observe(node));
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [edges]);
  return <svg ref={overlay} className="graph-cross-related" aria-hidden="true">{paths.map(path => <path key={path.id} data-edge={path.id} d={path.d} className="graph-related" />)}</svg>;
}

export function GraphView({ store, routes, view, later, search, reveal, tight, sessionLabel, continuedFrom, preferencesBusy = false, saveView, onReveal }: GraphViewProps) {
  const state = useSession(store), raw = state.snapshot?.session, hidden = useHidden();
  const session = useMemo(() => raw && visibleSession(raw, state.route, hidden), [raw, state.route, hidden]);
  const marker = useId().replace(/:/g, '');
  const scroller = useRef<HTMLDivElement>(null);
  const [localReveal, setLocalReveal] = useState<RevealedItem | null>(null);
  const [dismissedReveal, setDismissedReveal] = useState<RevealedItem | null>(null);
  // Hidden groups the owner has open, like the Tree's expandedHiddenGroups: local to this view and never saved.
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());
  // Optimistic view edits: `pending` waits for the current write, `inflight` is being written.
  const [pending, setPending] = useState<ViewChange | null>(null);
  const [inflight, setInflight] = useState<ViewChange | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errorNoticeId = JSON.stringify(['graph-action', state.route.project_id, state.route.session_id]);
  useEffect(() => () => notices.dismiss(errorNoticeId), [errorNoticeId]);
  useEffect(() => {
    if (!error) { notices.dismiss(errorNoticeId); return; }
    notices.push({ id: errorNoticeId, icon: 'ph ph-warning-circle', tone: 'problem', dismissible: true, text: error });
  }, [errorNoticeId, error]);
  const [scrollTarget, setScrollTarget] = useState<{ id: string; center: boolean; focus?: boolean } | null>(null);
  const mounted = useRef(true), request = useRef(0);
  const offered = localReveal ?? reveal;
  const currentReveal = offered === dismissedReveal ? null : offered;
  const itemReveal = currentReveal?.store === store && currentReveal.kind === 'item' ? currentReveal : null;
  const shown = useMemo(() => {
    const changed = applyChange(applyChange(view, inflight), pending);
    return search === undefined || search === changed.filters.search ? changed : { ...changed, filters: { ...changed.filters, search } };
  }, [view, inflight, pending, search]);
  const filterFolds = useFilterFolds(routes, shown.session, shown.filters);
  const selectedId = pending?.selected ?? inflight?.selected ?? itemReveal?.route.item_id ?? view.selected_item_id;
  const graph = useMemo(() => session ? sessionGraph({ session, view: shown, later, selectedId, tight,
    temporaryExpandedItemIds: itemReveal?.temporaryExpandedItemIds ?? [], revealedItemId: itemReveal?.route.item_id ?? null,
    filterCollapsedItemIds: filterFolds.items, expandedHiddenGroups: openGroups }) : null,
  [session, shown, later, selectedId, tight, itemReveal, filterFolds.items, openGroups]);
  const latest = useRef({ graph, shown, view, routes, onReveal, saveView, busy: preferencesBusy, ready: state.status === 'ready', selectedId });
  latest.current = { graph, shown, view, routes, onReveal, saveView, busy: preferencesBusy, ready: state.status === 'ready', selectedId };

  // A selection that moves onto a hidden item, or a reveal of one (a link, a Waiting card, search, detail), opens the
  // hidden groups on its route so it shows; the owner folds them again from their stubs. Hiding the item the graph is
  // showing (the x key, the detail pane) is the opposite: it folds away like any other hidden item.
  const hiddenSelection = useRef<{ sessionId?: string; selectedId: string | null }>({ selectedId: null });
  const knownHidden = useRef<ReadonlySet<string>>(new Set(view.hidden_item_ids ?? []));
  const revealedId = itemReveal?.route.item_id ?? null;
  useLayoutEffect(() => {
    const explicit = new Set(view.hidden_item_ids ?? []), added = new Set([...explicit].filter(id => !knownHidden.current.has(id)));
    knownHidden.current = explicit;
    if (!session) return;
    const previous = hiddenSelection.current;
    hiddenSelection.current = { sessionId: session.id, selectedId };
    const moved = previous.sessionId !== session.id || previous.selectedId !== selectedId;
    const hiding = !!revealedId && added.size > 0 && hiddenGroupsFor(session, added, revealedId).length > 0;
    if (hiding) setDismissedReveal(currentReveal);
    setOpenGroups(groups => {
      const next = new Set(groups);
      for (const id of [moved ? selectedId : null, hiding ? null : revealedId]) if (id) hiddenGroupsFor(session, explicit, id).forEach(key => next.add(key));
      return next.size === groups.size ? groups : next;
    });
  }, [session, selectedId, revealedId, view.hidden_item_ids]);
  const toggleStub = useCallback((stub: GraphStub) => {
    setDismissedReveal(currentReveal);
    setOpenGroups(groups => { const next = new Set(groups); if (stub.expanded) next.delete(stub.key); else next.add(stub.key); return next; });
  }, [currentReveal]);
  // When the focused node is hidden away, focus goes to its stub, as the Tree's does.
  const focusedRow = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = focusedRow.current, active = document.activeElement;
    if (!id || !graph || !session || graph.nodes.has(id) || (active && active !== document.body)) return;
    const explicit = new Set(view.hidden_item_ids ?? []);
    let key: string | null = null;
    for (let item = session.items[id]; item; item = item.parent ? session.items[item.parent] : undefined) {
      const group = hiddenGroupKey(item.topic_id, item.parent);
      if (explicit.has(item.id) && graph.stubs.has(group)) key = group;
    }
    const stub = key ? scroller.current?.querySelector<HTMLElement>(`[data-stub="${CSS.escape(key)}"]`) : null;
    if (stub) { focusedRow.current = null; stub.focus({ preventScroll: true }); }
  }, [graph, session, view.hidden_item_ids]);

  // The item this graph selected last; its reveal comes back through `reveal` and must not scroll again.
  const own = useRef<string | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++request.current; }; }, []);
  // A reveal from outside the graph (a link, a waiting card) centres its item.
  useLayoutEffect(() => {
    setLocalReveal(null);
    if (reveal?.store !== store || reveal.kind !== 'item') return;
    if (reveal.route.item_id === own.current) own.current = null;
    else setScrollTarget({ id: reveal.route.item_id, center: true, focus: true });
  }, [reveal]);
  useLayoutEffect(() => { ++request.current; setLocalReveal(null); setPending(null); setInflight(null); setError(null); setOpenGroups(new Set()); }, [store]);

  // Writes one change at a time through navigation's preference writer; later edits merge into `pending`.
  useEffect(() => {
    if (!pending || inflight || preferencesBusy || state.status !== 'ready') return;
    const change = pending, base = latest.current.view;
    setPending(null); setInflight(change); setError(null);
    const next = applyChange(base, change);
    const write = next === base ? Promise.resolve(true) : latest.current.saveView(structuredClone(next) as SessionPreferences);
    write.then(confirmed => { if (mounted.current && !confirmed) setError('Ariadne isn’t sure that view change was saved. Try it again.'); },
      (failure: unknown) => { if (mounted.current) setError(plainFailure(failure, 'The view change could not be saved. Try again.')); })
      .finally(() => { if (mounted.current) setInflight(null); });
  }, [pending, inflight, preferencesBusy, state.status]);

  const change = useCallback((next: ViewChange) => setPending(previous => mergeChange(previous, next)), []);
  /** Select an item: show it now, save it, and tell the App (which opens detail when asked). */
  const select = useCallback((id: string, options: { openDetail: boolean; expand?: boolean; center?: boolean }) => {
    if (options.expand && latest.current.graph?.filtering) filterFolds.setFold('items', id, false);
    change({ selected: id, expansion: options.expand ? [{ kind: 'expand', id }] : [] });
    setScrollTarget({ id, center: !!options.center });
    own.current = id;
    const call = ++request.current;
    void latest.current.routes.revealItem({ ...latest.current.view.session, item_id: id }).then(result => {
      if (!mounted.current || call !== request.current || !result) return;
      setLocalReveal(result); latest.current.onReveal(result, options.openDetail);
    }).catch((failure: unknown) => { if (mounted.current && call === request.current) setError(plainFailure(failure, 'This item could not be opened.')); });
  }, [change, filterFolds.setFold]);
  // Clicking a node selects it and opens detail; a collapsed node also opens its next tier (Ariadne.dc.html:1564).
  const open = useCallback((node: GraphNode) => {
    select(node.item.id, { openDetail: true, expand: node.collapsed, center: true });
  }, [select]);
  // "−" collapses the branches; a selection inside moves to this node (Ariadne.dc.html:1569).
  const collapse = useCallback((node: GraphNode) => {
    const selected = latest.current.selectedId;
    let inside = false;
    for (let id = selected ? session?.items[selected]?.parent : null; id; id = session?.items[id]?.parent) if (id === node.item.id) inside = true;
    if (inside) select(node.item.id, { openDetail: false, center: false });
    if (latest.current.graph?.filtering) filterFolds.setFold('items', node.item.id, true);
    change({ expansion: [{ kind: 'collapse', id: node.item.id }] });
    if (itemReveal?.temporaryExpandedItemIds.includes(node.item.id)) setDismissedReveal(currentReveal);
  }, [change, select, session, itemReveal, currentReveal, filterFolds.setFold]);

  // ↑/↓ move the selection in layout order, ←/→ fold and unfold, Enter opens detail (Ariadne.dc.html:1450-1497).
  const keys = useWorkspaceKeys<HTMLDivElement>({
    'move-down': () => move(1), 'move-up': () => move(-1), first: () => move(-Infinity), last: () => move(Infinity),
    unfold: () => {
      const { graph: current, selectedId: id } = latest.current, node = id ? current?.nodes.get(id) : undefined;
      if (!current || !node || (!node.below && !node.hiddenBelow)) return !!node;
      if (node.collapsed) {
        if (current.filtering) filterFolds.setFold('items', node.item.id, false);
        change({ expansion: [{ kind: 'expand', id: node.item.id }] }); return true;
      }
      const first = current.children.get(node.item.id)?.[0];
      if (first) select(first, { openDetail: false });
      return true;
    },
    fold: () => {
      const { graph: current, selectedId: id } = latest.current, node = id ? current?.nodes.get(id) : undefined;
      if (!current || !node) return false;
      if (node.canCollapse) { collapse(node); return true; }
      const parent = node.item.parent;
      if (parent && current.nodes.has(parent)) select(parent, { openDetail: false });
      return true;
    },
    enter: () => {
      const id = latest.current.selectedId;
      if (!id || !latest.current.graph?.nodes.has(id)) return false;
      select(id, { openDetail: true }); return true;
    },
  }, { scope: 'workspace' });
  function move(step: number): boolean {
    const order = latest.current.graph?.order ?? [];
    if (!order.length) return false;
    const index = order.indexOf(latest.current.selectedId ?? '');
    const next = step === -Infinity ? 0 : step === Infinity ? order.length - 1 : Math.max(0, Math.min(order.length - 1, index + step));
    if (order[next] !== latest.current.selectedId) select(order[next], { openDetail: false });
    return true;
  }

  const revealSelected = () => {
    const id = latest.current.selectedId, element = id ? scroller.current?.querySelector(`[data-row="${CSS.escape(id)}"]`) : null;
    if (scroller.current && element) scrollToNode(scroller.current, element, true);
  };
  // Opening the graph centres the selection (Ariadne.dc.html:978); later moves keep it in view.
  const opened = useRef<SessionStore | null>(null);
  useLayoutEffect(() => {
    if (!graph || opened.current === store) return;
    opened.current = store;
    const id = latest.current.selectedId, element = id ? scroller.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`) : null;
    if (scroller.current && element) { scrollToNode(scroller.current, element, true); element.focus({ preventScroll: true }); }
    else scroller.current?.focus({ preventScroll: true });
  }, [graph, store]);
  useLayoutEffect(() => {
    if (!scrollTarget) return;
    const element = scroller.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(scrollTarget.id)}"]`);
    if (!scroller.current || !element) return;
    setScrollTarget(null);
    scrollToNode(scroller.current, element, scrollTarget.center);
    if (scrollTarget.focus || scroller.current.contains(document.activeElement)) element.focus({ preventScroll: true });
  }, [scrollTarget, graph]);

  const focusId = selectedId && graph?.nodes.has(selectedId) ? selectedId : graph?.order[0] ?? null;
  // Like the prototype, the graph and its legend show only when a topic has nodes (Ariadne.dc.html:2177).
  return <div className="graph-view">
    <div ref={scroller} className="graph-scroll" tabIndex={-1}
      onFocus={event => { focusedRow.current = event.target instanceof Element ? event.target.closest('[data-row]')?.getAttribute('data-row') ?? null : null; }}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
      // A focused button keeps its own Enter and Space (Ariadne.dc.html:1471).
      if (!(event.target instanceof HTMLButtonElement)) keys(event);
    }}>
      {!!graph?.topics.length && <><div className="graph-legend">
        <span className="graph-legend-key" aria-label="Thread to the selected item" title="Thread to the selected item"><span className="graph-legend-thread" /><span className="graph-legend-label">Thread</span></span>
        <span className="graph-legend-key" aria-label="Related to the selected item" title="Related to the selected item"><svg className="graph-legend-related" aria-hidden="true"><path className="graph-related" d="M0 3 H22" /></svg><span className="graph-legend-label">Related</span></span>
        <span className="graph-legend-key" aria-label="Replaced by" title="Replaced by"><span className="graph-legend-replaced" /><span className="graph-legend-label">Replaced by</span></span>
        <span className="graph-legend-key" aria-label="Waiting on me" title="Waiting on me"><span className="graph-legend-waiting" /><span className="graph-legend-label">Waiting on me</span></span>
        <span className="graph-legend-key" aria-label="Closed" title="Closed"><span className="graph-legend-closed" /><span className="graph-legend-label">Closed</span></span>
        <span className="graph-legend-note" title="One graph per topic">One graph per topic</span>
        <div className="graph-legend-actions">
          <button type="button" className="btn btn-secondary graph-reveal" disabled={!selectedId || !graph?.nodes.has(selectedId)} onClick={revealSelected}>
            <i className="ph ph-crosshair-simple" aria-hidden="true" />Reveal selected</button>
          <GraphFilter />
        </div>
      </div>
      <div className="graph-cards">
        {graph?.topics.map(topic => <TopicCard key={topic.topic.id} graph={topic} sessionLabel={continuedFrom?.(topic.topic) ?? sessionLabel} marker={`${marker}-${topic.topic.id}`}
          focusId={focusId} onOpen={open} onCollapse={collapse} onToggleStub={toggleStub} />)}
        {!!graph?.crossTopicRelated.length && <CrossTopicLinks edges={graph.crossTopicRelated} />}
      </div></>}
      {/* With no topic to draw there is no legend, but a filter that emptied the graph must stay reachable. */}
      {!graph?.topics.length && <GraphFilter wrap />}
    </div>
  </div>;
}
