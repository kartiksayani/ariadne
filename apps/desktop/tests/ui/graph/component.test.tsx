import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useLayoutEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Session } from '../../../src/generated/domain/models';
import type { QueryEnvelope, SessionPreferences } from '../../../src/generated/core';
import { OpenSessions, immutable } from '../../../src/data/session-store';
import { RegisteredRoutes, type RevealedItem } from '../../../src/data/routes';
import { createDesktopService, type DesktopTransport } from '../../../src/data/service';
import { GraphView } from '../../../src/ui/graph/GraphView';
import { MapSearchContext, NO_SEARCH, type MapSearch } from '../../../src/ui/tree/mapSearch';
import { PeekContext, type PeekNavigation } from '../../../src/ui/peek/context';
import { GraphFilterSlot } from '../../../src/ui/tree/FilterBar';
import type { ChangeMarker } from '../../../src/ui/tree/model';
import { graphSession, preferences, topicA } from './fixture';
import { Notices, notices } from '../../../src/ui/pages/notices';

const opened: OpenSessions[] = [];
afterEach(() => { cleanup(); opened.splice(0).forEach(sessions => sessions.closeAll()); notices.clear(); vi.restoreAllMocks(); vi.useRealTimers(); });

interface CompositionProps {
  reveal?: RevealedItem | null; hidden?: string[]; selection?: string; filters?: Partial<SessionPreferences['filters']>;
  expanded?: string[]; markers?: ReadonlyMap<string, ChangeMarker>; search?: MapSearch; onCommit?: () => void;
}
async function setup(session: Session = graphSession(), view = preferences()) {
  const route = { project_id: session.project_id, session_id: session.id };
  let failReveal = false;
  const transport: DesktopTransport = {
    async invoke<T>(command: string, args: Parameters<DesktopTransport['invoke']>[1]): Promise<T> {
      if (command === 'reveal_item' && failReveal) return { api_version: 1, ok: false,
        error: { code: 'unavailable', message: 'The registered item could not be read.', hint: 'Retry.', retryable: true, field_errors: [] } } as T;
      const request = args.request;
      const result = command === 'session_get' ? { session: structuredClone(session), freshness: 'fresh' }
        : { ...route, item_id: 'request' in request ? (request.request.params as { item_id: string }).item_id : '1' };
      return { api_version: 1, ok: true, data: { kind: command, data: result } } as QueryEnvelope as T;
    },
    async listen() { return () => {}; },
  };
  const service = createDesktopService(transport), sessions = new OpenSessions(service); opened.push(sessions);
  const store = sessions.open(route); await store.refresh();
  const routes = new RegisteredRoutes(service, sessions), saved: SessionPreferences[] = [], reveals: [string, boolean][] = [];
  let write: (next: SessionPreferences) => Promise<boolean> = async () => true;
  function Composition({ reveal = null, hidden, selection, filters, expanded, markers, search, onCommit }: CompositionProps) {
    const [current, setCurrent] = useState(view);
    useLayoutEffect(() => { onCommit?.(); });
    const graph = <GraphView store={store} routes={routes} view={immutable({ ...current, ...(hidden ? { hidden_item_ids: hidden } : {}),
      ...(selection ? { selected_item_id: selection } : {}), ...(filters ? { filters: { ...current.filters, ...filters } } : {}),
      ...(expanded ? { expanded_item_ids: expanded } : {}) })} later={new Set()} reveal={reveal} markers={markers}
      saveView={async next => { saved.push(structuredClone(next)); const ok = await write(next); if (ok) setCurrent(next); return ok; }}
      onReveal={(result, openDetail) => { if (result.kind === 'item') reveals.push([result.route.item_id, openDetail]); }} />;
    return <MapSearchContext.Provider value={search ?? NO_SEARCH}>{graph}</MapSearchContext.Provider>;
  }
  return { Composition, store, routes, saved, reveals, route, session,
    failReveal: () => { failReveal = true; }, writeWith: (next: typeof write) => { write = next; } };
}
const node = (id: string) => document.querySelector<HTMLElement>(`.graph-node[data-item-id="${id}"]`)!;
const ids = () => [...document.querySelectorAll<HTMLElement>('.graph-node')].map(element => element.dataset.itemId);
const selected = () => document.querySelector<HTMLElement>('.graph-node[aria-selected="true"]')?.dataset.itemId;
const searchFor = (matches: string[], current: string | null, stepped = 0): MapSearch => ({ ...NO_SEARCH, query: 'needle', terms: ['needle'],
  matches: matches.map(id => ({ id, field: 'question' })), ids: new Set(matches), current: current ? { id: current, field: 'question' } : null, stepped });
/** Every node at one spot in a 400x300 scroller, shifted by its scroll: holding still is the only thing that can pass. */
function stillGeometry() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.matches('.graph-scroll')) return new DOMRect(0, 0, 400, 300);
    const box = this.closest<HTMLElement>('.graph-scroll');
    return new DOMRect(900 - (box?.scrollLeft ?? 0), 800 - (box?.scrollTop ?? 0), 124, 40);
  });
}
/** The scroller and every node at fixed spots: centring puts a node at 500 down 383 scrolled. */
function centreGeometry() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('graph-scroll') ? new DOMRect(0, 0, 400, 300) : new DOMRect(600, 500, 190, 66);
  });
}

