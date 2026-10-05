import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Item, ItemOwner, ItemStatus } from '../../generated/domain/models';
import type { SessionPreferences } from '../../generated/core';
import { useSession, type Immutable, type SessionStore } from '../../data/session-store';
import type { RegisteredRoutes, RevealedItem } from '../../data/routes';
import { sameOwner, sentenceRows, type SentenceRow } from '../../selectors/tree/rows';
import { TreeRow } from '../reference/TreeRow';
import { STATUS, type Status } from '../reference/StatusBadge';
import '../../styles/tree.css';

export interface SentenceTreeProps {
  readonly store: SessionStore;
  readonly routes: RegisteredRoutes;
  readonly view: Immutable<SessionPreferences>;
  readonly later: ReadonlySet<string>;
  readonly reveal?: RevealedItem | null;
  readonly highlightedItemIds?: ReadonlySet<string>;
  readonly onHoverItem?: (itemId: string | null) => void;
  // Composition persists these through the canonical preferences command.
  readonly saveView: (view: SessionPreferences) => Promise<boolean>;
  readonly saveLater: (itemId: string, later: boolean) => Promise<boolean>;
  readonly onReveal: (reveal: RevealedItem) => void;
}
const visualStatus = (status: Item['status']): Status => status === 'waiting_on_me' ? 'waiting' : status === 'in_progress' ? 'progress' : status;
const statuses: readonly ItemStatus[] = ['open', 'waiting_on_me', 'in_progress', 'decided', 'done', 'dropped', 'replaced'];
const editable = (target: EventTarget | null) => target instanceof HTMLElement
  && !!target.closest('input,textarea,select,[contenteditable="true"],[role="textbox"]');
type RowProps = { row: SentenceRow; selected: boolean; focused: boolean; later: boolean; highlighted: boolean;
  onHoverItem?: (itemId: string | null) => void;
  remember: (id: string, element: HTMLDivElement | null) => void; focus: (id: string) => void;
  select: (id: string) => void; toggle: (id: string) => void; keyboard: (event: KeyboardEvent<HTMLDivElement>, id: string) => void };

const SentenceItem = memo(function SentenceItem({ row, selected, focused, later, highlighted, onHoverItem, remember, focus, select, toggle, keyboard }: RowProps) {
  const item = row.item;
  return <TreeRow item={{ id: item.id, question: item.question, status: visualStatus(item.status),
    explanation: item.type === 'explanation', ask: item.ask ?? undefined, note: item.note ?? undefined,
    outcome: item.outcome ?? undefined, later }}
  depth={row.depth} selected={selected} focused={focused} context={row.context} touched={highlighted ? 'strong' : undefined}
  onEnter={() => onHoverItem?.(item.id)} onLeave={() => onHoverItem?.(null)}
  tabIndex={focused ? 0 : -1} rowRef={element => remember(item.id, element)} onFocus={() => focus(item.id)}
  onKeyDown={event => keyboard(event, item.id)} onSelect={() => select(item.id)} onToggle={() => toggle(item.id)}
  hasChildren={row.childCount > 0} expanded={row.expanded}
  collapsedSummary={!row.expanded && row.activeDescendants > 0 ? `${row.activeDescendants} active descendants` : undefined}
  replacement={row.replacement ? { question: row.replacement.question, status: visualStatus(row.replacement.status),
    onReveal: () => select(row.replacement!.id) } : undefined} />;
}, (a, b) => a.row.item.id === b.row.item.id && a.row.item.revision === b.row.item.revision
  && a.row.depth === b.row.depth && a.row.context === b.row.context && a.row.expanded === b.row.expanded
  && a.row.childCount === b.row.childCount && a.row.activeDescendants === b.row.activeDescendants
  && a.row.replacement?.id === b.row.replacement?.id && a.row.replacement?.revision === b.row.replacement?.revision
  && a.selected === b.selected && a.focused === b.focused && a.later === b.later
  && a.highlighted === b.highlighted && a.onHoverItem === b.onHoverItem
  && a.remember === b.remember && a.focus === b.focus && a.select === b.select && a.toggle === b.toggle && a.keyboard === b.keyboard);

