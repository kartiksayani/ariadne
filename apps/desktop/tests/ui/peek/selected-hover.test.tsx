// No hover peek on the selected item (alpha.24 D7, R10): the selected row's card never opens on a resting pointer, a hover card on a
// row goes when that row becomes selected (also while its wait runs), and Space still opens the selected row's card.
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { notices } from '../../../src/ui/pages/notices';
import { PEEK_OPEN_MS } from '../../../src/ui/peek/context';
import { AppTransport, route } from '../app/transport';

afterEach(() => { cleanup(); notices.clear(); });
const sleep = (ms: number) => act(() => new Promise<void>(resolve => { setTimeout(resolve, ms); }));
const card = () => screen.queryByRole('dialog', { name: /^Peek: / });
const row = (id: string) => document.querySelector<HTMLElement>(`[role="treeitem"][data-item-id="${id}"]`)!;
const saved = (transport: AppTransport) => transport.preferences.sessions.find(view => view.session.session_id === route.session_id)!;
async function mount(configure: (transport: AppTransport) => void = () => {}) {
  const transport = new AppTransport();
  transport.preferences.global.selected_navigation = { kind: 'session', session: route };
  saved(transport).tab_open = true;
  configure(transport);
  render(<DesktopApp service={createDesktopService(transport)} />);
  await waitFor(() => expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready'));
  return transport;
}
async function select(transport: AppTransport, id: string) {
  fireEvent.click(row(id));
  await waitFor(() => expect(saved(transport).selected_item_id).toBe(id));
  await waitFor(() => expect(transport.preferences.revision).toBeGreaterThan(1));
}
const rest = async (id: string) => { fireEvent.mouseEnter(row(id)); fireEvent.mouseMove(row(id)); await sleep(PEEK_OPEN_MS + 100); };
const leave = async (id: string) => { fireEvent.mouseLeave(row(id)); await sleep(400); };
/** A Graph node, by item. */
const node = (id: string) => document.querySelector<HTMLElement>(`[data-testid="graph-scroll"] [role="treeitem"][data-item-id="${id}"]`);
const question = (transport: AppTransport, id: string) => transport.sessions.get(route.session_id)!.items[id]!.question;
/** Rests the pointer on a name chip outside the Map until a hover card would open. */
const restOn = async (element: HTMLElement) => { fireEvent.mouseEnter(element); await sleep(PEEK_OPEN_MS + 100); };

describe('hover peek skips the selected item', { timeout: 15_000 }, () => {
  it('row 16: resting on the selected row opens no card; another row still peeks', async () => {
    const transport = await mount();
    await select(transport, '4');
    await rest('4');
    expect(card()).toBeNull();
    await leave('4');
    await rest('3');
    expect(card()?.getAttribute('aria-label')).toMatch(/^Peek: /);
  });

  it('row 17: a hover card open on a row closes when that row is clicked, and does not come back while the pointer rests', async () => {
    const transport = await mount();
    await rest('3');
    expect(card()).not.toBeNull();
    fireEvent.mouseDown(row('3')); fireEvent.click(row('3'));
    await waitFor(() => expect(saved(transport).selected_item_id).toBe('3'));
    expect(card()).toBeNull();
    fireEvent.mouseMove(row('3')); await sleep(PEEK_OPEN_MS + 100);
    expect(card()).toBeNull();
  });

  it('row 18: Space on the selected row still toggles its card', async () => {
    const transport = await mount();
    await select(transport, '4');
    row('4').focus(); fireEvent.keyDown(row('4'), { key: ' ' });
    await screen.findByRole('dialog', { name: /^Peek: / });
    // The pointer passing over the selected row leaves the owner's card alone.
    fireEvent.mouseMove(row('4')); await sleep(PEEK_OPEN_MS + 100);
    expect(card()).not.toBeNull();
    fireEvent.keyDown(row('4'), { key: ' ' });
    expect(card()).toBeNull();
  });

  it('row 19: the selection moving by a hide onto the row under the pointer opens no card for it', async () => {
    const transport = await mount();
    await select(transport, '3');
    fireEvent.mouseEnter(row('4')); fireEvent.mouseMove(row('4'));
    row('3').focus(); fireEvent.keyDown(row('3'), { key: 'x' });
    await waitFor(() => expect(saved(transport).selected_item_id).toBe('4'));
    await sleep(PEEK_OPEN_MS + 100);
    expect(card()).toBeNull();
  });

  it('row 19: a hover card already open on the row the selection moves onto closes', async () => {
    const transport = await mount();
    await select(transport, '3');
    await rest('4');
    expect(card()).not.toBeNull();
    row('3').focus(); fireEvent.keyDown(row('3'), { key: 'x' });
    await waitFor(() => expect(saved(transport).selected_item_id).toBe('4'));
    await waitFor(() => expect(card()).toBeNull());
  });

  it('rows 16 and 19, the Graph: the selected node opens no card, a wait running when a hide selects its node opens none, other nodes peek', async () => {
    const transport = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }));
    await waitFor(() => expect(node('4')).not.toBeNull());
    fireEvent.click(node('4')!);
    await waitFor(() => expect(saved(transport).selected_item_id).toBe('4'));
    fireEvent.mouseOver(node('4')!); await sleep(PEEK_OPEN_MS + 100);
    expect(card()).toBeNull();
    // The pointer rests on 5 and its wait runs; hiding 4 selects 5 before the wait ends, so no card opens when it does.
    fireEvent.mouseOver(node('5')!); await sleep(PEEK_OPEN_MS / 2);
    node('4')!.focus(); fireEvent.keyDown(node('4')!, { key: 'x' });
    await waitFor(() => expect(saved(transport).selected_item_id).toBe('5'));
    await sleep(PEEK_OPEN_MS);
    expect(card()).toBeNull();
    fireEvent.mouseOver(node('3')!); await sleep(PEEK_OPEN_MS + 100);
    expect(card()?.getAttribute('aria-label')).toBe(`Peek: ${question(transport, '3')}`);
  });
});

