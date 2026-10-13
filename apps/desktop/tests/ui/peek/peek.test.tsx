import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createDesktopService } from '../../../src/data/service';
import { SessionStore } from '../../../src/data/session-store';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { PeekProvider, usePeek, type PeekProviderProps } from '../../../src/ui/peek/Peek';
import { ItemRefSession } from '../../../src/ui/peek/context';
import { ItemReference, ItemRefs, Markdown } from '../../../src/ui/shared/MarkdownText';
import { peekPosition } from '../../../src/ui/peek/position';
import { peekNames } from '../../../src/ui/peek/names';
import { immutable } from '../../../src/data/session-store';
import { AppTransport, route } from '../app/transport';

const stores: SessionStore[] = [];
afterEach(() => { cleanup(); vi.useRealTimers(); stores.splice(0).forEach(store => store.close()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
  const go = vi.fn(), visit = vi.fn();
  render(<PeekProvider lookup={() => value.store} drafts={value.drafts} onGoTo={go} onVisit={visit} {...extra}>
    <ItemRefSession.Provider value={route}>
      <Markdown text="See [#2](item:2) and [#8](item:8)." />
      <RowSource /><button type="button">Outside control</button>
    </ItemRefSession.Provider>
  </PeekProvider>);
  return { go, visit, chip: () => screen.getByRole('button', { name: `${value.source.items['2']!.question} · Waiting on me` }) };
}

describe('name chips and item peek', () => {
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
      expect(screen.getByRole('dialog', { name: 'Peek: Delivery choice' })).toBeTruthy();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(document.activeElement).toBe(chip());
    } finally { style.remove(); }
  });

  it('answers a current waiting ask on a task through the same safe answer submission', async () => {
    const value = await setup(); value.source.items['2']!.type = 'task'; ++value.source.revision; await value.store.refresh();
    const { chip } = mount(value); fireEvent.click(chip());
    const peek = screen.getByRole('dialog', { name: 'Peek: Delivery choice' });
    expect(within(peek).getByText('task')).toBeTruthy();
    fireEvent.change(within(peek).getByRole('textbox', { name: 'One-line answer' }), { target: { value: 'Proceed with the task.' } });
    fireEvent.click(within(peek).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(value.transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(1));
    expect(value.transport.mutations.find(request => request.command.command === 'input_submit')).toMatchObject({
      command: { params: { target: { item_id: '2' }, kind: 'answer', text: 'Proceed with the task.' } },
    });
  });

  it('uses names through session scope, opens on click/Space, replaces one peek, and restores focus with Escape', async () => {
    const value = await setup(), { chip, go, visit } = mount(value);
    expect(chip().textContent).toBe('Delivery choice');
    expect(chip().textContent).not.toContain('#2');
    chip().focus(); fireEvent.keyDown(chip(), { key: ' ' });
    const first = screen.getByRole('dialog', { name: 'Peek: Delivery choice' });
    expect(within(first).getByText('question')).toBeTruthy();
    expect(within(first).getByText('Waiting on me')).toBeTruthy();
    expect(document.activeElement).toBe(within(first).getByRole('button', { name: 'Close peek' }));
    fireEvent.click(screen.getByRole('button', { name: `${value.source.items['8']!.question} · Open` }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.queryByRole('dialog', { name: 'Peek: Delivery choice' })).toBeNull();
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

  it('only opens after half a second of command-hover and cancels on leave, command release and blur', async () => {
    const value = await setup(); vi.useFakeTimers();
    const { chip, visit } = mount(value);
    fireEvent.mouseEnter(chip()); act(() => vi.advanceTimersByTime(600));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(document, { key: 'Meta', metaKey: true }); act(() => vi.advanceTimersByTime(499));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyUp(document, { key: 'Meta', metaKey: false }); act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.mouseEnter(chip(), { metaKey: true }); act(() => vi.advanceTimersByTime(200));
    fireEvent.mouseLeave(chip()); act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.mouseEnter(chip(), { metaKey: true }); fireEvent.blur(window); act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.mouseEnter(chip(), { metaKey: true }); act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(visit).toHaveBeenCalledTimes(1);
  });

  it('emits the displayed revision once after a full second and cancels a short preview', async () => {
    const value = await setup(); vi.useFakeTimers();
    const seen = vi.fn(), { chip } = mount(value, { onPeekSeen: seen });
    fireEvent.click(chip()); act(() => vi.advanceTimersByTime(999));
    expect(seen).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' }); act(() => vi.advanceTimersByTime(10));
    expect(seen).not.toHaveBeenCalled();
    fireEvent.click(chip()); act(() => vi.advanceTimersByTime(1000));
    expect(seen).toHaveBeenCalledExactlyOnceWith({ ...route, item_id: '2' }, value.source.items['2']!.revision);
    act(() => vi.advanceTimersByTime(500)); expect(seen).toHaveBeenCalledTimes(1);
    expect(value.transport.mutations.some(request => request.command.command === 'preferences_patch'
      && request.command.params.entries.some(entry => entry.kind === 'mark_seen'))).toBe(false);
  });

  it('keeps the opening revision when the displayed item refreshes during the dwell', async () => {
    const value = await setup(); vi.useFakeTimers();
    const revision = value.source.items['2']!.revision, seen = vi.fn(), { chip } = mount(value, { onPeekSeen: seen });
    fireEvent.click(chip()); act(() => vi.advanceTimersByTime(500));
    ++value.source.items['2']!.revision; ++value.source.revision;
    value.source.items['2']!.ask = 'A newer question summary.';
    await act(async () => { await value.store.refresh(); });
    expect(within(screen.getByRole('dialog')).getByText('A newer question summary.')).toBeTruthy();
    act(() => vi.advanceTimersByTime(500));
    expect(seen).toHaveBeenCalledExactlyOnceWith({ ...route, item_id: '2' }, revision);
    act(() => vi.advanceTimersByTime(1000)); expect(seen).toHaveBeenCalledTimes(1);
  });

  it('keeps hover previews from taking editor Escape or restoring focus on close', async () => {
    const value = await setup(); vi.useFakeTimers(); const { chip } = mount(value), editorKeys = vi.fn();
    render(<input aria-label="Outside editor" onKeyDown={editorKeys} />);
    const editor = screen.getByRole('textbox', { name: 'Outside editor' }); editor.focus();
    const hover = () => { fireEvent.mouseEnter(chip(), { metaKey: true }); act(() => vi.advanceTimersByTime(500)); };
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
    const value = await setup(); value.source.items['2']!.ask = 'Review [the branch](item:8).'; ++value.source.revision;
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
    const { container } = render(<PeekProvider lookup={() => value.store} drafts={value.drafts} onGoTo={vi.fn()}>
      <ItemRefSession.Provider value={route}><ItemRefs.Provider value={{ lookup: () => null, onOpenItem: vi.fn() }}>
        <Markdown text="Keep [the agent’s original words](item:8)." />
        <ItemRefs.Provider value={null}><Markdown text="Keep [my exact words](item:2)." /><ItemReference itemId="2">Owner reference</ItemReference></ItemRefs.Provider>
      </ItemRefs.Provider></ItemRefSession.Provider>
    </PeekProvider>);
    expect(container.textContent).toContain('the agent’s original words (item unavailable)');
    expect(container.textContent).toContain('Keep my exact words.'); expect(container.textContent).toContain('Owner reference');
    expect(container.querySelector('button, a')).toBeNull();
  });

  it('keeps command-hover pending across parent refreshes and uses the latest visit callback', async () => {
    const value = await setup(); vi.useFakeTimers();
    const visited = vi.fn();
    const tree = (renderCount: number) => <PeekProvider lookup={() => value.store} drafts={value.drafts} onGoTo={() => {}} onVisit={() => visited(renderCount)}>
      <ItemRefSession.Provider value={route}><ItemReference itemId="2" /></ItemRefSession.Provider>
    </PeekProvider>;
    const { rerender } = render(tree(1));
    fireEvent.mouseEnter(screen.getByRole('button'), { metaKey: true }); act(() => vi.advanceTimersByTime(200));
    rerender(tree(2)); act(() => vi.advanceTimersByTime(300));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(visited).toHaveBeenCalledExactlyOnceWith(2);
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
    const { container } = render(<PeekProvider lookup={() => value.store} drafts={value.drafts} onGoTo={vi.fn()}><ItemRefSession.Provider value={route}>
      <ItemReference itemId="404">Unknown reference</ItemReference>
    </ItemRefSession.Provider></PeekProvider>);
    expect(container.querySelector('button')).toBeNull();
  });

  it('copies the unchanged item reference and provides selectable fallback when the clipboard fails', async () => {
    const value = await setup(), writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { chip } = mount(value); fireEvent.click(chip());
    fireEvent.click(screen.getByRole('button', { name: 'Copy reference' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`2 — ${value.source.items['2']!.question}`));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
    writeText.mockRejectedValue(new Error('Unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Copied' }));
    const fallback = await screen.findByRole('textbox', { name: 'Select and copy reference' });
    expect((fallback as HTMLInputElement).value).toBe(`2 — ${value.source.items['2']!.question}`);
  });
});

describe('simple question answers in peek', () => {
  it('retains the durable one-line draft after closing and sends one input despite repeated sends and reopening', async () => {
    const value = await setup(), { chip, visit } = mount(value);
    fireEvent.click(chip());
    const input = screen.getByRole('textbox', { name: 'One-line answer' });
    fireEvent.change(input, { target: { value: 'Keep the current design.' } });
    fireEvent.keyDown(document, { key: 'Escape' }); fireEvent.click(chip());
    expect((screen.getByRole('textbox', { name: 'One-line answer' }) as HTMLInputElement).value).toBe('Keep the current design.');
    const send = screen.getByRole('button', { name: 'Send' }); fireEvent.click(send); fireEvent.click(send);
    await waitFor(() => expect(value.transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(1));
    await waitFor(() => expect(visit).toHaveBeenCalledWith({ ...route, item_id: '2' }, 'answered'));
    const request = value.transport.mutations.find(request => request.command.command === 'input_submit')!;
    expect(request.command).toMatchObject({ command: 'input_submit', params: { kind: 'answer', text: 'Keep the current design.', selected_option_id: null, target: { item_id: '2' } } });
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Map row' }), { key: ' ' });
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(value.transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(1);
  });

  it('sends an option pick through the same durable answer path', async () => {
    const value = await setup(), { chip } = mount(value); fireEvent.click(chip());
    const pick = screen.getByRole('button', { name: 'Keep the design Recommended' });
    expect(screen.getByText('Retain the current contract.')).toBeTruthy();
    fireEvent.click(pick); fireEvent.click(pick);
    await waitFor(() => expect(value.transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(1));
    expect(value.transport.mutations.find(request => request.command.command === 'input_submit')!.command).toMatchObject({ params: { selected_option_id: 'yes', kind: 'answer' } });
  });

  it('preserves a multiline draft for details, and blocks answering a changed question until reviewed', async () => {
    const value = await setup();
    const id = value.drafts.begin(value.source, '2', 'answer')!;
    value.drafts.edit(id, { text: 'Long first line\nKeep the full second line.' });
    const { chip, go } = mount(value); fireEvent.click(chip());
    expect(screen.queryByRole('textbox', { name: 'One-line answer' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Keep the design Recommended' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Open details' }));
    expect(go).toHaveBeenCalledWith({ ...route, item_id: '2' });
    expect(value.drafts.find(route, '2', 'answer')?.draft.text).toBe('Long first line\nKeep the full second line.');
    value.drafts.edit(id, { text: 'A short answer' });
    ++value.source.items['2']!.question_revision; ++value.source.items['2']!.revision; ++value.source.revision;
    await act(async () => { await value.store.refresh(); });
    fireEvent.click(chip());
    expect(screen.getByText('This question changed. Review it in details; your draft is kept.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);
    expect(value.transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(0);
  });

  it('keeps multiline pasted text and the rest of the selected one-line draft intact', async () => {
    const value = await setup(), { chip, go } = mount(value); fireEvent.click(chip());
    const input = screen.getByRole('textbox', { name: 'One-line answer' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Before old after' } });
    input.setSelectionRange(7, 10);
    const getData = vi.fn().mockReturnValue('first line\nsecond line');
    fireEvent.paste(input, { clipboardData: { getData } });
    expect(getData).toHaveBeenCalledWith('text');
    expect(value.drafts.find(route, '2', 'answer')?.draft.text).toBe('Before first line\nsecond line after');
    expect(screen.queryByRole('textbox', { name: 'One-line answer' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open details' }));
    expect(go).toHaveBeenCalledWith({ ...route, item_id: '2' });
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
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'One-line answer' }) as HTMLInputElement).disabled).toBe(false));
    expect(value.drafts.find(route, '2', 'answer')?.draft.op_id).not.toBe(oldId);
    fireEvent.change(screen.getByRole('textbox', { name: 'One-line answer' }), { target: { value: 'New round answer' } });
    const send = screen.getByRole('button', { name: 'Send' }); fireEvent.click(send); fireEvent.click(send);
    await waitFor(() => expect(value.transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(2));
    const latest = value.transport.mutations.filter(request => request.command.command === 'input_submit')[1]!;
    expect(latest.command).toMatchObject({ params: { text: 'New round answer', kind: 'answer' } });
    expect(latest.command.op_id).not.toBe(oldId);
  });

  it('subscribes to session changes and removes answer controls when the session closes', async () => {
    const value = await setup(), { chip } = mount(value); fireEvent.click(chip());
    expect(screen.getByRole('textbox', { name: 'One-line answer' })).toBeTruthy();
    value.source.state = 'closed'; ++value.source.revision;
    await act(async () => { await value.store.refresh(); });
    expect(screen.queryByRole('textbox', { name: 'One-line answer' })).toBeNull();
    expect(screen.getByText(/This session is closed/)).toBeTruthy();
    expect(value.transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(0);
  });
});

describe('peek viewport position', () => {
  it('measures header, tabs and ancestor chrome and includes the card border when fitting its bottom edge', async () => {
    const chrome: HTMLElement[] = ['shell-header', 'shell-tabs', 'tree-breadcrumb'].map(className => {
      const element = document.createElement('div'); element.className = className; document.body.append(element); return element;
    });
    const rectangle = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const index = chrome.indexOf(this);
      if (this.matches('.name-chip')) return new DOMRect(900, 650, 80, 20);
      return index < 0 ? rectangle.call(this) : new DOMRect(0, 0, 1000, [48, 86, 180][index]!);
    });
    vi.stubGlobal('innerWidth', 1000); vi.stubGlobal('innerHeight', 700);
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(400);
    const style = document.createElement('style'); style.textContent = '.item-peek { border: 1px solid black; }'; document.head.append(style);
    try {
      const value = await setup(), { chip } = mount(value);
      expect(window.innerHeight).toBe(700);
      expect(chrome[2]!.getBoundingClientRect().bottom).toBe(180);
      fireEvent.click(chip());
      const card = screen.getByRole('dialog');
      expect(card.scrollHeight).toBe(400);
      expect(card.style.top).toBe('286px'); // 700 - 12 - (400 + two border pixels).
      expect(card.style.left).toBe('552px');
      expect(card.style.maxHeight).toBe('500px');
      height.mockReturnValue(990);
      fireEvent(window, new Event('resize'));
      expect(card.style.top).toBe('188px');
      expect(card.style.maxHeight).toBe('500px');
    } finally { chrome.forEach(element => element.remove()); style.remove(); }
  });

  it('fits either side of the source, below chrome, and within every viewport edge', () => {
    expect(peekPosition({ left: 100, right: 200, top: 20, bottom: 50 }, 340, 300, 1000, 800, 60)).toMatchObject({ left: 208, top: 68 });
    expect(peekPosition({ left: 850, right: 950, top: 750, bottom: 780 }, 340, 300, 1000, 800, 60)).toMatchObject({ left: 502, top: 488 });
    expect(peekPosition({ left: 10, right: 40, top: 10, bottom: 20 }, 340, 1000, 200, 300, 60)).toEqual({ left: 12, top: 68, maxWidth: 176, maxHeight: 220 });
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
