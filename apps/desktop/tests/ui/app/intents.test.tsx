// C5 in the composed app: ⇧F, ⌘E and c work in the Tree, the Graph and the bigger view, and item keys act on the
// current view's item (the bigger view's, even when the Map selected another one meanwhile), never on a hidden button.
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { notices } from '../../../src/ui/pages/notices';
import { AppTransport, route } from './transport';

afterEach(() => { cleanup(); notices.clear(); });

const view = (transport: AppTransport) => transport.preferences.sessions.find(value => value.session.session_id === route.session_id)!;
const hiddenIds = (transport: AppTransport) => view(transport).hidden_item_ids ?? [];
const row = (id: string) => document.querySelector<HTMLElement>(`[role="treeitem"][data-item-id="${id}"]`)!;

async function setup(selected = '4') {
  const transport = new AppTransport();
  transport.preferences.global.selected_navigation = { kind: 'session', session: route };
  Object.assign(transport.preferences.sessions[0]!, { tab_open: true, selected_item_id: selected });
  render(<DesktopApp service={createDesktopService(transport)} />);
  await waitFor(() => {
    expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready');
    expect(screen.getByRole('button', { name: /^Switch session or project/ }).hasAttribute('disabled')).toBe(false);
    expect(row(selected)).not.toBeNull();
  });
  return transport;
}
/** Where a key lands in each view: the Tree's row, the Graph's roving node, the bigger view's region. */
async function enter(where: 'tree' | 'graph' | 'bigger', selected: string): Promise<HTMLElement> {
  if (where === 'tree') return row(selected);
  if (where === 'graph') {
    fireEvent.keyDown(row(selected), { key: 'g' });
    await waitFor(() => expect(document.querySelector('.graph-scroll')).not.toBeNull());
    return document.querySelector<HTMLElement>('.graph-scroll [tabindex="0"]') ?? document.querySelector<HTMLElement>('.graph-scroll')!;
  }
  fireEvent.click(screen.getByRole('button', { name: 'Read in a bigger view' }));
  return screen.findByRole('region', { name: 'Item conversation' });
}
/** Another window selects a different Map item while the bigger view stays on its own. */
async function selectElsewhere(transport: AppTransport, id: string) {
  view(transport).selected_item_id = id; ++transport.preferences.revision;
  await act(async () => { transport.emit('ariadne://preferences_changed', { revision: transport.preferences.revision }); });
  await waitFor(() => expect(document.querySelector('[role="treeitem"][aria-selected="true"]')?.getAttribute('data-item-id')).toBe(id));
}

describe('C5 intents in the Tree, the Graph and the bigger view', () => {
  describe.each(['tree', 'graph', 'bigger'] as const)('%s', where => {
    it('⇧F focuses on the current item', async () => {
      const transport = await setup('4');
      fireEvent.keyDown(await enter(where, '4'), { key: 'F', shiftKey: true });
      await waitFor(() => expect(view(transport).focused_item_id).toBe('4'));
    });
    it('⌘E opens Recent', async () => {
      await setup('4');
      fireEvent.keyDown(await enter(where, '4'), { key: 'e', metaKey: true });
      expect(await screen.findByRole('dialog', { name: 'Recent items' })).toBeTruthy();
    });
    it('c continues the current item’s topic', async () => {
      await setup('4');
      fireEvent.keyDown(await enter(where, '4'), { key: 'c' });
      expect(await screen.findByRole('dialog', { name: 'Continue “Delivery decisions” in another session' })).toBeTruthy();
    });
  });

  // alpha.24: Hide is `x` again; `h` is no key. The bigger view covers the Map, so Hide waits there as before.
  describe.each(['tree', 'graph', 'bigger'] as const)('Hide key in the %s', where => {
    it(where === 'bigger' ? 'x and h do not hide the covered Map item' : 'x hides the current item, and h does nothing', async () => {
      const transport = await setup('4');
      const target = await enter(where, '4');
      fireEvent.keyDown(target, { key: 'h' });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
      expect(hiddenIds(transport)).not.toContain('4');
      fireEvent.keyDown(target, { key: 'x' });
      if (where === 'bigger') {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
        expect(hiddenIds(transport)).not.toContain('4');
      } else await waitFor(() => expect(hiddenIds(transport)).toContain('4'));
    });
  });

  it('x hides the selected item from focus inside Details', async () => {
    const transport = await setup('4');
    const control = within(screen.getByRole('complementary', { name: 'Item detail' })).getByRole('button', { name: 'More actions' });
    control.focus(); fireEvent.keyDown(control, { key: 'h' });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(hiddenIds(transport)).not.toContain('4');
    fireEvent.keyDown(control, { key: 'x' });
    await waitFor(() => expect(hiddenIds(transport)).toContain('4'));
  });

  it('in the bigger view, ⇧F, c and r act on its item, not on what the Map selected meanwhile', async () => {
    const transport = await setup('4');
    const bigger = await enter('bigger', '4');
    await selectElsewhere(transport, '8');
    fireEvent.keyDown(bigger, { key: 'c' });
    const picker = await screen.findByRole('dialog', { name: 'Continue “Delivery decisions” in another session' });
    fireEvent.click(within(picker).getByRole('button', { name: /Cancel/ }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Continue/ })).toBeNull());
    fireEvent.keyDown(bigger, { key: 'F', shiftKey: true });
    await waitFor(() => expect(view(transport).focused_item_id).toBe('4'));
    fireEvent.keyDown(bigger, { key: 'r' });
    await waitFor(() => expect(document.activeElement?.closest('[aria-label="Item conversation"]')).not.toBeNull());
    expect(document.activeElement?.tagName).toBe('TEXTAREA');
    expect(screen.getByRole('region', { name: 'Item conversation' }).querySelector('[data-detail-item-id]')?.getAttribute('data-detail-item-id')).toBe('4');
  });

  it('no key presses a hidden shortcut button', async () => {
    await setup('4');
    expect(document.querySelector('button[hidden][data-shortcut-recent],button[hidden][data-shortcut-focus],button[hidden][data-shortcut-continue]')).toBeNull();
  });
});
