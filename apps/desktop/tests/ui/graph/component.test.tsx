import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Session } from '../../../src/generated/domain/models';
import type { QueryEnvelope, SessionPreferences } from '../../../src/generated/core';
import { OpenSessions, immutable } from '../../../src/data/session-store';
import { RegisteredRoutes, type RevealedItem } from '../../../src/data/routes';
import { createDesktopService, type DesktopTransport } from '../../../src/data/service';
import { GraphView } from '../../../src/ui/graph/GraphView';
import { graphSession, preferences } from './fixture';
import { Notices, notices } from '../../../src/ui/pages/notices';

const opened: OpenSessions[] = [];
afterEach(() => { cleanup(); opened.splice(0).forEach(sessions => sessions.closeAll()); notices.clear(); vi.restoreAllMocks(); vi.useRealTimers(); });

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
  const hovered: (string | null)[] = [];
  let write: (next: SessionPreferences) => Promise<boolean> = async () => true;
  function Composition({ reveal = null, tight = false, search }: { reveal?: RevealedItem | null; tight?: boolean; search?: string }) {
    const [current, setCurrent] = useState(view);
    return <GraphView store={store} routes={routes} view={immutable(current)} later={new Set()} search={search} reveal={reveal} tight={tight} sessionLabel="codex · yesterday"
      continuedFrom={topic => topic.name === 'Continued context' ? 'Continued from claude-code · yesterday' : null}
      saveView={async next => { saved.push(structuredClone(next)); const ok = await write(next); if (ok) setCurrent(next); return ok; }}
      onReveal={(result, openDetail) => { if (result.kind === 'item') reveals.push([result.route.item_id, openDetail]); }}
      onHoverItem={id => hovered.push(id)} />;
  }
  return { Composition, store, routes, saved, reveals, hovered, route,
    failReveal: () => { failReveal = true; }, writeWith: (next: typeof write) => { write = next; } };
}
const node = (id: string) => document.querySelector<HTMLElement>(`.graph-node[data-item-id="${id}"]`)!;
const ids = () => [...document.querySelectorAll<HTMLElement>('.graph-node')].map(element => element.dataset.itemId);
const selected = () => document.querySelector<HTMLElement>('.graph-node[aria-selected="true"]')?.dataset.itemId;

