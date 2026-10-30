import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService, type DesktopTransport } from '../../../src/data/service';
import { AppTransport, route } from './transport';
import { toasts } from '../../../src/ui/shell/toast';

afterEach(cleanup);
/** Hide and Unhide are rows of the Details head's "…" menu (alpha.21 E1, E2). */
const moreActions = () => screen.getByRole('button', { name: 'More actions' });
const pressRow = (name: string) => { fireEvent.click(moreActions()); fireEvent.click(screen.getByRole('menuitem', { name })); };
const hasRow = (name: string) => { fireEvent.click(moreActions()); const present = !!screen.queryByRole('menuitem', { name }); fireEvent.click(moreActions()); return present; };
const row = (id: string) => document.querySelector<HTMLElement>(`[role="treeitem"][data-item-id="${id}"]`);
const saved = (transport: AppTransport) => transport.preferences.sessions.find(view => view.session.session_id === route.session_id)!;
const group = (count = 1) => screen.getByRole('treeitem', { name: new RegExp(`^${count} hidden`) });
// The top bar's funnel opens the chip row (SPEC 6.10); the row's chips are toggle buttons named "<status> <count>".
const filterRow = () => {
  if (!screen.queryByRole('group', { name: 'Filter items' })) fireEvent.click(screen.getByRole('button', { name: /^Filter by status/ }));
  return screen.getByRole('group', { name: 'Filter items' });
};
const chip = (name: string) => within(filterRow()).getByRole('button', { name: new RegExp(`^${name} \\d+(, \\d+ more hidden)?$`) });
async function ready() {
  await waitFor(() => expect(screen.getByRole('button', { name: /^Switch session or project/ })).toBeTruthy());
  await waitFor(() => expect(screen.getByRole('button', { name: /^Filter by status/ }).hasAttribute('disabled')).toBe(false));
  await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready');
      expect(screen.getByRole('button', { name: /^Switch session or project/ }).hasAttribute('disabled')).toBe(false);
    });
}
async function mount(transport = new AppTransport()) {
  transport.preferences.global.selected_navigation = { kind: 'session', session: route };
  saved(transport).tab_open = true;
  const app = render(<DesktopApp service={createDesktopService(transport)} />);
  await screen.findByRole('region', { name: 'Session tree' }); await ready();
  return { transport, ...app };
}
async function hide(id: string) {
  fireEvent.click(within(row(id)!).getByRole('button', { name: 'Hide (x)' }));
  await waitFor(() => expect(row(id)).toBeNull()); await ready();
}

