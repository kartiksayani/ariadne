// No hover peek on the selected item (alpha.24 D7, R10): the selected row's card never opens on a resting pointer, a hover card on a
// row goes when that row becomes selected (also while its wait runs), and Space still opens the selected row's card.
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
async function mount() {
  const transport = new AppTransport();
  transport.preferences.global.selected_navigation = { kind: 'session', session: route };
  saved(transport).tab_open = true;
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
    row('3').focus(); fireEvent.keyDown(row('3'), { key: 'h' });
    await waitFor(() => expect(saved(transport).selected_item_id).toBe('4'));
    await sleep(PEEK_OPEN_MS + 100);
    expect(card()).toBeNull();
  });

  it('row 19: a hover card already open on the row the selection moves onto closes', async () => {
    const transport = await mount();
    await select(transport, '3');
    await rest('4');
    expect(card()).not.toBeNull();
    row('3').focus(); fireEvent.keyDown(row('3'), { key: 'h' });
    await waitFor(() => expect(saved(transport).selected_item_id).toBe('4'));
    await waitFor(() => expect(card()).toBeNull());
  });
});
