import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { stopDetailScroll } from '../../../src/ui/shell/detailScroll';
import { AppTransport, route } from './transport';
import { goToSession } from './open';
import { answerWords } from '../answer/words';
import { closeDetails } from '../shell/closeDetails';

beforeEach(() => { localStorage.clear(); });
afterEach(() => { stopDetailScroll(); cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

const row = (id = '2') => document.querySelector<HTMLElement>(`[role="treeitem"][data-item-id="${id}"]`)!;
const detail = () => screen.getByLabelText(/^Detail of /, { selector: '[data-detail-item-id="2"]' });
const down = (target: Element | Window, name: 'ArrowUp' | 'ArrowDown', extra = {}) => fireEvent.keyDown(target, { key: name, code: name, altKey: true, ...extra });
const up = (name: 'ArrowUp' | 'ArrowDown') => fireEvent.keyUp(document.body, { key: name, code: name });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** The position a scroller comes to rest at: unchanged across 150 ms. */
async function settled(element: HTMLElement) {
  for (let tries = 0; tries < 40; tries++) {
    const before = element.scrollTop;
    await pause(150);
    if (element.scrollTop === before) return before;
  }
  throw new Error('the scroll never came to rest');
}
/** jsdom has no layout: give a scroller a visible height and a long content. */
function sized(element: HTMLElement) {
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: 400 });
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 4000 });
  return element;
}
const selected = (transport: AppTransport) => transport.preferences.sessions.find(view => view.session.session_id === route.session_id)?.selected_item_id;

async function open() {
  const transport = new AppTransport();
  render(<DesktopApp service={createDesktopService(transport)} />);
  await goToSession(route);
  await screen.findByRole('region', { name: 'Session tree' });
  await waitFor(() => expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready'));
  fireEvent.click(row());
  await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="2"]' });
  await waitFor(() => expect(selected(transport)).toBe('2'));
  const scroller = screen.getByTestId('map-scroll');
  scroller.scrollTop = 80;
  return { transport, scroller, body: sized(within(detail()).getByTestId('detail-body')) };
}

