import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createDesktopService } from '../../../src/data/service';
import { SessionStore } from '../../../src/data/session-store';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { NavigationStore } from '../../../src/state/navigation/store';
import { PeekProvider, usePeek, type PeekProviderProps } from '../../../src/ui/peek/Peek';
import { AnswerSlot } from '../../../src/ui/detail/AnswerSlot';
import { ItemRefSession } from '../../../src/ui/peek/context';
import { ItemReference, ItemRefs, Markdown } from '../../../src/ui/shared/MarkdownText';
import { peekPosition } from '../../../src/ui/peek/position';
import { peekNames } from '../../../src/ui/peek/names';
import { peekChange } from '../../../src/ui/peek/change';
import type { ItemChangeBefore } from '../../../src/generated/domain/models';
import { immutable } from '../../../src/data/session-store';
import { AppTransport, route } from '../app/transport';
import { answerWords } from '../answer/words';

const stores: SessionStore[] = [], navigations: NavigationStore[] = [];
afterEach(() => {
  cleanup(); vi.useRealTimers(); stores.splice(0).forEach(store => store.close()); navigations.splice(0).forEach(store => store.stop());
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function setup() {
  const transport = new AppTransport(), service = createDesktopService(transport);
  const source = transport.sessions.get(route.session_id)!;
  source.items['2']!.short = 'Delivery choice';
  source.items['2']!.type = 'question';
  source.items['2']!.options = [{ id: 'yes', label: 'Keep the design', recommended: true, consequence: 'Retain the current contract.' },
    { id: 'no', label: 'Change the design', recommended: false, consequence: 'Review a new contract.' }];
  const store = new SessionStore(service, route), drafts = new OwnerDraftStore(service);
  stores.push(store);
  await Promise.all([store.refresh(), drafts.load()]);
  return { transport, source, store, drafts };
}

function RowSource() {
  const peek = usePeek()!;
  return <button type="button" aria-label="Map row" onKeyDown={event => { if (event.key === ' ') { event.preventDefault(); peek.open({ ...route, item_id: '2' }, event.currentTarget); } }}>Delivery choice row</button>;
}

function mount(value: Awaited<ReturnType<typeof setup>>, extra: Partial<PeekProviderProps> = {}) {
  const go = vi.fn(), open = vi.fn(), visit = vi.fn();
  render(<PeekProvider lookup={() => value.store} drafts={value.drafts} onGoTo={go} onOpenDetails={open} onVisit={visit} {...extra}>
    <ItemRefSession.Provider value={route}>
      <Markdown text="See [#2](item:2) and [#8](item:8)." />
      <RowSource /><button type="button">Outside control</button>
    </ItemRefSession.Provider>
  </PeekProvider>);
  return { go, open, visit, chip: () => screen.getByRole('button', { name: `${value.source.items['2']!.question} · Waiting on me` }) };
}

describe('name chips and item peek', () => {
  it('heads the card with the short name and status, and gives the full question in the summary and the card name', async () => {
    const value = await setup();
    const title = 'Add the receipt lookup test and keep its full result explanation available before choosing the next delivery window.';
    value.source.items['2']!.question = title; ++value.source.revision;
    await value.store.refresh();
    const { chip } = mount(value);
    expect(chip().textContent).toBe('Delivery choice');
    fireEvent.click(chip());
    const peek = screen.getByRole('dialog', { name: `Peek: ${title}` });
    const heading = within(peek).getByRole('heading', { level: 2 });
    expect(heading.textContent).toBe('Delivery choice');
    expect(heading.title).toBe(title);
    expect(peek.querySelector('.peek-head')!.textContent).toContain('Waiting on me');
    expect(peek.querySelector('.peek-summary')!.textContent).toBe(title);
    // An outcome, once there is one, is the summary instead.
    value.source.items['2']!.outcome = 'Ship it in the morning window.'; ++value.source.revision;
    await act(async () => { await value.store.refresh(); });
    expect(peek.querySelector('.peek-summary')!.textContent).toBe('Ship it in the morning window.');
  });

  it('has the board footer: esc to close, Open details and Go to, and no Copy reference', async () => {
    const value = await setup(), { chip, go, open } = mount(value);
    fireEvent.click(chip());
    const peek = screen.getByRole('dialog');
    const footer = peek.querySelector<HTMLElement>('.peek-footer')!;
    expect([...footer.querySelectorAll('button')].map(button => button.textContent)).toEqual(['esc to close', 'Open details', 'Go to']);
    expect(within(peek).queryByRole('button', { name: /Copy/ })).toBeNull();
    fireEvent.click(within(footer).getByRole('button', { name: 'Open details' }));
    expect(open).toHaveBeenCalledWith({ ...route, item_id: '2' });
    expect(go).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(chip());
    fireEvent.click(screen.getByRole('button', { name: 'Go to' }));
    expect(go).toHaveBeenCalledWith({ ...route, item_id: '2' });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('keeps running-text names inside the existing line box while retaining keyboard peek and focus return', async () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(resolve(__dirname, '../../../src/ui/peek/peek.css'), 'utf8');
    document.head.append(style);
    try {
      const value = await setup(), { chip } = mount(value);
      const computed = getComputedStyle(chip());
      expect(computed.display).toBe('inline');
      expect(computed.padding).toBe('0px');
      expect(computed.borderTopWidth).toBe('0px');
      chip().focus(); fireEvent.keyDown(chip(), { key: ' ' });
      expect(screen.getByRole('dialog', { name: `Peek: ${value.source.items['2']!.question}` })).toBeTruthy();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(document.activeElement).toBe(chip());
    } finally { style.remove(); }
  });

  it('answers a current waiting ask on a task through the same safe answer submission', async () => {
    const value = await setup(); value.source.items['2']!.type = 'task'; ++value.source.revision; await value.store.refresh();
    const { chip } = mount(value); fireEvent.click(chip());
    const peek = screen.getByRole('dialog', { name: `Peek: ${value.source.items['2']!.question}` });
    // The peek answers with option cards and Send only.
    expect(within(peek).queryByRole('textbox')).toBeNull();
    fireEvent.click(within(peek).getByRole('button', { name: /^Change the design/ }));
    fireEvent.click(within(peek).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(value.transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(1));
    expect(value.transport.mutations.find(request => request.command.command === 'input_submit')).toMatchObject({
      command: { params: { target: { item_id: '2' }, kind: 'answer', selected_option_id: 'no' } },
    });
  });

  it('uses names through session scope, opens on click/Space, replaces one peek, and restores focus with Escape', async () => {
    const value = await setup(), { chip, go, visit } = mount(value);
    expect(chip().textContent).toBe('Delivery choice');
    expect(chip().textContent).not.toContain('#2');
    chip().focus(); fireEvent.keyDown(chip(), { key: ' ' });
    const first = screen.getByRole('dialog', { name: `Peek: ${value.source.items['2']!.question}` });
    expect(within(first).getByText('Waiting on me')).toBeTruthy();
    expect(document.activeElement).toBe(within(first).getByRole('button', { name: 'Close peek' }));
    fireEvent.click(screen.getByRole('button', { name: `${value.source.items['8']!.question} · Open` }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.queryByRole('dialog', { name: `Peek: ${value.source.items['2']!.question}` })).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement?.textContent).toContain('Preserve');
    fireEvent.click(chip());
    fireEvent.click(screen.getByRole('button', { name: 'Go to' }));
    expect(go).toHaveBeenCalledWith({ ...route, item_id: '2' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(visit.mock.calls.map(call => call[1])).toEqual(['peek', 'peek', 'peek', 'opened']);
  });

  it('supports a Map-row Space source and keeps outside clicks focused on their destination', async () => {
    const value = await setup(); mount(value);
    const row = screen.getByRole('button', { name: 'Map row' }); row.focus();
    fireEvent.keyDown(row, { key: ' ' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(row);
    fireEvent.keyDown(row, { key: ' ' });
    const outside = screen.getByRole('button', { name: 'Outside control' });
    fireEvent.mouseDown(outside); outside.focus();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  it('opens after 350 ms of a resting pointer, with no Recent visit, and cancels on an early leave or blur', async () => {
    const value = await setup(); vi.useFakeTimers();
    const { chip, visit } = mount(value);
    fireEvent.mouseEnter(chip()); act(() => vi.advanceTimersByTime(349));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.mouseLeave(chip()); act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.mouseEnter(chip()); fireEvent.blur(window); act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole('dialog')).toBeNull();
    // Moving over the same name does not restart the wait.
    fireEvent.mouseEnter(chip()); act(() => vi.advanceTimersByTime(200));
    fireEvent.mouseMove(chip()); act(() => vi.advanceTimersByTime(150));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
    expect(visit).not.toHaveBeenCalled();
  });

  it('closes 260 ms after the pointer leaves, unless the pointer reaches the card or the owner uses it', async () => {
    const value = await setup(); vi.useFakeTimers();
    const { chip } = mount(value);
    const hover = () => { fireEvent.mouseEnter(chip()); act(() => vi.advanceTimersByTime(350)); return screen.getByRole('dialog'); };
    hover(); fireEvent.mouseLeave(chip()); act(() => vi.advanceTimersByTime(259));
    expect(screen.getByRole('dialog')).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole('dialog')).toBeNull();
    // Into the card within the grace: it stays; out of it: the same grace.
    let card = hover(); fireEvent.mouseLeave(chip()); act(() => vi.advanceTimersByTime(200));
    fireEvent.mouseEnter(card); act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole('dialog')).toBe(card);
    fireEvent.mouseLeave(card); act(() => vi.advanceTimersByTime(260));
    expect(screen.queryByRole('dialog')).toBeNull();
    // A pick keeps it: the owner is using the card.
    card = hover(); fireEvent.mouseLeave(chip()); fireEvent.mouseEnter(card);
    fireEvent.click(within(card).getByRole('button', { name: /^Keep the design/ }));
    fireEvent.mouseLeave(card); act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole('dialog')).toBe(card);
    fireEvent.keyDown(document, { key: 'Escape' });
    // Focus inside keeps it too.
    card = hover(); within(card).getByRole('button', { name: 'Go to' }).focus();
    fireEvent.mouseLeave(chip()); act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole('dialog')).toBe(card);
    fireEvent.keyDown(document, { key: 'Escape' });
    // A card opened by click is not closed by a passing pointer either.
    fireEvent.click(chip()); fireEvent.mouseLeave(chip()); act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('a passing pointer never replaces a card the owner opened; a click does', async () => {
    const value = await setup(); vi.useFakeTimers();
    const { chip } = mount(value), other = () => screen.getByRole('button', { name: `${value.source.items['8']!.question} · Open` });
    fireEvent.click(chip());
    fireEvent.mouseEnter(other()); act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole('dialog', { name: `Peek: ${value.source.items['2']!.question}` })).toBeTruthy();
    fireEvent.click(other());
    expect(screen.getByRole('dialog', { name: `Peek: ${value.source.items['8']!.question}` })).toBeTruthy();
  });

  // The owner's scrolling closes a card they opened; a scroll the page makes by itself does not (Details and the Map scroll
  // themselves, and the card must survive the click that opened it).
  it('an opened card survives a programmatic scroll of what holds its name', async () => {
    const value = await setup(), { chip } = mount(value);
    fireEvent.click(chip());
    const card = screen.getByRole('dialog');
    fireEvent.scroll(chip().parentElement!); fireEvent.scroll(document); fireEvent.scroll(document.documentElement);
    expect(screen.getByRole('dialog')).toBe(card);
  });

  it.each(['wheel', 'touchmove'] as const)('an opened card closes on the owner\'s %s over a scroller that holds its name, not inside the card or elsewhere', async kind => {
    const value = await setup(), { chip } = mount(value);
    const unrelated = document.createElement('div'); document.body.append(unrelated);
    const scroller = chip().parentElement!; scroller.style.overflowY = 'auto';
    const fire = (target: Element) => kind === 'wheel' ? fireEvent.wheel(target) : fireEvent.touchMove(target);
    try {
      fireEvent.click(chip());
      const card = screen.getByRole('dialog');
      fire(card); fire(unrelated);
      expect(screen.getByRole('dialog')).toBe(card);
      fire(scroller);
      expect(screen.queryByRole('dialog')).toBeNull();
      // The card had focus: it goes back to the name, without a scroll.
      expect(document.activeElement).toBe(chip());
      fireEvent.click(chip()); fire(chip());
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally { unrelated.remove(); }
  });

  it('a wheel over a part of the page that does not hold its name leaves the card', async () => {
    const value = await setup(), { chip } = mount(value);
    chip().parentElement!.style.overflowY = 'hidden';
    fireEvent.click(chip());
    fireEvent.wheel(chip().parentElement!);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('a hover card still closes on any scroll of what holds its name, not inside the card or elsewhere', async () => {
    const value = await setup(); vi.useFakeTimers();
    const { chip } = mount(value);
    const unrelated = document.createElement('div'); document.body.append(unrelated);
    try {
      fireEvent.mouseEnter(chip()); act(() => vi.advanceTimersByTime(350));
      const card = screen.getByRole('dialog');
      fireEvent.scroll(card); fireEvent.scroll(unrelated);
      expect(screen.getByRole('dialog')).toBe(card);
      fireEvent.scroll(chip().parentElement!);
      expect(screen.queryByRole('dialog')).toBeNull();
      fireEvent.mouseLeave(chip()); fireEvent.mouseEnter(chip()); act(() => vi.advanceTimersByTime(350));
      fireEvent.scroll(document);
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally { unrelated.remove(); }
  });

  it.each(['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'])('an opened card closes on %s while focus is outside it, and keeps focus inside it', async key => {
    const value = await setup(), { chip } = mount(value);
    fireEvent.click(chip());
    const card = screen.getByRole('dialog');
    fireEvent.keyDown(card, { key });
    expect(screen.getByRole('dialog')).toBe(card);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Outside control' }), { key });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Space closes an opened card from the page, but on a control or the name itself it keeps its own meaning', async () => {
    const value = await setup(), { chip } = mount(value);
    fireEvent.click(chip());
    fireEvent.keyDown(screen.getByRole('button', { name: 'Outside control' }), { key: ' ' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    // Space on the name toggles: one press closes, and it does not reopen.
    chip().focus(); fireEvent.keyDown(chip(), { key: ' ' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(chip());
    fireEvent.keyDown(document.body, { key: ' ' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('typing in a field outside the card keeps it: arrow keys move the caret there', async () => {
    const value = await setup(), { chip } = mount(value);
    const field = document.createElement('textarea'); document.body.append(field);
    try {
      fireEvent.click(chip());
      fireEvent.keyDown(field, { key: 'ArrowDown' }); fireEvent.keyDown(field, { key: 'Home' });
      expect(screen.getByRole('dialog')).toBeTruthy();
    } finally { field.remove(); }
  });

  it('a press cancels a pending hover until the pointer leaves the name and rests again', async () => {
    const value = await setup(); vi.useFakeTimers();
    const { chip } = mount(value), row = screen.getByRole('button', { name: 'Map row' });
    fireEvent.mouseEnter(chip()); act(() => vi.advanceTimersByTime(200));
    fireEvent.mouseDown(row); fireEvent.mouseMove(chip()); act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.mouseLeave(chip()); fireEvent.mouseEnter(chip()); act(() => vi.advanceTimersByTime(350));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('a resting pointer reopens a card a scroll closed, but not one the owner dismissed with Escape', async () => {
    const value = await setup(); vi.useFakeTimers();
    const { chip } = mount(value);
    fireEvent.mouseEnter(chip()); act(() => vi.advanceTimersByTime(350));
    fireEvent.scroll(chip().parentElement!);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.mouseMove(chip()); act(() => vi.advanceTimersByTime(350));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseMove(chip()); act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.mouseLeave(chip()); fireEvent.mouseEnter(chip()); act(() => vi.advanceTimersByTime(350));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('Space toggles the card from a name', async () => {
    const value = await setup(), { chip, visit } = mount(value);
    chip().focus(); fireEvent.keyDown(chip(), { key: ' ' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(chip(), { key: ' ' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(visit.mock.calls.map(call => call[1])).toEqual(['peek']);
  });

  it.each(['click', 'hover'] as const)('never marks seen and keeps the Changed pill and change strip through a long %s peek', async how => {
    const value = await setup(), since = '2026-10-01T00:00:00.000Z', at = '2026-10-13T21:08:00.000Z';
    const item = value.source.items['2']!;
    item.revision = 2; item.created_at = since; ++value.source.revision;
    item.changes = [{ revision: 2, at, cause_message_id: item.created_message_id, reason: 'First draft is in the docs folder.', before: { status: 'open' } }];
    value.transport.preferences.seen = [{ session: route, since, items: [], topics: [] }];
    await value.store.refresh();
    const navigation = new NavigationStore(createDesktopService(value.transport)); navigations.push(navigation);
    await navigation.start();
    const marks = vi.spyOn(NavigationStore.prototype, 'markItemSeen');
    const { chip } = mount(value, { navigation });
    vi.useFakeTimers();
    if (how === 'click') fireEvent.click(chip()); else { fireEvent.mouseEnter(chip()); act(() => vi.advanceTimersByTime(350)); }
    const card = screen.getByRole('dialog');
    const pill = () => within(card).queryByTestId('change-marker');
    expect(pill()?.getAttribute('aria-label')).toBe('Changed');
    expect(pill()?.title).toBe('Changed since you last saw it');
    const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
    expect(card.querySelector('.peek-strip')!.textContent).toBe(`Changed · ${time}. First draft is in the docs folder.`);
    act(() => vi.advanceTimersByTime(5000));
    vi.useRealTimers();
    await act(async () => { await Promise.resolve(); });
    expect(pill()?.getAttribute('aria-label')).toBe('Changed');
    expect(marks).not.toHaveBeenCalled();
    expect(value.transport.mutations.some(request => request.command.command === 'preferences_patch'
      && request.command.params.entries.some(entry => entry.kind === 'mark_seen'))).toBe(false);
  });

  it('keeps hover previews from taking editor Escape or restoring focus on close', async () => {
    const value = await setup(); vi.useFakeTimers(); const { chip } = mount(value), editorKeys = vi.fn();
    render(<input aria-label="Outside editor" onKeyDown={editorKeys} />);
    const editor = screen.getByRole('textbox', { name: 'Outside editor' }); editor.focus();
    const hover = () => { fireEvent.mouseLeave(chip()); fireEvent.mouseEnter(chip()); act(() => vi.advanceTimersByTime(350)); };
    hover(); expect(document.activeElement).toBe(editor);
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(editorKeys).toHaveBeenCalledTimes(1); expect(editorKeys.mock.calls[0][0].defaultPrevented).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(editor);
    hover(); fireEvent.click(screen.getByRole('button', { name: 'Close peek' }));
    expect(document.activeElement).toBe(editor);
    hover(); screen.getByRole('button', { name: 'Close peek' }).focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(document.activeElement).toBe(chip()); expect(editorKeys).toHaveBeenCalledTimes(1);
  });

  it('carries the original anchor position and focus source through nested replacement', async () => {
    const value = await setup(); value.source.items['2']!.outcome = 'Review [the branch](item:8).'; ++value.source.revision;
    await value.store.refresh(); const { chip } = mount(value), source = chip();
    vi.spyOn(source, 'getBoundingClientRect').mockReturnValue({ left: 300, right: 400, top: 200, bottom: 220, width: 100, height: 20 } as DOMRect);
    source.focus(); fireEvent.click(source);
    const first = screen.getByRole('dialog'), position = { left: first.style.left, top: first.style.top };
    const nested = within(first).getByRole('button', { name: `${value.source.items['8']!.question} · Open` });
    vi.spyOn(nested, 'getBoundingClientRect').mockReturnValue({ left: 12, right: 20, top: 12, bottom: 20, width: 8, height: 8 } as DOMRect);
    fireEvent.click(nested);
    const replacement = screen.getByRole('dialog'); expect(nested.isConnected).toBe(false);
    expect(replacement.style.left).toBe(position.left); expect(replacement.style.top).toBe(position.top);
    fireEvent(window, new Event('resize'));
    expect(replacement.style.left).toBe(position.left); expect(replacement.style.top).toBe(position.top);
    fireEvent.keyDown(document, { key: 'Escape' }); expect(document.activeElement).toBe(source);
  });

  it('preserves agent words for removed references and honors owner text suppression under a session scope', async () => {
    const value = await setup(); value.source.items['8']!.removed_at = value.source.updated_at; ++value.source.revision;
    await value.store.refresh();
    const { container } = render(<PeekProvider lookup={() => value.store} drafts={value.drafts} onGoTo={vi.fn()} onOpenDetails={vi.fn()}>
      <ItemRefSession.Provider value={route}><ItemRefs.Provider value={{ lookup: () => null, onOpenItem: vi.fn() }}>
        <Markdown text="Keep [the agent’s original words](item:8)." />
        <ItemRefs.Provider value={null}><Markdown text="Keep [my exact words](item:2)." /><ItemReference itemId="2">Owner reference</ItemReference></ItemRefs.Provider>
      </ItemRefs.Provider></ItemRefSession.Provider>
    </PeekProvider>);
    expect(container.textContent).toContain('the agent’s original words (item unavailable)');
    expect(container.textContent).toContain('Keep my exact words.'); expect(container.textContent).toContain('Owner reference');
    expect(container.querySelector('button, a')).toBeNull();
  });

  it('keeps a hover pending across parent refreshes and uses the latest visit callback for an explicit open', async () => {
    const value = await setup(); vi.useFakeTimers();
    const visited = vi.fn();
    const tree = (renderCount: number) => <PeekProvider lookup={() => value.store} drafts={value.drafts} onGoTo={() => {}} onOpenDetails={() => {}} onVisit={() => visited(renderCount)}>
      <ItemRefSession.Provider value={route}><ItemReference itemId="2" /></ItemRefSession.Provider>
    </PeekProvider>;
    const { rerender } = render(tree(1));
    const chip = screen.getByRole('button');
    fireEvent.mouseEnter(chip); act(() => vi.advanceTimersByTime(200));
    rerender(tree(2)); act(() => vi.advanceTimersByTime(150));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(visited).not.toHaveBeenCalled();
    rerender(tree(3)); fireEvent.click(chip);
    expect(visited).toHaveBeenCalledExactlyOnceWith(3);
  });

  it('shows distinguishing names for colliding short labels and keeps missing references inert', async () => {
    const value = await setup();
    value.source.items['2']!.short = value.source.items['8']!.short = 'Receipt lookup';
    value.source.items['8']!.topic_id = value.source.items['2']!.topic_id;
    value.source.items['2']!.question = 'Keep the receipt lookup in the delivery handler?';
    value.source.items['8']!.question = 'Keep the receipt lookup in the retry handler?';
    ++value.source.revision; await value.store.refresh();
    mount(value);
    expect(screen.getByRole('button', { name: `${value.source.items['2']!.question} · Waiting on me` }).textContent).toBe('delivery · Receipt lookup');
    expect(screen.getByRole('button', { name: `${value.source.items['8']!.question} · Open` }).textContent).toBe('retry · Receipt lookup');
    const { container } = render(<PeekProvider lookup={() => value.store} drafts={value.drafts} onGoTo={vi.fn()} onOpenDetails={vi.fn()}><ItemRefSession.Provider value={route}>
      <ItemReference itemId="404">Unknown reference</ItemReference>
    </ItemRefSession.Provider></PeekProvider>);
    expect(container.querySelector('button')).toBeNull();
  });

});

describe('simple question answers in peek', () => {
  it('shares the option and exact words with Details in both directions', async () => {
    const value = await setup();
    const detail = render(<AnswerSlot drafts={value.drafts} store={value.store} itemId="2" onEscape={vi.fn()} />);
    const words = ' Keep these words\nand this line. ';
    await waitFor(() => expect(document.querySelector('[data-answer-own]')).not.toBeNull());
    fireEvent.change(answerWords(), { target: { value: words } });
    fireEvent.click(screen.getByRole('button', { name: /^Keep the design/ }));
    detail.unmount();
    const { chip } = mount(value); fireEvent.click(chip());
    // The peek shows the pick; its Send would carry the Details words as the note.
    expect(screen.getByRole('button', { name: /^Keep the design/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Change the design/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Close peek' }));
    render(<AnswerSlot drafts={value.drafts} store={value.store} itemId="2" onEscape={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^Change the design/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Add a note for the agent' }).value).toBe(words);
    expect(value.drafts.find(route, '2', 'answer')?.draft).toMatchObject({ selected_option_id: 'no', text: words });
    expect(value.transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(0);
  });

  it('retains the durable pick after closing and sends one input despite repeated sends and reopening', async () => {
    const value = await setup(), { chip, visit } = mount(value);
    fireEvent.click(chip());
    fireEvent.click(screen.getByRole('button', { name: /^Keep the design/ }));
    fireEvent.keyDown(document, { key: 'Escape' }); fireEvent.click(chip());
    expect(screen.getByRole('button', { name: /^Keep the design/ }).getAttribute('aria-pressed')).toBe('true');
    const send = screen.getByRole('button', { name: 'Send' }); fireEvent.click(send); fireEvent.click(send);
    await waitFor(() => expect(value.transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(1));
    await waitFor(() => expect(visit).toHaveBeenCalledWith({ ...route, item_id: '2' }, 'answered'));
    const request = value.transport.mutations.find(request => request.command.command === 'input_submit')!;
    expect(request.command).toMatchObject({ command: 'input_submit', params: { kind: 'answer', selected_option_id: 'yes', target: { item_id: '2' } } });
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Map row' }), { key: ' ' });
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(value.transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(1);
  });

  describe('closing the card while the send is in flight', () => {
    const submits = (value: Awaited<ReturnType<typeof setup>>) => value.transport.mutations.filter(request => request.command.command === 'input_submit');
    /** Holds the response of the answer's submit until `release(error?)`; the request itself is recorded at once. */
    function hold(value: Awaited<ReturnType<typeof setup>>) {
      let release!: (error?: Error) => void;
      const gate = new Promise<void>((resolve, reject) => { release = error => { if (error) reject(error); else resolve(); }; });
      const invoke = value.transport.invoke.bind(value.transport);
      vi.spyOn(value.transport, 'invoke').mockImplementation(async (name, args) => {
        const request = args.request as { command?: { command?: string } };
        if (request.command?.command === 'input_submit') { const result = await invoke(name, args); await gate; return result; }
        return invoke(name, args);
      });
      return release;
    }
    const pickAndSend = (chip: () => HTMLElement) => {
      fireEvent.click(chip());
      fireEvent.click(screen.getByRole('button', { name: /^Keep the design/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    };
    it.each([['the Close button', () => fireEvent.click(screen.getByRole('button', { name: 'Close peek' }))],
      ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })]] as const)('still records "answered" once, and sends once, when %s closes it before the reply', async (_name, close) => {
      const value = await setup(), { chip, visit } = mount(value), release = hold(value);
      pickAndSend(chip);
      await waitFor(() => expect(submits(value)).toHaveLength(1));
      close();
      expect(visit).not.toHaveBeenCalledWith({ ...route, item_id: '2' }, 'answered');
      await act(async () => { release(); await Promise.resolve(); });
      await waitFor(() => expect(visit).toHaveBeenCalledWith({ ...route, item_id: '2' }, 'answered'));
      expect(visit.mock.calls.filter(([, action]) => action === 'answered')).toHaveLength(1);
      // Reopening shows no second send and no second request is made.
      fireEvent.click(chip());
      expect(submits(value)).toHaveLength(1);
    });
    it('keeps the draft and records nothing when the send fails after the card closed', async () => {
      const value = await setup(), { chip, visit } = mount(value), release = hold(value);
      pickAndSend(chip);
      await waitFor(() => expect(submits(value)).toHaveLength(1));
      fireEvent.click(screen.getByRole('button', { name: 'Close peek' }));
      await act(async () => { release(new Error('Connection lost')); await Promise.resolve(); });
      await waitFor(() => expect(value.drafts.find(route, '2', 'answer')?.draft).toMatchObject({ selected_option_id: 'yes' }));
      expect(visit.mock.calls.filter(([, action]) => action === 'answered')).toHaveLength(0);
      // The words are still the owner's: the draft stays, with its one operation id, and nothing was sent again.
      expect(value.drafts.find(route, '2', 'answer')?.draft.op_id).toBeTruthy();
      expect(submits(value)).toHaveLength(1);
    });
  });

  it('sends an option pick through the same durable answer path', async () => {
    const value = await setup(), { chip } = mount(value); fireEvent.click(chip());
    const pick = screen.getByRole('button', { name: /^Keep the design/ });
    // Compact cards carry the consequence in their title.
    expect(pick.title).toBe('Keep the design\nRetain the current contract.');
    expect(pick.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(pick); fireEvent.click(pick);
    expect(value.transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(0);
    const send = screen.getByRole('button', { name: 'Send' });
    fireEvent.click(send); fireEvent.click(send);
    await waitFor(() => expect(value.transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(1));
    expect(value.transport.mutations.find(request => request.command.command === 'input_submit')!.command).toMatchObject({ params: { selected_option_id: 'yes', kind: 'answer' } });
  });

  it('keeps a multiline Details draft untouched in the peek, and blocks answering a changed question until reviewed', async () => {
    const value = await setup();
    const id = value.drafts.begin(value.source, '2', 'answer')!;
    value.drafts.edit(id, { text: 'Long first line\nKeep the full second line.' });
    const { chip, open } = mount(value); fireEvent.click(chip());
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('button', { name: /^Keep the design/ }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Open details' }));
    expect(open).toHaveBeenCalledWith({ ...route, item_id: '2' });
    expect(value.drafts.find(route, '2', 'answer')?.draft.text).toBe('Long first line\nKeep the full second line.');
    value.drafts.edit(id, { text: 'A short answer' });
    ++value.source.items['2']!.question_revision; ++value.source.items['2']!.revision; ++value.source.revision;
    await act(async () => { await value.store.refresh(); });
    fireEvent.click(chip());
    expect(screen.getByText('This item changed. Review the current question and options; your text is retained.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);
    expect(value.transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(0);
  });

  it('keeps multiline own words as the note when the peek picks an option, with no own-answer card of its own', async () => {
    const value = await setup(), text = 'Before first line\nsecond line after';
    const id = value.drafts.begin(value.source, '2', 'answer')!;
    value.drafts.edit(id, { text });
    const { chip, open } = mount(value); fireEvent.click(chip());
    expect(screen.queryByRole('button', { name: 'Write my own answer' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Keep the design/ }));
    expect(value.drafts.find(route, '2', 'answer')?.draft).toMatchObject({ text, selected_option_id: 'yes' });
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open details' }));
    expect(open).toHaveBeenCalledWith({ ...route, item_id: '2' });
    expect(value.transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(0);
  });

  it('starts a fresh durable answer after an earlier round receipt and sends the new round once', async () => {
    const value = await setup();
    const oldId = value.drafts.begin(value.source, '2', 'answer')!;
    value.drafts.edit(oldId, { text: 'Earlier round answer' });
    expect(await value.drafts.submit(oldId)).toBe(true);
    const item = value.source.items['2']!, previous = value.source.rounds[item.current_round_id!]!;
    previous.closed_at = value.source.updated_at;
    ++item.revision; ++item.question_revision; ++value.source.revision;
    item.question = 'Which delivery window for this new round?';
    item.current_round_id = crypto.randomUUID();
    value.source.rounds[item.current_round_id] = { ...structuredClone(previous), id: item.current_round_id, ordinal: previous.ordinal + 1,
      question_snapshot: item.question, question_revision: item.question_revision, options_snapshot: structuredClone(item.options), closed_at: null,
      owner_message_ids: [], agent_message_ids: [], result_input_ids: [], fork_item_ids: [] };
    await value.store.refresh();
    const { chip } = mount(value); fireEvent.click(chip());
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: /^Change the design/ }).disabled).toBe(false));
    expect(value.drafts.find(route, '2', 'answer')?.draft.op_id).not.toBe(oldId);
    fireEvent.click(screen.getByRole('button', { name: /^Change the design/ }));
    const send = screen.getByRole('button', { name: 'Send' }); fireEvent.click(send); fireEvent.click(send);
    await waitFor(() => expect(value.transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(2));
    const latest = value.transport.mutations.filter(request => request.command.command === 'input_submit')[1]!;
    expect(latest.command).toMatchObject({ params: { selected_option_id: 'no', kind: 'answer' } });
    expect(latest.command.op_id).not.toBe(oldId);
  });

  it('subscribes to session changes and removes answer controls when the session closes', async () => {
    const value = await setup(), { chip } = mount(value); fireEvent.click(chip());
    expect(document.querySelector('.item-peek [data-answer-option]')).not.toBeNull();
    value.source.state = 'closed'; ++value.source.revision;
    await act(async () => { await value.store.refresh(); });
    expect(document.querySelector('.item-peek [data-answer-option]')).toBeNull();
    expect(screen.getByText(/This session is closed/)).toBeTruthy();
    expect(value.transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(0);
  });
});

describe('peek viewport position', () => {
  it('flips above a name near the bottom, counting the card border, and re-fits on resize', async () => {
    const rectangle = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.matches('.name-chip') ? new DOMRect(900, 650, 80, 20) : rectangle.call(this);
    });
    vi.stubGlobal('innerWidth', 1000); vi.stubGlobal('innerHeight', 700);
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(400);
    const style = document.createElement('style'); style.textContent = '.item-peek { border: 1px solid black; width: 340px; }'; document.head.append(style);
    try {
      const value = await setup(), { chip } = mount(value);
      fireEvent.click(chip());
      const card = screen.getByRole('dialog');
      expect(card.style.top).toBe('242px'); // 650 - 6 - (400 + two border pixels).
      expect(card.style.left).toBe('652px'); // 1000 - 8 - 340.
      expect(card.style.maxHeight).toBe('402px');
      height.mockReturnValue(990);
      fireEvent(window, new Event('resize'));
      expect(card.style.top).toBe('48px');
      expect(card.style.maxHeight).toBe('596px');
    } finally { style.remove(); }
  });

  it('sits under the marked name of a row rather than the whole row', async () => {
    const value = await setup();
    function Row() {
      const peek = usePeek()!;
      return <div role="treeitem" aria-selected={false} tabIndex={0} data-testid="row" onKeyDown={event => peek.open({ ...route, item_id: '2' }, event.currentTarget)}>
        <span data-peek-anchor>Delivery choice</span></div>;
    }
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.matches('[data-peek-anchor]') ? new DOMRect(75, 300, 120, 20) : new DOMRect(20, 290, 900, 40);
    });
    vi.stubGlobal('innerWidth', 1000); vi.stubGlobal('innerHeight', 800);
    render(<PeekProvider lookup={() => value.store} drafts={value.drafts} onGoTo={vi.fn()} onOpenDetails={vi.fn()}><Row /></PeekProvider>);
    fireEvent.keyDown(screen.getByTestId('row'), { key: ' ' });
    expect(screen.getByRole('dialog').style.left).toBe('75px');
    expect(screen.getByRole('dialog').style.top).toBe('326px');
  });

  it('opens under the name, aligned to it, 8px inside the window, and above it only when below does not fit', () => {
    expect(peekPosition({ left: 100, right: 180, top: 200, bottom: 220 }, 340, 300, 1000, 800)).toEqual({ left: 100, top: 226, maxWidth: 984, maxHeight: 566 });
    expect(peekPosition({ left: 900, right: 980, top: 200, bottom: 220 }, 340, 300, 1000, 800)).toMatchObject({ left: 652, top: 226 });
    expect(peekPosition({ left: 100, right: 180, top: 700, bottom: 720 }, 340, 300, 1000, 800)).toEqual({ left: 100, top: 394, maxWidth: 984, maxHeight: 300 });
    // Neither side fits: the larger one, never above 48px, scrolling inside.
    expect(peekPosition({ left: 100, right: 180, top: 200, bottom: 220 }, 340, 600, 1000, 300)).toEqual({ left: 100, top: 48, maxWidth: 984, maxHeight: 146 });
    expect(peekPosition({ left: 10, right: 40, top: 10, bottom: 20 }, 340, 100, 200, 300)).toEqual({ left: 8, top: 26, maxWidth: 184, maxHeight: 266 });
  });
});

describe('the card’s marker and change strip', () => {
  const since = '2026-10-01T00:00:00.000Z', at = '2026-10-13T21:12:00.000Z';
  const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
  it.each([
    ['an options change', { options: [] }, 'waiting_on_me', false, `Options changed · ${time}.`],
    ['progress on work in hand', { note: 'Earlier' }, 'in_progress', false, `Progress · ${time}.`],
    ['any other change', { status: 'open' }, 'decided', false, `Changed · ${time}.`],
    ['a change the owner’s answer caused', { status: 'open' }, 'decided', true, 'Changed by your answer:'],
  ] as const)('labels %s', async (_name, before, status, byAnswer, label) => {
    const { source } = await setup(), item = source.items['2']!;
    Object.assign(item, { status, created_at: since, revision: 3 });
    const cause = byAnswer ? source.messages.find(message => message.input_id)! : source.messages.find(message => !message.input_id)!;
    item.changes = [
      { revision: 2, at, cause_message_id: cause.id, reason: 'An older change.', before: { status: 'open' } },
      { revision: 3, at, cause_message_id: cause.id, reason: 'Three options now.', before: structuredClone(before) as ItemChangeBefore },
    ];
    const seen = { session: route, since, items: [], topics: [] };
    expect(peekChange(source, item, seen)).toEqual({ marker: 'changed', strip: { label, text: 'Three options now.' } });
    // Read up to the latest revision: nothing to say. New items get the New pill and no strip.
    expect(peekChange(source, item, { ...seen, items: [{ item_id: '2', revision: 3 }] })).toEqual({ marker: null, strip: null });
    item.created_at = at;
    expect(peekChange(source, item, seen)).toEqual({ marker: 'new', strip: null });
    expect(peekChange(source, item, null)).toEqual({ marker: null, strip: null });
  });
});

it('shares one name pass per immutable snapshot and refreshes after a changed name or removal', async () => {
  const value = await setup(), first = immutable(value.source), labels = peekNames(first);
  expect(peekNames(first)).toBe(labels);
  value.source.items['2']!.short = 'Changed delivery';
  value.source.items['8']!.removed_at = value.source.updated_at;
  const next = peekNames(immutable(value.source));
  expect(next.get('2')).toBe('Changed delivery');
  expect(next.has('8')).toBe(false);
  expect(labels.get('2')).toBe('Delivery choice');
});
