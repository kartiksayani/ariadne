// The Map never moves on its own, and the dock never opens by itself: over every trigger that changes what the dock
// holds or how tall it is, the Map's scroll position, its selection and the focus stay exactly where they were.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { notices } from '../../../src/ui/pages/notices';
import type { Session } from '../../../src/generated/domain/models';
import { AppTransport, route, secondId } from '../app/transport';
import { goToSession } from '../app/open';

afterEach(() => { cleanup(); notices.clear(); vi.restoreAllMocks(); localStorage.clear(); });

const changed = (transport: AppTransport, session: Session) => {
  session.revision++;
  act(() => { transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision }); });
};

async function mount() {
  const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
  transport.preferences.global.selected_navigation = { kind: 'session', session: route };
  Object.assign(transport.preferences.sessions[0]!, { tab_open: true, selected_item_id: '3' });
  transport.preferences.sessions.push({ ...transport.view(secondId), tab_open: true, tab_order: 1, selected_item_id: null });
  render(<DesktopApp service={createDesktopService(transport)} />);
  const tree = await screen.findByRole('tree', { name: 'Session items' });
  await waitFor(() => expect(tree.getAttribute('aria-busy')).toBe('false'));
  const dock = await screen.findByRole('region', { name: 'Answer dock' });
  await within(dock).findByRole('button', { name: /^1 waiting$/ });
  const scroller = tree.closest<HTMLElement>('.tree-scroll')!;
  const row = tree.querySelector<HTMLElement>('[data-item-id="4"]')!;
  scroller.scrollTop = 120; row.focus();
  const views = () => transport.mutations.filter(request => request.command.command === 'preferences_patch'
    && request.command.params.entries.some(entry => entry.kind === 'set_session_view')).length;
  const snapshot = () => ({
    scroll: scroller.scrollTop,
    selected: [...tree.querySelectorAll('[aria-selected="true"]')].map(element => element.getAttribute('data-item-id')),
    focus: document.activeElement, views: views(),
  });
  return { transport, session, tree, scroller, row, dock: () => screen.getByRole('region', { name: 'Answer dock' }), snapshot };
}

const triggers = ['question arriving', 'answered elsewhere', 'dock resized by drag', 'dock resized by keys', 'dock folded'] as const;

