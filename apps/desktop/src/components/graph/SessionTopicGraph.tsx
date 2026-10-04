import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SessionPreferences } from '../../generated/core';
import type { Item } from '../../generated/domain/models';
import { useSession, type Immutable, type SessionStore } from '../../data/session-store';
import type { RegisteredRoutes, RevealedItem } from '../../data/routes';
import { sentenceRows } from '../../selectors/tree/rows';
import { layoutGraph, selectedParentEdges } from '../../graph/layout/geometry';
import { fitBounds, fitsAtMinimum, zoomAt, type Viewport } from '../../graph/layout/viewport';
import { indexGraph, intersects, worldViewport } from '../../graph/culling/bounds-index';
import { useViewport } from '../../graph/culling/use-viewport';
import { StatusBadge, type Status } from '../reference/StatusBadge';
import './graph.css';

export interface SessionTopicGraphProps {
  readonly store: SessionStore;
  readonly routes: RegisteredRoutes;
  readonly topicId: string;
  readonly view: Immutable<SessionPreferences>;
  readonly later: ReadonlySet<string>;
  readonly reveal?: RevealedItem | null;
  readonly onReveal: (result: RevealedItem) => void;
  readonly saveSelection: (itemId: string) => Promise<boolean>;
  readonly onSwitchToTree: () => void;
}
const visualStatus = (status: Item['status']): Status => status === 'waiting_on_me' ? 'waiting' : status === 'in_progress' ? 'progress' : status;
function preview(text: string): readonly string[] {
  const characters = Array.from(text), lines = [characters.slice(0, 26).join(''), characters.slice(26, 51).join('')];
  if (characters.length > 51) lines[1] += '…';
  return lines;
}

