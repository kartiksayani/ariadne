import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useLayoutEffect, useState } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Session } from '../../../src/generated/domain/models';
import type { QueryEnvelope, SessionPreferences } from '../../../src/generated/core';
import { OpenSessions, immutable } from '../../../src/data/session-store';
import { RegisteredRoutes, type RevealedItem } from '../../../src/data/routes';
import { createDesktopService, type DesktopTransport } from '../../../src/data/service';
import { GraphView } from '../../../src/ui/graph/GraphView';
import { GraphFilterSlot } from '../../../src/ui/tree/FilterBar';
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
  let write: (next: SessionPreferences) => Promise<boolean> = async () => true;
  function Composition({ reveal = null, tight = false, search, hidden, selection, onCommit }: { reveal?: RevealedItem | null; tight?: boolean; search?: string; hidden?: string[]; selection?: string; onCommit?: () => void }) {
    const [current, setCurrent] = useState(view);
    useLayoutEffect(() => { onCommit?.(); });
    return <GraphView store={store} routes={routes} view={immutable({ ...current, ...(hidden ? { hidden_item_ids: hidden } : {}), ...(selection ? { selected_item_id: selection } : {}) })} later={new Set()} search={search} reveal={reveal} tight={tight} sessionLabel="codex · yesterday"
      continuedFrom={topic => topic.name === 'Continued context' ? 'Continued from claude-code · yesterday' : null}
      saveView={async next => { saved.push(structuredClone(next)); const ok = await write(next); if (ok) setCurrent(next); return ok; }}
      onReveal={(result, openDetail) => { if (result.kind === 'item') reveals.push([result.route.item_id, openDetail]); }} />;
  }
  return { Composition, store, routes, saved, reveals, route, session,
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

  const stub = (name: RegExp = /^\d+ items? hidden/) => screen.queryByRole('treeitem', { name });

  it('does not draw hidden items; one small stub stands for them and opens and folds them locally', async () => {
    const value = await setup(undefined, preferences({ hidden_item_ids: ['1'] }));
    render(<value.Composition />);
    expect(ids()).toEqual(['2', '3', '8']);
    expect(node('1')).toBeNull();
    const small = stub(/^1 item hidden, waiting on you$/)!;
    expect(small.textContent).toContain('1 hidden');
    expect(small.getAttribute('aria-expanded')).toBe('false');
    // Far smaller than a card.
    expect(parseInt(small.style.height)).toBeLessThan(parseInt(node('2').style.height || '66') / 2);
    fireEvent.click(small);
    expect(ids()).toEqual(['1', '1.1', '1.1.1', '1.2', '2', '3', '8']);
    for (const id of ['1', '1.1', '1.1.1', '1.2']) expect(node(id).className).toContain('is-hidden');
    expect(node('2').className).not.toContain('is-hidden');
    expect(node('1.1.1').getAttribute('aria-label')).toContain('(hidden)');
    expect(stub()!.getAttribute('aria-expanded')).toBe('true');
    // Choosing a hidden item selects it and opens detail without un-hiding it.
    fireEvent.click(node('1.1.1'));
    await waitFor(() => expect(value.reveals).toEqual([['1.1.1', true]]));
    expect(value.saved.at(-1)?.hidden_item_ids).toEqual(['1']);
    fireEvent.click(stub()!);
    expect(node('1.1.1')).toBeNull();
    expect(stub()!.getAttribute('aria-expanded')).toBe('false');
    // Opening and folding is local: nothing was saved for it.
    expect(value.saved.every(view => view.hidden_item_ids?.length === 1 && view.hidden_item_ids[0] === '1')).toBe(true);
  });

  it('opens a revealed hidden route once and lets the owner fold it', async () => {
    const value = await setup(undefined, preferences({ hidden_item_ids: ['1'] }));
    const { rerender } = render(<value.Composition />);
    expect(ids()).toEqual(['2', '3', '8']);
    const reveal = await value.routes.revealItem({ ...value.route, item_id: '1.2' });
    rerender(<value.Composition reveal={reveal} />);
    expect(selected()).toBe('1.2');
    expect(node('1.2').className).toContain('is-hidden');
    expect(stub()!.getAttribute('aria-expanded')).toBe('true');
    // "Reveal selected" finds it.
    expect((screen.getByRole('button', { name: /Reveal selected/ }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(stub()!);
    expect(node('1.2')).toBeNull();
    expect(stub()!.getAttribute('aria-expanded')).toBe('false');
  });

  it('can fold a revealed hidden route after selection has moved elsewhere', async () => {
    const value = await setup(undefined, preferences({ hidden_item_ids: ['1'], selected_item_id: '2' }));
    const reveal = await value.routes.revealItem({ ...value.route, item_id: '1.1.1' });
    render(<value.Composition reveal={reveal} />);
    vi.spyOn(value.routes, 'revealItem').mockResolvedValueOnce(null);
    let confirmWrite = () => {};
    value.writeWith(() => new Promise(resolve => { confirmWrite = () => resolve(true); }));
    fireEvent.keyDown(node('1.1.1'), { key: 'End' });
    await waitFor(() => expect(value.saved.at(-1)?.selected_item_id).toBe('8'));
    expect(node('1.1.1')).toBeTruthy();
    fireEvent.click(stub()!);
    expect(node('1.1.1')).toBeNull();
    expect(selected()).toBe('8');
    await act(async () => { confirmWrite(); });
    expect(selected()).toBe('8');
  });

  it('draws and centers a saved hidden selection on startup and on a session-keyed remount', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('graph-scroll') ? new DOMRect(0, 0, 400, 300) : new DOMRect(600, 500, 190, 66);
    });
    const value = await setup(undefined, preferences({ hidden_item_ids: ['1', '1.1'], selected_item_id: '1.1.1', expanded_item_ids: [] }));
    const commits: { selected: string | undefined; focused: Element | null; scroll: number }[] = [];
    const observe = () => commits.push({ selected: selected(), focused: document.activeElement, scroll: document.querySelector('.graph-scroll')!.scrollTop });
    const { rerender } = render(<value.Composition key="session-one" onCommit={observe} />);
    const check = () => {
      expect(selected()).toBe('1.1.1');
      expect(document.activeElement).toBe(node('1.1.1'));
      expect(document.querySelector('.graph-scroll')!.scrollTop).toBe(383);
      expect(node('1.1.1').className).toContain('is-hidden');
    };
    check();
    expect(commits[0]).toEqual({ selected: '1.1.1', focused: node('1.1.1'), scroll: 383 });
    commits.length = 0;
    rerender(<value.Composition key="session-two" onCommit={observe} />);
    check();
    expect(commits[0]).toEqual({ selected: '1.1.1', focused: node('1.1.1'), scroll: 383 });
    expect(value.saved).toEqual([]);
  });

  it('opens and centers a hidden Tree selection on the first Graph commit after the reveal is dismissed', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('graph-scroll') ? new DOMRect(0, 0, 400, 300) : new DOMRect(600, 500, 190, 66);
    });
    const value = await setup(undefined, preferences({ hidden_item_ids: ['1'], expanded_item_ids: [] }));
    const reveal = await value.routes.revealItem({ ...value.route, item_id: '1.1.1' });
    expect(reveal?.kind).toBe('item');
    const commits: (string | undefined)[] = [];
    render(<value.Composition reveal={null} selection="1.1.1" onCommit={() => { commits.push(selected()); }} />);
    expect(commits[0]).toBe('1.1.1');
    expect(document.querySelector('.graph-scroll')!.scrollTop).toBe(383);
    expect(selected()).toBe('1.1.1');
    expect(document.activeElement).toBe(node('1.1.1'));
    expect(node('1.1.1').className).toContain('is-hidden');
  });

  it('opens a truly newly selected hidden route without a reveal or a local stub expansion', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('graph-scroll') ? new DOMRect(0, 0, 400, 300) : new DOMRect(600, 500, 190, 66);
    });
    const value = await setup(undefined, preferences({ selected_item_id: '2', hidden_item_ids: ['1', '1.1'], expanded_item_ids: [] }));
    const { rerender } = render(<value.Composition />);
    expect(node('1.1.1')).toBeNull();
    const box = document.querySelector<HTMLElement>('.graph-scroll')!;
    box.scrollTop = 0;
    const left = box.scrollLeft, commits: { selected: string | undefined; top: number; left: number }[] = [];
    rerender(<value.Composition selection="1.1.1" onCommit={() => { commits.push({ selected: selected(), top: box.scrollTop, left: box.scrollLeft }); }} />);
    expect(commits[0]).toEqual({ selected: '1.1.1', top: 0, left });
    expect(node('1.1.1').className).toContain('is-hidden');
    expect(document.querySelectorAll('.graph-stub[aria-expanded="true"]')).toHaveLength(2);
    expect(value.saved).toEqual([]);
    expect(value.reveals).toEqual([]);
  });

  it.each(['visible', 'hidden'] as const)('keeps both scroll positions when a plain selection changes to an off-screen %s item', async visibility => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('graph-scroll')) return new DOMRect(0, 0, 400, 300);
      const box = this.closest<HTMLElement>('.graph-scroll'), target = this.dataset.itemId === '1.1.1';
      return new DOMRect((target ? 1000 : 100) - (box?.scrollLeft ?? 0), (target ? 900 : 100) - (box?.scrollTop ?? 0), 190, 66);
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
    expect(node('1.1.1').getBoundingClientRect().left).toBeGreaterThan(box.getBoundingClientRect().right);
    expect(node('1.1.1').classList.contains('is-hidden')).toBe(visibility === 'hidden');
    rerender(<value.Composition selection="1.1.1" tight onCommit={observe} />);
    await act(async () => { await value.store.refresh(true); });
    expect(commits.every(commit => commit.top === 47 && commit.left === 83)).toBe(true);
    expect(document.activeElement).toBe(focused);
    expect(value.saved).toEqual([]); expect(value.reveals).toEqual([]);
    const reveal = screen.getByRole('button', { name: /Reveal selected/ }) as HTMLButtonElement;
    expect(reveal.disabled).toBe(false);
    fireEvent.click(reveal);
    const bounds = node('1.1.1').getBoundingClientRect();
    expect(bounds.top + bounds.height / 2).toBe(150);
    expect(bounds.left + bounds.width / 2).toBe(200);
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

  it('folds an item hidden during the same selection and can reveal it dimmed again', async () => {
    const value = await setup(undefined, preferences({ selected_item_id: '2' }));
    const { rerender } = render(<value.Composition />);
    node('2').focus();
    rerender(<value.Composition hidden={['2']} />);
    expect(node('2')).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(stub()!.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: /Reveal selected/ }));
    expect(selected()).toBe('2');
    expect(node('2').className).toContain('is-hidden');
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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('graph-scroll') ? new DOMRect(0, 0, 400, 300) : new DOMRect(600, 500, 190, 66);
    });
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

  it.each(['outer click', 'inner click', 'outer ArrowLeft', 'inner ArrowLeft'])('respects the owner’s %s fold across rerenders and live updates', async action => {
    const value = await setup(undefined, preferences({ selected_item_id: '1.1.1', hidden_item_ids: ['1', '1.1'] }));
    const { rerender } = render(<value.Composition />);
    const key = `hidden:${value.session.items['1']!.topic_id}:${action.startsWith('inner') ? '1' : ''}`;
    const group = () => document.querySelector<HTMLElement>(`[data-stub="${key}"]`)!;
    expect(group().getAttribute('aria-expanded')).toBe('true');
    expect(group().title).toContain('fold them again');
    if (action.endsWith('ArrowLeft')) {
      act(() => group().focus()); fireEvent.keyDown(group(), { key: 'ArrowLeft' });
    } else fireEvent.click(group());
    const check = () => {
      expect(node('1.1.1')).toBeNull();
      expect(group().getAttribute('aria-expanded')).toBe('false');
      expect(group().title).toContain('show them');
    };
    check(); rerender(<value.Composition tight />); check();
    value.session.items['2']!.question = 'Live update elsewhere'; value.session.revision++;
    await act(async () => { await value.store.refresh(true); }); check();
  });

  it('enables Reveal selected for a folded hidden route and reopens and centers it', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('graph-scroll') ? new DOMRect(0, 0, 400, 300) : new DOMRect(600, 500, 190, 66);
    });
    const value = await setup(undefined, preferences({ selected_item_id: '1.1.1', hidden_item_ids: ['1', '1.1'], expanded_item_ids: [] }));
    render(<value.Composition />);
    fireEvent.click(document.querySelector('.graph-stub')!);
    expect(node('1.1.1')).toBeNull();
    const reveal = screen.getByRole('button', { name: /Reveal selected/ }) as HTMLButtonElement;
    expect(reveal.disabled).toBe(false);
    const box = document.querySelector<HTMLElement>('.graph-scroll')!; box.scrollTop = 0;
    fireEvent.click(reveal);
    expect(selected()).toBe('1.1.1'); expect(box.scrollTop).toBe(383);
    expect(document.activeElement).toBe(node('1.1.1'));
  });

  it('clears old route folds and opens the new route on each selection change', async () => {
    const value = await setup(undefined, preferences({ selected_item_id: '1.1.1', hidden_item_ids: ['1', '1.1', '8'] }));
    const { rerender } = render(<value.Composition />);
    const root = () => document.querySelector<HTMLElement>(`[data-stub="hidden:${value.session.items['1']!.topic_id}:"]`)!;
    fireEvent.click(root()); expect(node('1.1.1')).toBeNull();
    rerender(<value.Composition selection="8" />);
    expect(selected()).toBe('8'); expect(root().getAttribute('aria-expanded')).toBe('false');
    rerender(<value.Composition selection="1.1.1" />);
    expect(selected()).toBe('1.1.1');
    expect(root().getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector(`[data-stub="hidden:${value.session.items['1']!.topic_id}:1"]`)!.getAttribute('aria-expanded')).toBe('true');
  });

  it('reopens an owner-folded route for a new outside reveal of the same selection', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('graph-scroll') ? new DOMRect(0, 0, 400, 300) : new DOMRect(600, 500, 190, 66);
    });
    const value = await setup(undefined, preferences({ selected_item_id: '1.1.1', hidden_item_ids: ['1', '1.1'] }));
    const first = await value.routes.revealItem({ ...value.route, item_id: '1.1.1' });
    const { rerender } = render(<value.Composition reveal={first} />);
    fireEvent.click(document.querySelector('.graph-stub')!); expect(node('1.1.1')).toBeNull();
    rerender(<value.Composition reveal={first} tight />); expect(node('1.1.1')).toBeNull();
    rerender(<value.Composition reveal={null} />); expect(node('1.1.1')).toBeNull();
    const next = await value.routes.revealItem({ ...value.route, item_id: '1.1.1' });
    expect(next).not.toBe(first);
    const box = document.querySelector<HTMLElement>('.graph-scroll')!; box.scrollTop = 0;
    rerender(<value.Composition reveal={next} />); expect(selected()).toBe('1.1.1'); expect(box.scrollTop).toBe(383);
  });

  it('keeps owner stub folds local through reveal, live refresh and remount', async () => {
    const value = await setup(undefined, preferences({ selected_item_id: '1.1.1', hidden_item_ids: ['1'] }));
    const { rerender } = render(<value.Composition key="first" />);
    fireEvent.click(stub()!); expect(node('1.1.1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Reveal selected/ })); expect(selected()).toBe('1.1.1');
    fireEvent.click(stub()!); expect(node('1.1.1')).toBeNull();
    value.session.revision++;
    await act(async () => { await value.store.refresh(true); });
    expect(node('1.1.1')).toBeNull(); expect(value.saved).toEqual([]);
    rerender(<value.Composition key="second" />);
    expect(selected()).toBe('1.1.1'); expect(value.saved).toEqual([]);
  });

  it.each(['stub', 'node', 'hidden node', 'last node'])('keeps focus on the nearest surviving entry when a focused %s disappears', async kind => {
    const session = graphSession();
    const value = await setup(session, preferences({ selected_item_id: '2', hidden_item_ids: kind === 'stub' ? ['1.2'] : kind === 'hidden node' ? ['1.1'] : [] }));
    const { rerender } = render(<value.Composition />);
    const target = kind === 'stub' ? stub()! : node(kind === 'last node' ? '8' : '1.2');
    act(() => target.focus());
    if (kind === 'hidden node') rerender(<value.Composition hidden={['1.1', '1.2']} />);
    else {
      const id = kind === 'last node' ? '8' : '1.2';
      session.items[id]!.removed_at = session.updated_at; session.revision++;
      await act(async () => { await value.store.refresh(true); });
    }
    const expected = kind === 'last node' ? node('3') : kind === 'hidden node' ? stub()! : node('2');
    expect(document.activeElement).toBe(expected);
    expect(document.activeElement).not.toBe(document.body);
    expect(expected.tabIndex).toBe(0);
    fireEvent.keyDown(expected, { key: kind === 'last node' ? 'ArrowUp' : 'ArrowDown' });
    expect(document.activeElement).not.toBe(expected);
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

  it('moves arrows through stubs in layout order with one roving tab stop, and Enter/Space toggle them', async () => {
    const user = userEvent.setup();
    const value = await setup(undefined, preferences({ hidden_item_ids: ['1.2'], selected_item_id: '1.1.1' }));
    render(<value.Composition />);
    const small = stub(/^1 item hidden$/) as HTMLButtonElement;
    expect(small.tagName).toBe('BUTTON');
    expect(small.tabIndex).toBe(-1);
    fireEvent.keyDown(node('1.1.1'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(small);
    expect(small.tabIndex).toBe(0);
    expect(document.querySelectorAll('.graph-node[tabindex="0"], .graph-stub[tabindex="0"]')).toHaveLength(1);
    expect(value.reveals).toEqual([]);
    await user.keyboard('{Enter}');
    expect(small.getAttribute('aria-expanded')).toBe('true');
    expect(node('1.2')).toBeTruthy();
    await user.keyboard(' ');
    expect(small.getAttribute('aria-expanded')).toBe('false');
    expect(node('1.2')).toBeNull();
    fireEvent.keyDown(small, { key: 'ArrowRight' });
    expect(small.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(small, { key: 'ArrowLeft' });
    expect(small.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(small, { key: 'ArrowDown' });
    await waitFor(() => expect(value.reveals).toEqual([['2', false]]));
    expect(document.activeElement).toBe(node('2'));
    fireEvent.keyDown(node('2'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(small);
    fireEvent.keyDown(small, { key: 'ArrowUp' });
    await waitFor(() => expect(value.reveals.at(-1)).toEqual(['1.1.1', false]));
    expect(document.activeElement).toBe(node('1.1.1'));
  });

  describe('keyboard moves bring the target, with its focus ring, into view across as well as down', () => {
    /** A 400x300 scroller; each card and stub sits at its own x in the graph, shifted by the scroller's scrollLeft. */
    function lay(at: Record<string, number>, scrollerWidth = 400) {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const scroller = this.closest<HTMLElement>('.graph-scroll');
        if (this.classList.contains('graph-scroll')) return new DOMRect(0, 0, scrollerWidth, 300);
        const key = this.dataset.itemId ?? this.dataset.stub ?? '', own = this.classList.contains('graph-stub') ? 'stub' : key;
        const left = (at[own] ?? 100) - (scroller?.scrollLeft ?? 0), width = this.classList.contains('graph-stub') ? 90 : 190;
        return new DOMRect(left, 100, width, this.classList.contains('graph-stub') ? 20 : 66);
      });
    }
    const scrolled = () => document.querySelector<HTMLElement>('.graph-scroll')!.scrollLeft;

    it('scrolls to a stub beyond the right edge, then to a card beyond the left edge, leaving 8px for the ring', async () => {
      lay({ '1.1.1': 20, stub: 560, 2: 100 });
      const value = await setup(undefined, preferences({ hidden_item_ids: ['1.2'], selected_item_id: '1.1.1' }));
      render(<value.Composition />);
      fireEvent.keyDown(node('1.1.1'), { key: 'ArrowDown' });
      const small = stub(/^1 item hidden$/) as HTMLButtonElement;
      expect(document.activeElement).toBe(small);
      // The stub's right edge ends 8px inside the scroller's 400px.
      expect(small.getBoundingClientRect().right).toBe(400 - 8);
      fireEvent.keyDown(small, { key: 'ArrowDown' });
      await waitFor(() => expect(document.activeElement).toBe(node('2')));
      // The card began 158px left of the scroller; it now begins 8px inside it.
      expect(node('2').getBoundingClientRect().left).toBe(8);
    });
    it('scrolls to a stub beyond the left edge so its ring is whole', async () => {
      lay({ '1.1.1': 20, stub: -300 });
      const value = await setup(undefined, preferences({ hidden_item_ids: ['1.2'], selected_item_id: '1.1.1' }));
      render(<value.Composition />);
      fireEvent.keyDown(node('1.1.1'), { key: 'ArrowDown' });
      expect(document.activeElement).toBe(stub(/^1 item hidden$/));
      expect(stub(/^1 item hidden$/)!.getBoundingClientRect().left).toBe(8);
    });
    it('does not scroll when the target and its ring are already in view', async () => {
      lay({ '1.1.1': 20, stub: 120 });
      const value = await setup(undefined, preferences({ hidden_item_ids: ['1.2'], selected_item_id: '1.1.1' }));
      render(<value.Composition />);
      // Opening centres the selected card; the stub then sits inside the scroller with room to spare, so the key moves nothing.
      const before = scrolled(), small = stub(/^1 item hidden$/)!, at = small.getBoundingClientRect().left;
      expect(at).toBeGreaterThanOrEqual(8); expect(small.getBoundingClientRect().right).toBeLessThanOrEqual(392);
      fireEvent.keyDown(node('1.1.1'), { key: 'ArrowDown' });
      expect(document.activeElement).toBe(small);
      expect(scrolled()).toBe(before);
    });
    it('keeps the left edge of a target wider than the scroller in view', async () => {
      lay({ '1.1.1': 20, stub: 120, 2: 500 }, 150);
      const value = await setup(undefined, preferences({ hidden_item_ids: ['1.2'], selected_item_id: '1.1.1' }));
      render(<value.Composition />);
      fireEvent.keyDown(node('1.1.1'), { key: 'ArrowDown' });
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
      await waitFor(() => expect(document.activeElement).toBe(node('2')));
      expect(node('2').getBoundingClientRect().left).toBe(8);
    });
  });

  it('starts arrow traversal at a focused unselected node, using the same order as stubs', async () => {
    const value = await setup(undefined, preferences({ selected_item_id: '2', hidden_item_ids: ['1.2'] }));
    render(<value.Composition />);
    act(() => node('1.1.1').focus());
    fireEvent.keyDown(node('1.1.1'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(stub(/^1 item hidden$/));
    expect(selected()).toBe('2');
    expect(value.reveals).toEqual([]);
  });

  it('updates the roving tab stop when an external selection replaces a focused stub', async () => {
    const value = await setup(undefined, preferences({ selected_item_id: '1.1.1', hidden_item_ids: ['1.2'] }));
    const { rerender } = render(<value.Composition />);
    fireEvent.keyDown(node('1.1.1'), { key: 'ArrowDown' });
    const small = stub(/^1 item hidden$/)!;
    expect(small.tabIndex).toBe(0);
    rerender(<value.Composition selection="2" />);
    expect(node('2').tabIndex).toBe(0);
    expect(small.tabIndex).toBe(-1);
    expect(document.querySelectorAll('.graph-node[tabindex="0"], .graph-stub[tabindex="0"]')).toHaveLength(1);
  });

  it('makes a stub the roving tab stop when a topic has only hidden nodes', async () => {
    const value = await setup(undefined, preferences({ hidden_item_ids: ['1', '2', '3', '8'] }));
    render(<value.Composition />);
    const stops = document.querySelectorAll('.graph-node[tabindex="0"], .graph-stub[tabindex="0"]');
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBe(stub(/^3 items hidden, waiting on you$/));
    fireEvent.keyDown(document.querySelector('.graph-scroll')!, { key: 'Home' });
    expect(document.activeElement).toBe(stops[0]);
    fireEvent.keyDown(stops[0]!, { key: 'End' });
    expect(document.activeElement).toBe(stub(/^1 item hidden$/));
  });

  it('moves focus to the innermost containing stub when a focused unselected item becomes hidden', async () => {
    const value = await setup(undefined, preferences({ selected_item_id: '2', hidden_item_ids: ['1'] }));
    const { rerender } = render(<value.Composition />);
    fireEvent.click(stub(/^1 item hidden, waiting on you$/)!);
    act(() => node('1.1.1').focus());
    rerender(<value.Composition hidden={['1', '1.1']} />);
    expect(node('1.1.1')).toBeNull();
    const inner = document.querySelector<HTMLElement>('[data-stub="hidden:00000000-0000-4000-8000-000000000010:1"]')!;
    expect(document.activeElement).toBe(inner);
    expect(inner.tabIndex).toBe(0);
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

  it('counts the visible subtree in a collapsed node, and expanding it draws the stub too', async () => {
    const value = await setup(undefined, preferences({ hidden_item_ids: ['1.1'], expanded_item_ids: [] }));
    render(<value.Composition />);
    // 1.1 is hidden, so the pill counts 1.2 alone.
    expect(node('1').querySelector('.graph-node-below')!.textContent).toBe('+1');
    expect(stub()).toBeNull();
    fireEvent.click(within(node('1')).getByText('+1'));
    await waitFor(() => expect(value.reveals).toEqual([['1', true]]));
    expect(ids()).toEqual(['1', '1.2', '2', '3', '8']);
    expect(stub(/^1 item hidden, waiting on you$/)).toBeTruthy();
    expect(value.saved.at(-1)).toMatchObject({ hidden_item_ids: ['1.1'], expanded_item_ids: ['1'], selected_item_id: '1' });
  });

  it('shows +N for every visible descendant across deeper tiers while stubs count hidden siblings', async () => {
    const session = graphSession();
    session.items['1.2.1'] = { ...session.items['1.2']!, id: '1.2.1', parent: '1.2', ordinal: 1 };
    session.items['1.2.1.1'] = { ...session.items['1.2']!, id: '1.2.1.1', parent: '1.2.1', ordinal: 1 };
    session.items['1.2.1.2'] = { ...session.items['1.2']!, id: '1.2.1.2', parent: '1.2.1', ordinal: 2 };
    const value = await setup(session, preferences({ expanded_item_ids: [], hidden_item_ids: ['1.1', '1.2.1.2'] }));
    render(<value.Composition />);
    expect(node('1').querySelector('.graph-node-below')!.textContent).toBe('+3');
    fireEvent.click(node('1'));
    await waitFor(() => expect(value.reveals).toEqual([['1', true]]));
    expect(ids()).toEqual(['1', '1.2', '2', '3', '8']);
    expect(stub(/^1 item hidden, waiting on you$/)).toBeTruthy();
    expect(node('1.2').querySelector('.graph-node-below')!.textContent).toBe('+2');
    fireEvent.click(node('1.2'));
    await waitFor(() => expect(value.reveals.at(-1)).toEqual(['1.2', true]));
    expect(node('1.2.1').querySelector('.graph-node-below')!.textContent).toBe('+1');
    fireEvent.click(node('1.2.1'));
    await waitFor(() => expect(value.reveals.at(-1)).toEqual(['1.2.1', true]));
    expect(screen.getAllByRole('treeitem', { name: /^1 item hidden/ })).toHaveLength(2);
    expect(node('1.2.1.2')).toBeNull();
  });

  it('names a branch whose children are all hidden, and expanding it draws their stub', async () => {
    const value = await setup(undefined, preferences({ hidden_item_ids: ['1.1', '1.2'], expanded_item_ids: [] }));
    render(<value.Composition />);
    expect(node('1').querySelector('.graph-node-below')!.textContent).toBe('2 hidden');
    fireEvent.click(node('1'));
    await waitFor(() => expect(value.saved.at(-1)?.expanded_item_ids).toEqual(['1']));
    expect(stub(/^2 items hidden, waiting on you$/)).toBeTruthy();
    expect(ids()).toEqual(['1', '2', '3', '8']);
  });

  it('keeps hidden filter context at least as faded as other context nodes', async () => {
    const value = await setup(undefined, preferences({ hidden_item_ids: ['1'],
      filters: { ...preferences().filters, search: 'morning or evening' } }));
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

  it('uses the tighter layout and shows nothing for an empty session', async () => {
    const value = await setup(), view = render(<value.Composition tight />);
    expect(node('1').style.left).toBe('32px');
    view.unmount();
    const session = graphSession(); session.items = {};
    const empty = await setup(session); render(<empty.Composition />);
    expect(screen.queryByText('One graph per topic')).toBeNull();
    await act(async () => {});
  });

  it('seats the Tree column\'s filter control beside Reveal selected, and keeps it reachable when no topic is drawn', async () => {
    const slot = <button type="button">Filter</button>;
    const value = await setup(), view = render(<GraphFilterSlot.Provider value={slot}><value.Composition /></GraphFilterSlot.Provider>);
    const legend = document.querySelector('.graph-legend')!;
    expect(legend.querySelector('.graph-legend-actions')!.textContent).toBe('Reveal selectedFilter');
    expect(document.querySelectorAll('.graph-legend')).toHaveLength(1);
    view.unmount();
    const session = graphSession(); session.items = {};
    const empty = await setup(session); render(<GraphFilterSlot.Provider value={slot}><empty.Composition /></GraphFilterSlot.Provider>);
    expect(document.querySelector('.graph-legend-bare')!.textContent).toBe('Filter');
    await act(async () => {});
    cleanup();
    // Nothing provided (archived sessions): no stray row.
    render(<empty.Composition />);
    expect(document.querySelector('.graph-legend')).toBeNull();
  });
});
