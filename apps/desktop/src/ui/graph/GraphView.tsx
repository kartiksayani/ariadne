// The session's Graph (SPEC §5.1 state 1.3, §5.7 state 7.2, §5.9 state 9.9): topics stacked down one canvas, a trunk
// joining each topic's top items, orthogonal branch edges, the selected path in blue, related lines for the selected
// node and the one under the pointer, and a legend card that hangs 12px above the dock.
//
// The Graph never moves on its own: after every commit the node the owner is looking at (the selection when in view,
// otherwise the first node in view) is put back where it was on screen. Only the owner's own moves (scrolling, keys,
// a reveal, a search step, opening the Graph) take the view somewhere else.
import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import type { SessionPreferences } from '../../generated/core';
import { useSession, type Immutable, type SessionStore } from '../../data/session-store';
import type { RegisteredRoutes, RevealedItem } from '../../data/routes';
import { plainFailure } from '../../data/plain';
import { statusColor } from '../shared/status';
import { useWorkspaceKeys } from '../keys';
import { useHidden } from '../remove/queue';
import { visibleSession } from '../remove/model';
import { GraphFilter, GraphFilterSlot } from '../tree/FilterBar';
import { BRANCH_HUES } from '../tree/branch';
import type { ChangeMarker } from '../tree/model';
import { usePeek } from '../peek/context';
import { applyChange, graphColumn, mergeChange, relatedLines, sessionGraph, statusVisual, type GraphNode, type SessionGraph, type TopicGraph, type ViewChange } from './model';
import { useMapSearch } from '../tree/mapSearch';
import './graph.css';
import { useFilterFolds } from '../shared/filterFolds';
import { notices } from '../pages/notices';
import { scrollIntoViewIfHidden } from '../shared/scroll';
import { useDockInset } from '../shell/dockInset';

export interface GraphViewProps {
  readonly store: SessionStore;
  readonly routes: RegisteredRoutes;
  readonly view: Immutable<SessionPreferences>;
  readonly later: ReadonlySet<string>;
  /** The navigation's current reveal (a link, waiting card or tree selection). */
  readonly reveal: RevealedItem | null;
  /** New and Changed markers by item id (ui/tree/model.ts `mapChanges`): a diamond alone on the node (SPEC 9.9). */
  readonly markers?: ReadonlyMap<string, ChangeMarker>;
  readonly preferencesBusy?: boolean;
  readonly saveView: (view: SessionPreferences) => Promise<boolean>;
  /** Selection reached the item; `openDetail` is false for ↑/↓ moves and folds. */
  readonly onReveal: (result: RevealedItem, openDetail: boolean) => void;
}

/** Room kept beside a keyboard-reached target: its focus ring (2px outline + 2px offset) plus a little air. */
const RING_ROOM = 8;
/**
 * Scrolls `element` into the scroller: centred (opening, links) or just into view (keys, search steps).
 * The visible area ends above the floating dock and the legend card (`bottomInset`), so a node under either counts as hidden.
 */
function scrollToNode(scroller: HTMLElement, element: Element, center: boolean, bottomInset = 0, dockInset = 0) {
  const a = scroller.getBoundingClientRect(), b = element.getBoundingClientRect();
  if (center) {
    // A centred node sits mid-view, clear of the legend card: only the dock shortens the area it is centred in.
    scroller.scrollTop += (b.top + Math.min(b.height, 120) / 2) - (a.top + (a.height - dockInset) / 2);
    scroller.scrollLeft += (b.left + b.width / 2) - (a.left + a.width / 2);
    return;
  }
  scrollIntoViewIfHidden(scroller, element, { top: 8, bottom: 8, bottomInset });
  // The same nearest-edge move across: a node reached by key lands whole, with room for its focus ring.
  if (b.left < a.left + RING_ROOM) scroller.scrollLeft -= a.left + RING_ROOM - b.left;
  else if (b.right > a.right - RING_ROOM) scroller.scrollLeft += Math.min(b.right - a.right + RING_ROOM, b.left - a.left - RING_ROOM);
}

