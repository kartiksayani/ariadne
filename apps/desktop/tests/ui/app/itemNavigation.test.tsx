import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { AppTransport, route, secondId } from './transport';
import { sessionButton } from './open';

afterEach(cleanup);
async function click(element: Element) {
  await act(async () => { fireEvent.click(element); });
}
async function keyDown(element: Element, key: string, metaKey = false) {
  await act(async () => { fireEvent.keyDown(element, { key, metaKey }); });
}
// Use the controls' explicit labels/text instead of recomputing accessible names
// for every button in the full session tree on each history/readiness check.
const control = (name: string) => name === 'Back' || name === 'Forward'
  ? screen.getByLabelText<HTMLButtonElement>(name, { selector: 'button' })
  : screen.getByText<HTMLButtonElement>(name, { selector: 'button', exact: true });
function ready() {
  expect(control('Close session').disabled).toBe(false);
}
async function openSession(id = route.session_id) {
  await click(await sessionButton({ ...route, session_id: id }));
  screen.getByRole('region', { name: 'Session tree' }); ready();
}
function selected(id: string) {
  screen.getByLabelText(`Detail of #${id}`); ready();
}
async function pick(id: string) {
  await click(document.querySelector(`[role="treeitem"][data-item-id="${id}"]`)!); await selected(id);
}
async function setup() {
  const transport = new AppTransport();
  // The in-memory transport resolves immediately. Flush its promise/effect chain
  // at each interaction instead of polling the DOM between partial renders.
  await act(async () => { render(<DesktopApp service={createDesktopService(transport)} />); });
  return transport;
}

describe('composed item navigation', () => {
  it('records tree, detail child and breadcrumb selections, traverses without pushing, and branches after a new selection', async () => {
    await setup(); await openSession(); await pick('1');
    expect(control('Back').disabled).toBe(true); expect(control('Forward').disabled).toBe(true);
    await click(within(screen.getByLabelText('Item detail')).getByRole('button', { name: /^Add the receipt lookup test/ })); selected('1.1');
    expect(control('Back').disabled).toBe(false);
    await click(document.querySelectorAll<HTMLButtonElement>('.detail-path button')[1]); await selected('1');
    await click(control('Back')); await selected('1.1');
    await click(control('Back')); await selected('1');
    expect(control('Back').disabled).toBe(true);
    await click(control('Forward')); await selected('1.1');
    await pick('4'); expect(control('Forward').disabled).toBe(true);
    await click(control('Back')); await selected('1.1');
  });

  it('records graph keyboard selection, Waiting and native routes through the same effective selection', async () => {
    const transport = await setup(); await openSession(); await pick('4');
    await click(control('Graph')); screen.getAllByRole('tree', { name: / graph$/ }); ready();
    const graphRow = document.querySelector<HTMLElement>('.graph-node[data-item-id="4"]')!;
    await keyDown(graphRow, 'ArrowDown');
    expect(transport.preferences.sessions.find(view => view.session.session_id === route.session_id)?.selected_item_id).toBe('5');
    ready();
    await keyDown(document.body, '[', true); await selected('4');
    await click(document.querySelector('[data-waiting-item="2"]')!); await selected('2');
    await act(async () => { transport.emit('ariadne://route', { ...route, item_id: '8' }); }); await selected('8');
    await keyDown(document.body, '[', true); await selected('2');
    await keyDown(document.body, '[', true); await selected('4');
    await keyDown(document.body, ']', true); await selected('2');
  });

  it('keeps history isolated between session views and retains it when returning to an existing tab', async () => {
    const transport = await setup(); await openSession(); await pick('1'); await pick('4');
    await openSession(secondId);
    expect(screen.queryByLabelText('Back', { selector: 'button' })).toBeNull();
    const tab = [...document.querySelectorAll<HTMLButtonElement>('[data-session-tab]')].find(button => button.dataset.sessionTab?.includes(route.session_id))!;
    expect(tab.disabled).toBe(false); await click(tab); selected('4');
    await click(control('Back')); await selected('1');
    expect(transport.preferences.sessions.find(view => view.session.session_id === secondId)?.selected_item_id).toBeNull();
  });
});