describe('⌥↑ / ⌥↓ scroll Details', () => {
  it('scrolls Details with the Map row focused, and never the Map or its selection', async () => {
    const { transport, scroller, body } = await open();
    row().focus(); down(row(), 'ArrowDown'); up('ArrowDown');
    await waitFor(() => expect(body.scrollTop).toBeGreaterThan(5));
    const after = await settled(body);
    // A tap moves less than a tenth of the panel's 400 px.
    expect(after).toBeLessThanOrEqual(40);
    down(row(), 'ArrowUp'); up('ArrowUp');
    await waitFor(() => expect(body.scrollTop).toBeLessThan(after));
    expect(scroller.scrollTop).toBe(80);
    expect(selected(transport)).toBe('2');
    expect(document.activeElement).toBe(row());
  });

  it('keeps scrolling while held, ignores the OS key-repeat, and stops on key up', async () => {
    const { body } = await open();
    row().focus(); down(row(), 'ArrowDown');
    await waitFor(() => expect(body.scrollTop).toBeGreaterThan(20));
    const repeat = new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, repeat: true, bubbles: true, cancelable: true });
    row().dispatchEvent(repeat);
    expect(repeat.defaultPrevented).toBe(true);
    const mid = body.scrollTop;
    await pause(300);
    expect(body.scrollTop).toBeGreaterThan(mid + 10);
    up('ArrowDown');
    const rest = await settled(body);
    await pause(200);
    expect(body.scrollTop).toBe(rest);
  });

  it('leaves ⌥↑ / ⌥↓ to a text field', async () => {
    const { body } = await open();
    const words = answerWords(detail());
    words.focus(); down(words, 'ArrowDown'); down(words, 'ArrowUp');
    await pause(150);
    expect(body.scrollTop).toBe(0);
  });

  it('leaves ⌥↑ / ⌥↓ to an open menu', async () => {
    const { body } = await open();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const menu = await screen.findByRole('menu');
    down(menu, 'ArrowDown');
    await pause(150);
    expect(body.scrollTop).toBe(0);
  });

  it('scrolls the bigger view\'s body, not the Details column behind it', async () => {
    const { transport, scroller } = await open();
    const expand = screen.getByRole('button', { name: 'Read in a bigger view' });
    expand.focus(); fireEvent.click(expand);
    const view = await screen.findByRole('region', { name: 'Item conversation' });
    const body = sized(within(view).getByTestId('detail-body'));
    down(view, 'ArrowDown'); up('ArrowDown');
    await waitFor(() => expect(body.scrollTop).toBeGreaterThan(5));
    expect(scroller.scrollTop).toBe(80);
    expect(selected(transport)).toBe('2');
  });

  it('stops when Details is folded mid-hold, and unfolding shows the position at the fold', async () => {
    const { body } = await open();
    row().focus(); down(row(), 'ArrowDown');
    await waitFor(() => expect(body.scrollTop).toBeGreaterThan(20));
    fireEvent.click(screen.getByRole('button', { name: 'Fold Details' }));
    await screen.findByRole('button', { name: 'Show Details' });
    const atFold = body.scrollTop;
    // The key is still down and the body is still mounted at full size, but it is out of reach: it must stay put.
    await pause(400);
    expect(body.scrollTop).toBe(atFold);
    up('ArrowDown');
    fireEvent.click(screen.getByRole('button', { name: 'Show Details' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Show Details' })).toBeNull());
    expect(within(detail()).getByTestId('detail-body').scrollTop).toBe(atFold);
  });

  it('does nothing, and does not fail, when Details is closed', async () => {
    const { transport, scroller } = await open();
    closeDetails();
    await waitFor(() => expect(screen.queryByTestId('detail-body')).toBeNull());
    row().focus();
    expect(() => { down(row(), 'ArrowDown'); up('ArrowDown'); }).not.toThrow();
    await pause(100);
    expect(scroller.scrollTop).toBe(80);
    expect(selected(transport)).toBe('2');
  });
});

// WebKit's own ⌥↓ pages the focused scroller, so a press the workspace accepts is consumed whether or not it scrolls: a held key
// whose scroll has ended, or never began, must not page the Map under the OS key-repeat.
describe('⌥↑ / ⌥↓ are always consumed by the workspace', () => {
  /** Dispatches a real keydown on `target` and says whether the workspace consumed it. */
  const consumed = (target: Element, name: 'ArrowUp' | 'ArrowDown', repeat: boolean) => {
    const event = new KeyboardEvent('keydown', { key: name, code: name, altKey: true, repeat, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it('consumes the repeats of a hold whose scroll reached the end, and neither scroller moves', async () => {
    const { scroller, body } = await open();
    body.scrollTop = 3600;
    row().focus(); expect(consumed(row(), 'ArrowDown', false)).toBe(true);
    await pause(100);
    expect(body.scrollTop).toBe(3600);
    for (let count = 0; count < 5; count++) expect(consumed(row(), 'ArrowDown', true)).toBe(true);
    expect(scroller.scrollTop).toBe(80);
    expect(body.scrollTop).toBe(3600);
    up('ArrowDown');
    // The same at the top, with ⌥↑.
    body.scrollTop = 0;
    expect(consumed(row(), 'ArrowUp', false)).toBe(true);
    await pause(100);
    expect(consumed(row(), 'ArrowUp', true)).toBe(true);
    expect(scroller.scrollTop).toBe(80);
  });

  it('consumes the presses and repeats when Details is closed', async () => {
    const { scroller } = await open();
    closeDetails();
    await waitFor(() => expect(screen.queryByTestId('detail-body')).toBeNull());
    row().focus();
    expect(consumed(row(), 'ArrowDown', false)).toBe(true);
    expect(consumed(row(), 'ArrowDown', true)).toBe(true);
    expect(consumed(row(), 'ArrowUp', true)).toBe(true);
    expect(scroller.scrollTop).toBe(80);
  });

  it('consumes the presses and repeats when Details is folded', async () => {
    const { scroller } = await open();
    fireEvent.click(screen.getByRole('button', { name: 'Fold Details' }));
    await screen.findByRole('button', { name: 'Show Details' });
    row().focus();
    expect(consumed(row(), 'ArrowDown', false)).toBe(true);
    expect(consumed(row(), 'ArrowDown', true)).toBe(true);
    expect(consumed(row(), 'ArrowUp', true)).toBe(true);
    expect(scroller.scrollTop).toBe(80);
  });

  it('consumes the repeats of a held key with reduced motion, which steps once and never creeps', async () => {
    const { scroller, body } = await open();
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query }));
    row().focus(); expect(consumed(row(), 'ArrowDown', false)).toBe(true);
    const stepped = body.scrollTop;
    expect(stepped).toBe(36);
    for (let count = 0; count < 5; count++) expect(consumed(row(), 'ArrowDown', true)).toBe(true);
    await pause(100);
    expect(body.scrollTop).toBe(stepped);
    expect(scroller.scrollTop).toBe(80);
  });

  it('consumes the repeats after the owner wheel-scrolled Details away from a hold', async () => {
    const { scroller, body } = await open();
    row().focus(); expect(consumed(row(), 'ArrowDown', false)).toBe(true);
    await waitFor(() => expect(body.scrollTop).toBeGreaterThan(5));
    // The wheel moves it somewhere else: the hold gives up, the repeats still must not page the Map.
    body.scrollTop += 200;
    await pause(100);
    const away = body.scrollTop;
    for (let count = 0; count < 5; count++) expect(consumed(row(), 'ArrowDown', true)).toBe(true);
    await pause(100);
    expect(body.scrollTop).toBe(away);
    expect(scroller.scrollTop).toBe(80);
  });

  it('still leaves a text field and an open menu their ⌥↑ / ⌥↓', async () => {
    await open();
    const words = answerWords(detail());
    words.focus();
    expect(consumed(words, 'ArrowDown', false)).toBe(false);
    expect(consumed(words, 'ArrowDown', true)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const menu = await screen.findByRole('menu');
    expect(consumed(menu, 'ArrowDown', false)).toBe(false);
    expect(consumed(menu, 'ArrowDown', true)).toBe(false);
  });
});
