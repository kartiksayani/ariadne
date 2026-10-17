import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ChangeMarker } from '../../../src/ui/changes/ChangeMarker';
import { ChangesOpener } from '../../../src/ui/changes/ChangesOpener';
import { NavigationStore, useNavigation } from '../../../src/state/navigation/store';
import { useReadingSeen } from '../../../src/state/preferences/reading';
import { createDesktopService } from '../../../src/data/service';
import { AppTransport, route } from '../app/transport';
import { changesFixture } from './fixture';

const stores: NavigationStore[] = [];
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

async function setup(updated = 2, replaced = 1, added = 1) {
  vi.useFakeTimers(); vi.setSystemTime('2026-10-10T02:00:00Z');
  const value = changesFixture(updated, replaced, added), transport = new AppTransport();
  transport.sessions.set(value.session.id, value.session); transport.preferences.seen = [value.seen];
  transport.preferences.global.selected_navigation = { kind: 'session', session: route };
  const navigation = new NavigationStore(createDesktopService(transport)); stores.push(navigation);
  await navigation.start(); await navigation.opened.open(route).refresh();
  const onOpenItem = vi.fn();
  function Harness() {
    const nav = useNavigation(navigation), seen = useReadingSeen(navigation.reading, nav.preferences, route);
    return <div className="product-app"><ChangesOpener session={value.session} topicId={value.topic.id} seen={seen} navigation={navigation} onOpenItem={onOpenItem} /></div>;
  }
  render(<Harness />);
  return { ...value, transport, navigation, onOpenItem };
}

describe('ChangesOpener', () => {
  it('renders nothing when nothing is unseen', async () => {
    const value = await setup(0, 0, 0);
    expect(value.navigation.getSnapshot().preferences).not.toBeNull();
    expect(document.querySelector('.changes-opener')).toBeNull();
  });
  it('counts what is new and what changed, with the time of the last look', async () => {
    await setup();
    const opener = screen.getByRole('button', { name: /1 new.*3 changed/ });
    expect(opener.getAttribute('aria-expanded')).toBe('false');
    expect(opener.textContent).toMatch(/since \d\d:\d\d/);
  });
  it('opens a popover with the since-you-were-here rows, labelled and marked', async () => {
    const value = await setup();
    fireEvent.click(screen.getByRole('button', { name: /1 new/ }));
    const popover = screen.getByRole('dialog', { name: 'What changed' });
    expect(popover.closest('.product-app')).not.toBeNull();
    const rows = within(popover).getAllByRole('listitem').filter(row => row.classList.contains('changes-row'));
    expect(rows).toHaveLength(4);
    expect(within(popover).getAllByTestId('change-marker').map(marker => marker.getAttribute('data-kind')).sort()).toEqual(['changed', 'changed', 'changed', 'new']);
    expect(within(popover).getByText('New name A').closest('li')!.textContent).toContain('New');
    fireEvent.click(within(popover).getByRole('button', { name: 'Updated name A' }));
    expect(value.onOpenItem).toHaveBeenCalledWith('updated-0');
    expect(screen.queryByRole('dialog', { name: 'What changed' })).toBeNull();
  });
  it('closes on Escape and on a press outside, and returns focus to the opener on Escape', async () => {
    await setup();
    const opener = screen.getByRole('button', { name: /1 new/ });
    fireEvent.click(opener);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'What changed' })).toBeNull();
    expect(document.activeElement).toBe(opener);
    fireEvent.click(opener);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog', { name: 'What changed' })).toBeNull();
  });
  it('clears a marker only through a row’s own button, not by opening, and shows Seen', async () => {
    const value = await setup();
    fireEvent.click(screen.getByRole('button', { name: /1 new/ }));
    expect(value.navigation.reading.getSnapshot()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Mark Updated name A seen' }));
    expect(value.navigation.reading.getSnapshot().some(patch => patch.items.some(item => item.item_id === 'updated-0'))).toBe(true);
    expect(screen.getByRole('button', { name: 'Updated name A is seen' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: /1 new.*2 changed/ })).toBeTruthy();
  });
  it('marks everything caught up with an 8 second Undo that restores the markers', async () => {
    const value = await setup();
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
