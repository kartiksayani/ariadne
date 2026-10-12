import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService, type DesktopTransport } from '../../../src/data/service';
import { AppTransport, route } from './transport';

afterEach(cleanup);
const row = (id: string) => document.querySelector<HTMLElement>(`[role="treeitem"][data-item-id="${id}"]`);
const saved = (transport: AppTransport) => transport.preferences.sessions.find(view => view.session.session_id === route.session_id)!;
const group = (count = 1) => screen.getByRole('treeitem', { name: new RegExp(`^${count} items? hidden`) });
const filterButton = () => within(screen.getByRole('group', { name: 'Filter items' })).getByRole('button', { name: /^Filter/ });
const chip = (name: string) => {
  if (filterButton().getAttribute('aria-expanded') !== 'true') fireEvent.click(filterButton());
  return screen.getByRole(name === 'All' ? 'menuitem' : 'menuitemcheckbox', { name: new RegExp(`^${name === 'All' ? 'Show all' : name}`) });
};
async function ready() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Session actions' })).toBeTruthy());
  await waitFor(() => expect(filterButton().hasAttribute('disabled')).toBe(false));
  await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready');
      expect(screen.getByLabelText('Session').getAttribute('aria-busy')).toBe('false');
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
  ])('explains hiding in the pane and restores the item and its parents without moving the reader: %o', async ({ selected, hidden, parent }) => {
    const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
    session.items['1.1.1'] = { ...session.items['1.1']!, id: '1.1.1', parent: '1.1', ordinal: 1 };
    saved(transport).selected_item_id = selected; saved(transport).hidden_item_ids = hidden;
    await mount(transport);
    const pane = await screen.findByLabelText(`Detail of #${selected}`), detail = screen.getByRole('complementary', { name: 'Item detail' });
    const notice = within(detail).getByRole('status'), body = pane.querySelector<HTMLElement>('.detail-body')!;
    const message = parent ? hidden.includes(selected) ? `Hidden, along with its parent “${session.items[parent]!.question}”.`
      : `Hidden with its parent “${session.items[parent]!.question}”` : 'Hidden — this item is hidden from the list.';
    expect(notice.textContent).toContain(message);
    expect(detail.classList.contains('shell-detail-hidden')).toBe(true);
    const toggle = within(detail).getByRole('button', { name: 'Unhide item' });
    const title = parent ? 'Unhide this item and its hidden parents' : 'Unhide';
    expect(toggle.title).toBe(title); expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(within(notice).getByRole('button', { name: 'Unhide' }).title).toBe(title);
    body.scrollTop = 120; fireEvent.scroll(body);
    fireEvent.click(within(notice).getByRole('button', { name: 'Unhide' }));
    await waitFor(() => expect(saved(transport).hidden_item_ids).toEqual(['3'])); await ready();
    expect(within(detail).queryByRole('status')).toBeNull();
    expect(detail.classList.contains('shell-detail-hidden')).toBe(false);
    expect(screen.getByLabelText(`Detail of #${selected}`)).toBe(pane);
    expect(body.scrollTop).toBe(120); expect(saved(transport).selected_item_id).toBe(selected);
    expect(within(detail).getByRole('button', { name: 'Hide item' }).getAttribute('aria-pressed')).toBe('false');
  });

  it.each([false, true])('does not confuse a topic or its archive with owner hiding (archived: %s)', async archived => {
    const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!, topic = session.items['1.1']!.topic_id;
    if (archived) session.topics[topic]!.archived_at = '2026-10-07T12:00:00Z';
    saved(transport).hidden_item_ids = [topic]; saved(transport).selected_item_id = '1.1';
    await mount(transport); await screen.findByLabelText('Detail of #1.1');
    const detail = screen.getByRole('complementary', { name: 'Item detail' });
    expect(within(detail).queryByText(/^Hidden/)).toBeNull();
    expect(within(detail).getByRole('button', { name: 'Hide item' }).getAttribute('aria-pressed')).toBe('false');
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
    let release!: () => void;
    transport.holdSession = new Promise<void>(resolve => { release = resolve; });
    const session = transport.sessions.get(route.session_id)!;
    ++session.revision;
    act(() => { transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision }); });
    expect(row('4')!.getAttribute('aria-disabled')).toBeNull();
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

  it('keeps keyboard focus on the hidden group after x and enters its dimmed rows with Right', async () => {
    const { transport } = await mount(); row('4')!.focus(); fireEvent.keyDown(row('4')!, { key: 'x' });
    await waitFor(() => expect(saved(transport).hidden_item_ids).toEqual(['4'])); await ready();
    await waitFor(() => expect(document.activeElement).toBe(group()));
    fireEvent.keyDown(group(), { key: 'ArrowRight' });
    expect(group().getAttribute('aria-expanded')).toBe('true'); expect(document.activeElement).toBe(group());
    fireEvent.keyDown(group(), { key: 'ArrowRight' }); expect(document.activeElement).toBe(row('4'));
    fireEvent.keyDown(row('4')!, { key: 'x' });
    await waitFor(() => expect(saved(transport).hidden_item_ids ?? []).toEqual([]));
    expect(row('4')!.classList.contains('tree-item-hidden')).toBe(false);
  });

  it('keeps focus on a newly hidden row in an expanded group and unhides it with x', async () => {
    const { transport } = await mount(); await hide('2'); fireEvent.click(group());
    row('4')!.focus(); fireEvent.keyDown(row('4')!, { key: 'x' });
    await waitFor(() => expect(saved(transport).hidden_item_ids).toEqual(['2', '4'])); await ready();
    expect(group(2).getAttribute('aria-expanded')).toBe('true');
    expect(row('4')!.classList.contains('tree-item-hidden')).toBe(true);
    expect(document.activeElement).toBe(row('4'));
    fireEvent.keyDown(document.activeElement!, { key: 'x' });
    await waitFor(() => expect(saved(transport).hidden_item_ids).toEqual(['2'])); await ready();
    expect(row('4')!.classList.contains('tree-item-hidden')).toBe(false);
    expect(document.activeElement).toBe(row('4'));
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
    fireEvent.keyDown(group(), { key: 'Enter' }); row('1')!.focus(); fireEvent.keyDown(row('1')!, { key: 'x' });
    await waitFor(() => expect(saved(transport).hidden_item_ids ?? []).toEqual([]));
    expect(row('1')!.classList.contains('tree-item-hidden')).toBe(false); expect(row('1.1')).not.toBeNull();
    expect(screen.queryByRole('treeitem', { name: /^1 item hidden/ })).toBeNull();
    expect(JSON.stringify(transport.sessions.get(route.session_id))).toBe(sessionBefore);
    expect(transport.mutations.every(request => request.command.command === 'preferences_patch')).toBe(true);
  });

  it('hides a child alone and restores a parent without restoring an independently hidden child', async () => {
    const { transport } = await mount(); await hide('1.1');
    expect(row('1')).not.toBeNull(); expect(group().getAttribute('aria-level')).toBe('3');
    await hide('1'); await waitFor(() => expect(saved(transport).hidden_item_ids).toEqual(['1.1', '1']));
    expect(screen.getAllByRole('treeitem', { name: /^1 item hidden/ })).toHaveLength(1);
    fireEvent.click(group()); fireEvent.click(within(row('1')!).getByRole('button', { name: 'Unhide (x)' }));
    await waitFor(() => expect(saved(transport).hidden_item_ids).toEqual(['1.1'])); await ready();
    expect(row('1')!.classList.contains('tree-item-hidden')).toBe(false); expect(row('1.1')).toBeNull();
    expect(group().getAttribute('aria-level')).toBe('3');
    fireEvent.click(group()); fireEvent.click(within(row('1.1')!).getByRole('button', { name: 'Unhide (x)' }));
    await waitFor(() => expect(saved(transport).hidden_item_ids ?? []).toEqual([]));
    expect(row('1.1')!.classList.contains('tree-item-hidden')).toBe(false);
  });

  it('persists hidden preferences through an app restart and offers the detail header action', async () => {
    const { transport, unmount } = await mount();
    fireEvent.click(row('4')!); await screen.findByLabelText('Detail of #4'); await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Hide item' }));
    await waitFor(() => expect(saved(transport).hidden_item_ids).toEqual(['4'])); await ready();
    expect(screen.getByRole('button', { name: 'Unhide item' })).toBeTruthy();
    unmount(); await mount(transport);
    expect(saved(transport).hidden_item_ids).toEqual(['4']); expect(group()).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unhide item' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Unhide item' }));
    await waitFor(() => expect(saved(transport).hidden_item_ids ?? []).toEqual([])); await ready();
    expect(row('4')!.classList.contains('tree-item-hidden')).toBe(false);
  });

  it('keeps a hidden waiting question in the rail and reveals it dimmed when selected there', async () => {
    const { transport } = await mount(); const waitingBefore = chip('Waiting on me').textContent;
    await hide('2');
    expect(chip('Waiting on me').textContent).toBe(waitingBefore);
    expect(within(group()).getByText('waiting on you')).toBeTruthy();
    const card = document.querySelector<HTMLElement>('[data-waiting-item="2"]')!; expect(card).not.toBeNull();
    fireEvent.click(card); await screen.findByLabelText('Detail of #2'); await ready();
    expect(group().getAttribute('aria-expanded')).toBe('true');
    expect(row('2')!.classList.contains('tree-item-hidden')).toBe(true);
    expect(saved(transport).hidden_item_ids).toEqual(['2']);
    fireEvent.click(group());
    await waitFor(() => expect(group().getAttribute('aria-expanded')).toBe('false'));
    expect(row('2')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Unhide item' }));
    await waitFor(() => expect(saved(transport).hidden_item_ids ?? []).toEqual([]));
    expect(document.querySelector('[data-waiting-item="2"]')).not.toBeNull();
  });

  it('reveals a hidden descendant from a native item route and keeps its preference', async () => {
    const { transport } = await mount(); await hide('1');
    await act(async () => { transport.emit('ariadne://route', { ...route, item_id: '1.1' }); });
    await screen.findByLabelText('Detail of #1.1'); await ready();
    expect(group().getAttribute('aria-expanded')).toBe('true');
    expect(row('1.1')!.classList.contains('tree-item-hidden')).toBe(true);
    expect(saved(transport).hidden_item_ids).toEqual(['1']);
  });

  it('explains hidden search matches and adjusts the ordinary status chip counts', async () => {
    await mount(); await hide('1.1');
    expect(chip('All').textContent).toContain('8'); expect(chip('Open').textContent).toContain('2');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search questions and outcomes' }), { target: { value: 'receipt' } });
    expect(await screen.findByText('Showing 1 of 8 items matching “receipt” (1 hidden)')).toBeTruthy();
    expect(chip('All').textContent).toContain('1'); expect(chip('Open').textContent).toContain('0');
    fireEvent.click(chip('Open'));
    expect(await screen.findByText('Showing 0 of 8 items matching “receipt” (1 hidden) in the statuses you picked')).toBeTruthy();
    expect(group()).toBeTruthy();
  });

  it('explains hidden matches for a status chip without search and clears that filter', async () => {
    await mount(); await hide('1.1'); fireEvent.click(chip('Open'));
    expect(await screen.findByText('Showing 2 of 8 items (1 hidden) in the statuses you picked')).toBeTruthy();
    expect(chip('Open').textContent).toContain('2');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(filterButton().hasAttribute('data-active')).toBe(false));
    expect(screen.queryByText('Showing 2 of 8 items (1 hidden) in the statuses you picked')).toBeNull();
    expect(group()).toBeTruthy();
  });
});
