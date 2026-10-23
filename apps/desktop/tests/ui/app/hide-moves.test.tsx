// Hide moves on (alpha.24): hiding the selected item, or an ancestor of it, selects the next item on the same level, else the
// previous one, else the parent; with none, nothing is selected and Details closes. The selection rides in the hide's one write
// and shows when it lands. Row numbers are the plan's edge-case table; the Map's scroll position is measured in the layout specs.
import { useLayoutEffect, type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { NavigationWorkspace } from '../../../src/components/navigation/NavigationWorkspace';
import { notices } from '../../../src/ui/pages/notices';
import { toasts } from '../../../src/ui/shell/toast';
import { AppTransport, route } from './transport';
import type { MutationEnvelope } from '../../../src/generated/core';

// Every commit of the workspace: `hidden` is true while the selected item is hidden (Details dims it).
type WorkspaceProps = ComponentProps<typeof NavigationWorkspace>;
const probe = vi.hoisted(() => ({ commits: [] as boolean[] }));
vi.mock('../../../src/components/navigation/NavigationWorkspace', async original => {
  const actual = await original<typeof import('../../../src/components/navigation/NavigationWorkspace')>();
  return { ...actual, NavigationWorkspace: (props: WorkspaceProps) => {
    useLayoutEffect(() => { probe.commits.push(!!props.hidden); });
    return <actual.NavigationWorkspace {...props} />;
  } };
});
afterEach(() => { cleanup(); notices.clear(); probe.commits = []; const toast = toasts.current(); if (toast) toasts.dismiss(toast.id); });

/** Writes can be held in flight, refused once with a definite rejection, or lose their answer once (the store keeps them unsure). */
class Gate extends AppTransport {
  private gate: Promise<void> | null = null;
  release = () => {};
  held = 0;
  reject = false;
  hold() { this.gate = new Promise<void>(resolve => { this.release = () => { this.gate = null; resolve(); }; }); }
  override async invoke<T>(name: string, args: Parameters<AppTransport['invoke']>[1]): Promise<T> {
    const { request } = args;
    if ('command' in request && request.command.command === 'preferences_patch') {
      if (this.gate) { ++this.held; await this.gate; }
      if (this.reject) {
        this.reject = false;
        return { api_version: 1, ok: false, error: { code: 'invalid_transition', message: 'Refused.', hint: '', retryable: false, field_errors: [] } } satisfies MutationEnvelope as T;
      }
    }
    return super.invoke<T>(name, args);
  }
}
const row = (id: string) => document.querySelector<HTMLElement>(`[role="treeitem"][data-item-id="${id}"]`);
const saved = (transport: AppTransport) => transport.preferences.sessions.find(view => view.session.session_id === route.session_id)!;
const details = () => screen.queryByRole('complementary', { name: 'Item detail' });
const detailOf = () => details()?.querySelector('[data-detail-item-id]')?.getAttribute('data-detail-item-id') ?? null;
/** A Graph node, by item. */
const node = (id: string) => document.querySelector<HTMLElement>(`[data-testid="graph-scroll"] [role="treeitem"][data-item-id="${id}"]`);
const selectedRows = () => [...document.querySelectorAll('[role="treeitem"][aria-selected="true"]')].map(element => element.getAttribute('data-item-id'));
const hideWrites = (transport: AppTransport, id: string) => transport.mutations.filter(request => request.command.command === 'preferences_patch'
  && request.command.params.entries.some(entry => entry.kind === 'set_session_view' && entry.preferences.hidden_item_ids?.includes(id)));
async function ready() {
  await waitFor(() => {
    expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready');
    expect(screen.getByRole('button', { name: /^Switch session or project/ }).hasAttribute('disabled')).toBe(false);
  });
}
async function mount(configure: (transport: Gate) => void = () => {}) {
  const transport = new Gate();
  transport.preferences.global.selected_navigation = { kind: 'session', session: route };
  saved(transport).tab_open = true;
  // 1.2 joins 1.1 under 1, so 1.1 has a next sibling; topic B ("Continued context") holds 8 alone.
  const session = transport.sessions.get(route.session_id)!;
  session.items['1.2'] = { ...session.items['1.1']!, id: '1.2', ordinal: 2, question: 'Second child question' };
  configure(transport);
  render(<DesktopApp service={createDesktopService(transport)} />);
  await screen.findByRole('region', { name: 'Session tree' }); await ready();
  return transport;
}
async function select(transport: AppTransport, id: string) {
  fireEvent.click(row(id)!);
  await waitFor(() => expect(saved(transport).selected_item_id).toBe(id));
  await waitFor(() => expect(detailOf()).toBe(id));
  await ready();
}
const pressH = (id: string) => { row(id)!.focus(); fireEvent.keyDown(row(id)!, { key: 'h' }); };
const hoverHide = (id: string) => fireEvent.click(within(row(id)!).getByRole('button', { name: 'Hide (h)' }));
async function hidden(transport: AppTransport, id: string) {
  await waitFor(() => expect(saved(transport).hidden_item_ids ?? []).toContain(id)); await ready();
}

describe('hide moves on to the next item on the same level', () => {
  it.each([
    { row: 1, case: 'a middle sibling', selected: '3', hide: '3', next: '4' },
    { row: 1, case: 'a middle child', selected: '1.1', hide: '1.1', next: '1.2' },
    { row: 2, case: 'the last sibling', selected: '7', hide: '7', next: '6' },
    { row: 2, case: 'the last child', selected: '1.2', hide: '1.2', next: '1.1' },
    { row: 6, case: 'an ancestor of the selection (hover Hide)', selected: '1.2', hide: '1', next: '2' },
  ])('row $row: hiding $case selects $next in the same write, and Details follows', async ({ selected, hide, next }) => {
    const transport = await mount();
    await select(transport, selected);
    if (hide === selected) pressH(hide); else hoverHide(hide);
    await hidden(transport, hide);
    expect(saved(transport).selected_item_id).toBe(next);
    expect(selectedRows()).toEqual([next]);
    await waitFor(() => expect(detailOf()).toBe(next));
    // R1: one write carries the hide and the selection; nothing else is written for the move (not even a Recent visit).
    const writes = hideWrites(transport, hide);
    expect(writes).toHaveLength(1);
    const entry = writes[0]!.command.command === 'preferences_patch' ? writes[0]!.command.params.entries[0] : null;
    expect(entry?.kind === 'set_session_view' && entry.preferences.selected_item_id).toBe(next);
  });

  it('S1: no render shows the item hidden while it is still the selection', async () => {
    const transport = await mount();
    await select(transport, '3');
    const seen: { readonly row: boolean; readonly selected: readonly (string | null)[]; readonly detail: string | null; readonly dimmed: boolean }[] = [];
    const watch = new MutationObserver(() => {
      seen.push({ row: !!row('3'), selected: selectedRows(), detail: detailOf(), dimmed: !!details()?.classList.contains('shell-detail-hidden') });
    });
    watch.observe(document.body, { childList: true, subtree: true, attributes: true });
    probe.commits = [];
    pressH('3');
    await hidden(transport, '3');
    await waitFor(() => expect(detailOf()).toBe('4'));
    watch.disconnect();
    // No commit has the selection hidden: the hide and the move land in one update.
    expect(probe.commits.length).toBeGreaterThan(0);
    expect(probe.commits.filter(Boolean)).toEqual([]);
    const after = seen.filter(state => !state.row || state.dimmed);
    expect(after.length).toBeGreaterThan(0);
    expect(after.filter(state => state.detail === '3' || state.selected.includes('3') || state.dimmed)).toEqual([]);
  });

  it('row 3: hiding an only child selects its parent', async () => {
    const transport = await mount(transport => { delete transport.sessions.get(route.session_id)!.items['1.2']; });
    await select(transport, '1.1');
    pressH('1.1');
    await hidden(transport, '1.1');
    expect(saved(transport).selected_item_id).toBe('1');
    await waitFor(() => expect(detailOf()).toBe('1'));
  });

  it('row 4: hiding the only root of a topic selects nothing, closes Details and focuses the topic row', async () => {
    const transport = await mount();
    await select(transport, '8');
    pressH('8');
    await hidden(transport, '8');
    expect(saved(transport).selected_item_id).toBeNull();
    expect(selectedRows()).toEqual([]);
    await waitFor(() => expect(detailOf()).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: 'Continued context' }));
  });

  it('row 5: a next sibling already hidden is skipped', async () => {
    const transport = await mount(transport => { saved(transport).hidden_item_ids = ['5']; });
    await select(transport, '4');
    pressH('4');
    await hidden(transport, '4');
    expect(saved(transport).selected_item_id).toBe('6');
  });

  it('row 7: Hide on an unrelated row leaves the selection and Details alone', async () => {
    const transport = await mount();
    await select(transport, '4');
    hoverHide('2');
    await hidden(transport, '2');
    expect(saved(transport).selected_item_id).toBe('4');
    expect(detailOf()).toBe('4');
    // Its Undo unhides and leaves the selection alone too: the hide moved nothing (R7).
    act(() => toasts.runUndo(toasts.current()!.id));
    await waitFor(() => expect(saved(transport).hidden_item_ids ?? []).toEqual([])); await ready();
    expect(saved(transport).selected_item_id).toBe('4');
  });

  it('row 9: Details Hide moves the selection, and Details shows the next item', async () => {
    const transport = await mount();
    await select(transport, '3');
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }));
    await hidden(transport, '3');
    expect(saved(transport).selected_item_id).toBe('4');
    await waitFor(() => expect(detailOf()).toBe('4'));
  });

  it('row 10: the Graph’s h moves its selection by the same rule', async () => {
    const transport = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }));
    await waitFor(() => expect(node('3')).not.toBeNull());
    fireEvent.click(node('3')!);
    await waitFor(() => expect(saved(transport).selected_item_id).toBe('3')); await ready();
    node('3')!.focus(); fireEvent.keyDown(node('3')!, { key: 'h' });
    await hidden(transport, '3');
    expect(saved(transport).selected_item_id).toBe('4');
    await waitFor(() => expect(node('4')!.getAttribute('aria-selected')).toBe('true'));
    expect(node('3')).toBeNull();
    expect(document.activeElement).toBe(node('4'));
  });

  it('row 11: Undo right after unhides the item and selects it again, with Details', async () => {
    const transport = await mount();
    await select(transport, '3');
    pressH('3');
    await hidden(transport, '3');
    expect(saved(transport).selected_item_id).toBe('4');
    act(() => toasts.runUndo(toasts.current()!.id));
    await waitFor(() => expect(saved(transport).hidden_item_ids ?? []).toEqual([])); await ready();
    expect(saved(transport).selected_item_id).toBe('3');
    await waitFor(() => expect(detailOf()).toBe('3'));
    expect(selectedRows()).toEqual(['3']);
  });

  it('row 12: Undo after the owner selected something else unhides and leaves that selection', async () => {
    const transport = await mount();
    await select(transport, '3');
    pressH('3');
    await hidden(transport, '3');
    const toast = toasts.current()!;
    await select(transport, '6');
    act(() => toasts.runUndo(toast.id));
    await waitFor(() => expect(saved(transport).hidden_item_ids ?? []).toEqual([])); await ready();
    expect(saved(transport).selected_item_id).toBe('6');
    expect(detailOf()).toBe('6');
  });

  it('row 12: moving away and back again before Undo still counts as a newer choice', async () => {
    const transport = await mount();
    await select(transport, '3');
    pressH('3');
    await hidden(transport, '3');
    const toast = toasts.current()!;
    await select(transport, '6'); await select(transport, '4');
    act(() => toasts.runUndo(toast.id));
    await waitFor(() => expect(saved(transport).hidden_item_ids ?? []).toEqual([])); await ready();
    expect(saved(transport).selected_item_id).toBe('4');
  });

  it('row 14: Unhide on a selected hidden row keeps it selected', async () => {
    const transport = await mount(transport => { saved(transport).hidden_item_ids = ['4']; saved(transport).selected_item_id = '4'; });
    await waitFor(() => expect(row('4')).not.toBeNull());
    pressH('4');
    await waitFor(() => expect(saved(transport).hidden_item_ids ?? []).toEqual([])); await ready();
    expect(saved(transport).selected_item_id).toBe('4');
  });

  it('row 15: h keeps the focus ring on the new row, as Enter and . do', async () => {
    const transport = await mount();
    const tree = screen.getByRole('region', { name: 'Session tree' });
    row('3')!.focus(); fireEvent.keyDown(row('3')!, { key: 'Enter' });
    await waitFor(() => expect(saved(transport).selected_item_id).toBe('3')); await ready();
    expect(tree.hasAttribute('data-kbd')).toBe(true);
    fireEvent.keyDown(row('3')!, { key: '.' });
    await ready();
    expect(tree.hasAttribute('data-kbd')).toBe(true);
    fireEvent.keyDown(row('3')!, { key: 'h' });
    await hidden(transport, '3');
    expect(saved(transport).selected_item_id).toBe('4');
    expect(document.activeElement).toBe(row('4'));
    expect(tree.hasAttribute('data-kbd')).toBe(true);
    // A pointer choice clears the ring, as before.
    fireEvent.mouseDown(row('6')!); fireEvent.click(row('6')!);
    await waitFor(() => expect(saved(transport).selected_item_id).toBe('6'));
    expect(tree.hasAttribute('data-kbd')).toBe(false);
  });

  it('row 23: hiding the focused root ends Focus in the same write and selects the next root', async () => {
    const transport = await mount(transport => { saved(transport).focused_item_id = '3'; saved(transport).selected_item_id = '3'; });
    await waitFor(() => expect(selectedRows()).toEqual(['3']));
    pressH('3');
    await hidden(transport, '3');
    expect(saved(transport).focused_item_id).toBeUndefined();
    expect(saved(transport).selected_item_id).toBe('4');
    expect(hideWrites(transport, '3')).toHaveLength(1);
    // Focus ended in that write: no second write ends it again.
    expect(transport.mutations.filter(request => request.command.command === 'preferences_patch')).toHaveLength(1);
    expect(row('8')).not.toBeNull();
  });

  it('row 24: h with focus on another row hides the selected item by the rule and leaves focus where it is', async () => {
    const transport = await mount();
    await select(transport, '4');
    row('2')!.focus(); fireEvent.keyDown(row('2')!, { key: 'h' });
    await hidden(transport, '4');
    expect(saved(transport).selected_item_id).toBe('5');
    expect(document.activeElement).toBe(row('2'));
  });

  it('row 26: the bigger view’s Hide of its own item follows the rule there and leaves the Map selection', async () => {
    const transport = await mount(transport => { saved(transport).selected_item_id = '4'; });
    fireEvent.click(await screen.findByRole('button', { name: 'Read in a bigger view' }));
    const dock = screen.getByRole('region', { name: 'Answer dock' });
    fireEvent.click(within(dock).getByRole('button', { name: /^\d+ (more )?waiting$/ }));
    // The dock steps to item 2's question; its title opens it in the bigger view, as the Waiting card did.
    const question = transport.sessions.get(route.session_id)!.items['2']!.question;
    const open = () => within(dock).queryByRole('button', { name: `Open ${question}` });
    await waitFor(() => expect(within(dock).getByRole('button', { name: 'Next question' })).toBeTruthy());
    while (!open() && !within(dock).getByRole<HTMLButtonElement>('button', { name: 'Next question' }).disabled) {
      fireEvent.click(within(dock).getByRole('button', { name: 'Next question' }));
    }
    fireEvent.click(open()!);
    const bigger = () => screen.getByRole('region', { name: 'Item conversation' });
    await waitFor(() => expect(bigger().querySelector('[data-detail-item-id]')?.getAttribute('data-detail-item-id')).toBe('2'));
    fireEvent.click(within(bigger()).getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }));
    // The bigger view covers the Map (its region is hidden from the accessibility tree meanwhile).
    await waitFor(() => expect(saved(transport).hidden_item_ids ?? []).toContain('2'));
    await waitFor(() => expect(bigger().querySelector('[data-detail-item-id]')?.getAttribute('data-detail-item-id')).toBe('3'));
    expect(saved(transport).selected_item_id).toBe('4');
  });
});