const MARKER_TITLE: Readonly<Record<ChangeMarker, string>> = { new: 'New', changed: 'Changed' };

interface NodeProps {
  readonly node: GraphNode;
  readonly width: number;
  readonly focusable: boolean;
  readonly related: boolean;
  readonly match: boolean;
  readonly current: boolean;
  readonly marker: ChangeMarker | undefined;
  readonly onOpen: (node: GraphNode) => void;
}
const Node = memo(function Node({ node, width, focusable, related, match, current, marker, onOpen }: NodeProps) {
  const visual = statusVisual[node.status], hue = BRANCH_HUES[node.branch]!;
  const className = ['graph-node', node.selected && 'is-selected', node.onPath && 'is-path', related && 'is-related', node.closed && 'is-closed',
    node.dimmed && 'is-dimmed', node.hidden && 'is-hidden', match && 'is-match', current && 'is-current-match'].filter(Boolean).join(' ');
  const inside = node.folded ? `${node.inside} inside${node.waitingInside ? `, ${node.waitingInside} waiting on you` : ''}` : '';
  // The branch hue is carried for the Map's shared look but not drawn: the board's Graph nodes are plain.
  const style = { left: node.x, top: node.y, width, '--branch-hue': hue.hue, '--branch-chroma': hue.chroma } as CSSProperties;
  return <div className={className} role="treeitem" aria-selected={node.selected} aria-expanded={node.folded ? false : node.canFold ? true : undefined}
    aria-label={`${node.short}: ${node.item.question}${node.hidden ? ' (hidden)' : ''}${inside ? ` (folded, ${inside})` : ''}`} title={node.item.question}
    tabIndex={focusable ? 0 : -1} data-item-id={node.item.id} data-row={node.item.id} data-branch={node.branch} data-marker={marker}
    data-current-match={current || undefined} style={style} onClick={() => onOpen(node)}>
    <i className={`graph-node-icon ${visual.icon}`} role="img" aria-label={visual.label} title={visual.label} style={{ color: statusColor(node.status) }} />
    <span className="graph-node-name" data-peek-anchor="">{node.short}</span>
    {node.folded && <span className="graph-node-inside" title={inside}>+{node.inside}
      {node.waitingInside > 0 && <span className="graph-node-waiting"> · {node.waitingInside} waiting</span>}</span>}
    {marker && <span className={`graph-node-marker is-${marker}`} role="img" aria-label={MARKER_TITLE[marker]} title={MARKER_TITLE[marker]} />}
  </div>;
});

interface TopicProps {
  readonly graph: TopicGraph;
  readonly width: number;
  readonly focusId: string | null;
  readonly related: ReadonlySet<string>;
  readonly matches: ReadonlySet<string>;
  readonly current: string | null;
  readonly markers: ReadonlyMap<string, ChangeMarker> | undefined;
  readonly onOpen: NodeProps['onOpen'];
}
const Topic = memo(function Topic({ graph, width, focusId, related, matches, current, markers, onOpen }: TopicProps) {
  return <section className="graph-topic" role="tree" aria-label={`${graph.topic.name} graph`}
    style={{ top: graph.top, width: graph.width, height: graph.height }}>
    <h3 className="graph-topic-title" title={graph.topic.name}>{graph.topic.name}</h3>
    <svg className="graph-edges" width={graph.width} height={graph.height} aria-hidden="true">
      {graph.edges.map(edge => <path key={edge.id} data-edge={edge.id} d={edge.d} className="graph-edge" />)}
    </svg>
    {graph.nodes.map(node => <Node key={node.item.id} node={node} width={width} focusable={node.item.id === focusId}
      related={related.has(node.item.id)} match={matches.has(node.item.id)} current={node.item.id === current}
      marker={markers?.get(node.item.id)} onOpen={onOpen} />)}
  </section>;
});

