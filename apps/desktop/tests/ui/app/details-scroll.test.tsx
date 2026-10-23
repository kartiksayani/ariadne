import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { stopDetailScroll } from '../../../src/ui/shell/detailScroll';
import { AppTransport, route } from './transport';
import { goToSession } from './open';
import { answerWords } from '../answer/words';
import { closeDetails } from '../shell/closeDetails';

afterEach(() => { stopDetailScroll(); cleanup(); });

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