describe('a hide that is not saved moves nothing', () => {
  it('row 25: refused while another write is in flight: nothing is hidden and nothing moves', async () => {
    const transport = await mount();
    await select(transport, '3');
    transport.hold();
    fireEvent.click(screen.getByRole('button', { name: /^Filter by status/ }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Filter items' })).getByRole('button', { name: /^Open \d+$/ }));
    await waitFor(() => expect(transport.held).toBe(1));
    pressH('3');
    expect(selectedRows()).toEqual(['3']); expect(detailOf()).toBe('3');
    await act(async () => { transport.release(); });
    await ready();
    expect(saved(transport).hidden_item_ids ?? []).toEqual([]);
    expect(saved(transport).selected_item_id).toBe('3');
  });

  it('row 13 / 25: a rejected save leaves the item, the selection and Details as they were', async () => {
    const transport = await mount();
    await select(transport, '3');
    transport.reject = true;
    pressH('3');
    await screen.findByText('The hidden items preference could not be saved. Try again.');
    await ready();
    expect(saved(transport).hidden_item_ids ?? []).toEqual([]);
    expect(saved(transport).selected_item_id).toBe('3');
    expect(selectedRows()).toEqual(['3']); expect(detailOf()).toBe('3');
    expect(row('3')).not.toBeNull();
    expect(toasts.current()?.text ?? '').not.toMatch(/^Hid /);
  });

  it('S2: a lost answer moves nothing until Try again confirms the write, then the move shows', async () => {
    const transport = await mount();
    await select(transport, '3');
    transport.failNext = 'preferences_patch';
    pressH('3');
    const line = await screen.findByRole('status', { name: 'Connection' });
    expect(selectedRows()).toEqual(['3']); expect(detailOf()).toBe('3'); expect(row('3')).not.toBeNull();
    await act(async () => { fireEvent.click(within(line).getByRole('button', { name: 'Try again' })); });
    await hidden(transport, '3');
    expect(saved(transport).selected_item_id).toBe('4');
    await waitFor(() => expect(selectedRows()).toEqual(['4']));
    await waitFor(() => expect(detailOf()).toBe('4'));
  });

  it('S3: a selection the owner makes while the hide is in flight wins', async () => {
    const transport = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }));
    await waitFor(() => expect(node('3')).not.toBeNull());
    fireEvent.click(node('3')!);
    await waitFor(() => expect(saved(transport).selected_item_id).toBe('3')); await ready();
    transport.hold();
    node('3')!.focus(); fireEvent.keyDown(node('3')!, { key: 'h' });
    await waitFor(() => expect(transport.held).toBe(1));
    fireEvent.click(node('6')!);
    await waitFor(() => expect(node('6')!.getAttribute('aria-selected')).toBe('true'));
    await act(async () => { transport.release(); });
    await hidden(transport, '3');
    await waitFor(() => expect(saved(transport).selected_item_id).toBe('6'));
    expect(node('6')!.getAttribute('aria-selected')).toBe('true');
  });
});