describe('owner hide and unhide actions', () => {
  it.each([
    { selected: '1.1', hidden: ['1.1', '3'], parent: null },
    { selected: '1.1', hidden: ['1', '3'], parent: '1' },
    { selected: '1.1.1', hidden: ['1', '3'], parent: '1' },
    { selected: '1.1.1', hidden: ['1', '1.1', '3'], parent: '1.1' },
    { selected: '1.1', hidden: ['1', '1.1', '3'], parent: '1' },
    { selected: '1.1.1', hidden: ['1', '1.1', '1.1.1', '3'], parent: '1.1' },
  ])('explains hiding in the pane and restores the item and its parents without moving the reader: %o', async ({ selected, hidden }) => {
    const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
    session.items['1.1.1'] = { ...session.items['1.1']!, id: '1.1.1', parent: '1.1', ordinal: 1 };
    saved(transport).selected_item_id = selected; saved(transport).hidden_item_ids = hidden;
    await mount(transport);
    const pane = await screen.findByLabelText(/^Detail of /, { selector: `[data-detail-item-id="${selected}"]` }), detail = screen.getByRole('complementary', { name: 'Item detail' });
    const body = pane.querySelector<HTMLElement>('.detail-body')!;
    // The head's "Hidden — … Unhide" line is gone: the item reads dimmed and its "…" menu offers Unhide.
    expect(within(detail).queryByRole('status')).toBeNull();
    expect(detail.classList.contains('shell-detail-hidden')).toBe(true);
    expect(hasRow('Unhide')).toBe(true); expect(hasRow('Hide')).toBe(false);
    body.scrollTop = 120; fireEvent.scroll(body);
    pressRow('Unhide');
    await waitFor(() => expect(saved(transport).hidden_item_ids).toEqual(['3'])); await ready();
    expect(detail.classList.contains('shell-detail-hidden')).toBe(false);
    expect(screen.getByLabelText(/^Detail of /, { selector: `[data-detail-item-id="${selected}"]` })).toBe(pane);
    expect(body.scrollTop).toBe(120); expect(saved(transport).selected_item_id).toBe(selected);
    expect(hasRow('Hide')).toBe(true);
  });

  it('says "Hid “x”." with an Undo that unhides once, and does nothing more when the item was unhidden another way', async () => {
    const { transport } = await mount();
    const name = transport.sessions.get(route.session_id)!.items['4']!.short ?? transport.sessions.get(route.session_id)!.items['4']!.question;
    await hide('4');
    await waitFor(() => expect(toasts.current()).not.toBeNull());
    const first = toasts.current();
    expect(first?.text).toMatch(/^Hid “.+”\.$/); expect(first?.text).toContain(name.slice(0, 8));
    act(() => toasts.runUndo(first!.id));
    await waitFor(() => expect(saved(transport).hidden_item_ids ?? []).toEqual([])); await ready();
    expect(row('4')).not.toBeNull(); expect(toasts.current()).toBeNull();
    // Hidden again, then unhidden by hand: a late Undo must not hide it again.
    await hide('4');
    const second = toasts.current()!;
    fireEvent.click(screen.getByRole('treeitem', { name: /^1 hidden/ }));
    fireEvent.click(within(row('4')!).getByRole('button', { name: 'Unhide (x)' }));
    await waitFor(() => expect(saved(transport).hidden_item_ids ?? []).toEqual([])); await ready();
    act(() => toasts.runUndo(second.id));
    await ready();
    expect(saved(transport).hidden_item_ids ?? []).toEqual([]);
  });

  it.each([false, true])('does not confuse a topic or its archive with owner hiding (archived: %s)', async archived => {
    const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!, topic = session.items['1.1']!.topic_id;
    if (archived) session.topics[topic]!.archived_at = '2026-10-07T12:00:00Z';
    saved(transport).hidden_item_ids = [topic]; saved(transport).selected_item_id = '1.1';
    await mount(transport); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1.1"]' });
    const detail = screen.getByRole('complementary', { name: 'Item detail' });
    expect(within(detail).queryByText(/^Hidden/)).toBeNull();
    expect(hasRow('Hide')).toBe(true); expect(hasRow('Unhide')).toBe(false);
  });

  it.each([null, '1'])('moves Up and Down through visible siblings, the hidden group and its items (parent: %s)', async parent => {
    const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
    if (parent) {
      session.items['1.2'] = { ...session.items['1.1']!, id: '1.2', ordinal: 2 };
      session.items['1.3'] = { ...session.items['1.1']!, id: '1.3', ordinal: 3 };
    }
    saved(transport).hidden_item_ids = parent ? ['1.1', '1.3'] : ['1', '3'];
    await mount(transport);
    const lastVisible = row(parent ? '1.2' : '7')!, hidden = group(2);
    lastVisible.focus(); fireEvent.keyDown(lastVisible, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(hidden);
    fireEvent.keyDown(hidden, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(parent ? row('2') : screen.getByRole('treeitem', { name: 'Continued context' }));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(hidden);
    fireEvent.keyDown(hidden, { key: 'ArrowRight' });
    const order = parent ? [lastVisible, hidden, row('1.1')!, row('1.3')!, row('2')!]
      : [lastVisible, hidden, row('1')!, row('1.1')!, row('3')!, screen.getByRole('treeitem', { name: 'Continued context' })];
    const visible = [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    expect(visible.slice(visible.indexOf(lastVisible), visible.indexOf(order.at(-1)!) + 1)).toEqual(order);
    lastVisible.focus();
    for (const next of order.slice(1)) { fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' }); expect(document.activeElement).toBe(next); }
    for (const previous of order.slice(0, -1).reverse()) { fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' }); expect(document.activeElement).toBe(previous); }
  });

  it('hides with x during a session refresh, saving once after the fresh read returns', async () => {
    class RefreshTransport extends AppTransport {
      holdSession: Promise<void> | null = null;
      override async invoke<T>(name: string, args: Parameters<DesktopTransport['invoke']>[1]): Promise<T> {
        if (name === 'session_get' && this.holdSession) await this.holdSession;
        return super.invoke<T>(name, args);
      }
    }
    const transport = new RefreshTransport(); await mount(transport);
    fireEvent.click(row('4')!); await waitFor(() => expect(saved(transport).selected_item_id).toBe('4'));
    let release!: () => void;
    transport.holdSession = new Promise<void>(resolve => { release = resolve; });
    const session = transport.sessions.get(route.session_id)!;
    ++session.revision;
    act(() => { transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision }); });
    expect(document.querySelector('[role="tree"]')!.getAttribute('aria-busy')).toBe('false');
    row('4')!.focus(); fireEvent.keyDown(row('4')!, { key: 'x' });
    expect(saved(transport).hidden_item_ids ?? []).toEqual([]);
    await act(async () => { transport.holdSession = null; release(); });
    await waitFor(() => expect(saved(transport).hidden_item_ids).toEqual(['4']));
    await ready();
    expect(row('4')).toBeNull();
    expect(screen.queryByText('The hidden items preference could not be saved. Try again.')).toBeNull();
    expect(transport.mutations.filter(request => request.command.command === 'preferences_patch'
      && request.command.params.entries.some(entry => entry.kind === 'set_session_view' && entry.preferences.hidden_item_ids?.includes('4')))).toHaveLength(1);
  });

  // alpha.24 "Hide moves on" replaces "focus goes to the hidden group": x selects the next row and focus goes with it.
  it('moves the selection and keyboard focus to the next row after x; the hidden group still opens into its dimmed rows', async () => {
    const { transport } = await mount(); fireEvent.click(row('4')!); await waitFor(() => expect(saved(transport).selected_item_id).toBe('4'));
    row('4')!.focus(); fireEvent.keyDown(row('4')!, { key: 'x' });
    await waitFor(() => expect(saved(transport).hidden_item_ids).toEqual(['4'])); await ready();
    expect(saved(transport).selected_item_id).toBe('5');
    expect(row('5')!.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(row('5'));
    group().focus(); fireEvent.keyDown(group(), { key: 'ArrowRight' });
    expect(group().getAttribute('aria-expanded')).toBe('true'); expect(document.activeElement).toBe(group());
    fireEvent.keyDown(group(), { key: 'ArrowRight' }); expect(document.activeElement).toBe(row('4'));
    // Unhide never moves the selection (row 14). All by keyboard: Enter selects the dimmed row, x unhides it, and it keeps the
    // selection and the focus.
    fireEvent.keyDown(row('4')!, { key: 'Enter' }); await waitFor(() => expect(saved(transport).selected_item_id).toBe('4')); await ready();
    expect(document.activeElement).toBe(row('4'));
    fireEvent.keyDown(row('4')!, { key: 'x' });
    await waitFor(() => expect(saved(transport).hidden_item_ids ?? []).toEqual([])); await ready();
    expect(row('4')!.classList.contains('tree-item-hidden')).toBe(false);
    expect(saved(transport).selected_item_id).toBe('4');
    expect(document.activeElement).toBe(row('4'));
  });

  // alpha.24 replaces "a newly hidden row keeps focus": in an open hidden group the row dims at the group's end, and the
  // selection and focus move to the next row on its level (Path B).
  it('moves on from a row newly hidden into an expanded group, and unhides it with x', async () => {
    const { transport } = await mount(); await hide('2'); fireEvent.click(group());
    fireEvent.click(row('4')!); await waitFor(() => expect(saved(transport).selected_item_id).toBe('4'));
    row('4')!.focus(); fireEvent.keyDown(row('4')!, { key: 'x' });
    await waitFor(() => expect(saved(transport).hidden_item_ids).toEqual(['2', '4'])); await ready();
    expect(group(2).getAttribute('aria-expanded')).toBe('true');
    expect(row('4')!.classList.contains('tree-item-hidden')).toBe(true);
    expect(saved(transport).selected_item_id).toBe('5');
    expect(document.activeElement).toBe(row('5'));
    fireEvent.click(row('4')!); await waitFor(() => expect(saved(transport).selected_item_id).toBe('4'));
    fireEvent.keyDown(row('4')!, { key: 'x' });
    await waitFor(() => expect(saved(transport).hidden_item_ids).toEqual(['2'])); await ready();
    expect(row('4')!.classList.contains('tree-item-hidden')).toBe(false);
    expect(saved(transport).selected_item_id).toBe('4');
    expect(group().getAttribute('aria-expanded')).toBe('true');
  });

  it('hides a parent from the hover actions, expands and collapses its group, and unhides with x', async () => {
    const { transport } = await mount(), sessionBefore = JSON.stringify(transport.sessions.get(route.session_id));
    const actions = row('1')!.querySelector('.tree-actions')!;
    expect(within(actions as HTMLElement).getByRole('button', { name: 'Hide (x)' }).querySelector('svg')).not.toBeNull();
    await hide('1'); expect(row('1.1')).toBeNull();
    await waitFor(() => expect(saved(transport).hidden_item_ids).toEqual(['1']));
    expect(group().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(group());
    expect(group().getAttribute('aria-expanded')).toBe('true');
    expect(row('1')!.classList.contains('tree-item-hidden')).toBe(true);
    expect(row('1.1')!.classList.contains('tree-item-hidden')).toBe(true);
    expect(within(row('1')!).getByRole('button', { name: 'Unhide (x)' }).getAttribute('title')).toBe('Unhide (x)');
    group().focus(); fireEvent.keyDown(group(), { key: 'Enter' }); expect(row('1')).toBeNull();
    fireEvent.keyDown(group(), { key: 'Enter' }); fireEvent.click(row('1')!); await waitFor(() => expect(saved(transport).selected_item_id).toBe('1'));
    row('1')!.focus(); fireEvent.keyDown(row('1')!, { key: 'x' });
    await waitFor(() => expect(saved(transport).hidden_item_ids ?? []).toEqual([]));
    expect(row('1')!.classList.contains('tree-item-hidden')).toBe(false); expect(row('1.1')).not.toBeNull();
    expect(screen.queryByRole('treeitem', { name: /^1 hidden/ })).toBeNull();
    expect(JSON.stringify(transport.sessions.get(route.session_id))).toBe(sessionBefore);
    expect(transport.mutations.every(request => request.command.command === 'preferences_patch')).toBe(true);
  });

  it('hides a child alone and restores a parent without restoring an independently hidden child', async () => {
    const { transport } = await mount(); await hide('1.1');
    expect(row('1')).not.toBeNull(); expect(group().getAttribute('aria-level')).toBe('3');
    await hide('1'); await waitFor(() => expect(saved(transport).hidden_item_ids).toEqual(['1.1', '1']));
    expect(screen.getAllByRole('treeitem', { name: /^1 hidden/ })).toHaveLength(1);
    fireEvent.click(group()); fireEvent.click(within(row('1')!).getByRole('button', { name: 'Unhide (x)' }));
    await waitFor(() => expect(saved(transport).hidden_item_ids).toEqual(['1.1'])); await ready();
    expect(row('1')!.classList.contains('tree-item-hidden')).toBe(false); expect(row('1.1')).toBeNull();
    expect(group().getAttribute('aria-level')).toBe('3');
    fireEvent.click(group()); fireEvent.click(within(row('1.1')!).getByRole('button', { name: 'Unhide (x)' }));
    await waitFor(() => expect(saved(transport).hidden_item_ids ?? []).toEqual([]));
    expect(row('1.1')!.classList.contains('tree-item-hidden')).toBe(false);
  });

  // alpha.24 replaces "Details keeps the hidden item": Details Hide moves the selection on, and Details follows it, through a restart.
  it('persists hidden preferences and the selection Hide moved to through an app restart, and offers Unhide in the detail head menu', async () => {
    const { transport, unmount } = await mount();
    fireEvent.click(row('4')!); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="4"]' }); await ready();
    pressRow('Hide');
    await waitFor(() => expect(saved(transport).hidden_item_ids).toEqual(['4'])); await ready();
    await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="5"]' });
    expect(saved(transport).selected_item_id).toBe('5'); expect(hasRow('Hide')).toBe(true);
    unmount(); await mount(transport);
    expect(saved(transport).hidden_item_ids).toEqual(['4']); expect(group()).toBeTruthy();
    await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="5"]' });
    fireEvent.click(group()); fireEvent.click(row('4')!);
    await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="4"]' }); await ready();
    expect(hasRow('Unhide')).toBe(true);
    pressRow('Unhide');
    await waitFor(() => expect(saved(transport).hidden_item_ids ?? []).toEqual([])); await ready();
    expect(row('4')!.classList.contains('tree-item-hidden')).toBe(false);
  });

  it('keeps a hidden waiting question in the dock and reveals it dimmed when opened from its path', async () => {
    const { transport } = await mount(); const waitingBefore = chip('Waiting on me').getAttribute('aria-label');
    await hide('2');
    expect(chip('Waiting on me').getAttribute('aria-label')).toBe(waitingBefore);
    expect(within(group()).getByText('1 hidden · 1 waiting')).toBeTruthy();
    const dock = screen.getByRole('region', { name: 'Answer dock' }), current = () => dock.querySelector('.answer-dock-current [data-owner-input="2"]');
    fireEvent.click(within(dock).getByRole('button', { name: /^\d+ (more )?waiting$/ }));
    await waitFor(() => expect(dock.querySelector('.answer-dock-current')).not.toBeNull());
    const next = () => within(dock).getByRole<HTMLButtonElement>('button', { name: 'Next question' });
    while (!current() && !next().disabled) fireEvent.click(next());
    expect(current()).not.toBeNull();
    fireEvent.click(dock.querySelector<HTMLButtonElement>('.dock-question-open')!); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="2"]' }); await ready();
    expect(group().getAttribute('aria-expanded')).toBe('true');
    expect(row('2')!.classList.contains('tree-item-hidden')).toBe(true);
    expect(saved(transport).hidden_item_ids).toEqual(['2']);
    fireEvent.click(group());
    await waitFor(() => expect(group().getAttribute('aria-expanded')).toBe('false'));
    expect(row('2')).toBeNull();
    pressRow('Unhide');
    await waitFor(() => expect(saved(transport).hidden_item_ids ?? []).toEqual([]));
    expect(row('2')).not.toBeNull();
  });

  it('reveals a hidden descendant from a native item route and keeps its preference', async () => {
    const { transport } = await mount(); await hide('1');
    await act(async () => { transport.emit('ariadne://route', { ...route, item_id: '1.1' }); });
    await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1.1"]' }); await ready();
    expect(group().getAttribute('aria-expanded')).toBe('true');
    expect(row('1.1')!.classList.contains('tree-item-hidden')).toBe(true);
    expect(saved(transport).hidden_item_ids).toEqual(['1']);
  });

  it('names hidden search matches in the top bar and leaves the ordinary status chip counts alone', async () => {
    await mount(); await hide('1.1');
    // alpha.24 (G3): the visible count is unchanged; the chip now also says what hides behind it.
    expect(chip('Open').getAttribute('aria-label')).toBe('Open 2, 1 more hidden');
    // The top bar's search box opens from its "Search the Map" button.
    fireEvent.click(screen.getByRole('button', { name: 'Search the Map' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Search the Map' }), { target: { value: 'receipt' } });
    // "Implement receipt lookup" is in view (its question and its note are two matches); "Add the receipt lookup test" is hidden, and named in the note, not shown.
    await waitFor(() => expect(document.querySelector('.tb-search-count')?.textContent).toBe('1 of 2'));
    expect(document.querySelector('.tb-search-note .tb-note-text')?.textContent).toBe('Also matching: 1 in a hidden item.');
    expect(row('1.1')).toBeNull();
    expect(chip('Open').getAttribute('aria-label')).toBe('Open 2, 1 more hidden');
    fireEvent.click(chip('Open'));
    expect(await screen.findByText('Showing 2 of 8 items')).toBeTruthy();
    await waitFor(() => expect(document.querySelector('.tb-search-count')?.textContent).toBe('No matches'));
    expect(document.querySelector('.tb-search-note .tb-note-text')?.textContent).toBe('Also matching: 1 in a hidden item.');
    expect(group()).toBeTruthy();
  });

  it('explains hidden matches for a status chip without search and clears that filter', async () => {
    const { transport } = await mount(); await hide('1.1'); fireEvent.click(chip('Open'));
    expect(await screen.findByText('Showing 2 of 8 items')).toBeTruthy();
    expect(chip('Open').getAttribute('aria-label')).toBe('Open 2, 1 more hidden');
    expect(within(filterRow()).getByText('+1 hidden match')).toBeTruthy();
    expect(group()).toBeTruthy();
    fireEvent.click(within(filterRow()).getByRole('button', { name: 'Clear' }));
    // Clear empties the saved chips and closes the row.
    await waitFor(() => expect(saved(transport).filters.statuses).toEqual([]));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Filter items' })).toBeNull());
    expect(screen.queryByText('Showing 2 of 8 items')).toBeNull();
    expect(group()).toBeTruthy();
  });
});
