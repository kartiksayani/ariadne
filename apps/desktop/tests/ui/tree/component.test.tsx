import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import demo from '../../../../../fixtures/domain/demo/session.json';
import type { Session } from '../../../src/generated/domain/models';
import type { QueryEnvelope, SessionPreferences } from '../../../src/generated/core';
import { OpenSessions, immutable } from '../../../src/data/session-store';
import { RegisteredRoutes, type RevealedItem } from '../../../src/data/routes';
import { createDesktopService, type DesktopTransport } from '../../../src/data/service';
import { SentenceTree } from '../../../src/components/tree/SentenceTree';

const route = { project_id: demo.project_id, session_id: demo.id };
const opened: OpenSessions[] = [];
afterEach(() => { cleanup(); opened.splice(0).forEach(sessions => sessions.closeAll()); vi.useRealTimers(); vi.restoreAllMocks(); });
function preferences(): SessionPreferences {
  return { session: route, tab_open: true, selected_item_id: '1', tab_order: 0, expanded_item_ids: ['1'],
    filters: { search: '', statuses: [], topic_id: null, archived: false, hide_later: false }, rail: 'waiting', scroll: null };
}
async function setup(session: Session = structuredClone(demo) as Session, view = preferences()) {
  const calls: { command: string; request: Parameters<DesktopTransport['invoke']>[1]['request'] }[] = [];
  let readError = false, missing = false;
  const transport: DesktopTransport = {
    async invoke<T>(command: string, args: Parameters<DesktopTransport['invoke']>[1]): Promise<T> {
      calls.push({ command, request: structuredClone(args.request) });
      if (readError || (command === 'reveal_item' && missing)) return { api_version: 1, ok: false,
        error: { code: 'not_found', message: 'The registered item is missing.', hint: 'Read the registered session.', retryable: false, field_errors: [] } } as T;
      const request = args.request;
      const result = command === 'session_get' ? { session: structuredClone(session), freshness: 'fresh' }
        : { ...route, item_id: 'request' in request ? (request.request.params as { item_id: string }).item_id : '1' };
      return { api_version: 1, ok: true, data: { kind: command, data: result } } as QueryEnvelope as T;
    },
    async listen() { return () => {}; },
  };
  const service = createDesktopService(transport), sessions = new OpenSessions(service); opened.push(sessions);
  const store = sessions.open(route); await store.refresh();
  const routes = new RegisteredRoutes(service, sessions), saved: SessionPreferences[] = [], laterWrites: [string, boolean][] = [], reveals: RevealedItem[] = [];
  let rejectWrite = false;
  function Composition({ externalReveal = null }: { externalReveal?: RevealedItem | null }) {
    const [current, setCurrent] = useState(view), [later, setLater] = useState(new Set<string>());
    return <SentenceTree store={store} routes={routes} view={immutable(current)} later={later} reveal={externalReveal}
      saveView={async next => { saved.push(structuredClone(next)); if (rejectWrite) return false; setCurrent(next); return true; }}
      saveLater={async (id, value) => { laterWrites.push([id, value]); setLater(previous => { const next = new Set(previous); if (value) next.add(id); else next.delete(id); return next; }); return true; }}
      onReveal={result => { reveals.push(result); }} />;
  }
  return { Composition, session, store, calls, routes, saved, laterWrites, reveals,
    unavailable: () => { readError = true; }, missing: () => { missing = true; }, rejectWrite: () => { rejectWrite = true; } };
}
const rows = () => screen.getAllByRole('treeitem');
describe('registered variable-height sentence tree', () => {
  it('renders full stored sentences and outcomes with one roving focus target', async () => {
    const session = structuredClone(demo) as Session;
    session.items['1']!.question = 'A full question\nwith a second line and no summary substitution.';
    session.items['1']!.status = 'done'; session.items['1']!.outcome = 'The full retained terminal outcome\ncontinues on a second line.';
    const { Composition } = await setup(session); render(<Composition />);
    expect(screen.getByText(session.items['1']!.question, { normalizer: text => text })).toBeTruthy();
    expect(screen.getByText(session.items['1']!.outcome, { normalizer: text => text })).toBeTruthy();
    expect(rows().filter(row => row.tabIndex === 0)).toHaveLength(1);
    expect(rows()[0].getAttribute('aria-level')).toBe('1');
    expect(rows()[0].getAttribute('aria-expanded')).toBe('true');
  });
  it('moves focus using numeric visible order without selecting or writing until Enter', async () => {
    const value = await setup(); render(<value.Composition />); rows()[0].focus();
    fireEvent.keyDown(rows()[0], { key: 'j' }); expect(document.activeElement).toBe(rows()[1]); expect(value.saved).toHaveLength(0);
    fireEvent.keyDown(rows()[1], { key: 'End' }); expect(document.activeElement).toBe(rows().at(-1));
    fireEvent.keyDown(rows().at(-1)!, { key: 'Home' }); expect(document.activeElement).toBe(rows()[0]);
    fireEvent.keyDown(rows()[0], { key: 'Enter' });
    await waitFor(() => expect(value.reveals).toHaveLength(1));
    expect(value.calls.find(call => call.command === 'reveal_item')?.request).toEqual({ session: route, request: { command: 'reveal_item', params: { item_id: '1' } } });
    expect(value.saved.at(-1)?.selected_item_id).toBe('1');
  });
  it('expands/collapses through persisted preferences and preserves a hidden descendant as temporary reveal', async () => {
    const value = await setup(); const rendered = render(<value.Composition />);
    fireEvent.keyDown(rows()[0], { key: 'h' });
    await waitFor(() => expect(rows()[0].getAttribute('aria-expanded')).toBe('false'));
    expect(value.saved[0].expanded_item_ids).toEqual([]);
    const reveal = await value.routes.revealItem({ ...route, item_id: '1.1' });
    rendered.rerender(<value.Composition externalReveal={reveal} />);
    expect(rows()[0].getAttribute('aria-expanded')).toBe('true');
    expect(value.saved[0].expanded_item_ids).toEqual([]);
  });
  it('leaves keyboard shortcuts alone in editable controls and uses canonical Later callback', async () => {
    const value = await setup(); render(<value.Composition />);
    const input = screen.getByRole('searchbox'); input.focus(); fireEvent.keyDown(input, { key: 'z' }); expect(value.laterWrites).toHaveLength(0);
    rows()[0].focus(); fireEvent.keyDown(rows()[0], { key: 'z' });
    await waitFor(() => expect(value.laterWrites).toEqual([['1', true]]));
    fireEvent.keyDown(rows()[0], { key: 'z' }); await waitFor(() => expect(value.laterWrites.at(-1)).toEqual(['1', false]));
  });
  it('debounces search by 100ms while preserving all other canonical preferences', async () => {
    const value = await setup(); render(<value.Composition />); vi.useFakeTimers();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'ＮＡＴＩＶＥ queue' } });
    await act(async () => { vi.advanceTimersByTime(99); }); expect(value.saved).toHaveLength(0);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(value.saved[0].filters.search).toBe('ＮＡＴＩＶＥ queue'); expect(value.saved[0].expanded_item_ids).toEqual(['1']);
    expect(value.saved[0].tab_open).toBe(true);
  });
  it('retains last valid rows and disables preferences changes after failed read', async () => {
    const value = await setup(); render(<value.Composition />); const before = rows().length;
    value.unavailable(); await act(async () => { await value.store.refresh(); });
    expect(rows()).toHaveLength(before); expect((screen.getByRole('searchbox') as HTMLInputElement).disabled).toBe(true);
    fireEvent.keyDown(rows()[0], { key: 'z' }); expect(value.laterWrites).toHaveLength(0);
    expect(screen.getByRole('status').textContent).toContain('missing');
  });
  it('shows missing-item fallback from registered lookup without invented selection or expansion', async () => {
    const value = await setup(); render(<value.Composition />); value.missing();
    fireEvent.keyDown(rows()[0], { key: 'Enter' });
    await waitFor(() => expect(value.reveals[0]?.kind).toBe('missing_item'));
    expect(value.saved).toHaveLength(0); expect(screen.getByRole('status').textContent).toContain('missing');
    expect(value.calls.filter(call => call.command === 'session_get').length).toBeGreaterThan(1);
  });
  it('keeps failed preference writes visible and does not apply unconfirmed collapse', async () => {
    const value = await setup(); value.rejectWrite(); render(<value.Composition />);
    fireEvent.click(within(rows()[0]).getByRole('button', { name: 'Expand or collapse' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('not confirmed'));
    expect(rows()[0].getAttribute('aria-expanded')).toBe('true');
  });
  it('writes AND/OR filters through the canonical view record and offers a clear action for no matches', async () => {
    const value = await setup(); render(<value.Composition />);
    const statuses = screen.getByRole('group', { name: 'Item status' });
    fireEvent.click(within(statuses).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(value.saved.at(-1)?.filters.statuses).toEqual(['done']));
    fireEvent.click(within(statuses).getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(value.saved.at(-1)?.filters.statuses).toEqual(['done', 'open']));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hide Later' }));
    await waitFor(() => expect(value.saved.at(-1)?.filters.hide_later).toBe(true));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Archive' }));
    await waitFor(() => expect(value.saved.at(-1)?.filters.archived).toBe(true));
    const search = screen.getByRole('searchbox'); fireEvent.change(search, { target: { value: 'No canonical sentence has this phrase' } });
    await screen.findByText('No sentences match these filters.');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(value.saved.at(-1)?.filters).toEqual({ search: '', statuses: [], topic_id: null, archived: true, hide_later: false }));
  });
  it('focuses search from tree shortcuts without invoking browser search or changing item selection', async () => {
    const value = await setup(); render(<value.Composition />); rows()[0].focus();
    fireEvent.keyDown(rows()[0], { key: '/' }); expect(document.activeElement).toBe(screen.getByRole('searchbox'));
    rows()[0].focus(); fireEvent.keyDown(rows()[0], { key: 'f', metaKey: true });
    expect(document.activeElement).toBe(screen.getByRole('searchbox')); expect(value.reveals).toHaveLength(0);
  });
  it('shows outside-filter reveal, focuses its ancestry and dismisses it without clearing saved filters', async () => {
    const view = preferences(); view.filters.statuses = ['waiting_on_me']; view.expanded_item_ids = [];
    const value = await setup(undefined, view), reveal = await value.routes.revealItem({ ...route, item_id: '1.1' });
    render(<value.Composition externalReveal={reveal} />);
    expect(screen.getByRole('status').textContent).toContain('outside the current filters');
    const child = rows().find(row => row.querySelector('.ref-tree-id')?.textContent === '1.1');
    expect(document.activeElement).toBe(child); expect(child?.getAttribute('aria-level')).toBe('2');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss temporary reveal' }));
    expect(screen.queryByRole('status')).toBeNull(); expect(value.saved).toHaveLength(0);
    expect(rows().some(row => row.querySelector('.ref-tree-id')?.textContent === '1.1')).toBe(false);
  });
  it('does not steal focus from an editable control when a live snapshot updates', async () => {
    const value = await setup(); render(<value.Composition />);
    const input = screen.getByRole('searchbox'); input.focus();
    value.session.revision++; value.session.items['1']!.revision++; value.session.items['1']!.question = 'A new canonical question';
    await act(async () => { await value.store.refresh(); });
    expect(document.activeElement).toBe(input); expect(screen.getByText('A new canonical question')).toBeTruthy();
  });
  it('preserves a visible row scroll anchor when upstream wrapped sentences grow', async () => {
    const value = await setup(); render(<value.Composition />); const tree = screen.getByRole('tree', { name: 'Sentences' });
    let growth = 0;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const rowIndex = rows().indexOf(this), top = rowIndex < 0 ? 0 : rowIndex * 20 + (rowIndex > 0 ? growth : 0) - tree.scrollTop;
      return { top, bottom: top + (rowIndex < 0 ? 100 : 20), height: 20, left: 0, right: 500, width: 500, x: 0, y: top, toJSON: () => ({}) };
    });
    tree.scrollTop = 40; fireEvent.scroll(tree);
    growth = 30; value.session.revision++; value.session.items['1']!.revision++;
    value.session.items['1']!.question = 'A longer wrapped canonical sentence above the retained anchor';
    await act(async () => { await value.store.refresh(); });
    expect(tree.scrollTop).toBe(70);
  });
});