/** The legend card (SPEC 1.3): what the three lines mean, plus the Tree column's filter control when it is open. */
function Legend({ drawn }: { readonly drawn: boolean }) {
  // With nothing drawn the card stays only to keep the filter reachable.
  const filter = useContext(GraphFilterSlot);
  if (!drawn && !filter) return null;
  return <div className="graph-legend" role="group" aria-label="Graph legend">
    {drawn && <>
      <span className="graph-legend-key"><span className="graph-legend-branch" aria-hidden="true" />Branch</span>
      <span className="graph-legend-key"><span className="graph-legend-path" aria-hidden="true" />Path to the selected item</span>
      <span className="graph-legend-key"><svg className="graph-legend-related" aria-hidden="true"><path className="graph-related" d="M0 3 H22" /></svg>Related</span>
      <span className="graph-legend-note">Lines show for the selected item and the one under the pointer.</span>
    </>}
    <GraphFilter />
  </div>;
}

/** Each topic's top in the canvas, by topic id. */
const topicTops = (graph: SessionGraph) => new Map(graph.topics.map(topic => [topic.topic.id, topic.top]));
const NO_LINES: ReturnType<typeof relatedLines> = { paths: [], related: new Set() };

export function GraphView({ store, routes, view, later, reveal, markers, preferencesBusy = false, saveView, onReveal }: GraphViewProps) {
  const state = useSession(store), raw = state.snapshot?.session, hidden = useHidden();
  const session = useMemo(() => raw && visibleSession(raw, state.route, hidden), [raw, state.route, hidden]);
  const scroller = useRef<HTMLDivElement>(null), dockInset = useDockInset();
  const peek = usePeek(), search = useMapSearch();
  const [localReveal, setLocalReveal] = useState<{ result: RevealedItem; external: RevealedItem | null } | null>(null);
  const [localSelection, setLocalSelection] = useState<{ id: string; external: RevealedItem | null } | null>(null);
  const [dismissedReveal, setDismissedReveal] = useState<RevealedItem | null>(null);
  const [focusedEntry, setFocusedEntry] = useState<{ id: string; selectedId: string | null } | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  // The column is fitted to the Map's width when the Graph opens or the session changes, and then kept (model.ts graphColumn).
  const [fit, setFit] = useState<{ store: SessionStore; column: number } | null>(null);
  useLayoutEffect(() => { if (scroller.current) setFit({ store, column: graphColumn(scroller.current.clientWidth) }); }, [store]);
  const column = fit?.store === store ? fit.column : null;
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
  const offered = localReveal?.external === reveal ? localReveal.result : reveal;
  const currentReveal = offered === dismissedReveal ? null : offered;
  const itemReveal = currentReveal?.store === store && currentReveal.kind === 'item' ? currentReveal : null;
  const shown = useMemo(() => applyChange(applyChange(view, inflight), pending), [view, inflight, pending]);
  const filterFolds = useFilterFolds(routes, shown.session, shown.filters);
  // An outside reveal wins immediately over an older selection whose preference write is still pending.
  const optimisticSelection = localSelection?.external === reveal && (pending?.selected || inflight?.selected) ? localSelection.id : null;
  const selectedId = optimisticSelection ?? itemReveal?.route.item_id ?? view.selected_item_id;
  const graph = useMemo(() => session && column !== null ? sessionGraph({ session, view: shown, later, selectedId, column,
    temporaryExpandedItemIds: itemReveal?.temporaryExpandedItemIds ?? [], revealedItemId: itemReveal?.route.item_id ?? null,
    filterCollapsedItemIds: filterFolds.items }) : null,
  [session, shown, later, selectedId, column, itemReveal, filterFolds.items]);
  const latest = useRef({ graph, shown, view, routes, onReveal, saveView, busy: preferencesBusy, ready: state.status === 'ready', selectedId, external: reveal, dockInset });
  latest.current = { graph, shown, view, routes, onReveal, saveView, busy: preferencesBusy, ready: state.status === 'ready', selectedId, external: reveal, dockInset };

  // Related lines show for the selected node and the one under the pointer only (SPEC 1.3). They are drawn over the
  // canvas from the laid-out positions, so hovering never rebuilds the 2,000-node model.
  const lines = useMemo(() => graph && session ? relatedLines(graph, session, [selectedId, hoverId]) : NO_LINES,
    [graph, session, selectedId, hoverId]);

  // ------------------------------------------------------------ the anchor
  /**
   * The node the owner is looking at: where it sat in the window (`y`; the scroller itself can move, plan D24) and across
   * the scroller (`x`), the scroll it was seen at, and the layout it was seen in (to find its neighbours if it leaves).
   */
  const held = useRef<{ readonly id: string; readonly x: number; readonly y: number; readonly top: number; readonly left: number; readonly graph: SessionGraph } | null>(null);
  const nodeElement = (id: string) => scroller.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`) ?? null;
  /** The legend card hangs over the scroller's bottom edge; a node must land above it as well as above the dock. */
  const legendInset = useRef(0);
  const bottomInset = () => latest.current.dockInset + legendInset.current;
  /** Blank room under the canvas that keeps the scroll extent when the content shrinks under a held node at the bottom. */
  const spacer = useRef<HTMLDivElement>(null);
  const anchorOn = (element: HTMLElement, box: HTMLElement, graph: SessionGraph) => {
    const frame = box.getBoundingClientRect(), rect = element.getBoundingClientRect();
    return { id: element.dataset.row!, x: rect.left - frame.left, y: rect.top, top: box.scrollTop, left: box.scrollLeft, graph };
  };
  const remember = () => {
    const box = scroller.current, current = latest.current.graph;
    if (!box || !current) { held.current = null; return; }
    // The owner scrolling back up gives the room back: keep only what the current scroll position needs.
    const gap = spacer.current;
    if (gap && gap.offsetHeight) gap.style.height = `${Math.max(0, Math.ceil(box.scrollTop - (box.scrollHeight - box.clientHeight - gap.offsetHeight)))}px`;
    const frame = box.getBoundingClientRect(), bottom = frame.bottom - bottomInset();
    const inView = (rect: DOMRect) => rect.bottom > frame.top && rect.top < bottom && rect.right > frame.left && rect.left < frame.right;
    const selected = latest.current.selectedId;
    let element = selected && current.nodes.has(selected) ? nodeElement(selected) : null;
    if (element && !inView(element.getBoundingClientRect())) element = null;
    const canvas = !element ? box.querySelector('.graph-canvas')?.getBoundingClientRect() : undefined;
    if (canvas) {
      // Layout order is top-then-left reading order (parents sit on their first child's lane), so the first node whose
      // top is in view is the one the owner reads first.
      const tops = topicTops(current);
      for (const id of current.order) {
        const node = current.nodes.get(id)!, top = canvas.top + (tops.get(node.topicId) ?? 0) + node.y, left = canvas.left + node.x;
        if (top >= frame.top && top < bottom && left >= frame.left && left < frame.right) { element = nodeElement(id); break; }
      }
    }
    held.current = element ? anchorOn(element, box, current) : null;
  };
  /**
   * Where the held node's place is now, and the window position that place should keep. The node itself while it is drawn;
   * the ancestor that folded over it; else the nearest node that survives, below it first, then above, which keeps the
   * position it had before (plan D24); else the nearest drawn ancestor.
   */
  const placeOf = (before: NonNullable<typeof held.current>, current: SessionGraph) => {
    const own = nodeElement(before.id), was = before.graph;
    if (own) return { element: own, y: before.y, x: before.x };
    const parentOf = (id: string) => was.nodes.get(id)?.item.parent ?? null;
    for (let id = parentOf(before.id); id; id = parentOf(id)) {
      const element = current.nodes.get(id)?.folded ? nodeElement(id) : null;
      if (element) return { element, y: before.y, x: before.x };
    }
    const tops = topicTops(was), me = was.nodes.get(before.id), at = was.order.indexOf(before.id);
    if (me && at >= 0) {
      for (const step of [1, -1]) {
        for (let index = at + step; index >= 0 && index < was.order.length; index += step) {
          const id = was.order[index]!, node = was.nodes.get(id)!, element = current.nodes.has(id) ? nodeElement(id) : null;
          if (element) return { element, y: before.y + (tops.get(node.topicId) ?? 0) + node.y - (tops.get(me.topicId) ?? 0) - me.y, x: before.x + node.x - me.x };
        }
      }
    }
    for (let id = parentOf(before.id); id; id = parentOf(id)) {
      const element = nodeElement(id);
      if (element) return { element, y: before.y, x: before.x };
    }
    return null;
  };
  /** Puts the held node back where it was in the window, keeping the scroll extent it needs. */
  const restore = () => {
    const box = scroller.current, before = held.current, current = latest.current.graph;
    if (!box || !before || !current) return;
    // A different scroll position than the one the node was seen at is the owner's own move: keep it. The browser also
    // moves a scroll by itself when the content shrank under it (clamped to the new end); that is not the owner.
    const clamped = (now: number, was: number, limit: number) => was > now && Math.abs(now - limit) < 0.5;
    if (box.scrollTop !== before.top && !clamped(box.scrollTop, before.top, box.scrollHeight - box.clientHeight)) return;
    if (box.scrollLeft !== before.left && !clamped(box.scrollLeft, before.left, box.scrollWidth - box.clientWidth)) return;
    const place = placeOf(before, current);
    if (!place) return;
    const frame = box.getBoundingClientRect(), rect = place.element.getBoundingClientRect();
    const dy = rect.top - place.y, dx = rect.left - frame.left - place.x;
    const top = box.scrollTop + (Math.abs(dy) >= 0.5 ? dy : 0), gap = spacer.current;
    if (gap) gap.style.height = `${Math.max(0, Math.ceil(top - (box.scrollHeight - box.clientHeight - gap.offsetHeight)))}px`;
    if (Math.abs(dy) >= 0.5) box.scrollTop = top;
    if (Math.abs(dx) >= 0.5) box.scrollLeft += dx;
  };
  /** Measures the legend card (it wraps with the width) so scrolling and the scroller's padding keep clear of it. */
  const measureLegend = () => {
    const box = scroller.current, legend = box?.parentElement?.querySelector<HTMLElement>('.graph-legend');
    const inset = legend?.offsetHeight ? legend.offsetHeight + 12 : 0;
    if (inset === legendInset.current) return;
    legendInset.current = inset;
    box?.style.setProperty('--graph-legend-inset', `${inset}px`);
  };
  useLayoutEffect(measureLegend);
  useEffect(() => {
    const view = scroller.current?.parentElement;
    if (!view || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(measureLegend);
    watch.observe(view);
    return () => watch.disconnect();
  }, []);

  // Keep keyboard focus at the same layout position when the focused node disappears.
  const focusedRow = useRef<string | null>(null);
  const previousOrder = useRef<readonly string[]>([]);
  useLayoutEffect(() => {
    const before = previousOrder.current;
    const order = graph?.order ?? [];
    previousOrder.current = order;
    const id = focusedRow.current, active = document.activeElement;
    if (!id || order.includes(id) || (active && active !== document.body)) return;
    const index = before.indexOf(id), next = order[Math.min(Math.max(index, 0), order.length - 1)];
    (next ? nodeElement(next) : scroller.current)?.focus({ preventScroll: true });
  }, [graph]);

  // A selection's reveal comes back through `reveal` and must not scroll again.
  const ownReveal = useRef<RevealedItem | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++request.current; }; }, []);
  useLayoutEffect(() => { ++request.current; setLocalReveal(null); setPending(null); setInflight(null); setError(null); held.current = null; }, [store]);

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
  const select = useCallback((id: string, options: { openDetail: boolean; expand?: boolean }) => {
    peek?.closeAll();
    // The node the owner aimed at keeps its place through what this changes (it may unfold above the old selection),
    // so it is held at its pre-commit position instead of the old selection.
    const box = scroller.current, current = latest.current.graph, element = nodeElement(id);
    if (box && current?.nodes.has(id) && element) held.current = anchorOn(element, box, current);
    setLocalSelection({ id, external: latest.current.external });
    setFocusedEntry({ id, selectedId: id });
    if (options.expand && latest.current.graph?.filtering) filterFolds.setFold('items', id, false);
    change({ selected: id, expansion: options.expand ? [{ kind: 'expand', id }] : [] });
    setScrollTarget({ id, center: false });
    const call = ++request.current, external = latest.current.external;
    void latest.current.routes.revealItem({ ...latest.current.view.session, item_id: id }).then(result => {
      if (!mounted.current || call !== request.current || external !== latest.current.external || !result) return;
      ownReveal.current = result;
      setLocalReveal({ result, external }); latest.current.onReveal(result, options.openDetail);
    }).catch((failure: unknown) => { if (mounted.current && call === request.current && external === latest.current.external) setError(plainFailure(failure, 'This item could not be opened.')); });
  }, [change, filterFolds.setFold, peek]);
  // Clicking a node selects it and opens detail; a folded node also opens its next tier.
  const open = useCallback((node: GraphNode) => {
    select(node.item.id, { openDetail: true, expand: node.folded });
  }, [select]);
  /** ← on an unfolded node folds it, in the saved view (or the filter's own folds while filtering). */
  const fold = (node: GraphNode) => {
    if (latest.current.graph?.filtering) filterFolds.setFold('items', node.item.id, true);
    change({ expansion: [{ kind: 'collapse', id: node.item.id }] });
    if (itemReveal?.temporaryExpandedItemIds.includes(node.item.id)) setDismissedReveal(currentReveal);
  };

  // ↑/↓ move the selection in layout order, ←/→ fold and unfold, Enter opens detail, Space peeks.
  const keys = useWorkspaceKeys<HTMLDivElement>({
    'move-down': () => move(1), 'move-up': () => move(-1), first: () => move(-Infinity), last: () => move(Infinity),
    unfold: () => {
      const { graph: current, selectedId: id } = latest.current, node = id ? current?.nodes.get(id) : undefined;
      if (!current || !node) return false;
      if (node.folded) {
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
      if (node.canFold) { fold(node); return true; }
      const parent = node.item.parent;
      if (parent && current.nodes.has(parent)) select(parent, { openDetail: false });
      return true;
    },
    enter: () => {
      const id = latest.current.selectedId;
      if (!id || !latest.current.graph?.nodes.has(id)) return false;
      select(id, { openDetail: true }); return true;
    },
    peek: () => {
      const id = focusedRow.current ?? latest.current.selectedId, element = id ? nodeElement(id) : null;
      if (!id || !element || !peek) return false;
      peek.toggle({ ...state.route, item_id: id }, element); return true;
    },
  }, { scope: 'workspace' });
  function move(step: number): boolean {
    const order = latest.current.graph?.order ?? [];
    if (!order.length) return false;
    const current = focusedRow.current && order.includes(focusedRow.current) ? focusedRow.current : latest.current.selectedId;
    const index = order.indexOf(current ?? '');
    const next = step === -Infinity ? 0 : step === Infinity ? order.length - 1 : Math.max(0, Math.min(order.length - 1, index + step));
    const id = order[next]!;
    if (id !== current) select(id, { openDetail: false });
    return true;
  }

  // A search step scrolls the current match into view; it selects nothing and closes a peek (SPEC 6.9, plan Q7).
  const stepped = useRef(search.stepped);
  useEffect(() => {
    if (search.stepped === stepped.current) return;
    stepped.current = search.stepped;
    peek?.closeAll();
    const id = search.current?.id;
    if (id && latest.current.graph?.nodes.has(id)) setScrollTarget({ id, center: false });
  }, [search.stepped, search.current, peek]);

  // Every commit: hold the anchor through what changed, then carry out the owner's own scroll request, then remember.
  // Consume every request against this commit's DOM, even when its target is absent; a later change never revives one.
  const opened = useRef<SessionStore | null>(null);
  const previousReveal = useRef<RevealedItem | null | undefined>(undefined);
  useLayoutEffect(() => {
    restore();
    let target = scrollTarget;
    if (scrollTarget) setScrollTarget(null);
    if (previousReveal.current !== reveal) {
      previousReveal.current = reveal;
      setLocalReveal(null); setLocalSelection(null);
      const echo = reveal !== null && reveal === ownReveal.current;
      ownReveal.current = null;
      if (!echo && reveal?.store === store && reveal.kind === 'item') target = { id: reveal.route.item_id, center: true, focus: true };
    }
    const initial = !!graph && opened.current !== store;
    if (initial) {
      opened.current = store;
      if (!target && selectedId) target = { id: selectedId, center: true, focus: true };
    }
    const box = scroller.current;
    const element = target ? nodeElement(target.id) : null;
    if (box && element && target) {
      scrollToNode(box, element, target.center, bottomInset(), dockInset);
      if (target.focus || box.contains(document.activeElement)) element.focus({ preventScroll: true });
    } else if (initial) box?.focus({ preventScroll: true });
    remember();
  });

  // The pointer: one delegated handler for every node. Hover lights the node's related lines and asks for a peek.
  const hovered = useRef<string | null>(null);
  const pointerOver = (event: MouseEvent<HTMLDivElement>) => {
    const element = event.target instanceof Element ? event.target.closest<HTMLElement>('.graph-node[data-row]') : null;
    const id = element?.dataset.row ?? null;
    if (!element || !id || id === hovered.current) return;
    hovered.current = id; setHoverId(id);
    peek?.hoverStart({ ...state.route, item_id: id }, element);
  };
  // A scroll or a search step makes the peek forget the node; resting on it again asks again (the same node is a no-op).
  const pointerMove = (event: MouseEvent<HTMLDivElement>) => {
    const element = event.target instanceof Element ? event.target.closest<HTMLElement>('.graph-node[data-row]') : null;
    if (element?.dataset.row) peek?.hoverStart({ ...state.route, item_id: element.dataset.row }, element);
  };
  const pointerOut = (event: MouseEvent<HTMLDivElement>) => {
    const element = event.target instanceof Element ? event.target.closest<HTMLElement>('.graph-node[data-row]') : null;
    if (!element || (event.relatedTarget instanceof globalThis.Node && element.contains(event.relatedTarget))) return;
    hovered.current = null; setHoverId(null);
    peek?.hoverEnd();
  };

  const focusId = focusedEntry && focusedEntry.selectedId === selectedId && graph?.order.includes(focusedEntry.id) ? focusedEntry.id
    : selectedId && graph?.nodes.has(selectedId) ? selectedId : graph?.order[0] ?? null;
  const drawn = !!graph?.topics.length;
  const current = search.current?.id ?? null;
  return <div className="graph-view">
    <div ref={scroller} className="graph-scroll" tabIndex={-1} onScroll={remember}
      onFocus={event => {
        const element = event.target instanceof Element ? event.target.closest('[data-row]') : null;
        focusedRow.current = element?.getAttribute('data-row') ?? null;
        if (focusedRow.current) setFocusedEntry({ id: focusedRow.current, selectedId: latest.current.selectedId });
      }}
      onBlur={event => {
        if (!(event.relatedTarget instanceof globalThis.Node) || !event.currentTarget.contains(event.relatedTarget)) focusedRow.current = null;
      }}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => { if (!(event.target instanceof HTMLButtonElement)) keys(event); }}>
      {graph && drawn && <>
        <div className="graph-canvas" style={{ width: graph.width, height: graph.height }} onMouseOver={pointerOver} onMouseMove={pointerMove} onMouseOut={pointerOut}>
          {graph.topics.map(topic => <Topic key={topic.topic.id} graph={topic} width={graph.nodeWidth} focusId={focusId} related={lines.related}
            matches={search.ids} current={current} markers={markers} onOpen={open} />)}
          <svg className="graph-lines" width={graph.width} height={graph.height} aria-hidden="true">
            {lines.paths.map(path => <path key={path.id} data-edge={path.id} d={path.d} className="graph-related" />)}
            {graph.path && <path data-edge="path" d={graph.path} className="graph-path" />}
          </svg>
        </div>
        <div ref={spacer} aria-hidden="true" />
      </>}
    </div>
    <Legend drawn={drawn} />
  </div>;
}