export function SessionTopicGraph(props: SessionTopicGraphProps) {
  const { store, view, later, topicId, reveal, onSwitchToTree } = props;
  const state = useSession(store), session = state.snapshot?.session;
  const svg = useRef<SVGSVGElement>(null), marker = useId();
  const [size, setSize] = useState({ width: 800, height: 420 });
  const measuredSize = useRef(size);
  const { viewport, current: requestedViewport, setViewport } = useViewport({ x: 32, y: 32, scale: 1 });
  const [focused, setFocused] = useState<string | null>(null);
  const nodeElements = useRef(new Map<string, SVGGElement>());
  const pendingFocus = useRef<{ id: string; viewport: Viewport } | null>(null);
  const lastSelection = useRef<{ store: SessionStore; topicId: string; id: string | null; reveal: RevealedItem | null; present: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localReveal, setLocalReveal] = useState<RevealedItem | null>(null);
  const writing = useRef<number | null>(null);
  const latest = useRef(props); latest.current = props;
  const mounted = useRef(true), request = useRef(0);
  const pan = useRef<{ pointer: number; x: number; y: number; start: Viewport } | null>(null);
  const routeMatches = view.session.project_id === state.route.project_id && view.session.session_id === state.route.session_id;
  const topicMatches = !!session?.topics[topicId] && routeMatches && (view.filters.topic_id === null || view.filters.topic_id === topicId);
  const projection = useMemo(() => session && topicMatches ? sentenceRows(session, {
    ...view, filters: { ...view.filters, topic_id: topicId }, expanded_item_ids: Object.keys(session.items),
  }, later) : null, [session, topicMatches, view, topicId, later]);
  const layout = useMemo(() => layoutGraph(projection?.rows.map(row => row.item) ?? []), [projection]);
  const queryGraph = useMemo(() => indexGraph(layout), [layout]);
  const currentReveal = localReveal ?? reveal;
  const selectionReveal = currentReveal?.kind === 'item' ? currentReveal : null;
  const selected = currentReveal?.store === store && currentReveal.kind === 'item' ? currentReveal.route.item_id : view.selected_item_id;
  const rendered = useMemo(() => queryGraph(worldViewport(viewport, size.width, size.height), [selected, focused]), [queryGraph, viewport, size, selected, focused]);
  const highlighted = useMemo(() => selectedParentEdges(layout, selected), [layout, selected]);
  const visible = useMemo(() => new Set(layout.nodes.map(node => node.item.id)), [layout]);
  const context = useMemo(() => new Set(projection?.rows.filter(row => row.context).map(row => row.item.id)), [projection]);
  const initialFit = useRef<string | null>(null);
  useLayoutEffect(() => {
    const element = svg.current;
    if (!element) return;
    const resize = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        measuredSize.current = {width:rect.width,height:rect.height}; setSize(measuredSize.current);
      }
    };
    resize();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(resize); observer.observe(element); return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const key = JSON.stringify([store.getSnapshot().route, topicId]);
    if (layout.nodes.length && initialFit.current !== key) {
      initialFit.current = key; setViewport(fitBounds(layout.bounds, measuredSize.current.width, measuredSize.current.height));
    }
  }, [layout, size, store, topicId]);
  useLayoutEffect(() => {
    const node = layout.nodes.find(node => node.item.id === selected);
    const previousSelection = lastSelection.current;
    if (previousSelection?.store === store && previousSelection.topicId === topicId && previousSelection.id === selected
      && previousSelection.reveal === selectionReveal && previousSelection.present === !!node) return;
    lastSelection.current = { store, topicId, id: selected, reveal: selectionReveal, present: !!node };
    pendingFocus.current = null;
    if (!node) return;
    const previous = requestedViewport.current;
    const next = intersects(node, worldViewport(previous, size.width, size.height, 0)) ? previous
      : { ...previous, x: size.width / 2 - (node.x + node.width / 2) * previous.scale,
        y: size.height / 2 - (node.y + node.height / 2) * previous.scale };
    pendingFocus.current = { id: node.item.id, viewport: next };
    if (next !== previous) setViewport(next);
  }, [selected, selectionReveal, layout, store, topicId]);
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending || viewport.x !== pending.viewport.x || viewport.y !== pending.viewport.y || viewport.scale !== pending.viewport.scale) return;
    const element = nodeElements.current.get(pending.id);
    if (element) { pendingFocus.current = null; element.focus({ preventScroll: true }); }
  }, [rendered, viewport]);
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect(), point = {x:event.clientX - rect.left,y:event.clientY - rect.top};
      setViewport(previous => zoomAt(previous, point, previous.scale * Math.exp(-event.deltaY * 0.001)));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++request.current; }; }, []);
  useEffect(() => { ++request.current; writing.current = null; setLocalReveal(null); setError(null); setFocused(null); pan.current = null; }, [store, topicId]);
  useEffect(() => { setLocalReveal(null); }, [reveal]);
  const select = async (id: string) => {
    const call = ++request.current, current = latest.current, route = {...current.view.session,item_id:id};
    setError(null);
    try {
      const result = await current.routes.revealItem(route);
      if (!result || !mounted.current || call !== request.current || latest.current.store !== current.store || latest.current.topicId !== current.topicId) return;
      setLocalReveal(result); latest.current.onReveal(result);
      if (result.kind === 'item' && result.store === current.store && latest.current.store === current.store && latest.current.topicId === current.topicId) {
        if (writing.current !== null || current.store.getSnapshot().status !== 'ready') {
          setError('Refresh the current preferences before saving another selection.'); return;
        }
        writing.current = call;
        const confirmed = await latest.current.saveSelection(result.route.item_id);
        if (!confirmed && mounted.current && call === request.current) setError('The selection was not saved. Reconcile the current preferences.');
      }
    } catch (failure: unknown) {
      if (mounted.current && call === request.current) setError(failure instanceof Error ? failure.message : 'The registered item could not be read.');
    } finally { if (writing.current === call) writing.current = null; }
  };
  const zoom = (factor: number) => setViewport(previous => zoomAt(previous, {x:size.width/2,y:size.height/2}, previous.scale * factor));
  return <section className="ariadne-reference session-topic-graph" aria-label="Topic graph">
    <header><h2>{session?.topics[topicId]?.name ?? 'Topic graph'}</h2><div className="topic-graph-controls">
      <button type="button" className="ref-button" onClick={() => setViewport(fitBounds(layout.bounds, size.width, size.height))}>Fit</button>
      <button type="button" className="ref-button" aria-label="Zoom out" disabled={viewport.scale <= 0.25} onClick={() => zoom(1/1.2)}>−</button>
      <output aria-live="polite">{Math.round(viewport.scale * 100)}%</output>
      <button type="button" className="ref-button" aria-label="Zoom in" disabled={viewport.scale >= 2} onClick={() => zoom(1.2)}>+</button>
      <button type="button" className="ref-button" onClick={onSwitchToTree}>Switch to tree</button>
    </div></header>
    {state.status !== 'ready' && <p role="status">{state.error?.message ?? (session ? 'Showing the last valid session snapshot.' : 'Loading the registered session…')}</p>}
    {error && <p role="alert">{error}</p>}
    {!topicMatches && session && <p role="status">Select an existing topic that matches the shared topic filter.</p>}
    {topicMatches && !layout.nodes.length && <p role="status">No sentences match the shared filters.</p>}
    {currentReveal?.store === store && currentReveal.kind === 'missing_item' && <p role="status">{currentReveal.banner}</p>}
    {selected && !visible.has(selected) && layout.nodes.length > 0 && <p role="status">The selected item is outside this filtered topic. Open the tree to follow its registered route.</p>}
    {layout.nodes.length > 0 && !fitsAtMinimum(layout.bounds, size.width, size.height) && <p role="status">Full bounds exceed this viewport at 25%. Pan to explore or switch to tree.</p>}
    <svg ref={svg} className="topic-graph-canvas" aria-label="Topic sentences" width="100%" height="420"
      onPointerDown={event => {
        if (event.button !== 0 || (event.target as Element).closest('[data-graph-node]')) return;
        pan.current = {pointer:event.pointerId,x:event.clientX,y:event.clientY,start:requestedViewport.current};
        event.currentTarget.setPointerCapture?.(event.pointerId); event.preventDefault();
      }} onPointerMove={event => {
        const drag = pan.current;
        if (drag?.pointer === event.pointerId) setViewport({...drag.start,x:drag.start.x + event.clientX - drag.x,y:drag.start.y + event.clientY - drag.y});
      }} onPointerUp={event => { if (pan.current?.pointer === event.pointerId) { pan.current = null; event.currentTarget.releasePointerCapture?.(event.pointerId); } }}
      onPointerCancel={() => { pan.current = null; }}>
      <defs><marker id={marker} viewBox="0 0 8 8" refX="8" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--st-replaced)" /></marker></defs>
      <g data-graph-world="true" transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>
        <g aria-hidden="true">{rendered.edges.map(edge => <g key={edge.id} data-edge={edge.id}><path d={edge.path} fill="none"
          stroke={edge.kind === 'replacement' ? 'var(--st-replaced)' : highlighted.has(edge.id) ? 'var(--color-accent)' : 'var(--a-edge)'}
          strokeWidth={highlighted.has(edge.id) ? 1.75 : 1.25} strokeDasharray={edge.kind === 'replacement' ? '4 4' : undefined}
          markerEnd={edge.kind === 'replacement' ? `url(#${marker})` : undefined} />
          {edge.label && <text x={edge.label.x} y={edge.label.y} textAnchor="middle" className="topic-replacement-label">replaced by</text>}</g>)}</g>
        {rendered.nodes.map(node => <g key={node.item.id} data-graph-node={node.item.id} transform={`translate(${node.x} ${node.y})`}
          ref={element => { if (element) nodeElements.current.set(node.item.id, element); else nodeElements.current.delete(node.item.id); }}
          className={`topic-graph-node${context.has(node.item.id) ? ' topic-graph-context' : ''}`} role="button" tabIndex={0}
          aria-label={`Item ${node.item.id}: ${node.item.question}`} aria-pressed={selected === node.item.id}
          onFocus={() => setFocused(node.item.id)} onBlur={() => setFocused(previous => previous === node.item.id ? null : previous)}
          onClick={() => { void select(node.item.id); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void select(node.item.id); } }}>
          <title>{node.item.question}</title><rect width="190" height="66" rx="8" />
          <text x="12" y="20" className="topic-node-id">{node.item.id}</text>
          <foreignObject x="50" y="8" width="128" height="20"><StatusBadge status={visualStatus(node.item.status)} variant="text" /></foreignObject>
          {preview(node.item.question).map((line,index) => <text key={index} x="12" y={39 + index * 15} className="topic-node-preview">{line}</text>)}
        </g>)}
      </g>
    </svg>
    {projection && <footer>{projection.matchingTotal} matching · {projection.scopeTotal} in this topic · drag blank canvas to pan</footer>}
    <ul className="topic-replacement-links" aria-label="Replacement routes">{layout.nodes.filter(node => node.item.replaced_by).map(node => <li key={node.item.id}>
      Item {node.item.id} replaced by <button type="button" className="ref-button ref-ghost" onClick={() => { void select(node.item.replaced_by!); }}>
        {session?.items[node.item.replaced_by!]?.question ?? `item ${node.item.replaced_by}`}</button>{!visible.has(node.item.replaced_by!) && ' · outside this filtered topic'}
    </li>)}</ul>
  </section>;
}
