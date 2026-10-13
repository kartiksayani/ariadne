import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { immutable } from '../../../src/data/session-store';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { AppTransport, route, secondId } from './transport';
import { sessionButton } from './open';
import { sessionClosedReason } from '../../../src/selectors/sessionClosed';
import { NavigationStore } from '../../../src/state/navigation/store';
import { shortLabel } from '../../../src/ui/shared/short';
import { changesFixture } from '../changes/fixture';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
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
  screen.getByLabelText(/^Detail of /, { selector: `[data-detail-item-id="${id}"]` }); ready();
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

const treeRow = (id: string) => document.querySelector<HTMLElement>(`[role="treeitem"][data-item-id="${id}"]`)!;
const treeScroll = () => document.querySelector<HTMLElement>('.tree-scroll')!;
// Model the composed tree's actual rendered rows, including filtered/hidden rows.
// Row coordinates move with scrolling so a changed scrollTop alone cannot pass
// a reveal test unless the target really reaches the viewport.
function treeGeometry() {
  const rectangle = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const box = this.closest<HTMLElement>('.tree-scroll');
    if (this.matches('.tree-scroll')) return new DOMRect(0, 0, 300, 400);
    if (box && this.matches('[role="treeitem"][data-item-id]')) {
      const rows = [...box.querySelectorAll('[role="treeitem"][data-item-id]')];
      return new DOMRect(0, (rows.indexOf(this) + 1) * 100 - box.scrollTop, 300, 40);
    }
    return rectangle.call(this);
  });
}
async function readAt(top: number) {
  await act(async () => { treeScroll().scrollTop = top; fireEvent.scroll(treeScroll()); });
}
function outsideTree(id: string) {
  const rectangle = treeRow(id).getBoundingClientRect();
  expect(rectangle.top < 0 || rectangle.bottom > 400).toBe(true);
}
function inTree(id: string) {
  const rectangle = treeRow(id).getBoundingClientRect();
  expect(rectangle.top).toBeGreaterThanOrEqual(0);
  expect(rectangle.bottom).toBeLessThanOrEqual(400);
}

describe('composed item navigation', { timeout: 10_000 }, () => {
  it('opens and focuses the owner answer behind a change, then consumes the jump', async () => {
    const value = changesFixture(), transport = new AppTransport();
    transport.sessions.set(value.session.id, value.session);
    transport.preferences.seen = [value.seen];
    await setup(transport); await openSession(); await pick('updated-0');
    const context = screen.getByRole('region', { name: 'What changed' });
    await click(within(context).getByRole('button', { name: 'Changed after your typed answer ↗' }));
    selected(value.answer.item_id);
    expect(document.activeElement?.getAttribute('data-message-id')).toBe(value.answer.message_id);
    const otherControl = screen.getByRole('button', { name: 'Close detail' });
    otherControl.focus();
    const session = transport.sessions.get(route.session_id)!; ++session.revision;
    session.messages.find(message => message.id === value.answer.message_id)!.body += '\nAdditional words.';
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision }); });
    expect(document.activeElement).toBe(otherControl);
  });
  it('marks current details as read and leaves changes unseen while the pane is closed', async () => {
    const mark = vi.spyOn(NavigationStore.prototype, 'markItemSeen');
    const transport = await setup(); await openSession();
    vi.useFakeTimers(); await pick('2');
    expect(mark).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(mark).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mark).toHaveBeenCalledWith(route, '2', transport.sessions.get(route.session_id)!.items['2']!.revision);
    await click(screen.getByRole('button', { name: 'Close detail' }));
    mark.mockClear();
    const session = transport.sessions.get(route.session_id)!;
    ++session.items['2']!.revision; ++session.revision;
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision }); });
    expect(mark).not.toHaveBeenCalled();
    await pick('2');
    expect(mark).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(mark).toHaveBeenCalledWith(route, '2', transport.sessions.get(route.session_id)!.items['2']!.revision);
  });
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
    await click(within(document.querySelector<HTMLElement>('.detail-related')!).getByRole('button', { name: `${shortLabel(session.items['2']!)} · Waiting on me` }));
    const detail = screen.getByLabelText(/^Detail of /, { selector: '[data-detail-item-id="2"]' });
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
    await click(within(document.querySelector<HTMLElement>('.detail-related')!).getByRole('button', { name: `${shortLabel(session.items['2']!)} · Waiting on me` }));
    const detail = screen.getByLabelText(/^Detail of /, { selector: '[data-detail-item-id="2"]' });
    expect(within(detail).getByRole('region', { name: 'Your answer' })).toBeTruthy();
    expect(within(detail).getByText(sessionClosedReason)).toBeTruthy();
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
    const hidden = within(links).getByRole('button', { name: `${shortLabel(session.items['1.1']!)} (hidden) · Open` });
    expect(hidden.classList.contains('is-hidden')).toBe(true);
    await click(hidden); selected('1.1');
    expect(document.querySelector('[role="treeitem"][data-item-id="1.1"]')!.classList.contains('tree-item-hidden')).toBe(true);
    expect(document.querySelector('.tree-hidden-group')!.getAttribute('aria-expanded')).toBe('true');
    expect(view().hidden_item_ids).toEqual(['1']);
    await click(control('Back')); selected('4');
    expect(within(document.querySelector<HTMLElement>('.detail-related')!).getByRole('button', { name: `${shortLabel(session.items['1.1']!)} (hidden) · Open` })).toBeTruthy();
    await click(control('Forward')); selected('1.1');
    // The reverse connection navigates through the same history even though only item 4 declared it.
    await click(within(document.querySelector<HTMLElement>('.detail-related')!).getByRole('button', { name: `${shortLabel(session.items['4']!)} · Open` })); selected('4');
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

