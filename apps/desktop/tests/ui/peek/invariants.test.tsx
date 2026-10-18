// Peek invariants, one row per trigger:
// - peeking never marks an item seen, and only an explicit open (click or key) is a Recent visit, never a hover;
// - opening and closing the card never moves the Map;
// - answering in the card sends exactly once, and the owner's words and pick survive every way the card closes.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { SessionStore } from '../../../src/data/session-store';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { NavigationStore } from '../../../src/state/navigation/store';
import { PeekProvider, usePeek } from '../../../src/ui/peek/Peek';
import { ItemRefSession } from '../../../src/ui/peek/context';
import { Markdown } from '../../../src/ui/shared/MarkdownText';
import { notices } from '../../../src/ui/pages/notices';
import { AppTransport, route } from '../app/transport';
import { goToSession } from '../app/open';

const stores: SessionStore[] = [];
afterEach(() => { cleanup(); notices.clear(); stores.splice(0).forEach(store => store.close()); vi.restoreAllMocks(); localStorage.clear(); });
const sleep = (ms: number) => act(() => new Promise<void>(resolve => { setTimeout(resolve, ms); }));
const card = () => document.querySelector<HTMLElement>('.item-peek');
const options = [{ id: 'yes', label: 'Keep the design', recommended: true, consequence: 'Retain the current contract.' },
  { id: 'no', label: 'Change the design', recommended: false, consequence: 'Review a new contract.' }];
const submits = (transport: AppTransport) => transport.mutations.filter(request => request.command.command === 'input_submit');

const opens = ['hover', 'click', 'keyboard'] as const;
const closes = ['pointer', 'scroll', 'Escape'] as const;

describe('peek in the Map: never marks seen, Recent only on an explicit open, the Map stays put', { timeout: 15_000 }, () => {
  async function mount() {
    const transport = new AppTransport(), source = transport.sessions.get(route.session_id)!;
    source.items['2']!.options = structuredClone(options);
    source.items['3']!.outcome = 'Waits on [the delivery choice](item:2).';
    render(<DesktopApp service={createDesktopService(transport)} />);
    await goToSession(route);
    const tree = await screen.findByRole('tree', { name: 'Session items' });
    await waitFor(() => expect(tree.getAttribute('aria-busy')).toBe('false'));
    const scroller = tree.closest<HTMLElement>('.tree-scroll')!;
    const row = tree.querySelector<HTMLElement>('[role="treeitem"][data-item-id="2"]')!;
    const reading = tree.querySelector<HTMLElement>('[role="treeitem"][data-item-id="4"]')!;
    scroller.scrollTop = 40;
    return { transport, tree, scroller, row, reading };
  }
  const seenPatches = (transport: AppTransport) => transport.mutations.filter(request => request.command.command === 'preferences_patch'
    && request.command.params.entries.some(entry => entry.kind === 'mark_seen' && entry.items.some(item => item.item_id === '2')));
  const visits = (transport: AppTransport) => (transport.preferences.sessions.find(view => view.session.session_id === route.session_id)?.recent_items ?? [])
    .filter(entry => entry.item_id === '2');

  it.each(opens.flatMap(open => closes.map(close => [open, close] as const)))('opened by %s, closed by %s', async (open, close) => {
    const value = await mount();
    // The keyboard opens from the focused row: focusing it is the owner's own move, before the snapshot.
    if (open === 'keyboard') value.row.focus();
    await sleep(20);
    value.scroller.scrollTop = 40;
    const scrolls = vi.fn();
    Element.prototype.scrollIntoView = scrolls;
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    const marks = vi.spyOn(NavigationStore.prototype, 'markItemSeen');
    const selected = [...value.tree.querySelectorAll('[aria-selected="true"]')].map(element => element.getAttribute('data-item-id'));
    const before = { scroll: value.scroller.scrollTop, reading: value.reading.getBoundingClientRect().top, selected };
    let anchor: HTMLElement = value.row;
    if (open === 'hover') {
      fireEvent.mouseEnter(value.row);
      await sleep(400);
    } else if (open === 'click') {
      anchor = value.tree.querySelector<HTMLElement>('[data-item-id="3"] .name-chip')!;
      fireEvent.click(anchor);
    } else fireEvent.keyDown(value.row, { key: ' ' });
    expect(card()).not.toBeNull();
    // A whole second open: the dwell that Details and the dock use must not run in the peek.
    await sleep(1100);
    if (close === 'pointer') {
      if (open === 'hover') { fireEvent.mouseLeave(value.row); await sleep(300); } else fireEvent.mouseDown(document.body);
    } else if (close === 'scroll') {
      if (open === 'hover') fireEvent.scroll(value.scroller);
      else {
        // A card the owner opened ignores the page's own scrolling and closes on the owner's wheel.
        fireEvent.scroll(value.scroller); fireEvent.scroll(document);
        expect(card()).not.toBeNull();
        value.scroller.style.overflowY = 'auto';
        fireEvent.wheel(value.scroller);
      }
    }    else fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(card()).toBeNull());
    await sleep(50);
    expect(marks.mock.calls.filter(call => call[1] === '2')).toEqual([]);
    expect(seenPatches(value.transport)).toHaveLength(0);
    if (open === 'hover') expect(visits(value.transport)).toHaveLength(0);
    else await waitFor(() => expect(visits(value.transport)).toEqual([expect.objectContaining({ item_id: '2', action: 'peeked' })]));
    // The Map never moves: same scroll, same reading row, same selection, nothing scrolled into view or focused with a scroll.
    expect(value.scroller.scrollTop).toBe(before.scroll);
    expect(value.reading.getBoundingClientRect().top).toBe(before.reading);
    expect([...value.tree.querySelectorAll('[aria-selected="true"]')].map(element => element.getAttribute('data-item-id'))).toEqual(before.selected);
    expect(scrolls).not.toHaveBeenCalled();
    expect(focus.mock.calls.filter(call => !call[0]?.preventScroll)).toEqual([]);
    expect(anchor.isConnected).toBe(true);
  });
});

