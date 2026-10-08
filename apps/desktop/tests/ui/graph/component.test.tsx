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

const opened: OpenSessions[] = [];
afterEach(() => { cleanup(); opened.splice(0).forEach(sessions => sessions.closeAll()); vi.restoreAllMocks(); });

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
  function Composition({ reveal = null, tight = false }: { reveal?: RevealedItem | null; tight?: boolean }) {
    const [current, setCurrent] = useState(view);
    return <GraphView store={store} routes={routes} view={immutable(current)} later={new Set()} reveal={reveal} tight={tight} sessionLabel="codex · yesterday"
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

  it('renders the legend and one card per topic with its nodes and edges', async () => {
    const value = await setup(); render(<value.Composition />);
    for (const text of ['Thread to the selected item', 'Replaced by', 'Waiting on me', 'Closed', 'One graph per topic']) expect(screen.getByText(text)).toBeTruthy();
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
    expect(within(node('1')).getByText('+3').title).toBe('3 items below, collapsed · click to open the next tier');
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
    expect((await screen.findByRole('alert')).textContent).toBe('Ariadne isn’t sure that view change was saved. Try it again.');
    value.writeWith(async () => { throw new Error('Preferences are read-only.'); });
    fireEvent.click(node('8'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('The view change could not be saved. Try again.'));
    value.writeWith(async () => true); value.failReveal();
    fireEvent.click(node('3'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('This item could not be opened.'));
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
