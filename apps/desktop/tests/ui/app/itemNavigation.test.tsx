import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { AppTransport, route, secondId } from './transport';
import { sessionButton } from './open';

afterEach(cleanup);
const control = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name });
async function ready() {
  await waitFor(() => expect(control('Close session').disabled).toBe(false));
}
async function openSession(id = route.session_id) {
  fireEvent.click(await sessionButton({ ...route, session_id: id }));
  await screen.findByRole('region', { name: 'Session tree' }); await ready();
}
async function selected(id: string) {
  await screen.findByLabelText(`Detail of #${id}`); await ready();
}
async function pick(id: string) {
  fireEvent.click(document.querySelector(`[role="treeitem"][data-item-id="${id}"]`)!); await selected(id);
}
function setup() {
  const transport = new AppTransport();
  render(<DesktopApp service={createDesktopService(transport)} />);
  return transport;
}

describe('composed item navigation', () => {
  it('records tree, detail child and breadcrumb selections, traverses without pushing, and branches after a new selection', async () => {
    setup(); await openSession(); await pick('1');
    expect(control('Back').disabled).toBe(true); expect(control('Forward').disabled).toBe(true);
    fireEvent.click(await screen.findByRole('button', { name: /^Add the receipt lookup test/ })); await selected('1.1');
    expect(control('Back').disabled).toBe(false);
    fireEvent.click(document.querySelectorAll<HTMLButtonElement>('.detail-path button')[1]); await selected('1');
    fireEvent.click(control('Back')); await selected('1.1');
    fireEvent.click(control('Back')); await selected('1');
    expect(control('Back').disabled).toBe(true);
    fireEvent.click(control('Forward')); await selected('1.1');
    await pick('4'); expect(control('Forward').disabled).toBe(true);
    fireEvent.click(control('Back')); await selected('1.1');
  });

  it('records graph keyboard selection, Waiting and native routes through the same effective selection', async () => {
    const transport = setup(); await openSession(); await pick('4');
    fireEvent.click(control('Graph')); await screen.findAllByRole('tree', { name: / graph$/ }); await ready();
    const graphRow = document.querySelector<HTMLElement>('.graph-node[data-item-id="4"]')!;
    fireEvent.keyDown(graphRow, { key: 'ArrowDown' });
    await waitFor(() => expect(transport.preferences.sessions.find(view => view.session.session_id === route.session_id)?.selected_item_id).toBe('5'));
    await ready();
    fireEvent.keyDown(document.body, { key: '[', metaKey: true }); await selected('4');
    fireEvent.click(document.querySelector('[data-waiting-item="2"]')!); await selected('2');
    await act(async () => { transport.emit('ariadne://route', { ...route, item_id: '8' }); }); await selected('8');
    fireEvent.keyDown(document.body, { key: '[', metaKey: true }); await selected('2');
    fireEvent.keyDown(document.body, { key: '[', metaKey: true }); await selected('4');
    fireEvent.keyDown(document.body, { key: ']', metaKey: true }); await selected('2');
  });

  it('keeps history isolated between session views and retains it when returning to an existing tab', async () => {
    const transport = setup(); await openSession(); await pick('1'); await pick('4');
    await openSession(secondId);
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    const tab = [...document.querySelectorAll<HTMLButtonElement>('[data-session-tab]')].find(button => button.dataset.sessionTab?.includes(route.session_id))!;
    await waitFor(() => expect(tab.disabled).toBe(false)); fireEvent.click(tab); await selected('4');
    fireEvent.click(control('Back')); await selected('1');
    expect(transport.preferences.sessions.find(view => view.session.session_id === secondId)?.selected_item_id).toBeNull();
  });
});