describe('composed map reveal scrolling', { timeout: 10_000 }, () => {
  it.each([false, true])('opens at the saved anchor when present, otherwise the saved selection (anchor: %s)', async savedAnchor => {
    treeGeometry();
    const transport = new AppTransport(), view = transport.preferences.sessions[0]!;
    view.selected_item_id = '8';
    if (savedAnchor) view.scroll = { item_id: '4', offset: 24 };
    await setup(transport); await openSession();
    if (savedAnchor) {
      expect(treeRow('4').getBoundingClientRect().top).toBe(24);
      outsideTree('8');
    } else {
      inTree('8');
      expect(treeRow('8').getBoundingClientRect().top).toBe(180);
    }
    const opening = treeScroll().scrollTop;
    expect(opening).toBeGreaterThan(0);
    await click(screen.getByRole('button', { name: 'Close detail' }));
    expect(treeScroll().scrollTop).toBe(opening);
    await readAt(150);
    await pick('8');
    expect(treeScroll().scrollTop).toBe(150);
  });

  it.each(['hidden row', 'folded parent', 'folded topic'] as const)('opens a saved selection behind a %s without a scroll anchor', async path => {
    treeGeometry();
    const transport = new AppTransport(), view = transport.preferences.sessions[0]!;
    const id = path === 'folded parent' ? '1.1' : '8';
    view.selected_item_id = id; view.scroll = null;
    if (path === 'hidden row') view.hidden_item_ids = [id];
    if (path === 'folded parent') view.expanded_item_ids = [];
    if (path === 'folded topic') view.collapsed_topic_ids = [transport.sessions.get(route.session_id)!.items[id]!.topic_id];
    const saved = { expanded: [...view.expanded_item_ids], folded: [...(view.collapsed_topic_ids ?? [])] };
    await setup(transport); await openSession();
    expect(treeRow(id)).not.toBeNull(); inTree(id);
    const current = transport.preferences.sessions.find(view => view.session.session_id === route.session_id)!;
    expect(current.expanded_item_ids).toEqual(saved.expanded);
    expect(current.collapsed_topic_ids ?? []).toEqual(saved.folded);
  });

  it('keeps row clicks and detail close/reopen stationary after keyboard navigation', async () => {
    treeGeometry(); await setup(); await openSession(); await pick('4');
    await keyDown(treeRow('4'), 'End');
    inTree('8');
    await readAt(150); outsideTree('8');
    await pick('8');
    expect(treeScroll().scrollTop).toBe(150);
    await click(screen.getByRole('button', { name: 'Close detail' }));
    expect(treeScroll().scrollTop).toBe(150);
    await pick('8');
    expect(treeScroll().scrollTop).toBe(150);
    outsideTree('8');
  });

  it.each(['card', 'Details'] as const)('brings a Waiting target into view through its %s, including the already-selected target', async entry => {
    treeGeometry(); await setup(); await openSession(); await pick('2');
    const card = document.querySelector<HTMLElement>('[data-waiting-item="2"]')!;
    const open = () => click(entry === 'card' ? card : within(card).getByRole('button', { name: 'Details' }));
    for (let attempt = 0; attempt < 2; ++attempt) {
      await readAt(600); outsideTree('2');
      await open(); selected('2');
      expect(treeScroll().scrollTop).toBeLessThan(600);
      inTree('2');
      expect(treeRow('2').getBoundingClientRect().top).toBe(8);
    }
  });

  it.each(['related link', 'Markdown reference', 'child link', 'breadcrumb'] as const)('brings the target of a detail %s into view', async entry => {
    treeGeometry();
    const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
    session.items['4']!.related = ['8'];
    session.items['4']!.question = 'Record retry limits and [continued context](item:8)';
    await setup(transport); await openSession();
    const source = entry === 'child link' ? '1' : entry === 'breadcrumb' ? '1.1' : '4';
    const target = entry === 'child link' ? '1.1' : entry === 'breadcrumb' ? '1' : '8';
    await pick(source); await readAt(entry === 'child link' || entry === 'breadcrumb' ? 600 : 150);
    outsideTree(target);
    const before = treeScroll().scrollTop;
    const detail = within(screen.getByLabelText('Item detail'));
    if (entry === 'related link') {
      await click(within(document.querySelector<HTMLElement>('.detail-related')!).getByRole('button', { name: `${shortLabel(session.items['8']!)} · Open` }));
    } else if (entry === 'Markdown reference') {
      await click(detail.getByRole('link', { name: 'continued context' }));
    } else if (entry === 'child link') {
      await click(detail.getByRole('button', { name: /^Branched into Add the receipt lookup test/ }));
    } else await click(document.querySelectorAll<HTMLButtonElement>('.detail-path button')[1]);
    selected(target);
    expect(treeScroll().scrollTop).not.toBe(before);
    inTree(target);
  });

  it('reveals a hidden descendant from its detail link without changing the hidden preference', async () => {
    treeGeometry();
    const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
    session.items['4']!.related = ['1.1'];
    transport.preferences.sessions[0]!.hidden_item_ids = ['1'];
    await setup(transport); await openSession(); await pick('4'); await readAt(150);
    expect(treeRow('1.1')).toBeNull();
    await click(within(document.querySelector<HTMLElement>('.detail-related')!).getByRole('button', { name: `${shortLabel(session.items['1.1']!)} (hidden) · Open` }));
    selected('1.1'); inTree('1.1');
    expect(treeScroll().scrollTop).toBeGreaterThan(150);
    expect(transport.preferences.sessions.find(view => view.session.session_id === route.session_id)!.hidden_item_ids).toEqual(['1']);
  });

  it('reveals Back and Forward targets while preserving the current search', async () => {
    treeGeometry(); const transport = await setup(); await openSession(); await pick('2'); await pick('8');
    await act(async () => { fireEvent.change(screen.getByLabelText('Search questions and outcomes'), { target: { value: 'receipt' } }); });
    await readAt(600); outsideTree('8');
    await click(control('Back')); selected('2'); inTree('2');
    await readAt(600);
    await click(control('Forward')); selected('8'); inTree('8');
    expect(screen.getByLabelText<HTMLInputElement>('Search questions and outcomes').value).toBe('receipt');
    expect(transport.preferences.sessions.find(view => view.session.session_id === route.session_id)!.selected_item_id).toBe('8');
  });

  it('reveals a clicked search result through the composed search and tree controls', async () => {
    treeGeometry(); await setup(); await openSession();
    await act(async () => { fireEvent.change(screen.getByLabelText('Search questions and outcomes'), { target: { value: 'receipt' } }); });
    expect(screen.getByText(/items matching “receipt”/)).toBeTruthy();
    await readAt(600); outsideTree('1.1');
    await pick('1.1');
    expect(treeScroll().scrollTop).toBeLessThan(600);
    inTree('1.1');
    expect(screen.getByLabelText<HTMLInputElement>('Search questions and outcomes').value).toBe('receipt');
  });

  it('reveals a native item route opening a session instead of restoring that session’s reading anchor', async () => {
    treeGeometry();
    const transport = new AppTransport(), view = transport.preferences.sessions[0]!;
    view.selected_item_id = '1'; view.scroll = { item_id: '4', offset: 24 };
    await setup(transport);
    expect(document.querySelector('.tree-scroll')).toBeNull();
    await act(async () => { transport.emit('ariadne://route', { ...route, item_id: '8' }); });
    selected('8'); inTree('8');
    expect(treeRow('4').getBoundingClientRect().top).not.toBe(24);
    expect(transport.preferences.sessions.find(view => view.session.session_id === route.session_id)!.scroll).toEqual({ item_id: '4', offset: 24 });
  });

  it('reveals native item routes again after the already-selected target is scrolled away', async () => {
    treeGeometry(); const transport = await setup(); await openSession(); await pick('8');
    for (let attempt = 0; attempt < 2; ++attempt) {
      await readAt(150); outsideTree('8');
      await act(async () => { transport.emit('ariadne://route', { ...route, item_id: '8' }); });
      selected('8'); inTree('8');
      expect(treeScroll().scrollTop).toBeGreaterThan(150);
      expect(treeRow('8').getBoundingClientRect().bottom).toBe(392);
    }
  });

  it.each(['⌘J', 'edge marker'] as const)('reveals the offscreen selection through %s', async entry => {
    treeGeometry(); await setup(); await openSession(); await pick('8'); await readAt(150); outsideTree('8');
    if (entry === '⌘J') await keyDown(document.body, 'j', true);
    else await click(screen.getByRole('button', { name: /^↓ Selected:/ }));
    selected('8'); inTree('8');
    expect(treeScroll().scrollTop).toBeGreaterThan(150);
  });
});