export function SentenceTree({ store, routes, view, later, reveal, saveView, saveLater, onReveal, highlightedItemIds, onHoverItem }: SentenceTreeProps) {
  const state = useSession(store), session = state.snapshot?.session;
  useEffect(() => () => onHoverItem?.(null), [store, onHoverItem]);
  const [focusId, setFocusId] = useState<string | null>(view.selected_item_id);
  const [localReveal, setLocalReveal] = useState<RevealedItem | null>(null);
  const [dismissedReveal, setDismissedReveal] = useState<RevealedItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [search, setSearch] = useState(view.filters.search);
  const [pendingSearch, setPendingSearch] = useState<{ store: SessionStore; text: string } | null>(null);
  const elements = useRef(new Map<string, HTMLDivElement>()), container = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const request = useRef(0), mounted = useRef(true);
  const latest = useRef({ view, saveView, saveLater, onReveal, routes, later, state, writing });
  latest.current = { view, saveView, saveLater, onReveal, routes, later, state, writing };
  const offeredReveal = reveal ?? localReveal;
  const currentReveal = offeredReveal === dismissedReveal ? null : offeredReveal;
  const belongs = currentReveal?.store === store;
  const revealedId = belongs && currentReveal.kind === 'item' ? currentReveal.route.item_id : null;
  const projection = session ? sentenceRows(session, view, later,
    belongs && currentReveal.kind === 'item' ? currentReveal.temporaryExpandedItemIds : [], revealedId) : null;
  const rows = projection?.rows ?? [];
  const currentRows = useRef(rows); currentRows.current = rows;
  const currentRevealRef = useRef(currentReveal); currentRevealRef.current = currentReveal;
  const remember = useCallback((id: string, element: HTMLDivElement | null) => {
    if (element) elements.current.set(id, element); else elements.current.delete(id);
  }, []);
  const focus = useCallback((id: string) => setFocusId(id), []);
  const write = useCallback(async (operation: () => Promise<boolean>) => {
    if (!mounted.current || latest.current.writing || latest.current.state.status !== 'ready') return;
    // A ref closes the gap before React paints the pending state.
    latest.current.writing = true; setWriting(true); setError(null);
    let confirmed = false;
    try {
      confirmed = await operation();
      if (!confirmed && mounted.current) setError('The view change was not confirmed. Keep the current view and reconcile its preferences.');
    } catch (failure: unknown) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'The view change could not be saved.'); }
    finally { if (mounted.current) {
      // Only an unsubmitted search may follow a confirmed write. Failed or
      // uncertain operations keep their original explicit reconciliation path.
      if (!confirmed) setPendingSearch(null);
      latest.current.writing = false; setWriting(false);
    } }
  }, []);
  const select = useCallback((id: string) => {
    const call = ++request.current, value = latest.current;
    const route = { ...value.view.session, item_id: id };
    void value.routes.revealItem(route).then(result => {
      if (!mounted.current || call !== request.current || !result
        || latest.current.view.session.project_id !== route.project_id || latest.current.view.session.session_id !== route.session_id) return;
      setLocalReveal(result); value.onReveal(result);
      if (result.kind === 'item') {
        setFocusId(result.route.item_id);
        void write(() => latest.current.saveView({ ...structuredClone(latest.current.view), selected_item_id: result.route.item_id } as SessionPreferences));
      }
    }).catch((failure: unknown) => { if (mounted.current && call === request.current) setError(failure instanceof Error ? failure.message : 'This registered item could not be read.'); });
  }, [write]);
  const toggle = useCallback((id: string) => {
    const value = latest.current.view;
    const expanded = new Set(value.expanded_item_ids);
    const open = currentRows.current.find(row => row.item.id === id)?.expanded;
    if (open) expanded.delete(id); else expanded.add(id);
    void write(async () => {
      const confirmed = await latest.current.saveView({ ...structuredClone(value), expanded_item_ids: [...expanded] } as SessionPreferences);
      if (confirmed && open && mounted.current) setDismissedReveal(currentRevealRef.current);
      return confirmed;
    });
  }, [write]);
  const keyboard = useCallback((event: KeyboardEvent<HTMLDivElement>, id: string) => {
    if (editable(event.target) || event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
    const visible = currentRows.current, index = visible.findIndex(row => row.item.id === id), row = visible[index];
    if (!row) return;
    let destination: string | undefined;
    switch (event.key) {
      case 'ArrowDown': case 'j': destination = visible[Math.min(index + 1, visible.length - 1)]?.item.id; break;
      case 'ArrowUp': case 'k': destination = visible[Math.max(0, index - 1)]?.item.id; break;
      case 'Home': destination = visible[0]?.item.id; break;
      case 'End': destination = visible.at(-1)?.item.id; break;
      case 'ArrowRight': case 'l': if (row.childCount && !row.expanded) toggle(id); else if (row.expanded) destination = visible[index + 1]?.depth > row.depth ? visible[index + 1].item.id : undefined; break;
      case 'ArrowLeft': case 'h': if (row.childCount && row.expanded && latest.current.view.expanded_item_ids.includes(id)) toggle(id); else destination = row.item.parent ?? undefined; break;
      case 'Enter': select(id); break;
      case 'z': void write(() => latest.current.saveLater(id, !latest.current.later.has(id))); break;
      default: return;
    }
    event.preventDefault();
    if (destination) { setFocusId(destination); elements.current.get(destination)?.focus({ preventScroll: true }); }
  }, [select, toggle, write]);
  useEffect(() => { setSearch(view.filters.search); setPendingSearch(null); }, [store, view.filters.search]);
  useEffect(() => {
    if (search === view.filters.search) return;
    const timer = setTimeout(() => setPendingSearch({ store, text: search }), 100);
    return () => clearTimeout(timer);
  }, [search, view.filters.search, store]);
  useEffect(() => {
    if (!pendingSearch || writing || state.status !== 'ready') return;
    setPendingSearch(null);
    if (pendingSearch.store !== store || pendingSearch.text !== search || pendingSearch.text === view.filters.search) return;
    // Merge only the latest unsubmitted text into the newly rendered view and
    // its composition-owned revision; never retry a previously attempted edit.
    void write(() => latest.current.saveView({ ...structuredClone(latest.current.view),
      filters: { ...structuredClone(latest.current.view.filters), search: pendingSearch.text } } as SessionPreferences));
  }, [pendingSearch, writing, state.status, store, search, view, write]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++request.current; }; }, []);
  useEffect(() => {
    ++request.current; setLocalReveal(null);
    setFocusId(reveal?.store === store && reveal.kind === 'item' ? reveal.route.item_id : latest.current.view.selected_item_id);
    // External reveal changes are handled by the layout effect; this reset is
    // only for replacing the opened session store.
  }, [store]);
  const previousFocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!rows.length) return;
    if (focusId && rows.some(row => row.item.id === focusId)) return;
    let candidate = focusId ? session?.items[focusId]?.parent : null;
    while (candidate && !rows.some(row => row.item.id === candidate)) candidate = session?.items[candidate]?.parent ?? null;
    const next = candidate ?? rows[0].item.id;
    setFocusId(next);
    if (previousFocus.current) elements.current.get(next)?.focus({ preventScroll: true });
  }, [rows, focusId, session]);
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const captureAnchor = useCallback(() => {
    const scroller = container.current;
    if (!scroller) return;
    const top = scroller.getBoundingClientRect().top;
    const first = [...elements.current].find(([, element]) => element.getBoundingClientRect().bottom > top);
    anchor.current = first ? { id: first[0], offset: first[1].getBoundingClientRect().top - top } : null;
  }, []);
  useLayoutEffect(() => {
    const scroller = container.current;
    if (!scroller) return;
    if (anchor.current) {
      const element = elements.current.get(anchor.current.id);
      if (element) scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.current.offset;
    } else if (view.scroll?.item_id) {
      const element = elements.current.get(view.scroll.item_id);
      if (element) scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - view.scroll.offset;
    }
    captureAnchor();
  }, [projection, view.scroll, captureAnchor]);
  useLayoutEffect(() => {
    if (!belongs || currentReveal.kind !== 'item') return;
    setFocusId(currentReveal.route.item_id);
    const element = elements.current.get(currentReveal.route.item_id);
    element?.focus({ preventScroll: true });
    element?.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
    captureAnchor();
  }, [currentReveal, belongs, captureAnchor]);
  const clearFilters = () => {
    const next = structuredClone(view) as SessionPreferences;
    next.filters = { ...next.filters, search: '', statuses: [], owners: [], topic_id: null, hide_later: false };
    void write(() => latest.current.saveView(next));
  };
  const filter = (change: (next: SessionPreferences['filters']) => void) => {
    const next = structuredClone(view) as SessionPreferences;
    change(next.filters); void write(() => latest.current.saveView(next));
  };
  const disabled = state.status !== 'ready' || writing;
  const outside = rows.find(row => row.outsideFilters);
  const owners: Immutable<ItemOwner>[] = [...view.filters.owners];
  for (const item of Object.values(session?.items ?? {})) if (item && !owners.some(owner => sameOwner(owner, item.owner))) owners.push(item.owner);
  return <section className="ariadne-reference sentence-tree" aria-label="Session sentence tree" onKeyDown={event => {
    if (!editable(event.target) && (event.key === '/' || (event.metaKey && event.key.toLowerCase() === 'f'))) {
      event.preventDefault(); searchInput.current?.focus();
    }
  }}>
    <label className="sentence-search">Search sentences<input ref={searchInput} type="search" value={search} onChange={event => { setPendingSearch(null); setSearch(event.target.value); }} disabled={disabled} /></label>
    <div className="sentence-filters" aria-label="Sentence filters">
      <label>Topic<select value={view.filters.topic_id ?? ''} disabled={disabled} onChange={event => filter(next => { next.topic_id = event.target.value || null; })}>
        <option value="">All topics</option>{session && Object.values(session.topics).filter(topic => !!topic)
          .sort((a, b) => a.order - b.order).map(topic => <option key={topic.id} value={topic.id}>{topic.name}</option>)}
      </select></label>
      <div role="group" aria-label="Item status">{statuses.map(status => <button type="button" key={status}
        disabled={disabled} aria-pressed={view.filters.statuses.includes(status)} className="ref-button ref-ghost"
        onClick={() => filter(next => { next.statuses = next.statuses.includes(status) ? next.statuses.filter(value => value !== status) : [...next.statuses, status]; })}>
        {STATUS[visualStatus(status)].label}</button>)}</div>
      <div role="group" aria-label="Item owner">{owners.map((owner, index) => <button type="button" key={index}
        disabled={disabled} aria-pressed={view.filters.owners.some(value => sameOwner(value, owner))} className="ref-button ref-ghost"
        onClick={() => filter(next => { next.owners = next.owners.some(value => sameOwner(value, owner))
          ? next.owners.filter(value => !sameOwner(value, owner)) : [...next.owners, structuredClone(owner) as ItemOwner]; })}>
        {owner.kind === 'me' ? 'Me' : owner.kind === 'other' ? owner.name : `Agent · ${owner.binding_id}`}</button>)}</div>
      <label><input type="checkbox" checked={view.filters.hide_later} disabled={disabled} onChange={event => filter(next => { next.hide_later = event.target.checked; })} />Hide Later</label>
      <label><input type="checkbox" checked={view.filters.archived} disabled={disabled} onChange={event => filter(next => { next.archived = event.target.checked; })} />Archive</label>
    </div>
    {state.status !== 'ready' && <p role="status">{state.error?.message ?? (session ? 'This session is stale. Showing the last valid snapshot.' : 'Loading the registered session…')}</p>}
    {error && <p role="alert">{error}</p>}
    {belongs && currentReveal.kind === 'missing_item' && <p role="status">{currentReveal.banner}</p>}
    {outside && <p role="status">Item {outside.item.id} is outside the current filters. <button type="button" onClick={() => setDismissedReveal(currentReveal)}>Dismiss temporary reveal</button></p>}
    {projection && !rows.length && <p>No sentences match these filters. <button type="button" disabled={writing || state.status !== 'ready'} onClick={clearFilters}>Clear filters</button></p>}
    <div ref={container} role="tree" aria-label="Sentences" aria-busy={state.status === 'loading'} className="sentence-rows"
      onScroll={captureAnchor} onFocus={() => { previousFocus.current = focusId; }} onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          previousFocus.current = null;
          if (anchor.current) void write(() => latest.current.saveView({ ...structuredClone(latest.current.view), scroll: { item_id: anchor.current!.id, offset: anchor.current!.offset } } as SessionPreferences));
        }
      }}>
      {rows.map(row => <SentenceItem key={row.item.id} row={row} selected={view.selected_item_id === row.item.id} focused={focusId === row.item.id}
        later={later.has(row.item.id)} highlighted={highlightedItemIds?.has(row.item.id) ?? false} onHoverItem={onHoverItem} remember={remember} focus={focus} select={select} toggle={toggle} keyboard={keyboard} />)}
    </div>
    {projection && <footer>{rows.length} visible · {projection.matchingTotal} matching · {projection.scopeTotal} in this scope · ↑/↓ or j/k to move · Enter to open · z for Later</footer>}
  </section>;
}
