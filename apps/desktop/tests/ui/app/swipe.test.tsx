// A two-finger swipe takes the same history as Command+[ and Command+] (alpha.24 P2): the same selections, the same guards.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { AppTransport, route } from './transport';
import { goToSession } from './open';
import { useWideWindow } from '../shell/wideWindow';
useWideWindow();

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function click(element: Element) {
  await act(async () => { fireEvent.click(element); });
  // A reference in the detail opens its peek first; "Go to" follows it.
  if (element.classList.contains('name-chip')) await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Go to' })); });
}
async function keyDown(element: Element, key: string, metaKey = false) { await act(async () => { fireEvent.keyDown(element, { key, metaKey }); }); }
/** A two-finger swipe: wheel events, `deltaX` each, until well past the threshold; then the fingers rest for longer than the gap. */
async function swipe(target: Element, deltaX: number) {
  await act(async () => { for (let index = 0; index < 14; index++) fireEvent.wheel(target, { deltaX, deltaY: 0 }); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
}
function selected(id: string) {
  screen.getByLabelText(/^Detail of /, { selector: `[data-detail-item-id="${id}"]` });
  expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-busy')).toBe('false');
}
async function openSession() {
  await act(async () => { render(<DesktopApp service={createDesktopService(new AppTransport())} />); });
  await goToSession(route, click);
  screen.getByLabelText('Session tree', { selector: 'section' });
}
const pick = async (id: string) => { await click(document.querySelector(`[role="treeitem"][data-item-id="${id}"]`)!); selected(id); };
/** Item 1, then its child 1.1: Back has an entry, Forward has none. */
async function twoSteps() {
  await openSession(); await pick('1');
  await click(within(screen.getByLabelText('Item detail')).getByRole('button', { name: /^Branched into Add the receipt lookup/ })); selected('1.1');
}

describe('two-finger swipe in the app', () => {
  it('a swipe right goes back and a swipe left goes forward, to the items Command+[ and Command+] reach', async () => {
    await twoSteps();
    await swipe(document.body, -10); selected('1');
    await swipe(document.body, 10); selected('1.1');
    // The keys land on the same items.
    await keyDown(document.body, '[', true); selected('1');
    await keyDown(document.body, ']', true); selected('1.1');
  });

  it('shows the arrow only where there is an entry', async () => {
    await twoSteps();
    // At the newest entry there is no Forward: a swipe left draws nothing and changes nothing.
    await act(async () => { for (let index = 0; index < 5; index++) fireEvent.wheel(document.body, { deltaX: 10, deltaY: 0 }); });
    expect(screen.queryByTestId('swipe-arrow')).toBeNull();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    await act(async () => { for (let index = 0; index < 5; index++) fireEvent.wheel(document.body, { deltaX: -10, deltaY: 0 }); });
    expect(screen.getByTestId('swipe-arrow').getAttribute('data-side')).toBe('left');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    expect(screen.queryByTestId('swipe-arrow')).toBeNull();
    selected('1.1');
  });

  it('offers no arrow where Back refuses: over the bigger conversation view, with history behind it', async () => {
    await twoSteps();
    await click(screen.getByRole('button', { name: 'Read in a bigger view' }));
    screen.getByRole('region', { name: 'Item conversation' });
    await act(async () => { for (let index = 0; index < 5; index++) fireEvent.wheel(document.body, { deltaX: -10, deltaY: 0 }); });
    expect(screen.queryByTestId('swipe-arrow')).toBeNull();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    await swipe(document.body, -10);
    expect(screen.queryByTestId('swipe-arrow')).toBeNull();
    // Neither the swipe nor the key went back: the conversation is still open.
    await keyDown(document.body, '[', true);
    screen.getByRole('region', { name: 'Item conversation' });
  });

  it('does nothing while the owner is typing in the Map search, like the keys', async () => {
    await twoSteps();
    await click(screen.getByLabelText('Search the Map', { selector: 'button' }));
    const box = screen.getByLabelText<HTMLInputElement>('Search the Map', { selector: 'input' });
    box.focus();
    await swipe(box, -10);
    selected('1.1');
  });
});
