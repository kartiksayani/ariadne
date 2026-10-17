import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ChangeMarker } from '../../../src/ui/changes/ChangeMarker';
import { route } from '../app/transport';
import { setupChanges, stores } from './harness';

afterEach(() => { cleanup(); stores.splice(0).forEach(store => store.stop()); vi.useRealTimers(); localStorage.clear(); });

describe('ChangeMarker', () => {
  it.each([
    ['new', 'pill', 'New', 'New: you haven’t seen this item yet'],
    ['changed', 'pill', 'Changed', 'Changed since you last saw it'],
    ['new', 'diamond', 'New', 'New'],
    ['changed', 'diamond', 'Changed', 'Changed'],
  ] as const)('draws %s as a %s with its name and title', (kind, form, name, title) => {
    render(<ChangeMarker kind={kind} form={form} />);
    const marker = screen.getByTestId('change-marker');
    expect(marker.getAttribute('role')).toBe('img');
    expect(marker.getAttribute('aria-label')).toBe(name);
    expect(marker.getAttribute('title')).toBe(title);
    expect(marker.getAttribute('data-kind')).toBe(kind);
    expect(marker.getAttribute('data-form')).toBe(form);
    expect(marker.textContent).toBe(form === 'pill' ? name : '');
  });
  it('is a pill unless asked for the diamond alone', () => {
    render(<ChangeMarker kind="new" />);
    expect(screen.getByTestId('change-marker').getAttribute('data-form')).toBe('pill');
  });
});

describe('ChangesOpener', () => {
  it('renders nothing when nothing is unseen', async () => {
    await setupChanges(0, 0, 0);
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('counts what is new and what changed, with the time of the last look', async () => {
    await setupChanges(2, 1, 1);
    const opener = screen.getByRole('button', { name: /1 new.*3 changed/ });
    expect(opener.getAttribute('aria-expanded')).toBe('false');
    expect(opener.textContent).toMatch(/since \d\d:\d\d/);
  });
  it('opens a popover with the since-you-were-here rows, labelled and marked', async () => {
    const value = await setupChanges(2, 1, 1);
    fireEvent.click(screen.getByRole('button', { name: /1 new/ }));
    const popover = screen.getByRole('dialog', { name: 'What changed' });
    expect(popover.closest('.product-app')).not.toBeNull();
    const rows = within(popover).getAllByTestId('changes-row');
    expect(rows).toHaveLength(4);
    expect(within(popover).getAllByTestId('change-marker').map(marker => marker.getAttribute('data-kind')).sort()).toEqual(['changed', 'changed', 'changed', 'new']);
    expect(within(popover).getByText('New name A').closest('li')!.textContent).toContain('New');
    expect(within(popover).getByText(/Open → Replaced|Replaced by/)).toBeTruthy();
    fireEvent.click(within(popover).getByRole('button', { name: 'Updated name A' }));
    expect(value.onOpenItem).toHaveBeenCalledWith('updated-0');
    expect(screen.queryByRole('dialog', { name: 'What changed' })).toBeNull();
  });
  it('closes on Escape and on a press outside, and returns focus to the opener on Escape', async () => {
    await setupChanges(2, 1, 1);
    const opener = screen.getByRole('button', { name: /1 new/ });
    fireEvent.click(opener);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'What changed' })).toBeNull();
    expect(document.activeElement).toBe(opener);
    fireEvent.click(opener);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog', { name: 'What changed' })).toBeNull();
  });
  it('closes when the Map scrolls but not when its own list does', async () => {
    await setupChanges(2, 1, 1);
    fireEvent.click(screen.getByRole('button', { name: /1 new/ }));
    fireEvent.scroll(screen.getByRole('dialog', { name: 'What changed' }).querySelector('.changes-body')!);
    expect(screen.getByRole('dialog', { name: 'What changed' })).toBeTruthy();
    fireEvent.scroll(document.body.firstElementChild!);
    expect(screen.queryByRole('dialog', { name: 'What changed' })).toBeNull();
  });
  it('clears a marker only through a row’s own button, not by opening, and shows Seen', async () => {
    const value = await setupChanges(2, 1, 1);
    fireEvent.click(screen.getByRole('button', { name: /1 new/ }));
    expect(value.navigation.reading.getSnapshot()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Mark Updated name A seen' }));
    expect(value.navigation.reading.getSnapshot().some(patch => patch.items.some(item => item.item_id === 'updated-0'))).toBe(true);
    expect(screen.getByRole('button', { name: 'Updated name A is seen' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: /1 new.*2 changed/ })).toBeTruthy();
  });
  it('marks everything caught up with an 8 second Undo that restores the markers', async () => {
    const value = await setupChanges(2, 1, 1);
    fireEvent.click(screen.getByRole('button', { name: /1 new/ }));
    fireEvent.click(screen.getByRole('button', { name: /Mark all caught up/ }));
    expect(screen.getByText(/All caught up\. The markers are cleared; nothing was acked or changed\./)).toBeTruthy();
    expect(value.transport.preferences.seen![0].items).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(7900); });
    expect(value.navigation.reading.undoToken(route, value.topic.id)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '↺ Undo' }));
    expect(screen.getByRole('button', { name: 'Updated name A' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Mark all caught up/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(7900); });
    expect(value.transport.preferences.seen![0].items).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(value.transport.preferences.seen![0].items.length).toBeGreaterThan(0);
  });
});
