import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { immutable } from '../../../src/data/session-store';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { AppTransport, route, secondId } from './transport';
import { goToSession } from './open';
import { sessionClosedReason } from '../../../src/selectors/sessionClosed';
import { NavigationStore } from '../../../src/state/navigation/store';
import { changesFixture } from '../changes/fixture';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
async function click(element: Element) {
  await act(async () => { fireEvent.click(element); });
  // These navigation regressions deliberately follow references through their peek.
  if (element.classList.contains('name-chip')) {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Go to' })); });
  }
}
async function keyDown(element: Element, key: string, metaKey = false) {
  await act(async () => { fireEvent.keyDown(element, { key, metaKey }); });
}
// Use the controls' explicit labels/text instead of recomputing accessible names
// for every button in the full session tree on each history/readiness check.
const control = (name: string) => screen.getByLabelText<HTMLButtonElement>(name, { selector: 'button' });
/** The top bar's search: a button until the owner opens it, then a box (`.tb-search-input`) that finds in place. */
async function searchBox() {
  if (!document.querySelector('.tb-search-input')) await click(screen.getByLabelText('Search the Map', { selector: 'button' }));
  return document.querySelector<HTMLInputElement>('.tb-search-input')!;
}
function ready() {
  // The connection dot opens the card that replaced the Session actions menu.
  expect(document.querySelector('[data-popover-trigger="connection"]')).toBeTruthy();
  expect(screen.getByLabelText('Session tree', { selector: 'section' }).getAttribute('data-session-status')).toBe('ready');
  expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-busy')).toBe('false');
}
async function openSession(id = route.session_id) {
  await goToSession({ ...route, session_id: id }, click);
  screen.getByLabelText('Session tree', { selector: 'section' }); ready();
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
/** Opens the dock's first waiting question and follows its title, the question itself (as a Waiting card did). */
async function fromDock() {
  const dock = screen.getByRole('region', { name: 'Answer dock' });
  if (!dock.hasAttribute('data-open')) await click(within(dock).getByRole('button', { name: /^\d+ (more )?waiting$/ }));
  await click(dock.querySelector<HTMLButtonElement>('.dock-question-open')!);
}
function inTree(id: string) {
  const rectangle = treeRow(id).getBoundingClientRect();
  expect(rectangle.top).toBeGreaterThanOrEqual(0);
  expect(rectangle.bottom).toBeLessThanOrEqual(400);
}

describe('composed item navigation', () => {
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
    mark.mockClear();
    await click(screen.getByRole('button', { name: 'Close detail' }));
    await pick('2');
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(mark).not.toHaveBeenCalled(); // Reopening the same read revision adds no observation.
    await click(screen.getByRole('button', { name: 'Close detail' }));
    const session = transport.sessions.get(route.session_id)!;
    ++session.items['2']!.revision; ++session.revision;
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision }); });
    fireEvent.mouseEnter(document.querySelector('[role="treeitem"][data-item-id="2"]')!);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(mark).not.toHaveBeenCalled();
    await pick('2');
    expect(mark).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(mark).toHaveBeenCalledWith(route, '2', transport.sessions.get(route.session_id)!.items['2']!.revision);
  });
  it('records detail dwell during pending catch-up so Undo preserves that real read', async () => {
    const mark = vi.spyOn(NavigationStore.prototype, 'markItemSeen');
    const value = changesFixture(2), transport = new AppTransport();
    transport.sessions.set(value.session.id, value.session); transport.preferences.seen = [value.seen];
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-10T02:00:00Z');
    await setup(transport); await openSession();
    vi.useFakeTimers(); vi.setSystemTime('2026-10-10T02:00:00Z');
    await click(screen.getByRole('button', { name: /Since you were here ·/ }));
    await click(screen.getByRole('button', { name: 'Mark all caught up' }));
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
    await pick('updated-0');
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(mark).toHaveBeenCalledWith(route, 'updated-0', 2);
    await click(screen.getByRole('button', { name: 'Undo' }));
    expect(within(treeRow('updated-0')).queryByRole('img', { name: 'Changed since you read it' })).toBeNull();
    expect(within(treeRow('updated-1')).getByRole('img', { name: 'Changed since you read it' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Since you were here · 1 change/ })).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(transport.preferences.seen![0].items).toEqual([{ item_id: 'updated-0', revision: 2 }]);
    expect(transport.preferences.seen![0].topics).toEqual([]);
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
    await click(within(document.querySelector<HTMLElement>('.detail-related')!).getByRole('button', { name: `${session.items['2']!.question} · Waiting on me` }));
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
    await click(within(document.querySelector<HTMLElement>('.detail-related')!).getByRole('button', { name: `${session.items['2']!.question} · Waiting on me` }));
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
    const hidden = within(links).getByRole('button', { name: `${session.items['1.1']!.question} (hidden) · Open` });
    expect(hidden.classList.contains('is-hidden')).toBe(true);
    await click(hidden); selected('1.1');
    expect(document.querySelector('[role="treeitem"][data-item-id="1.1"]')!.classList.contains('tree-item-hidden')).toBe(true);
    expect(document.querySelector('.tree-hidden-group')!.getAttribute('aria-expanded')).toBe('true');
    expect(view().hidden_item_ids).toEqual(['1']);
    await click(control('Back')); selected('4');
    expect(within(document.querySelector<HTMLElement>('.detail-related')!).getByRole('button', { name: `${session.items['1.1']!.question} (hidden) · Open` })).toBeTruthy();
    await click(control('Forward')); selected('1.1');
    // The reverse connection navigates through the same history even though only item 4 declared it.
    await click(within(document.querySelector<HTMLElement>('.detail-related')!).getByRole('button', { name: `${session.items['4']!.question} · Open` })); selected('4');
    await click(control('Back')); selected('1.1');
    expect(view().hidden_item_ids).toEqual(['1']);
  });

  it('records tree, detail child and breadcrumb selections, traverses without pushing, and branches after a new selection', async () => {
    await setup(); await openSession(); await pick('1');
    expect(control('Back').disabled).toBe(true); expect(control('Forward').disabled).toBe(true);
    await click(within(screen.getByLabelText('Item detail')).getByRole('button', { name: /^Branched into Add the receipt lookup/ })); selected('1.1');
    expect(control('Back').disabled).toBe(false);
    await click(document.querySelectorAll<HTMLButtonElement>('.detail-path button')[1]); await selected('1');
    await click(control('Back')); await selected('1.1');
    await click(control('Back')); await selected('1');
    expect(control('Back').disabled).toBe(true);
    await click(control('Forward')); await selected('1.1');
    await pick('4'); expect(control('Forward').disabled).toBe(true);
    await click(control('Back')); await selected('1.1');
  });

  it('records graph keyboard selection, dock and native routes through the same effective selection', async () => {
    const transport = await setup(); await openSession(); await pick('4');
    await click(control('Graph')); screen.getAllByRole('tree', { name: / graph$/ }); ready();
    const graphRow = document.querySelector<HTMLElement>('.graph-node[data-item-id="4"]')!;
    await keyDown(graphRow, 'ArrowDown');
    expect(transport.preferences.sessions.find(view => view.session.session_id === route.session_id)?.selected_item_id).toBe('5');
    ready();
    await keyDown(document.body, '[', true); await selected('4');
    await fromDock(); await selected('2');
    await act(async () => { transport.emit('ariadne://route', { ...route, item_id: '8' }); }); await selected('8');
    await keyDown(document.body, '[', true); await selected('2');
    await keyDown(document.body, '[', true); await selected('4');
    await keyDown(document.body, ']', true); await selected('2');
  });

  it('keeps history isolated between session views and retains it when returning to an existing session', async () => {
    const transport = await setup(); await openSession(); await pick('1'); await pick('4');
    await openSession(secondId);
    expect(screen.queryByLabelText('Back', { selector: 'button' })).toBeNull();
    // No tabs: returning to the session is the same click on its row in All sessions (open.ts waits until it is enabled).
    await openSession(); selected('4');
    await click(control('Back')); await selected('1');
    expect(transport.preferences.sessions.find(view => view.session.session_id === secondId)?.selected_item_id).toBeNull();
  });
});