describe('answering in the peek: one send, and the owner’s words and pick survive every close', { timeout: 10_000 }, () => {
  let closeAll = () => {};
  async function setup() {
    const transport = new AppTransport(), service = createDesktopService(transport);
    const source = transport.sessions.get(route.session_id)!;
    source.items['2']!.short = 'Delivery choice';
    source.items['2']!.options = structuredClone(options);
    const store = new SessionStore(service, route), drafts = new OwnerDraftStore(service);
    stores.push(store);
    await Promise.all([store.refresh(), drafts.load()]);
    // Words typed in Details first: the peek has no box of its own, but its Send carries them.
    const id = drafts.begin(source, '2', 'answer')!;
    drafts.edit(id, { text: 'Typed in Details\nkeep both lines' });
    // Hold every send until the test lets it land.
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const invoke = transport.invoke.bind(transport), sent: unknown[] = [];
    vi.spyOn(transport, 'invoke').mockImplementation(async (name: string, args: Parameters<AppTransport['invoke']>[1]) => {
      if ('command' in args.request && args.request.command.command === 'input_submit') { sent.push(args.request); await held; }
      return invoke(name, args);
    });
    function Scroller() {
      const peek = usePeek()!;
      closeAll = () => peek.closeAll();
      return <div className="tree-scroll" data-testid="map">
        <ItemRefSession.Provider value={route}><Markdown text="See [the choice](item:2)." /></ItemRefSession.Provider>
        <button type="button" aria-label="Map row" onKeyDown={event => { if (event.key === ' ') { event.preventDefault(); peek.open({ ...route, item_id: '2' }, event.currentTarget); } }}>Row</button>
      </div>;
    }
    render(<PeekProvider lookup={() => store} drafts={drafts} onGoTo={vi.fn()} onOpenDetails={vi.fn()}><Scroller /></PeekProvider>);
    const chip = () => screen.getByRole('button', { name: `${source.items['2']!.question} · Waiting on me` });
    return { transport, store, drafts, source, chip, release, sent, map: () => screen.getByTestId('map') };
  }
  const pick = () => fireEvent.click(within(card()!).getByRole('button', { name: /^Keep the design/ }));
  const send = () => within(card()!).getByRole('button', { name: 'Send' });

  const repeats = ['double click', 'repeat Enter', '⌘↵ plus click', 'close mid-send', 'scroll mid-send'] as const;
  it.each(repeats)('%s sends exactly once', async repeat => {
    const value = await setup();
    fireEvent.click(value.chip()); pick();
    const button = send(), option = within(card()!).getByRole('button', { name: /^Keep the design/ });
    if (repeat === 'double click') { fireEvent.click(button); fireEvent.click(button); }
    else if (repeat === 'repeat Enter') {
      option.focus();
      fireEvent.keyDown(option, { key: 'Enter' }); fireEvent.keyDown(option, { key: 'Enter', repeat: true }); fireEvent.keyDown(option, { key: 'Enter' });
    } else if (repeat === '⌘↵ plus click') {
      fireEvent.keyDown(within(card()!).getByRole('group', { name: 'Answer' }), { key: 'Enter', metaKey: true });
      fireEvent.click(button);
    } else if (repeat === 'close mid-send') {
      fireEvent.click(button);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(card()).toBeNull();
      // Reopened while the first send is still out: nothing can send again.
      fireEvent.click(value.chip());
      const again = within(card()!).queryByRole('button', { name: 'Send' });
      if (again) fireEvent.click(again);
    } else {
      fireEvent.click(button);
      // A send in flight keeps the card on the owner's scroll too, so its outcome stays in sight.
      value.map().style.overflowY = 'auto';
      fireEvent.scroll(value.map()); fireEvent.wheel(value.map());
      expect(card()).not.toBeNull();
    }
    await waitFor(() => expect(value.sent).toHaveLength(1));
    value.release();
    await waitFor(() => expect(value.drafts.find(route, '2', 'answer')?.receipt).toBeTruthy());
    // After the landing the card offers no second Send.
    if (!card()) fireEvent.click(value.chip());
    await waitFor(() => expect(within(card()!).queryByRole('button', { name: 'Send' })).toBeNull());
    await sleep(20);
    expect(value.sent).toHaveLength(1);
    expect(submits(value.transport)).toHaveLength(1);
    expect(submits(value.transport)[0]!.command).toMatchObject({ params: { selected_option_id: 'yes', text: 'Typed in Details\nkeep both lines', target: { item_id: '2' } } });
  });

  const closings = ['Escape', 'scroll', 'pointer', 'outside click', 'close all'] as const;
  it.each(closings)('closed by %s keeps the typed words and the pick, and sends nothing', async closing => {
    const value = await setup();
    if (closing === 'pointer') { fireEvent.mouseEnter(value.chip()); await sleep(400); } else fireEvent.click(value.chip());
    expect(card()).not.toBeNull();
    pick();
    if (closing === 'Escape') fireEvent.keyDown(document.body, { key: 'Escape' });
    else if (closing === 'scroll') { value.map().style.overflowY = 'auto'; fireEvent.wheel(value.map()); }
    else if (closing === 'outside click') fireEvent.mouseDown(document.body);
    else if (closing === 'close all') act(() => { closeAll(); });
    else { fireEvent.mouseLeave(value.chip()); fireEvent.mouseLeave(card()!); await sleep(300); }
    if (closing === 'pointer') {
      // A card with a pick stays when the pointer leaves; Escape then closes it.
      expect(card()).not.toBeNull();
      fireEvent.keyDown(document.body, { key: 'Escape' });
    }
    expect(card()).toBeNull();
    expect(value.drafts.find(route, '2', 'answer')?.draft).toMatchObject({ text: 'Typed in Details\nkeep both lines', selected_option_id: 'yes' });
    fireEvent.click(value.chip());
    expect(within(card()!).getByRole('button', { name: /^Keep the design/ }).getAttribute('aria-pressed')).toBe('true');
    expect(value.sent).toHaveLength(0);
  });

  it('closeAll keeps a card whose send is in flight', async () => {
    const value = await setup();
    fireEvent.click(value.chip()); pick(); fireEvent.click(send());
    await waitFor(() => expect(value.sent).toHaveLength(1));
    act(() => { closeAll(); });
    expect(card()).not.toBeNull();
    value.release();
    await waitFor(() => expect(value.drafts.find(route, '2', 'answer')?.receipt).toBeTruthy());
    expect(value.sent).toHaveLength(1);
  });
});
