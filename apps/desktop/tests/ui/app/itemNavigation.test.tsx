import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { immutable } from '../../../src/data/session-store';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
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
  expect(screen.getByRole('button', { name: 'Session actions' })).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready');
  expect(screen.getByLabelText('Session').getAttribute('aria-busy')).toBe('false');
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
async function setup(transport = new AppTransport()) {
  // The in-memory transport resolves immediately. Flush its promise/effect chain
  // at each interaction instead of polling the DOM between partial renders.
  await act(async () => { render(<DesktopApp service={createDesktopService(transport)} />); });
  return transport;
}

describe('composed item navigation', () => {
  it.each([
    { archive: 'session', retained: false }, { archive: 'session', retained: true },
    { archive: 'topic', retained: false }, { archive: 'topic', retained: true },
  ])('reads a related waiting target in an archived $archive without owner inputs (retained draft: $retained)', async ({ archive, retained }) => {
    const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
    session.items['8']!.related = ['2'];
    session.items['2']!.options = [{ id: 'choice', label: 'Keep it', consequence: 'Keep this choice.', recommended: true }];
    let draftId: string | null = null;
    if (retained) {
      const drafts = new OwnerDraftStore(createDesktopService(transport));
      await drafts.load();
      draftId = drafts.begin(immutable(session), '2', 'answer');
      drafts.edit(draftId!, { text: 'Keep this attempted answer.' });
      transport.failNext = 'input_submit';
      expect(await drafts.submit(draftId!)).toBe(false);
    }
    const submissions = () => transport.mutations.filter(request => request.command.command === 'input_submit');
    const sentBeforeReading = submissions().length;
    await setup(transport); await openSession(); await pick('8');
    if (archive === 'session') {
      session.state = 'closed'; session.closed_at = session.updated_at; session.archived_at = session.updated_at;
    } else session.topics[session.items['2']!.topic_id]!.archived_at = session.updated_at;
    ++session.revision;
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision }); });
    await click(within(document.querySelector<HTMLElement>('.detail-related')!).getByRole('button', { name: /^#2 / }));
    const detail = screen.getByLabelText('Detail of #2');
    expect(within(detail).getByRole('region', { name: 'Conversation' })).toBeTruthy();
    expect(detail.querySelector('[data-owner-input]')).toBeNull();
    if (retained) {
      const saved = within(detail).getByRole<HTMLTextAreaElement>('textbox', { name: 'Saved answer text' });
      expect(saved.value).toBe('Keep this attempted answer.');
      expect(saved.readOnly).toBe(true);
      expect(saved.disabled).toBe(false);
    } else expect(within(detail).queryByRole('textbox')).toBeNull();
    expect(within(detail).queryByRole('region', { name: 'Your answer' })).toBeNull();
    await keyDown(document.body, 'a'); await keyDown(document.body, '1', true);
    expect(detail.querySelector('[data-owner-input]')).toBeNull();
    expect(submissions()).toHaveLength(sentBeforeReading);
    if (retained) expect(transport.preferences.drafts.find(draft => draft.op_id === draftId)?.text).toBe('Keep this attempted answer.');
  });

  it('keeps a related waiting target’s blocked answer visible in a closed unarchived session', async () => {
    const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
    session.items['8']!.related = ['2'];
    await setup(transport); await openSession(); await pick('8');
    session.state = 'closed'; session.closed_at = session.updated_at; ++session.revision;
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision }); });
    await click(within(document.querySelector<HTMLElement>('.detail-related')!).getByRole('button', { name: /^#2 / }));
    const detail = screen.getByLabelText('Detail of #2');
    expect(within(detail).getByRole('region', { name: 'Your answer' })).toBeTruthy();
    expect(within(detail).getByText('This session is closed. Reopen it to answer.')).toBeTruthy();
    expect(transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(0);
  });

  it('reveals a hidden related descendant and preserves links, hiding, and Back/Forward navigation', async () => {
    const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
    session.items['4']!.related = ['1.1', '8'];
    const view = () => transport.preferences.sessions.find(view => view.session.session_id === route.session_id)!;
    view().hidden_item_ids = ['1'];
    await setup(transport); await openSession(); await pick('4');
    expect(document.querySelector('[role="treeitem"][data-item-id="1.1"]')).toBeNull();
    const links = document.querySelector<HTMLElement>('.detail-related')!;
    const hidden = within(links).getByRole('button', { name: /^#1\.1 .*\(hidden\)/ });
    expect(hidden.classList.contains('is-hidden')).toBe(true);
    await click(hidden); selected('1.1');
    expect(document.querySelector('[role="treeitem"][data-item-id="1.1"]')!.classList.contains('tree-item-hidden')).toBe(true);
    expect(document.querySelector('.tree-hidden-group')!.getAttribute('aria-expanded')).toBe('true');
    expect(view().hidden_item_ids).toEqual(['1']);
    await click(control('Back')); selected('4');
    expect(within(document.querySelector<HTMLElement>('.detail-related')!).getByRole('button', { name: /^#1\.1 .*\(hidden\)/ })).toBeTruthy();
    await click(control('Forward')); selected('1.1');
    // The reverse connection navigates through the same history even though only item 4 declared it.
    await click(within(document.querySelector<HTMLElement>('.detail-related')!).getByRole('button', { name: /^#4 / })); selected('4');
    await click(control('Back')); selected('1.1');
    expect(view().hidden_item_ids).toEqual(['1']);
  });

  it('records tree, detail child and breadcrumb selections, traverses without pushing, and branches after a new selection', async () => {
    await setup(); await openSession(); await pick('1');
    expect(control('Back').disabled).toBe(true); expect(control('Forward').disabled).toBe(true);
    await click(within(screen.getByLabelText('Item detail')).getByRole('button', { name: /^Branched into Add the receipt lookup test/ })); selected('1.1');
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