describe('composed map reveal scrolling', () => {
  it.each(['search over a collapsed ancestor', 'status', 'search matching nothing', 'collapsed ancestor'] as const)('reveals an undrawn Graph selection through its registered route after %s, preserving the saved view', async cause => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = this.closest<HTMLElement>('.graph-scroll');
      if (this.matches('.graph-scroll')) return new DOMRect(0, 0, 400, 300);
      if (box && this.matches('.graph-node')) return new DOMRect(600 - box.scrollLeft, 500 - box.scrollTop, 190, 66);
      return new DOMRect();
    });
    const transport = new AppTransport(), view = transport.preferences.sessions[0]!;
    view.selected_item_id = '1.1';
    view.expanded_item_ids = ['2', '3'];
    view.hidden_item_ids = ['6'];
    if (cause === 'search over a collapsed ancestor') view.filters.search = 'delivery window';
    if (cause === 'status') view.filters.statuses = ['waiting_on_me'];
    if (cause === 'search matching nothing') view.filters.search = 'no matching question';
    const saved = structuredClone(view);
    await setup(transport); await openSession();
    await click(screen.getByRole('button', { name: 'Close detail' }));
    // Opening the session reveals its saved selection. A search edit keeps that temporary reveal (a search hides no
    // row, SPEC §4), so a fold dismisses it here: the hidden group opened and closed, which saves nothing.
    const search = await searchBox();
    await act(async () => { fireEvent.change(search, { target: { value: `${saved.filters.search} ` } }); });
    await act(async () => { fireEvent.change(search, { target: { value: saved.filters.search } }); });
    if (cause !== 'status') for (let toggle = 0; toggle < 2; toggle++) {
      await click(screen.getByRole('treeitem', { name: /^1 item hidden/ }));
    }
    await click(control('Graph'));
    const target = () => document.querySelector<HTMLElement>('.graph-node[data-item-id="1.1"]');
    expect(target()).toBeNull();
    expect(screen.queryByText('Showing an item outside your current filters.')).toBeNull();
    const before = transport.queries.filter(query => query.request.command === 'reveal_item').length;
    // The Graph has no Reveal selected button (SPEC 1.3); an outside route (a link, the dock, a native route) reveals it.
    await act(async () => { transport.emit('ariadne://route', { ...route, item_id: '1.1' }); });
    await waitFor(() => expect(target()).not.toBeNull());
    expect(transport.queries.filter(query => query.request.command === 'reveal_item').slice(before)).toEqual([
      expect.objectContaining({ session: route, request: { command: 'reveal_item', params: { item_id: '1.1' } } }),
    ]);
    expect(target()).not.toBeNull();
    expect(target()!.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(target());
    const rectangle = target()!.getBoundingClientRect();
    // Centred in the room above the 40px dock line: (300 − 40) / 2.
    expect(rectangle.left + rectangle.width / 2).toBe(200);
    expect(rectangle.top + rectangle.height / 2).toBe(130);
    expect(document.querySelector('.graph-node[data-item-id="1"]')!.getAttribute('aria-expanded')).toBe('true');
    // A route goes to the item: Details opens on it.
    expect(document.querySelector('[data-detail-item-id="1.1"]')).not.toBeNull();
    const current = transport.preferences.sessions.find(view => view.session.session_id === route.session_id)!;
    expect(current.filters).toEqual(saved.filters);
    expect(current.expanded_item_ids).toEqual(saved.expanded_item_ids);
    expect(current.hidden_item_ids).toEqual(saved.hidden_item_ids);
    expect(current.selected_item_id).toBe('1.1');
    expect((await searchBox()).value).toBe(saved.filters.search);
    // Only a status filter puts the item outside the filters; a search, matching or not, filters nothing.
    if (cause === 'status') {
      expect(screen.getByText('Showing an item outside your current filters.')).toBeTruthy();
      await click(screen.getByRole('button', { name: 'Resume filtered view' }));
      expect(target()).toBeNull();
      expect(screen.queryByText('Showing an item outside your current filters.')).toBeNull();
      expect(transport.preferences.sessions.find(view => view.session.session_id === route.session_id)!.filters).toEqual(saved.filters);
    }
  });

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

  it('brings a waiting question into view from the dock path, including the already-selected target', async () => {
    treeGeometry(); await setup(); await openSession(); await pick('2');
    for (let attempt = 0; attempt < 2; ++attempt) {
      // Details answers the selected question, so the dock holds it once Details closes.
      await click(screen.getByRole('button', { name: 'Close detail' }));
      await readAt(600); outsideTree('2');
      await fromDock(); selected('2');
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
      await click(within(document.querySelector<HTMLElement>('.detail-related')!).getByRole('button', { name: `${session.items['8']!.question} · Open` }));
    } else if (entry === 'Markdown reference') {
      await click(within(document.querySelector<HTMLElement>('.detail-question')!).getByRole('button', { name: `${session.items['8']!.question} · Open` }));
    } else if (entry === 'child link') {
      await click(detail.getByRole('button', { name: /^Branched into Add the receipt lookup/ }));
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
    await click(within(document.querySelector<HTMLElement>('.detail-related')!).getByRole('button', { name: `${session.items['1.1']!.question} (hidden) · Open` }));
    selected('1.1'); inTree('1.1');
    expect(treeScroll().scrollTop).toBeGreaterThan(150);
    expect(transport.preferences.sessions.find(view => view.session.session_id === route.session_id)!.hidden_item_ids).toEqual(['1']);
  });

  it('reveals Back and Forward targets while preserving the current search', async () => {
    treeGeometry(); const transport = await setup(); await openSession(); await pick('2'); await pick('8');
    await act(async () => { fireEvent.change(await searchBox(), { target: { value: 'receipt' } }); });
    // The search keeps every row, so 8 is the ninth row: reading at 1200 puts both targets out of view.
    await readAt(1200); outsideTree('8');
    await click(control('Back')); selected('2'); inTree('2');
    await readAt(1200); outsideTree('8');
    await click(control('Forward')); selected('8'); inTree('8');
    expect((await searchBox()).value).toBe('receipt');
    expect(transport.preferences.sessions.find(view => view.session.session_id === route.session_id)!.selected_item_id).toBe('8');
  });

  it('keeps a clicked search-result tree row stationary through the composed controls', async () => {
    treeGeometry(); await setup(); await openSession();
    await act(async () => { fireEvent.change(await searchBox(), { target: { value: 'receipt' } }); });
    // The search finds in place: the top bar counts it and the Map keeps every row.
    expect(document.querySelector('.tb-search-count')?.textContent).toBe('1 of 2');
    await readAt(600); outsideTree('1.1');
    await pick('1.1');
    expect(treeScroll().scrollTop).toBe(600);
    outsideTree('1.1');
    expect((await searchBox()).value).toBe('receipt');
  });

  it('keeps dock, linked and history reveals working after opening an archived saved selection', async () => {
    treeGeometry();
    const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
    transport.preferences.sessions[0]!.selected_item_id = '8';
    session.topics[session.items['8']!.topic_id]!.archived_at = session.updated_at;
    session.items['2']!.related = ['1.1'];
    await setup(transport); await openSession();
    expect(treeRow('8')).toBeNull();
    await readAt(600);
    await fromDock();
    selected('2'); inTree('2');
    expect(document.activeElement).toBe(treeRow('2'));
    await readAt(600);
    await click(within(document.querySelector<HTMLElement>('.detail-related')!).getByRole('button', { name: `${session.items['1.1']!.question} · Open` }));
    selected('1.1'); inTree('1.1');
    await readAt(600);
    await click(control('Back')); selected('2'); inTree('2');
    await readAt(600);
    await click(control('Forward')); selected('1.1'); inTree('1.1');
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
      // 8px above the 40px dock line that floats over the Map's bottom.
      expect(treeRow('8').getBoundingClientRect().bottom).toBe(352);
    }
  });

  // ⌘J is gone (SPEC 7 "Removed"); the . key (Back to the selected item, SPEC 6.1) replaces it.
  it.each(['.', 'Back-to pill'] as const)('reveals the offscreen selection through %s', async entry => {
    treeGeometry(); await setup(); await openSession(); await pick('8'); await readAt(150); outsideTree('8');
    if (entry === '.') await keyDown(document.body, '.');
    else await click(screen.getByRole('button', { name: /^Back to “/ }));
    selected('8'); inTree('8');
    expect(treeScroll().scrollTop).toBeGreaterThan(150);
  });
});