describe('session graph view', () => {
  it('filters with the live header search and clears scoped folds when that search changes', async () => {
    const value = await setup(undefined, preferences({ expanded_item_ids: [], selected_item_id: '1' }));
    const { rerender } = render(<value.Composition search="morning or evening" />);
    expect(ids()).toEqual(['1', '1.1', '1.1.1']);
    fireEvent.click(within(node('1')).getByRole('button', { name: 'Collapse branches' }));
    expect(ids()).toEqual(['1']);
    rerender(<value.Composition search="delivery window" />);
    expect(ids()).toEqual(['1', '1.1', '1.1.1', '2']);
  });
  it('folds and unfolds search ancestors with the existing mouse and keyboard controls', async () => {
    const value = await setup(undefined, preferences({ expanded_item_ids: [], selected_item_id: '1',
      filters: { ...preferences().filters, search: 'morning or evening' } }));
    render(<value.Composition />);
    expect(ids()).toEqual(['1', '1.1', '1.1.1']);
    fireEvent.click(within(node('1')).getByRole('button', { name: 'Collapse branches' }));
    expect(ids()).toEqual(['1']);
    // The saved branch was already folded; only the scoped override needs to change.
    await act(async () => {});
    expect(value.saved).toEqual([]);
    fireEvent.keyDown(node('1'), { key: 'ArrowRight' });
    expect(ids()).toEqual(['1', '1.1', '1.1.1']);
    await waitFor(() => expect(value.saved.at(-1)?.expanded_item_ids).toEqual(['1']));
    fireEvent.keyDown(node('1'), { key: 'ArrowLeft' });
    expect(ids()).toEqual(['1']);
    fireEvent.click(node('1'));
    expect(ids()).toEqual(['1', '1.1', '1.1.1']);
  });
  it('draws same-topic connections beneath hierarchy paths and measured cross-topic connections for either selection', async () => {
    const session = graphSession(); session.items['1']!.related = ['2', '8'];
    let measurable = true;
    let horizontalOffset = 0;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const top = this.dataset.itemId === '8' ? 500 : 60;
      const left = (this.dataset.itemId === '8' ? 1000 : 46) - horizontalOffset;
      const width = this.classList.contains('graph-node') && measurable ? 190 : this.classList.contains('graph-cards') ? 200 : 0;
      return { left, top, right: left + width, bottom: top + 66, width, height: 66, x: left, y: top, toJSON() {} };
    });
    const value = await setup(session, preferences({ selected_item_id: '1' }));
    render(<value.Composition />);
    const same = document.querySelector('[data-edge="related:1:2"]')!;
    const parent = document.querySelector('[data-edge="parent:1:1.1"]')!;
    expect(same.compareDocumentPosition(parent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const cross = document.querySelector('.graph-cross-related [data-edge="related:1:8"]')!;
    // A deep target can lie beyond the cards container's initial 200px viewport.
    expect(cross.getAttribute('d')).toBe('M95 66 L1049 440');
    const css = readFileSync(resolve(__dirname, '../../../src/ui/graph/graph.css'), 'utf8');
    const overlayRule = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(([, rule]) => rule!.trim() === '.graph-cross-related')![2];
    expect(overlayRule).toMatch(/overflow:\s*visible;/);
    expect(cross.hasAttribute('marker-end')).toBe(false);
    horizontalOffset = 600;
    fireEvent.scroll(document.querySelector('.graph-scroll')!, { target: { scrollLeft: 600 } });
    fireEvent(window, new Event('resize'));
    expect(document.querySelector('[data-edge="related:1:8"]')!.getAttribute('d')).toBe('M95 66 L1049 440');
    fireEvent.click(node('8'));
    await waitFor(() => expect(value.reveals).toEqual([['8', true]]));
    expect(document.querySelector('[data-edge="related:1:2"]')).toBeNull();
    expect(document.querySelector('[data-edge="related:8:1"]')).toBeTruthy();
    measurable = false; fireEvent(window, new Event('resize'));
    expect(document.querySelector('[data-edge="related:8:1"]')).toBeNull();
  });

  it('does not draw related connections without a selection', async () => {
    const session = graphSession(); session.items['1']!.related = ['2', '8'];
    const value = await setup(session); render(<value.Composition />);
    expect(document.querySelector('.graph-edges .graph-related, .graph-cross-related .graph-related')).toBeNull();
  });

  it('explains related connections with a matching undirected dashed key distinct from replacement arcs', async () => {
    const session = graphSession(); session.items['1']!.related = ['2'];
    const value = await setup(session, preferences({ selected_item_id: '1' })); render(<value.Composition />);
    const key = screen.getByTitle('Related to the selected item');
    expect(key.textContent).toBe('Related');
    const sample = key.querySelector('svg path')!;
    expect(sample.classList.contains('graph-related')).toBe(true);
    expect(document.querySelector('[data-edge="related:1:2"]')!.classList.contains('graph-related')).toBe(true);
    expect(sample.hasAttribute('marker-end')).toBe(false);
    const css = readFileSync(resolve(__dirname, '../../../src/ui/graph/graph.css'), 'utf8');
    const rule = (selector: string) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(([, value]) => value!.trim() === selector)![2]!;
    expect(rule('.graph-related')).toMatch(/stroke:\s*color-mix\(in srgb, var\(--color-text\)/);
    expect(rule('.graph-replaced')).toMatch(/stroke:\s*var\(--st-replaced\);/);
    expect(rule('.graph-related')).toMatch(/stroke-dasharray:\s*6 5;/);
    expect(rule('.graph-replaced')).toMatch(/stroke-dasharray:\s*4 4;/);
    expect(screen.getByTitle('Replaced by').querySelector('.graph-legend-replaced')).toBeTruthy();
  });

  it('finds and observes only cross-topic endpoints and their cards, updating paths after their layout changes', async () => {
    const session = graphSession(); session.items['1']!.related = ['8'];
    const unrelatedTopic = '00000000-0000-4000-8000-000000000099';
    const template = Object.values(session.topics)[0]!;
    session.topics[unrelatedTopic] = { ...template, id: unrelatedTopic, name: 'Separate notes', order: 3 };
    session.items['9'] = { ...session.items['8']!, id: '9', topic_id: unrelatedTopic, ordinal: 9 };
    let targetTop = 500;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const top = this.dataset.itemId === '8' ? targetTop : 60;
      const left = this.dataset.itemId === '8' ? 1000 : 46;
      return new DOMRect(left, top, this.classList.contains('graph-node') ? 190 : 200, 66);
    });
    const observers: { measure: () => void; observed: Element[]; disconnect: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal('ResizeObserver', class {
      readonly state;
      constructor(measure: () => void) {
        this.state = { measure, observed: [] as Element[], disconnect: vi.fn() }; observers.push(this.state);
      }
      observe(element: Element) { this.state.observed.push(element); }
      disconnect() { this.state.disconnect(); }
    });
    try {
      const scans = vi.spyOn(Element.prototype, 'querySelectorAll');
      const value = await setup(session, preferences({ selected_item_id: '1' })); render(<value.Composition />);
      const observer = observers.at(-1)!;
      const endpoints = [node('1'), node('8')];
      expect(new Set(observer.observed)).toEqual(new Set([...endpoints, ...endpoints.map(endpoint => endpoint.closest('.graph-card')!)]));
      expect(observer.observed).not.toContain(node('2'));
      expect(observer.observed).not.toContain(node('9').closest('.graph-card'));
      expect(scans.mock.calls.some(([selector]) => selector === '.graph-node' || selector === '.graph-card')).toBe(false);
      const path = () => document.querySelector('[data-edge="related:1:8"]')!;
      expect(path().getAttribute('d')).toBe('M95 66 L1049 440');
      targetTop = 700; act(() => observer.measure());
      expect(path().getAttribute('d')).toBe('M95 66 L1049 640');
      fireEvent.click(node('2'));
      await waitFor(() => expect(value.reveals).toEqual([['2', true]]));
      expect(observer.disconnect).toHaveBeenCalled();
      expect(document.querySelector('.graph-cross-related')).toBeNull();
    } finally { vi.unstubAllGlobals(); }
  });

  it('fades hidden branches while keeping click and outside selection paths into detail', async () => {
    const value = await setup(undefined, preferences({ hidden_item_ids: ['1'] }));
    const { rerender } = render(<value.Composition />);
    for (const id of ['1', '1.1', '1.1.1', '1.2']) expect(node(id).className).toContain('is-hidden');
    expect(node('2').className).not.toContain('is-hidden');
    expect(node('1.1.1').getAttribute('aria-label')).toContain('(hidden)');
    fireEvent.click(node('1.1.1'));
    await waitFor(() => expect(value.reveals).toEqual([['1.1.1', true]]));
    expect(value.saved.at(-1)?.hidden_item_ids).toEqual(['1']);
    const reveal = await value.routes.revealItem({ ...value.route, item_id: '1.2' });
    rerender(<value.Composition reveal={reveal} />);
    expect(selected()).toBe('1.2');
    expect(node('1.2').className).toContain('is-hidden');
  });

  it('highlights collapsed children consistently in graph badges and tree notes', () => {
    for (const [file, selector] of [['graph/graph.css', '.graph-node-below'], ['tree/tree.css', '.tree-collapsed']]) {
      const css = readFileSync(resolve(__dirname, '../../../src/ui', file!), 'utf8');
      const declarations = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
        .find(([, rule]) => rule!.trim() === selector)?.[2];
      expect(declarations).toMatch(/color:\s*var\(--a-acc-text\);/);
      expect(declarations).toMatch(/background:\s*color-mix\(in srgb, var\(--color-accent\) 15%, var\(--a-card\)\);/);
    }
  });

  it('mutes collapsed badges on hidden graph nodes and tree rows, including hover', () => {
    for (const [file, selector] of [['graph/graph.css', '.graph-node.is-hidden .graph-node-below'],
      ['tree/tree.css', '.tree-item-hidden .tree-collapsed'], ['tree/tree.css', '.tree-item-hidden .tree-collapsed:hover']]) {
      const css = readFileSync(resolve(__dirname, '../../../src/ui', file!), 'utf8');
      const declarations = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
        .find(([, rule]) => rule!.trim() === selector)?.[2];
      expect(declarations).toMatch(/color:\s*color-mix\(in srgb, var\(--color-text\) 62%, transparent\);/);
      expect(declarations).toMatch(/background:\s*color-mix\(in srgb, var\(--color-text\) \d+%, transparent\);/);
      expect(declarations).not.toMatch(/var\(--(?:color-accent|a-acc-text)\)/);
    }
  });

  it('opens hidden collapsed branches without clearing their hidden preference', async () => {
    const value = await setup(undefined, preferences({ hidden_item_ids: ['1'], expanded_item_ids: [] }));
    render(<value.Composition />);
    expect(node('1').classList.contains('is-hidden')).toBe(true);
    fireEvent.click(within(node('1')).getByText('+3'));
    await waitFor(() => expect(value.reveals).toEqual([['1', true]]));
    expect(node('1.1').classList.contains('is-hidden')).toBe(true);
    expect(value.saved.at(-1)).toMatchObject({ hidden_item_ids: ['1'], expanded_item_ids: ['1'], selected_item_id: '1' });
  });

  it('keeps hidden filter context at least as faded as other context nodes', async () => {
    const value = await setup(undefined, preferences({ hidden_item_ids: ['1'],
      filters: { ...preferences().filters, search: 'morning or evening' } }));
    render(<value.Composition />);
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

  it('renders the legend and one card per topic with its nodes and edges', async () => {
    const value = await setup(); render(<value.Composition />);
    const legend = within(document.querySelector('.graph-legend')! as HTMLElement);
    for (const [text, title] of [['Thread', 'Thread to the selected item'], ['Related', 'Related to the selected item'], ['Replaced by', 'Replaced by'], ['Waiting on me', 'Waiting on me'], ['Closed', 'Closed']]) {
      expect(legend.getByText(text!).closest('.graph-legend-key')?.getAttribute('title')).toBe(title);
      expect(legend.getByLabelText(title!)).toBe(legend.getByText(text!).closest('.graph-legend-key'));
    }
    expect(legend.getByText('One graph per topic').getAttribute('title')).toBe('One graph per topic');
    const card = screen.getByRole('region', { name: 'Delivery decisions' });
    expect(within(card).getByText('1 waiting on you · 2 open · 1 in progress · 2 closed')).toBeTruthy();
    expect(within(card).getByText('codex · yesterday')).toBeTruthy();
    expect(screen.getByRole('tree', { name: 'Continued context graph' })).toBeTruthy();
    // A continued topic names its origin session instead of this one.
    const continued = screen.getByRole('region', { name: 'Continued context' });
    expect(continued.querySelector('.graph-card-session')?.textContent).toBe('Continued from claude-code · yesterday');
    expect(ids()).toEqual(['1', '1.1', '1.1.1', '1.2', '2', '3', '8']);
    const waiting = node('1.1.1');
    expect(waiting.getAttribute('aria-label')).toBe('Which delivery window…: Which delivery window: morning or evening?');
    expect(waiting.className).toContain('is-waiting');
    expect(node('1').className).toContain('is-closed');
    expect(within(waiting).getByRole('img', { name: 'Waiting on me' })).toBeTruthy();
    expect(document.querySelector('[data-edge="replacement:3:2"]')?.textContent).toBe('replaced by');
    expect(document.querySelectorAll('path.graph-edge')).toHaveLength(7);
    expect(screen.getByRole('button', { name: 'Reveal selected' })).toHaveProperty('disabled', true);
    expect(node('1').style.left).toBe('46px');
  });

  it('opens a collapsed node: selects it, expands it, opens detail and saves the view', async () => {
    const value = await setup(undefined, preferences({ expanded_item_ids: [] })); render(<value.Composition />);
    const badge = within(node('1')).getByText('+3');
    expect(badge.classList.contains('graph-node-below')).toBe(true);
    expect(badge.title).toBe('3 items below, collapsed · click to open the next tier');
    expect(node('1').getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(node('1'));
    expect(selected()).toBe('1'); expect(ids()).toContain('1.1');
    await waitFor(() => expect(value.reveals).toEqual([['1', true]]));
    expect(value.saved.at(-1)).toMatchObject({ selected_item_id: '1', expanded_item_ids: ['1'] });
    expect(node('1').getAttribute('aria-expanded')).toBe('true');
  });

  it('collapses with "−" and moves a selection inside the branch to the node', async () => {
    const value = await setup(undefined, preferences({ selected_item_id: '1.1.1' })); render(<value.Composition />);
    fireEvent.click(within(node('1')).getByRole('button', { name: 'Collapse branches' }));
    expect(ids()).toEqual(['1', '2', '3', '8']); expect(selected()).toBe('1');
    await waitFor(() => expect(value.saved.at(-1)).toMatchObject({ selected_item_id: '1', expanded_item_ids: ['1.1'] }));
    await waitFor(() => expect(value.reveals).toEqual([['1', false]]));
    fireEvent.click(node('2'));
    await waitFor(() => expect(value.reveals.at(-1)).toEqual(['2', true]));
  });

  it('collapses an unrelated branch without moving the selection', async () => {
    const value = await setup(undefined, preferences({ selected_item_id: '2' })); render(<value.Composition />);
    fireEvent.click(within(node('1.1')).getByRole('button', { name: 'Collapse branches' }));
    expect(selected()).toBe('2'); expect(ids()).not.toContain('1.1.1');
    await waitFor(() => expect(value.saved.at(-1)).toMatchObject({ selected_item_id: '2', expanded_item_ids: ['1'] }));
    expect(value.reveals).toEqual([]);
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

  it('ignores keys on its buttons and without a selection', async () => {
    const value = await setup(undefined, preferences({ expanded_item_ids: ['1'] })); render(<value.Composition />);
    fireEvent.keyDown(within(node('1')).getByRole('button', { name: 'Collapse branches' }), { key: 'ArrowDown' });
    expect(selected()).toBeUndefined();
    fireEvent.keyDown(node('1'), { key: 'Enter' }); fireEvent.keyDown(node('1'), { key: 'ArrowLeft' }); fireEvent.keyDown(node('1'), { key: 'ArrowRight' });
    expect(selected()).toBeUndefined();
    expect(value.saved).toHaveLength(0);
    fireEvent.keyDown(node('1'), { key: 'ArrowDown' }); expect(selected()).toBe('1');
    await waitFor(() => expect(value.saved).toHaveLength(1));
  });

  it('shows an outside reveal and its temporary ancestors, and reveals the selection on request', async () => {
    const value = await setup(undefined, preferences({ expanded_item_ids: [] })), { rerender } = render(<value.Composition />);
    const reveal = await value.routes.revealItem({ ...value.route, item_id: '1.1.1' });
    rerender(<value.Composition reveal={reveal} />);
    expect(selected()).toBe('1.1.1'); expect(node('1.1').className).toContain('is-thread');
    const button = screen.getByRole('button', { name: 'Reveal selected' });
    expect(button).toHaveProperty('disabled', false);
    fireEvent.click(button);
    fireEvent.click(within(node('1')).getByRole('button', { name: 'Collapse branches' }));
    expect(ids()).toEqual(['1', '2', '3', '8']);
  });

  it('reports a view write that is not confirmed or fails, and a reveal that fails', async () => {
    const value = await setup(); render(<value.Composition />);
    value.writeWith(async () => false);
    fireEvent.click(node('2'));
    await waitFor(() => expect(notices.getSnapshot().map(notice => notice.text)).toEqual(['Ariadne isn’t sure that view change was saved. Try it again.']));
    expect(screen.queryByRole('alert')).toBeNull();
    const notice = notices.getSnapshot()[0]!;
    act(() => notices.dismiss(notice.id));
    fireEvent.mouseEnter(node('2'));
    expect(notices.getSnapshot()).toEqual([]);
    value.writeWith(async () => { throw new Error('Preferences are read-only.'); });
    fireEvent.click(node('8'));
    await waitFor(() => expect(notices.getSnapshot().map(notice => notice.text)).toEqual(['The view change could not be saved. Try again.']));
    value.writeWith(async () => true); value.failReveal();
    fireEvent.click(node('3'));
    await waitFor(() => expect(notices.getSnapshot().map(notice => notice.text)).toEqual(['This item could not be opened.']));
    expect(document.querySelector('.graph-error')).toBeNull();
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

  it('reports hover and clears it on unmount; shows nothing for an empty session', async () => {
    const value = await setup(), view = render(<value.Composition tight />);
    expect(node('1').style.left).toBe('32px');
    fireEvent.mouseEnter(node('2')); fireEvent.mouseLeave(node('2'));
    view.unmount();
    expect(value.hovered).toEqual(['2', null, null]);
    const session = graphSession(); session.items = {};
    const empty = await setup(session); render(<empty.Composition />);
    expect(screen.queryByText('One graph per topic')).toBeNull();
    await act(async () => {});
  });
});