describe('session graph view', () => {
  // The Graph never moves on its own (graph-anchor.spec.mts holds the real-layout table); here nothing a passive change
  // does may scroll or take focus, from any kind of selection.
  const scrollStarts = ['visible selection', 'hidden selection', 'status-excluded selection', 'collapsed-parent selection'] as const;
  const passiveEvents = ['search highlight', 'status change', 'parent fold', 'parent unfold', 'live addition', 'live removal', 'plain selection',
    'pointer over a node', 'Map width change'] as const;
  it.each(scrollStarts.flatMap(start => passiveEvents.map(event => ({ start, event }))))('keeps Graph scroll and focus unchanged after $event from $start', async ({ start, event }) => {
    stillGeometry();
    const session = graphSession();
    session.items['9'] = { ...session.items['8']!, id: '9', ordinal: 9, question: 'Unrelated branch' };
    session.items['9.1'] = { ...session.items['8']!, id: '9.1', parent: '9', ordinal: 1, question: 'Unrelated child' };
    const target = '1.1.1';
    const value = await setup(session, preferences({ selected_item_id: target, hidden_item_ids: start === 'hidden selection' ? ['1.1'] : [] }));
    let props: CompositionProps = { filters: { statuses: start === 'status-excluded selection' ? ['open'] : [] },
      expanded: [...(start === 'collapsed-parent selection' ? [] : ['1', '1.1']), ...(event === 'parent unfold' ? [] : ['9'])], selection: target };
    const composition = () => <><input aria-label="Outside editor" /><value.Composition {...props} /></>;
    const { rerender } = render(composition());
    expect(node(target) !== null).toBe(start === 'visible selection' || start === 'hidden selection');
    await act(async () => {});
    const box = document.querySelector<HTMLElement>('.graph-scroll')!, editor = screen.getByRole('textbox', { name: 'Outside editor' });
    box.scrollTop = 47; box.scrollLeft = 83;
    act(() => editor.focus());
    const before = { top: box.scrollTop, left: box.scrollLeft, focused: document.activeElement, left2: node('2').style.left };
    if (event === 'search highlight') props = { ...props, search: searchFor(['9', '2'], '9') };
    else if (event === 'status change') props = { ...props, filters: { statuses: start === 'status-excluded selection' ? [] : ['open'] } };
    else if (event === 'parent fold' || event === 'parent unfold') props = { ...props, expanded: event === 'parent fold' ? props.expanded!.filter(id => id !== '9') : [...props.expanded!, '9'] };
    else if (event === 'live addition' || event === 'live removal') {
      if (event === 'live addition') session.items['10'] = { ...session.items['8']!, id: '10', ordinal: 10 };
      else delete session.items['8'];
      session.revision++;
      await act(async () => { await value.store.refresh(true); });
    } else if (event === 'plain selection') props = { ...props, selection: '8' };
    else if (event === 'pointer over a node') fireEvent.mouseOver(node('2'));
    else vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
    rerender(composition());
    await act(async () => {});
    expect({ top: box.scrollTop, left: box.scrollLeft, focused: document.activeElement, left2: node('2').style.left }).toEqual(before);
  });

  it('fits the column to the Map’s width when it opens, and keeps it through later width changes until the session changes', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    const value = await setup();
    const { rerender } = render(<value.Composition key="one" />);
    // col = clamp(150, floor((1000 − 56) / 5), 196) = 188; nodes 162 wide; depth 2 at 36 + 188.
    expect([node('1.1').style.left, node('1.1').style.width]).toEqual(['224px', '162px']);
    width.mockReturnValue(600);
    rerender(<value.Composition key="one" selection="2" />);
    fireEvent(window, new Event('resize'));
    expect([node('1.1').style.left, node('1.1').style.width]).toEqual(['224px', '162px']);
    // A new session view fits again.
    const other = await setup();
    render(<other.Composition key="two" />);
    expect(document.querySelectorAll<HTMLElement>('.graph-node[data-item-id="1.1"]')[1]!.style.width).toBe('124px');
  });

  it.each(['button', 'page body'] as const)('leaves focus outside the Graph on the %s when a previously focused entry disappears', async destination => {
    const value = await setup();
    render(<><button type="button">Elsewhere</button><value.Composition /></>);
    act(() => node('1.2').focus());
    const outside = screen.getByRole('button', { name: 'Elsewhere' });
    act(() => { outside.focus(); if (destination === 'page body') outside.blur(); });
    const focused = document.activeElement;
    value.session.items['1.2']!.removed_at = value.session.updated_at; value.session.revision++;
    await act(async () => { await value.store.refresh(true); });
    expect(document.activeElement).toBe(focused);
  });

  it.each(['outside reveal', 'owner key', 'owner click'] as const)('drops an undrawn %s scroll target before a later commit can draw it', async cause => {
    stillGeometry();
    const value = await setup(undefined, preferences({ selected_item_id: '1.1.1', expanded_item_ids: [] }));
    const reveal = await value.routes.revealItem({ ...value.route, item_id: '1.1.1' });
    // An outside route may precede its live snapshot. Neither that arrival nor
    // a later expansion may revive this commit's unsuccessful scroll request.
    const undrawn = reveal?.kind === 'item' ? { ...reveal, route: { ...reveal.route, item_id: 'late' }, temporaryExpandedItemIds: [] } : null;
    const { rerender } = render(<><input aria-label="Outside editor" /><value.Composition /></>);
    if (cause === 'outside reveal') rerender(<><input aria-label="Outside editor" /><value.Composition reveal={undrawn} /></>);
    else {
      vi.spyOn(value.routes, 'revealItem').mockResolvedValueOnce(null);
      act(() => {
        node('1').focus();
        if (cause === 'owner key') fireEvent.keyDown(node('1'), { key: 'ArrowDown' });
        else fireEvent.click(node('2'));
        // The optimistic target is excluded in the very commit it requested.
        rerender(<><input aria-label="Outside editor" /><value.Composition filters={{ statuses: ['done'] }} /></>);
      });
      expect(node('2')).toBeNull();
    }
    await act(async () => {});
    const box = document.querySelector<HTMLElement>('.graph-scroll')!, editor = screen.getByRole('textbox', { name: 'Outside editor' });
    box.scrollTop = 47; box.scrollLeft = 83; act(() => editor.focus());
    if (cause === 'outside reveal') {
      value.session.items['late'] = { ...value.session.items['8']!, id: 'late', ordinal: 9 }; value.session.revision++;
      await act(async () => { await value.store.refresh(true); });
      expect(node('late')).not.toBeNull();
    } else rerender(<><input aria-label="Outside editor" /><value.Composition expanded={['1', '1.1']} /></>);
    await act(async () => {});
    expect({ top: box.scrollTop, left: box.scrollLeft, focused: document.activeElement }).toEqual({ top: 47, left: 83, focused: editor });
  });

  describe('search (contract C3): tints in place, never filters', () => {
    it('tints every drawn match and rings the current one, keeping every node', async () => {
      const value = await setup();
      const { rerender } = render(<value.Composition />);
      const all = ids();
      rerender(<value.Composition search={searchFor(['1.1.1', '2', 'missing'], '2')} />);
      expect(ids()).toEqual(all);
      expect([...document.querySelectorAll('.graph-node.is-match')].map(element => (element as HTMLElement).dataset.itemId)).toEqual(['1.1.1', '2']);
      expect(node('2').className).toContain('is-current-match');
      expect(node('2').dataset.currentMatch).toBe('true');
      expect(node('1.1.1').className).not.toContain('is-current-match');
      expect(value.saved).toEqual([]); expect(value.reveals).toEqual([]);
    });

    it('scrolls the current match into view on a step only, selecting nothing and closing a peek', async () => {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        if (this.matches('.graph-scroll')) return new DOMRect(0, 0, 400, 300);
        const box = this.closest<HTMLElement>('.graph-scroll'), far = this.dataset.itemId === '3';
        return new DOMRect(100 - (box?.scrollLeft ?? 0), (far ? 700 : 100) - (box?.scrollTop ?? 0), 124, 40);
      });
      const peek = peekStub();
      const value = await setup(undefined, preferences({ selected_item_id: '2' }));
      const view = (search: MapSearch) => <PeekContext.Provider value={peek}><value.Composition search={search} /></PeekContext.Provider>;
      const { rerender } = render(view(searchFor(['3'], '3')));
      const box = document.querySelector<HTMLElement>('.graph-scroll')!;
      box.scrollTop = 0;
      // Typing (new matches, same step count) never scrolls.
      rerender(view(searchFor(['3', '8'], '3')));
      await act(async () => {});
      expect(box.scrollTop).toBe(0);
      rerender(view(searchFor(['3', '8'], '3', 1)));
      await act(async () => {});
      // Nearest edge: the 40px match ends 8px above the scroller's bottom.
      expect(box.scrollTop).toBe(700 + 40 - 300 + 8);
      expect(selected()).toBe('2');
      expect(value.saved).toEqual([]); expect(value.reveals).toEqual([]);
      expect(peek.closeAll).toHaveBeenCalledTimes(1);
    });
  });

  describe('related lines and the pointer', () => {
    it('draws related lines only for the selected node and the node under the pointer, and rings what they reach', async () => {
      const session = graphSession(); session.items['1']!.related = ['2', '8']; session.items['3']!.related = ['1.2'];
      const value = await setup(session);
      const { rerender } = render(<value.Composition />);
      expect(document.querySelector('.graph-related[data-edge]')).toBeNull();
      rerender(<value.Composition selection="1" />);
      expect([...document.querySelectorAll<SVGPathElement>('.graph-lines .graph-related')].map(path => path.dataset.edge).sort())
        .toEqual(['related:1:2', 'related:1:8']);
      expect([node('2'), node('8')].every(element => element.classList.contains('is-related'))).toBe(true);
      fireEvent.mouseOver(node('3'));
      expect(document.querySelector('[data-edge="related:3:1.2"]')).toBeTruthy();
      expect(node('1.2').className).toContain('is-related');
      // Moving within the node keeps it; leaving it clears the hover's lines, the selection's stay.
      fireEvent.mouseOut(node('3').querySelector('.graph-node-name')!, { relatedTarget: node('3') });
      expect(document.querySelector('[data-edge="related:3:1.2"]')).toBeTruthy();
      fireEvent.mouseOut(node('3'), { relatedTarget: document.body });
      expect(document.querySelector('[data-edge="related:3:1.2"]')).toBeNull();
      expect(document.querySelector('[data-edge="related:1:2"]')).toBeTruthy();
      expect(value.saved).toEqual([]); expect(value.reveals).toEqual([]);
    });

    it('asks the peek to open on hover and to close on leave from one delegated handler, and Space toggles it for the focused node', async () => {
      const peek = peekStub(), value = await setup(undefined, preferences({ selected_item_id: '2' }));
      render(<PeekContext.Provider value={peek}><value.Composition /></PeekContext.Provider>);
      fireEvent.mouseOver(node('1.2').querySelector('.graph-node-name')!);
      expect(peek.hoverStart).toHaveBeenCalledWith({ ...value.route, item_id: '1.2' }, node('1.2'));
      fireEvent.mouseOver(node('1.2'));
      expect(peek.hoverStart).toHaveBeenCalledTimes(1);
      // Resting again (after a scroll made the peek forget the node) asks again; the peek ignores a repeat.
      fireEvent.mouseMove(node('1.2').querySelector('.graph-node-name')!);
      expect(peek.hoverStart).toHaveBeenLastCalledWith({ ...value.route, item_id: '1.2' }, node('1.2'));
      fireEvent.mouseOut(node('1.2'), { relatedTarget: document.body });
      expect(peek.hoverEnd).toHaveBeenCalledTimes(1);
      act(() => node('2').focus());
      fireEvent.keyDown(node('2'), { key: ' ' });
      expect(peek.toggle).toHaveBeenCalledWith({ ...value.route, item_id: '2' }, node('2'));
      // The card anchors to the node's name.
      expect(node('2').querySelector('[data-peek-anchor]')!.textContent).toBe(node('2').querySelector('.graph-node-name')!.textContent);
    });
  });

  describe('hidden items are not drawn (SPEC 1.3)', () => {
    it('draws no hidden item and no stub, and opens a hidden item’s detail from its selected route only', async () => {
      const value = await setup(undefined, preferences({ hidden_item_ids: ['1'] }));
      const { rerender } = render(<value.Composition />);
      expect(ids()).toEqual(['2', '3', '8']);
      expect(document.querySelector('.graph-stub')).toBeNull();
      rerender(<value.Composition selection="1.1.1" />);
      expect(ids()).toEqual(['1', '1.1', '1.1.1', '2', '3', '8']);
      for (const id of ['1', '1.1', '1.1.1']) expect(node(id).className).toContain('is-hidden');
      expect(node('1.1.1').getAttribute('aria-label')).toContain('(hidden)');
      // Choosing a hidden item on the route selects it and opens detail without un-hiding it.
      fireEvent.click(node('1.1'));
      await waitFor(() => expect(value.reveals).toEqual([['1.1', true]]));
      await waitFor(() => expect(value.saved.at(-1)).toMatchObject({ selected_item_id: '1.1', hidden_item_ids: ['1'] }));
    });

    it('drops a hidden route when the selection moves elsewhere', async () => {
      const value = await setup(undefined, preferences({ hidden_item_ids: ['1'], selected_item_id: '1.1.1' }));
      render(<value.Composition />);
      expect(node('1.1.1')).toBeTruthy();
      fireEvent.keyDown(node('1.1.1'), { key: 'End' });
      await waitFor(() => expect(value.saved.at(-1)?.selected_item_id).toBe('8'));
      expect(node('1.1.1')).toBeNull();
      expect(selected()).toBe('8');
    });

    it('draws and centers a saved hidden selection on startup and on a session-keyed remount', async () => {
      centreGeometry();
      const value = await setup(undefined, preferences({ hidden_item_ids: ['1', '1.1'], selected_item_id: '1.1.1', expanded_item_ids: [] }));
      // The first commit fits the column to the Map's width; the drawn commit follows before any paint.
      const { rerender } = render(<value.Composition key="session-one" />);
      const check = () => {
        expect(selected()).toBe('1.1.1');
        expect(document.activeElement).toBe(node('1.1.1'));
        expect(document.querySelector('.graph-scroll')!.scrollTop).toBe(383);
        expect(node('1.1.1').className).toContain('is-hidden');
      };
      check();
      document.querySelector<HTMLElement>('.graph-scroll')!.scrollTop = 0;
      rerender(<value.Composition key="session-two" />);
      check();
      expect(value.saved).toEqual([]);
    });

    it('opens and centers a hidden Tree selection on the first drawn Graph commit after the reveal is dismissed', async () => {
      centreGeometry();
      const value = await setup(undefined, preferences({ hidden_item_ids: ['1'], expanded_item_ids: [] }));
      render(<value.Composition reveal={null} selection="1.1.1" />);
      expect(selected()).toBe('1.1.1');
      expect(document.querySelector('.graph-scroll')!.scrollTop).toBe(383);
      expect(document.activeElement).toBe(node('1.1.1'));
      expect(node('1.1.1').className).toContain('is-hidden');
    });

    it('draws a newly selected hidden route in place, without a reveal or a scroll', async () => {
      centreGeometry();
      const value = await setup(undefined, preferences({ selected_item_id: '2', hidden_item_ids: ['1', '1.1'], expanded_item_ids: [] }));
      const { rerender } = render(<value.Composition />);
      expect(node('1.1.1')).toBeNull();
      const box = document.querySelector<HTMLElement>('.graph-scroll')!;
      box.scrollTop = 0;
      const left = box.scrollLeft, commits: { selected: string | undefined; top: number; left: number }[] = [];
      rerender(<value.Composition selection="1.1.1" onCommit={() => { commits.push({ selected: selected(), top: box.scrollTop, left: box.scrollLeft }); }} />);
      expect(commits[0]).toEqual({ selected: '1.1.1', top: 0, left });
      expect(node('1.1.1').className).toContain('is-hidden');
      expect(value.saved).toEqual([]);
      expect(value.reveals).toEqual([]);
    });

    it('keeps a selection that becomes hidden drawn, dimmed and focused', async () => {
      const value = await setup(undefined, preferences({ selected_item_id: '2' }));
      const { rerender } = render(<value.Composition />);
      act(() => node('2').focus());
      rerender(<value.Composition hidden={['2']} />);
      expect(node('2').className).toContain('is-hidden');
      expect(document.activeElement).toBe(node('2'));
    });
  });

  it.each(['visible', 'hidden'] as const)('keeps both scroll positions when a plain selection changes to an off-screen %s item', async visibility => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('graph-scroll')) return new DOMRect(0, 0, 400, 300);
      const box = this.closest<HTMLElement>('.graph-scroll'), target = this.dataset.itemId === '1.1.1';
      return new DOMRect((target ? 1000 : 100) - (box?.scrollLeft ?? 0), (target ? 900 : 100) - (box?.scrollTop ?? 0), 124, 40);
    });
    const value = await setup(undefined, preferences({ selected_item_id: '2',
      ...(visibility === 'hidden' ? { hidden_item_ids: ['1', '1.1'], expanded_item_ids: [] } : {}) }));
    const { rerender } = render(<value.Composition />);
    const box = document.querySelector<HTMLElement>('.graph-scroll')!;
    box.scrollTop = 47; box.scrollLeft = 83;
    const focused = document.activeElement, commits: { selected: string | undefined; top: number; left: number }[] = [];
    const observe = () => { commits.push({ selected: selected(), top: box.scrollTop, left: box.scrollLeft }); };
    rerender(<value.Composition selection="1.1.1" onCommit={observe} />);
    expect(commits[0]).toEqual({ selected: '1.1.1', top: 47, left: 83 });
    expect(node('1.1.1').getBoundingClientRect().top).toBeGreaterThan(box.getBoundingClientRect().bottom);
    expect(node('1.1.1').classList.contains('is-hidden')).toBe(visibility === 'hidden');
    await act(async () => { await value.store.refresh(true); });
    expect(commits.every(commit => commit.top === 47 && commit.left === 83)).toBe(true);
    expect(document.activeElement).toBe(focused);
    expect(value.saved).toEqual([]); expect(value.reveals).toEqual([]);
  });

  it.each(['visible', 'off-screen'] as const)('uses nearest-edge scrolling for an owner click on the %s node', async position => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('graph-scroll')) return new DOMRect(0, 0, 400, 300);
      const box = this.closest<HTMLElement>('.graph-scroll'), target = this.dataset.itemId === '3';
      return new DOMRect((target ? position === 'visible' ? 100 : 600 : 105) - (box?.scrollLeft ?? 0),
        (target ? position === 'visible' ? 100 : 500 : 117) - (box?.scrollTop ?? 0), 190, 66);
    });
    const value = await setup(undefined, preferences({ selected_item_id: '2' }));
    const echo = await value.routes.revealItem({ ...value.route, item_id: '3' });
    vi.spyOn(value.routes, 'revealItem').mockResolvedValueOnce(echo);
    const { rerender } = render(<value.Composition />);
    const box = document.querySelector<HTMLElement>('.graph-scroll')!;
    fireEvent.click(node('3'));
    await waitFor(() => expect(value.reveals).toEqual([['3', true]]));
    const expected = position === 'visible' ? { top: 0, left: 0 } : { top: 274, left: 398 };
    expect({ top: box.scrollTop, left: box.scrollLeft }).toEqual(expected);
    rerender(<value.Composition reveal={echo} />);
    expect({ top: box.scrollTop, left: box.scrollLeft }).toEqual(expected);
  });

  it('opens an outside hidden selection on its first commit after an internal reveal', async () => {
    const value = await setup(undefined, preferences({ selected_item_id: '2', hidden_item_ids: ['1', '1.1'] }));
    const { rerender } = render(<value.Composition />);
    fireEvent.click(node('3'));
    await waitFor(() => expect(value.reveals).toEqual([['3', true]]));
    const reveal = await value.routes.revealItem({ ...value.route, item_id: '1.1.1' });
    const commits: (string | undefined)[] = [];
    rerender(<value.Composition reveal={reveal} onCommit={() => { commits.push(selected()); }} />);
    expect(commits[0]).toBe('1.1.1');
    expect(selected()).toBe('1.1.1');
  });

  it('discards an internal reveal that finishes after an outside reveal replaces it', async () => {
    centreGeometry();
    const value = await setup(undefined, preferences({ selected_item_id: '2', hidden_item_ids: ['1'] }));
    const outside = await value.routes.revealItem({ ...value.route, item_id: '1.1.1' });
    const stale = await value.routes.revealItem({ ...value.route, item_id: '3' });
    let finish!: (result: RevealedItem | null) => void;
    vi.spyOn(value.routes, 'revealItem').mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const { rerender } = render(<value.Composition />);
    fireEvent.click(node('3'));
    await waitFor(() => expect(value.saved.at(-1)?.selected_item_id).toBe('3'));
    rerender(<value.Composition reveal={outside} />);
    await act(async () => { finish(stale); });
    expect(selected()).toBe('1.1.1');
    expect(value.reveals).toEqual([]);
    const box = document.querySelector<HTMLElement>('.graph-scroll')!;
    box.scrollTop = 0;
    rerender(<value.Composition reveal={stale} />);
    expect(selected()).toBe('3');
    expect(box.scrollTop).toBe(383);
    expect(document.activeElement).toBe(node('3'));
  });

  it('opens an outside hidden selection on its first commit while an older selection write is pending', async () => {
    const value = await setup(undefined, preferences({ selected_item_id: '2', hidden_item_ids: ['1'] }));
    const outside = await value.routes.revealItem({ ...value.route, item_id: '1.1.1' });
    let finish!: () => void;
    value.writeWith(() => new Promise(resolve => { finish = () => resolve(true); }));
    const { rerender } = render(<value.Composition />);
    fireEvent.click(node('3'));
    await waitFor(() => expect(value.reveals).toEqual([['3', true]]));
    expect(value.saved.at(-1)?.selected_item_id).toBe('3');
    const commits: (string | undefined)[] = [];
    rerender(<value.Composition reveal={outside} onCommit={() => { commits.push(selected()); }} />);
    expect(commits[0]).toBe('1.1.1');
    await act(async () => { finish(); });
    expect(selected()).toBe('1.1.1');
  });

  it.each(['node', 'hidden node', 'last node'])('keeps focus on the nearest surviving entry when a focused %s disappears', async kind => {
    const session = graphSession();
    const value = await setup(session, preferences({ selected_item_id: '2', hidden_item_ids: kind === 'hidden node' ? ['1.1'] : [] }));
    const { rerender } = render(<value.Composition />);
    const target = node(kind === 'last node' ? '8' : '1.2');
    act(() => target.focus());
    if (kind === 'hidden node') rerender(<value.Composition hidden={['1.1', '1.2']} />);
    else {
      const id = kind === 'last node' ? '8' : '1.2';
      session.items[id]!.removed_at = session.updated_at; session.revision++;
      await act(async () => { await value.store.refresh(true); });
    }
    const expected = kind === 'last node' ? node('3') : node('2');
    expect(document.activeElement).toBe(expected);
    expect(expected.tabIndex).toBe(0);
    fireEvent.keyDown(expected, { key: kind === 'last node' ? 'ArrowUp' : 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).not.toBe(expected));
    expect(document.activeElement).not.toBe(document.body);
  });

  it('keeps focus on the scroller when the final graph entry disappears', async () => {
    const session = graphSession(); Object.keys(session.items).forEach(id => { if (id !== '8') delete session.items[id]; });
    const value = await setup(session, preferences({ selected_item_id: '8' }));
    render(<value.Composition />); act(() => node('8').focus());
    session.items['8']!.removed_at = session.updated_at; session.revision++;
    await act(async () => { await value.store.refresh(true); });
    expect(document.activeElement).toBe(document.querySelector('.graph-scroll'));
  });

  it('keeps one roving tab stop: the focused node, else the selection, else the first node', async () => {
    const value = await setup(undefined, preferences({ selected_item_id: '1.1.1' }));
    const { rerender } = render(<value.Composition />);
    const stops = () => [...document.querySelectorAll<HTMLElement>('.graph-node[tabindex="0"]')].map(element => element.dataset.itemId);
    expect(stops()).toEqual(['1.1.1']);
    act(() => node('1.2').focus());
    expect(stops()).toEqual(['1.2']);
    rerender(<value.Composition selection="2" />);
    expect(stops()).toEqual(['2']);
    cleanup();
    const plain = await setup();
    render(<plain.Composition />);
    expect(stops()).toEqual(['1']);
  });

  it('starts arrow traversal at a focused unselected node', async () => {
    const value = await setup(undefined, preferences({ selected_item_id: '2' }));
    render(<value.Composition />);
    act(() => node('1.1.1').focus());
    fireEvent.keyDown(node('1.1.1'), { key: 'ArrowDown' });
    expect(selected()).toBe('1.2');
    await waitFor(() => expect(value.reveals).toEqual([['1.2', false]]));
    expect(document.activeElement).toBe(node('1.2'));
  });

  describe('keyboard moves bring the target, with its focus ring, into view across as well as down', () => {
    /** A scroller 300 high; each node at its own x, shifted by the scroller's scrollLeft. */
    function lay(at: Record<string, number>, scrollerWidth = 400) {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const scroller = this.closest<HTMLElement>('.graph-scroll');
        if (this.classList.contains('graph-scroll')) return new DOMRect(0, 0, scrollerWidth, 300);
        const left = (at[this.dataset.itemId ?? ''] ?? 100) - (scroller?.scrollLeft ?? 0);
        return new DOMRect(left, 100, 124, 40);
      });
    }
    const scrolled = () => document.querySelector<HTMLElement>('.graph-scroll')!.scrollLeft;

    it('scrolls to a node beyond the right edge, then to one beyond the left edge, leaving 8px for the ring', async () => {
      lay({ '1.1.1': 20, '1.2': 560, 2: 100 });
      const value = await setup(undefined, preferences({ selected_item_id: '1.1.1' }));
      render(<value.Composition />);
      fireEvent.keyDown(node('1.1.1'), { key: 'ArrowDown' });
      await waitFor(() => expect(document.activeElement).toBe(node('1.2')));
      expect(node('1.2').getBoundingClientRect().right).toBe(400 - 8);
      fireEvent.keyDown(node('1.2'), { key: 'ArrowDown' });
      await waitFor(() => expect(document.activeElement).toBe(node('2')));
      expect(node('2').getBoundingClientRect().left).toBe(8);
    });
    it('does not scroll when the target and its ring are already in view', async () => {
      lay({ '1.1.1': 20, '1.2': 120 });
      const value = await setup(undefined, preferences({ selected_item_id: '1.1.1' }));
      render(<value.Composition />);
      const before = scrolled(), at = node('1.2').getBoundingClientRect();
      expect(at.left).toBeGreaterThanOrEqual(8); expect(at.right).toBeLessThanOrEqual(392);
      fireEvent.keyDown(node('1.1.1'), { key: 'ArrowDown' });
      await waitFor(() => expect(document.activeElement).toBe(node('1.2')));
      expect(scrolled()).toBe(before);
    });
    it('keeps the left edge of a target wider than the scroller in view', async () => {
      lay({ '1.1.1': 20, '1.2': 120, 2: 500 }, 100);
      const value = await setup(undefined, preferences({ selected_item_id: '1.2' }));
      render(<value.Composition />);
      fireEvent.keyDown(node('1.2'), { key: 'ArrowDown' });
      await waitFor(() => expect(document.activeElement).toBe(node('2')));
      expect(node('2').getBoundingClientRect().left).toBe(8);
    });
  });

  describe('a folded node shows a quiet "+N" so its children never vanish unseen', () => {
    it('opens a folded node: selects it, unfolds it, opens detail and saves the view', async () => {
      const value = await setup(undefined, preferences({ expanded_item_ids: [] })); render(<value.Composition />);
      const chip = node('1').querySelector<HTMLElement>('.graph-node-inside')!;
      expect(chip.textContent).toBe('+3 · 1 waiting');
      expect(chip.title).toBe('3 inside, 1 waiting on you');
      expect(node('1').getAttribute('aria-label')).toMatch(/\(folded, 3 inside, 1 waiting on you\)$/);
      expect(node('1').getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(node('1'));
      expect(selected()).toBe('1'); expect(ids()).toContain('1.1');
      await waitFor(() => expect(value.reveals).toEqual([['1', true]]));
      expect(value.saved.at(-1)).toMatchObject({ selected_item_id: '1', expanded_item_ids: ['1'] });
      expect(node('1').getAttribute('aria-expanded')).toBe('true');
      expect(node('1').querySelector('.graph-node-inside')).toBeNull();
    });

    it('counts what unfolding brings back across tiers, leaving hidden branches out', async () => {
      const session = graphSession();
      session.items['1.2.1'] = { ...session.items['1.2']!, id: '1.2.1', parent: '1.2', ordinal: 1 };
      session.items['1.2.1.1'] = { ...session.items['1.2']!, id: '1.2.1.1', parent: '1.2.1', ordinal: 1 };
      session.items['1.2.1.2'] = { ...session.items['1.2']!, id: '1.2.1.2', parent: '1.2.1', ordinal: 2 };
      const value = await setup(session, preferences({ expanded_item_ids: [], hidden_item_ids: ['1.1', '1.2.1.2'] }));
      render(<value.Composition />);
      const chip = (id: string) => node(id).querySelector('.graph-node-inside')?.textContent;
      expect(chip('1')).toBe('+3');
      fireEvent.click(node('1'));
      await waitFor(() => expect(value.reveals).toEqual([['1', true]]));
      expect(ids()).toEqual(['1', '1.2', '2', '3', '8']);
      expect(chip('1.2')).toBe('+2');
      fireEvent.click(node('1.2'));
      await waitFor(() => expect(value.reveals.at(-1)).toEqual(['1.2', true]));
      expect(chip('1.2.1')).toBe('+1');
      fireEvent.click(node('1.2.1'));
      await waitFor(() => expect(value.reveals.at(-1)).toEqual(['1.2.1', true]));
      expect(node('1.2.1.2')).toBeNull();
    });

    it('shows no chip on a node whose children are all hidden', async () => {
      const value = await setup(undefined, preferences({ hidden_item_ids: ['1.1', '1.2'], expanded_item_ids: [] }));
      render(<value.Composition />);
      expect(node('1').querySelector('.graph-node-inside')).toBeNull();
      expect(node('1').hasAttribute('aria-expanded')).toBe(false);
    });

    it('keeps the chip quiet: no accent, no fill', () => {
      const css = readFileSync(resolve(__dirname, '../../../src/ui/graph/graph.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      const rule = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(([, selector]) => selector!.trim() === '.graph-node-inside')![2]!;
      expect(rule).toMatch(/color:\s*color-mix\(in srgb, var\(--color-text\) 55%, transparent\);/);
      expect(rule).not.toMatch(/background|--color-accent|--a-acc-text/);
    });
  });

  it('keeps hidden filter context at least as faded as other context nodes', async () => {
    const value = await setup(undefined, preferences({ hidden_item_ids: ['1'], filters: { ...preferences().filters, statuses: ['waiting_on_me'] } }));
    const reveal = await value.routes.revealItem({ ...value.route, item_id: '1.1.1' });
    render(<value.Composition reveal={reveal} />);
    const style = document.createElement('style');
    style.textContent = readFileSync(resolve(__dirname, '../../../src/ui/graph/graph.css'), 'utf8');
    document.head.append(style);
    try {
      expect(node('1').classList.contains('is-dimmed')).toBe(true);
      expect(node('1').classList.contains('is-hidden')).toBe(true);
      expect(getComputedStyle(node('1')).opacity).toBe('0.4');
      expect(getComputedStyle(node('1.1.1')).opacity).toBe('0.45');
    } finally { style.remove(); }
  });

  it('renders each topic’s title, trunk, nodes and edges, with the legend card', async () => {
    const value = await setup(); render(<value.Composition />);
    const legend = within(screen.getByRole('group', { name: 'Graph legend' }));
    expect(legend.getByText('Branch').querySelector('.graph-legend-branch')).toBeTruthy();
    expect(legend.getByText('Path to the selected item').querySelector('.graph-legend-path')).toBeTruthy();
    expect(legend.getByText('Related').querySelector('svg path.graph-related')).toBeTruthy();
    expect(legend.getByText('Lines show for the selected item and the one under the pointer.')).toBeTruthy();
    const tree = screen.getByRole('tree', { name: 'Delivery decisions graph' });
    expect(within(tree).getByRole('heading', { name: 'Delivery decisions' })).toBeTruthy();
    expect(screen.getByRole('tree', { name: 'Continued context graph' })).toBeTruthy();
    expect(ids()).toEqual(['1', '1.1', '1.1.1', '1.2', '2', '3', '8']);
    const waiting = node('1.1.1');
    expect(waiting.getAttribute('aria-label')).toBe('Which delivery window…: Which delivery window: morning or evening?');
    expect(waiting.title).toBe('Which delivery window: morning or evening?');
    expect(within(waiting).getByRole('img', { name: 'Waiting on me' })).toBeTruthy();
    expect(node('1').className).toContain('is-closed');
    // Two trunks, four branches into top items, three elbows; no replacement arcs, no counts, no session chip.
    expect(document.querySelectorAll('path.graph-edge')).toHaveLength(9);
    expect(document.querySelector(`[data-edge="trunk:${topicA}"]`)!.getAttribute('d')).toBe('M16 36 V220');
    expect(document.querySelector('[data-edge^="replacement:"], .graph-card-counts, .graph-card-session')).toBeNull();
    expect([node('1').style.left, node('1').style.top, node('1.1').style.left, node('1.1').style.width]).toEqual(['36px', '50px', '186px', '124px']);
    // The branch hue rides along for the Map's shared look; nothing draws it.
    expect([node('1').dataset.branch, node('2').dataset.branch, node('1.1.1').dataset.branch, node('8').dataset.branch]).toEqual(['0', '1', '0', '2']);
    expect(document.querySelector('[data-edge="path"]')).toBeNull();
  });

  it('draws the New and Changed markers as diamonds alone (SPEC 9.9)', async () => {
    const value = await setup();
    render(<value.Composition markers={new Map([['1.1', 'new'], ['2', 'changed']])} />);
    expect(within(node('1.1')).getByRole('img', { name: 'New' }).className).toBe('graph-node-marker is-new');
    expect(within(node('2')).getByRole('img', { name: 'Changed' }).className).toBe('graph-node-marker is-changed');
    expect(node('1.1').dataset.marker).toBe('new');
    expect(node('3').querySelector('.graph-node-marker')).toBeNull();
  });

  it('moves with ↑/↓, Home and End, folds and unfolds with ←/→ and opens detail with Enter', async () => {
    const value = await setup(undefined, preferences({ selected_item_id: '1', expanded_item_ids: ['1'] })); render(<value.Composition />);
    const key = (name: string) => fireEvent.keyDown(document.activeElement!, { key: name });
    await waitFor(() => expect(document.activeElement).toBe(node('1')));
    key('ArrowDown'); expect(selected()).toBe('1.1'); await waitFor(() => expect(document.activeElement).toBe(node('1.1')));
    key('ArrowRight'); expect(ids()).toContain('1.1.1'); expect(selected()).toBe('1.1');
    key('ArrowRight'); expect(selected()).toBe('1.1.1');
    key('ArrowRight'); expect(selected()).toBe('1.1.1');
    key('ArrowLeft'); expect(selected()).toBe('1.1');
    key('ArrowLeft'); expect(ids()).not.toContain('1.1.1'); expect(selected()).toBe('1.1');
    key('End'); expect(selected()).toBe('8');
    key('ArrowDown'); expect(selected()).toBe('8');
    key('Home'); expect(selected()).toBe('1');
    key('ArrowUp'); expect(selected()).toBe('1');
    key('ArrowLeft'); expect(ids()).toEqual(['1', '2', '3', '8']);
    key('ArrowLeft'); expect(selected()).toBe('1');
    key('Enter');
    await waitFor(() => expect(value.reveals.at(-1)).toEqual(['1', true]));
    await waitFor(() => expect(value.saved.at(-1)).toMatchObject({ selected_item_id: '1', expanded_item_ids: [] }));
  });

  it('ignores fold, unfold and Enter without a selection; ↓ starts at the first node', async () => {
    const value = await setup(undefined, preferences({ expanded_item_ids: ['1'] })); render(<value.Composition />);
    fireEvent.keyDown(node('1'), { key: 'Enter' }); fireEvent.keyDown(node('1'), { key: 'ArrowLeft' }); fireEvent.keyDown(node('1'), { key: 'ArrowRight' });
    expect(selected()).toBeUndefined();
    expect(value.saved).toHaveLength(0);
    fireEvent.keyDown(node('1'), { key: 'ArrowDown' }); expect(selected()).toBe('1');
    await waitFor(() => expect(value.saved).toHaveLength(1));
  });

  it('shows an outside reveal with its temporary ancestors and the selected path, without saving them', async () => {
    const value = await setup(undefined, preferences({ expanded_item_ids: [] })), { rerender } = render(<value.Composition />);
    const reveal = await value.routes.revealItem({ ...value.route, item_id: '1.1.1' });
    rerender(<value.Composition reveal={reveal} />);
    expect(selected()).toBe('1.1.1');
    expect(['1', '1.1'].map(id => node(id).className.includes('is-path'))).toEqual([true, true]);
    expect(document.querySelector('[data-edge="path"]')!.getAttribute('d')).toBe('M16 36 V70 H36 M160 70 H173 V70 H186 M310 70 H323 V70 H336');
    expect(value.saved).toEqual([]);
  });

  it('reports a view write that is not confirmed or fails, and a reveal that fails', async () => {
    const value = await setup(); render(<value.Composition />);
    value.writeWith(async () => false);
    fireEvent.click(node('2'));
    await waitFor(() => expect(notices.getSnapshot().map(notice => notice.text)).toEqual(['Ariadne isn’t sure that view change was saved. Try it again.']));
    expect(screen.queryByRole('alert')).toBeNull();
    const notice = notices.getSnapshot()[0]!;
    act(() => notices.dismiss(notice.id));
    fireEvent.mouseOver(node('2'));
    expect(notices.getSnapshot()).toEqual([]);
    value.writeWith(async () => { throw new Error('Preferences are read-only.'); });
    fireEvent.click(node('8'));
    await waitFor(() => expect(notices.getSnapshot().map(notice => notice.text)).toEqual(['The view change could not be saved. Try again.']));
    value.writeWith(async () => true); value.failReveal();
    fireEvent.click(node('3'));
    await waitFor(() => expect(notices.getSnapshot().map(notice => notice.text)).toEqual(['This item could not be opened.']));
  });

  it('updates a visible failure in place, then clears it on success or unmount', async () => {
    const value = await setup();
    let refuseReveal!: (reason: Error) => void;
    const reveal = new Promise<never>((_resolve, reject) => { refuseReveal = reject; });
    vi.spyOn(value.routes, 'revealItem').mockReturnValueOnce(reveal);
    value.writeWith(async () => false);
    vi.useFakeTimers();
    const view = render(<><value.Composition /><Notices /></>);
    await act(async () => { fireEvent.click(node('2')); });
    const initial = 'Ariadne isn’t sure that view change was saved. Try it again.';
    expect(notices.getSnapshot()[0]?.text).toBe(initial);
    expect(screen.queryByText(initial)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    const card = screen.getByText(initial).closest('.pw-note');
    const visibleStates: string[][] = [];
    const unsubscribe = notices.subscribe(() => { visibleStates.push(notices.getVisibleSnapshot().map(notice => notice.text)); });
    await act(async () => { refuseReveal(new Error('Reveal failed.')); });
    const changed = 'This item could not be opened.';
    expect(screen.getByText(changed).closest('.pw-note')).toBe(card);
    expect(visibleStates).toEqual([[changed]]);
    unsubscribe();
    value.writeWith(async () => true);
    await act(async () => { fireEvent.click(node('3')); });
    expect(notices.getSnapshot()).toEqual([]);
    expect(screen.queryByText(changed)).toBeNull();
    value.writeWith(async () => false);
    await act(async () => { fireEvent.click(node('8')); await vi.advanceTimersByTimeAsync(300); });
    expect(screen.getByText(initial)).toBeTruthy();
    view.unmount();
    expect(notices.getSnapshot()).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(notices.getVisibleSnapshot()).toEqual([]);
  });

  it('shows nothing for an empty session', async () => {
    const session = graphSession(); session.items = {};
    const empty = await setup(session); render(<empty.Composition />);
    expect(document.querySelector('.graph-canvas, .graph-legend')).toBeNull();
    await act(async () => {});
  });

  it('seats the Tree column’s filter control at the end of the legend card, and keeps it reachable when no topic is drawn', async () => {
    const slot = <button type="button">Filter</button>;
    const value = await setup(), view = render(<GraphFilterSlot.Provider value={slot}><value.Composition /></GraphFilterSlot.Provider>);
    const legend = screen.getByRole('group', { name: 'Graph legend' });
    expect(legend.lastElementChild!.textContent).toBe('Filter');
    expect(document.querySelectorAll('.graph-legend')).toHaveLength(1);
    view.unmount();
    const session = graphSession(); session.items = {};
    const empty = await setup(session); render(<GraphFilterSlot.Provider value={slot}><empty.Composition /></GraphFilterSlot.Provider>);
    expect(screen.getByRole('group', { name: 'Graph legend' }).textContent).toBe('Filter');
    await act(async () => {});
    cleanup();
    // Nothing provided (archived sessions): no stray card.
    render(<empty.Composition />);
    expect(document.querySelector('.graph-legend')).toBeNull();
  });
});

function peekStub() {
  const peek = {
    open: vi.fn(), close: vi.fn(), reference: () => null,
    chipProps: () => ({ onClick() {}, onKeyDown() {}, onMouseEnter() {}, onMouseMove() {}, onMouseLeave() {} }),
    hoverStart: vi.fn(), hoverEnd: vi.fn(), toggle: vi.fn(), closeAll: vi.fn(),
  };
  return peek as typeof peek & PeekNavigation;
}