describe('the Map never moves and the dock never opens by itself', () => {
  it.each(triggers.flatMap(trigger => (['folded', 'open'] as const).map(dock => [trigger, dock] as const)))('%s with the dock %s', async (trigger, start) => {
    const value = await mount();
    if (start === 'open') {
      fireEvent.click(within(value.dock()).getByRole('button', { name: /^1 waiting$/ }));
      await within(value.dock()).findByRole('button', { name: 'Fold the dock' });
      value.row.focus();
    }
    const before = value.snapshot();
    if (trigger === 'question arriving') {
      Object.assign(value.session.items['8']!, { status: 'waiting_on_me', waiting_since: '2026-10-03T12:30:00.000Z' });
      changed(value.transport, value.session);
      if (start === 'folded') await within(value.dock()).findByRole('button', { name: /^2 waiting$/ });
      else await within(value.dock()).findByText('1 of 2');
    } else if (trigger === 'answered elsewhere') {
      const input = structuredClone(value.session.inputs['00000000-0000-4000-8000-000000000076']!);
      Object.assign(input, { id: '00000000-0000-4000-8000-000000000099', seq: 99, kind: 'answer', answer_id: null,
        target: { topic_id: value.session.items['2']!.topic_id, item_id: '2' } });
      input.payload = { ...input.payload, text: 'Answered from another place', selected_option_id: null,
        target_snapshot: { ...input.payload.target_snapshot, item_question: value.session.items['2']!.question, question_revision: 1 } };
      value.session.inputs[input.id] = input;
      changed(value.transport, value.session);
      await within(value.dock()).findByText('Nothing waiting on you');
    } else if (trigger === 'dock folded') {
      if (start === 'open') fireEvent.click(within(value.dock()).getByRole('button', { name: 'Fold the dock' }));
      await within(value.dock()).findByRole('button', { name: /^1 waiting$/ });
    } else {
      const grip = within(value.dock()).getByRole('separator', { name: 'Resize answer dock' });
      if (trigger === 'dock resized by drag') {
        fireEvent.pointerDown(grip, { button: 0, clientY: 700, pointerId: 1 });
        fireEvent.pointerMove(grip, { clientY: 300, pointerId: 1 });
        fireEvent.pointerUp(grip, { clientY: 300, pointerId: 1 });
      } else { fireEvent.keyDown(grip, { key: 'ArrowUp' }); value.row.focus(); }
      // Resizing is an owner action on the dock: it opens it, and nothing else.
      await within(value.dock()).findByRole('button', { name: 'Fold the dock' });
    }
    const after = value.snapshot();
    expect(after.scroll).toBe(before.scroll);
    expect(after.selected).toEqual(before.selected);
    expect(after.selected).toEqual(['3']);
    expect(after.views).toBe(before.views);
    if (!trigger.startsWith('dock resized by drag')) expect(after.focus).toBe(before.focus);
    const open = !!value.dock().getAttribute('data-open');
    // Only the owner opens the dock: a change in what it holds never does.
    if (trigger === 'question arriving') expect(open).toBe(start === 'open');
    if (trigger === 'answered elsewhere') expect(open).toBe(false);
    if (trigger === 'dock folded') expect(open).toBe(false);
  });

  it.each(['folded', 'open'] as const)('a session switch leaves the dock folded and the next Map as it was saved (dock %s)', async start => {
    const value = await mount();
    if (start === 'open') fireEvent.click(within(value.dock()).getByRole('button', { name: /^1 waiting$/ }));
    await goToSession({ ...route, session_id: secondId });
    await waitFor(() => expect(value.dock().textContent).toContain('Nothing waiting on you'));
    expect(value.dock().getAttribute('data-open')).toBeNull();
    expect(document.querySelectorAll('[role="tree"] [aria-selected="true"]')).toHaveLength(0);
    // Back again: the first session's dock is folded too, and its selection is the saved one.
    await goToSession(route);
    await waitFor(() => within(value.dock()).getByRole('button', { name: /^1 waiting$/ }));
    expect(value.dock().getAttribute('data-open')).toBeNull();
    await waitFor(() => expect([...document.querySelectorAll('[role="tree"] [aria-selected="true"]')].map(element => element.getAttribute('data-item-id'))).toEqual(['3']));
    expect(value.transport.mutations.filter(request => request.command.command === 'preferences_patch'
      && request.command.params.entries.some(entry => entry.kind === 'set_session_view' && entry.preferences.selected_item_id !== null
        && entry.preferences.selected_item_id !== '3')).length).toBe(0);
  });

  // The dock's provider sits above Shell, so Body (and through it the Tree and the Graph) reads the dock's real height:
  // rows under the dock never count as visible. Wrapping only the dock slot would leave them all at 0.
  it('hands the dock height to the Map viewport, folded and open, without moving the Map', async () => {
    const value = await mount();
    const viewport = value.tree.closest<HTMLElement>('.shell-body-viewport')!;
    expect(viewport.style.getPropertyValue('--dock-inset')).toBe('40px');
    const rect = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return this.matches('.answer-dock[data-open]') ? new DOMRect(0, 400, 1280, 300) : rect.call(this);
    });
    const before = value.snapshot();
    fireEvent.click(within(value.dock()).getByRole('button', { name: /^1 waiting$/ }));
    await waitFor(() => expect(viewport.style.getPropertyValue('--dock-inset')).toBe('300px'));
    value.row.focus();
    expect(value.snapshot()).toEqual({ ...before, focus: value.row });
    fireEvent.click(within(value.dock()).getByRole('button', { name: 'Fold the dock' }));
    await waitFor(() => expect(viewport.style.getPropertyValue('--dock-inset')).toBe('40px'));
    expect(value.scroller.scrollTop).toBe(before.scroll);
  });
});