describe('name chips outside the Map and the Graph still hover-peek the selected item', { timeout: 15_000 }, () => {
  it('a reference to it in its own Details', async () => {
    const transport = await mount(transport => { transport.sessions.get(route.session_id)!.items['4']!.why = 'Compare [this one](item:4) first.'; });
    await select(transport, '4');
    const detail = await screen.findByRole('article', { name: `Detail of ${question(transport, '4')}` });
    const chip = within(detail).getAllByRole('button').find(button => button.classList.contains('name-chip') && button.getAttribute('aria-label')?.startsWith(question(transport, '4')));
    expect(chip).toBeTruthy();
    await restOn(chip!);
    expect(card()?.getAttribute('aria-label')).toBe(`Peek: ${question(transport, '4')}`);
  });

  it('its name in What changed', async () => {
    const transport = await mount(transport => {
      const session = transport.sessions.get(route.session_id)!, target = session.items['1.1']!;
      target.created_at = new Date(Date.now() - 30_000).toISOString(); target.changes = []; target.short = 'New receipt branch';
      session.updated_at = target.created_at;
      transport.preferences.seen = [{ session: route, since: new Date(Date.now() - 60_000).toISOString(), items: [], topics: [] }];
    });
    await select(transport, '1.1');
    fireEvent.click(screen.getByRole('button', { name: /1 new/ }));
    const since = screen.getByRole('dialog', { name: 'What changed' });
    await restOn(within(since).getByRole('button', { name: 'New receipt branch' }));
    expect(card()?.getAttribute('aria-label')).toBe(`Peek: ${question(transport, '1.1')}`);
  });

  it('its entry in Recent', async () => {
    const transport = await mount(transport => { saved(transport).recent_items = [{ item_id: '4', action: 'viewed', visited_at: '2026-10-13T11:00:00.000Z' }]; });
    await select(transport, '4');
    fireEvent.click(document.querySelector<HTMLElement>('[data-popover-trigger="recent"]')!);
    const recent = await screen.findByRole('dialog', { name: 'Recent items' });
    const entry = within(within(recent).getByRole('region', { name: 'Viewed' })).getAllByRole('button').find(button => button.title === question(transport, '4'));
    expect(entry).toBeTruthy();
    await restOn(entry!);
    expect(card()?.getAttribute('aria-label')).toBe(`Peek: ${question(transport, '4')}`);
  });
});
