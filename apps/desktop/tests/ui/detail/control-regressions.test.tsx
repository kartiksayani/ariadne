import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SessionStore } from '../../../src/data/session-store';
import { createDesktopService } from '../../../src/data/service';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { AnswerControl } from '../../../src/ui/answer/AnswerControl';
import { ConversationView } from '../../../src/ui/detail/ConversationView';
import { conversationAnswerState, ItemConversation } from '../../../src/ui/detail/ItemConversation';
import { notices } from '../../../src/ui/pages/notices';
import { sessionClosedReason } from '../../../src/selectors/sessionClosed';
import { AppTransport, route } from '../app/transport';

const stores: SessionStore[] = [];
afterEach(() => { cleanup(); stores.splice(0).forEach(store => store.close()); notices.clear(); vi.restoreAllMocks(); });

async function setup() {
  const transport = new AppTransport(), source = transport.sessions.get(route.session_id)!;
  Object.values(source.inputs).forEach(input => {
    if (input?.target.item_id === '4' && input.state === 'queued') input.state = 'handled';
  });
  const service = createDesktopService(transport), store = new SessionStore(service, route), drafts = new OwnerDraftStore(service);
  stores.push(store);
  await Promise.all([store.refresh(), drafts.load()]);
  const props = { store, drafts, itemId: '4', later: false, onOpenItem: vi.fn() };
  return { transport, source, service, store, drafts, props };
}

/**
 * jsdom does no layout, so this stands in for the two-line clamp of the pinned question and the view's title: while `clipped`
 * is true their text is taller than the box that shows it.
 */
function clamp(clipped: boolean) {
  const state = { clipped };
  const clamped = (element: Element) => element.matches('.conversation-question-text, .conversation-title');
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) { return clamped(this) ? 90 : 0; });
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) { return clamped(this) ? (state.clipped ? 40 : 90) : 0; });
  return state;
}
const resize = () => act(() => { window.dispatchEvent(new Event('resize')); });

describe('conversation control regressions', () => {
  it.each(['Cancel', 'Escape'] as const)('closes Drop with %s, keeps its draft through restart and prefills the next explicit Drop', async action => {
    const { transport, service, drafts, props } = await setup();
    const view = render(<ItemConversation {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Drop' }));
    const reason = screen.getByLabelText<HTMLInputElement>('Drop reason');
    fireEvent.change(reason, { target: { value: '  Already covered  ' } });
    if (action === 'Cancel') fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    else fireEvent.keyDown(reason, { key: 'Escape' });
    expect(screen.queryByLabelText('Drop reason')).toBeNull();
    expect(drafts.find(route, '4', 'drop')?.draft.text).toBe('Let’s drop this (  Already covered  ): Record retry limits');
    fireEvent.click(screen.getByRole('button', { name: 'Drop' }));
    expect(screen.getByLabelText<HTMLInputElement>('Drop reason').value).toBe('  Already covered  ');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Drop reason')).toBeNull();
    await waitFor(() => expect(transport.preferences.drafts.some(draft => draft.intent === 'drop')).toBe(true));
    view.unmount();
    const restarted = new OwnerDraftStore(service);
    await restarted.load();
    render(<ConversationView {...props} drafts={restarted} onClose={vi.fn()} />);
    expect(screen.queryByLabelText('Drop reason')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Drop' }));
    expect(screen.getByLabelText<HTMLInputElement>('Drop reason').value).toBe('  Already covered  ');
    fireEvent.click(screen.getByRole('button', { name: 'Drop item' }));
    await waitFor(() => expect(transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(1));
    expect(transport.mutations.find(request => request.command.command === 'input_submit')?.command).toMatchObject({
      params: { text: 'Let’s drop this (Already covered): Record retry limits' },
    });
  });

  it('still reopens an uncertain Drop attempt after restart so it can be retried', async () => {
    const { transport, service, source, drafts, props } = await setup();
    const id = drafts.begin(source, '4', 'drop')!;
    drafts.edit(id, { text: 'Let’s drop this (Already covered): Record retry limits' });
    transport.failNext = 'input_submit';
    expect(await drafts.submit(id)).toBe(false);
    expect(drafts.find(route, '4', 'drop')?.uncertain).toBe(true);
    const restarted = new OwnerDraftStore(service);
    await restarted.load();
    render(<ConversationView {...props} drafts={restarted} onClose={vi.fn()} />);
    const saved = await screen.findByLabelText<HTMLTextAreaElement>('Saved drop message');
    expect(saved.value).toBe('Let’s drop this (Already covered): Record retry limits');
    expect(saved.readOnly).toBe(true);
    expect(screen.getByRole('button', { name: 'Try sending again' })).toBeTruthy();
  });

  it('keeps an explicitly opened Drop editor after its pre-submit read fails', async () => {
    const { transport, drafts, props } = await setup();
    render(<ConversationView {...props} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Drop' }));
    fireEvent.change(screen.getByLabelText('Drop reason'), { target: { value: '  Keep these words  ' } });
    const invoke = transport.invoke.bind(transport);
    let failRead = true;
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if (failRead && 'request' in args.request && args.request.request.command === 'session_get') {
        failRead = false;
        return { api_version: 1, ok: false, error: { code: 'io_error', message: 'Read failed', hint: '', retryable: true, field_errors: [] } };
      }
      return invoke(name, args);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Drop item' }));
    await waitFor(() => expect(drafts.find(route, '4', 'drop')?.error).toBeTruthy());
    const reason = screen.getByLabelText<HTMLInputElement>('Drop reason');
    expect(reason.value).toBe('Keep these words');
    expect(reason.disabled).toBe(false);
    expect(transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Drop reason')).toBeNull();
  });

  it('keeps plain Enter for multiline saved Drop text and sends only with the explicit shortcut', async () => {
    const { transport, source, drafts, props } = await setup();
    const id = drafts.begin(source, '4', 'drop')!;
    const message = 'Keep this editable saved message\nwith a second line';
    drafts.edit(id, { text: message });
    render(<ConversationView {...props} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Drop' }));
    const saved = screen.getByLabelText<HTMLTextAreaElement>('Saved drop message');
    expect(saved.readOnly).toBe(false);
    expect(fireEvent.keyDown(saved, { key: 'Enter', cancelable: true })).toBe(true);
    const multiline = `${message}\nAnother paragraph`;
    fireEvent.change(saved, { target: { value: multiline } });
    expect(drafts.find(route, '4', 'drop')?.draft.text).toBe(multiline);
    expect(transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(0);
    fireEvent.keyDown(saved, { key: 'Escape' });
    expect(screen.queryByLabelText('Saved drop message')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Drop' }));
    const reopened = screen.getByLabelText<HTMLTextAreaElement>('Saved drop message');
    expect(reopened.value).toBe(multiline);
    fireEvent.keyDown(reopened, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(1));
    expect(transport.mutations.find(request => request.command.command === 'input_submit')?.command).toMatchObject({ params: { text: multiline } });
  });

  it('keeps an in-flight Drop attempt visible when changing surfaces', async () => {
    const { transport, source, drafts, props } = await setup();
    const id = drafts.begin(source, '4', 'drop')!;
    drafts.edit(id, { text: 'Let’s drop this (Already covered): Record retry limits' });
    const invoke = transport.invoke.bind(transport);
    let release!: () => void, entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('command' in args.request && args.request.command.command === 'input_submit') { entered = true; await gate; }
      return invoke(name, args);
    });
    const sending = drafts.submit(id);
    await waitFor(() => expect(entered).toBe(true));
    render(<ConversationView {...props} onClose={vi.fn()} />);
    expect(screen.getByLabelText<HTMLTextAreaElement>('Saved drop message').readOnly).toBe(true);
    expect(screen.getByRole('button', { name: 'Try sending again' }).hasAttribute('disabled')).toBe(true);
    await act(async () => { release(); await sending; });
  });

  it.each(['pane', 'conversation'] as const)('keeps an unanswered closed-session question disabled in the %s without a Your turn pin', async surface => {
    const { source, store, drafts, props } = await setup();
    const id = drafts.begin(source, '2', 'answer')!;
    drafts.edit(id, { text: 'Keep my answer' });
    source.state = 'closed'; ++source.revision;
    await store.refresh();
    expect(conversationAnswerState(store.getSnapshot().snapshot!.session, '2', drafts.find(route, '2', 'answer'))).toEqual({ showAnswer: true, live: false });
    if (surface === 'pane') render(<ItemConversation {...props} itemId="2" />);
    else render(<ConversationView {...props} itemId="2" onClose={vi.fn()} />);
    const answer = await screen.findByRole('group', { name: 'Answer' });
    expect(within(answer).getByLabelText<HTMLTextAreaElement>('Reply in your own words').value).toBe('Keep my answer');
    expect(within(answer).getByLabelText<HTMLTextAreaElement>('Reply in your own words').disabled).toBe(true);
    expect(within(answer).getByText(sessionClosedReason)).toBeTruthy();
    expect(screen.queryByText(/^Your turn/)).toBeNull();
  });

  it.each(['missing', 'closed', 'revised', 'archived'] as const)('uses the same answer eligibility when the current round is %s', async state => {
    const { source, store, props } = await setup(), item = source.items['2']!;
    if (state === 'missing') item.current_round_id = null;
    else if (state === 'closed') source.rounds[item.current_round_id!]!.closed_at = source.updated_at;
    else if (state === 'revised') ++item.question_revision;
    else source.archived_at = source.updated_at;
    ++source.revision; await store.refresh();
    expect(conversationAnswerState(store.getSnapshot().snapshot!.session, '2')).toEqual({ showAnswer: false, live: false });
    const pane = render(<ItemConversation {...props} itemId="2" />);
    expect(screen.queryByRole('region', { name: 'Your answer' })).toBeNull();
    pane.unmount();
    render(<ConversationView {...props} itemId="2" onClose={vi.fn()} />);
    expect(screen.queryByRole('region', { name: 'Your answer' })).toBeNull();
    expect(screen.queryByText(/^Your turn/)).toBeNull();
  });

  it('hides the owner question pin and answer control while an answer is queued', async () => {
    const { source, store, drafts, props } = await setup();
    const id = drafts.begin(source, '2', 'answer')!;
    drafts.edit(id, { text: 'My queued answer' });
    expect(await drafts.submit(id)).toBe(true);
    await store.refresh();
    expect(conversationAnswerState(store.getSnapshot().snapshot!.session, '2', drafts.find(route, '2', 'answer'))).toEqual({ showAnswer: false, live: false });
    render(<ConversationView {...props} itemId="2" onClose={vi.fn()} />);
    expect(screen.queryByRole('region', { name: 'Your answer' })).toBeNull();
    expect(screen.queryByText(/^Your turn/)).toBeNull();
    expect(screen.getByLabelText('Reply message')).toBeTruthy();
  });

  it('keeps only options in their scroll region with question and the mode-aware Send outside it, including an unselected choice', () => {
    const onSendOption = vi.fn(), onSendText = vi.fn(), onSelect = vi.fn();
    const props = { variant: 'chat' as const, compactOptions: true, options: [{ id: 'one', label: 'Use the full window', consequence: 'Full explanation', recommended: false }],
      selected: -1, draft: 'My note', prompt: <p>Current question</p>, onSelect, onDraft: vi.fn(), onSendOption, onSendText };
    const view = render(<AnswerControl {...props} />);
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send.hasAttribute('disabled')).toBe(false);
    expect(screen.getByText('Current question').closest('.answer-choices')).toBeNull();
    expect(screen.getByText('Use the full window').closest('.answer-choices')).toBeTruthy();
    expect(send.closest('.answer-fixed-controls')).toBeTruthy();
    expect(screen.getByLabelText('Reply in your own words').closest('.answer-fixed-controls')).toBeTruthy();
    expect(send.closest('.answer-choices')).toBeNull();
    fireEvent.click(send); expect(onSendText).toHaveBeenCalledWith('My note');
    view.rerender(<AnswerControl {...props} selected={0} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send “Use the full window” with your note' }));
    expect(onSendOption).toHaveBeenCalledWith(0, 'My note');
  });

  it('keeps the full pinned question one click away without changing the saved note or choice', async () => {
    clamp(true);
    const { source, store, props } = await setup();
    const question = 'Should we keep all the details of this question available to the owner? '.repeat(8);
    source.items['2']!.options = [{ id: 'keep', label: 'Keep all the details', consequence: 'Preserve them.', recommended: true }];
    source.items['2']!.ask = question; ++source.revision; await store.refresh();
    render(<ConversationView {...props} itemId="2" onClose={vi.fn()} />);
    const box = screen.getByRole('textbox', { name: 'Reply in your own words' }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'My exact saved note' } });
    fireEvent.click(document.querySelector('[data-answer-option]')!);
    const choice = document.querySelector('[data-answer-option][aria-pressed="true"]');
    const toggle = screen.getByRole('button', { name: 'Expand question' });
    const text = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(text.textContent?.trim()).toBe(question.trim());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(text.closest('.answer-choices')).toBeNull();
    toggle.focus(); fireEvent.click(toggle);
    const dialog = screen.getByRole('dialog', { name: 'Current question' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(dialog.querySelector('.dialog-body')?.textContent?.trim()).toBe(question.trim());
    expect(text.closest('.conversation-pin')).toBeTruthy();
    expect(box.value).toBe('My exact saved note');
    expect(document.querySelector('[data-answer-option][aria-pressed="true"]')).toBe(choice);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Current question' })).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
    expect(screen.getByRole('region', { name: 'Item conversation' })).toBeTruthy();
    fireEvent.click(toggle); fireEvent.click(screen.getByRole('button', { name: 'Close question' }));
    expect(screen.queryByRole('dialog', { name: 'Current question' })).toBeNull();
    expect(box.value).toBe('My exact saved note');
  });

  it('keeps question dialog keys from selecting or sending the pinned answer', async () => {
    clamp(true);
    const { transport, source, store, drafts, props } = await setup();
    source.items['2']!.options = [
      { id: 'keep', label: 'Keep the window', consequence: 'Keep the timing.', recommended: true },
      { id: 'change', label: 'Change the window', consequence: 'Change the timing.', recommended: false },
    ];
    ++source.revision; await store.refresh();
    const onAgentNotRunning = vi.fn();
    render(<ConversationView {...props} itemId="2" onClose={vi.fn()} onAgentNotRunning={onAgentNotRunning} />);
    const box = screen.getByRole('textbox', { name: 'Reply in your own words' }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Keep my note' } });
    fireEvent.click(document.querySelector('[data-answer-option]')!);
    const choice = document.querySelector('[data-answer-option][aria-pressed="true"]');
    const before = drafts.find(route, '2', 'answer')!.draft.selected_option_id;
    fireEvent.click(screen.getByRole('button', { name: 'Expand question' }));
    const dialog = screen.getByRole('dialog', { name: 'Current question' });
    await act(async () => {
      fireEvent.keyDown(dialog, { key: '2' });
      fireEvent.keyDown(dialog, { key: 'Enter', metaKey: true });
    });
    expect(document.querySelector('[data-answer-option][aria-pressed="true"]')).toBe(choice);
    expect(drafts.find(route, '2', 'answer')!.draft.selected_option_id).toBe(before);
    expect(drafts.find(route, '2', 'answer')!.saving).toBe(false);
    expect(transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(0);
    expect(box.value).toBe('Keep my note');
    expect(onAgentNotRunning).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Current question' })).toBe(dialog);
  });

  it('reveals a long conversation title with one accessible button press', async () => {
    clamp(true);
    const { source, store, props } = await setup();
    const fullTitle = 'A complete long title with all the detail needed to understand the item. '.repeat(8);
    source.items['4']!.question = fullTitle; ++source.revision; await store.refresh();
    render(<ConversationView {...props} onClose={vi.fn()} />);
    const title = screen.getByRole('button', { name: `Expand title: ${fullTitle.trim()}` });
    expect(title.getAttribute('aria-expanded')).toBe('false');
    expect(title.textContent).toBe(fullTitle);
    fireEvent.click(title);
    expect(screen.getByRole('button', { name: `Collapse title: ${fullTitle.trim()}` }).classList.contains('conversation-title-expanded')).toBe(true);
    expect(title.getAttribute('aria-expanded')).toBe('true');
  });

  it('folds the title with the keyboard and keeps focus on it', async () => {
    clamp(true);
    const { source, store, props } = await setup();
    const fullTitle = 'A complete long title with all the detail needed to understand the item. '.repeat(8);
    source.items['4']!.question = fullTitle; ++source.revision; await store.refresh();
    render(<ConversationView {...props} onClose={vi.fn()} />);
    const title = screen.getByRole('button', { name: `Expand title: ${fullTitle.trim()}` });
    title.focus();
    fireEvent.keyDown(title, { key: 'Enter' });
    expect(title.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(title, { key: ' ' });
    expect(title.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('button', { name: `Expand title: ${fullTitle.trim()}` })).toBe(title);
    expect(document.activeElement).toBe(title);
  });

  it('shows an expand control for the title and question only while their text is clipped, and re-measures on resize and on text edits', async () => {
    const state = clamp(false);
    const { source, store, props } = await setup();
    source.items['2']!.ask = 'Which window?'; ++source.revision; await store.refresh();
    render(<ConversationView {...props} itemId="2" onClose={vi.fn()} />);
    const title = () => screen.queryByRole('button', { name: /^(Expand|Collapse) title/ });
    expect(screen.queryByRole('button', { name: 'Expand question' }), 'a question that fits has no caret').toBeNull();
    expect(title(), 'a title that fits has no button').toBeNull();
    // The window narrows: the same text now needs more than two lines.
    state.clipped = true; resize();
    expect(screen.getByRole('button', { name: 'Expand question' })).toBeTruthy();
    expect(title()).toBeTruthy();
    // The window widens again.
    state.clipped = false; resize();
    expect(screen.queryByRole('button', { name: 'Expand question' })).toBeNull();
    expect(title()).toBeNull();
    // The agent rewrites the question and the title at a length that no longer fits.
    state.clipped = true;
    source.items['2']!.ask = 'Which window should we use? '.repeat(20); source.items['2']!.question = 'A longer title. '.repeat(20); ++source.revision;
    await act(async () => { await store.refresh(); });
    expect(screen.getByRole('button', { name: 'Expand question' })).toBeTruthy();
    expect(title()).toBeTruthy();
  });

  it('keeps the full-question dialog open, with the new text and its focus, when the agent edits the question', async () => {
    clamp(true);
    const { source, store, props } = await setup();
    source.items['2']!.ask = 'Which window should we use? '.repeat(8); ++source.revision; await store.refresh();
    render(<ConversationView {...props} itemId="2" onClose={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: 'Expand question' });
    fireEvent.click(toggle);
    const dialog = screen.getByRole('dialog', { name: 'Current question' });
    const close = within(dialog).getByRole('button', { name: 'Close question' });
    close.focus();
    expect(document.activeElement).toBe(close);
    source.items['2']!.ask = 'Which window should we use after the agent changed its mind?'; ++source.revision;
    await act(async () => { await store.refresh(); });
    expect(screen.getByRole('dialog', { name: 'Current question' }), 'the dialog is not remounted').toBe(dialog);
    expect(dialog.querySelector('.dialog-body')?.textContent?.trim()).toBe('Which window should we use after the agent changed its mind?');
    expect(document.activeElement, 'focus stays on the dialog control').toBe(close);
    expect(screen.getByRole('button', { name: 'Expand question' })).toBe(toggle);
    fireEvent.click(close);
    expect(screen.queryByRole('dialog', { name: 'Current question' })).toBeNull();
  });

  it('keeps the original pane owner caption after the reply while the larger view labels You before it', async () => {
    const { props } = await setup();
    const pane = render(<ItemConversation {...props} itemId="1" />);
    const paneCaption = document.querySelector('.detail-bubble-you .detail-pending-caption')!;
    expect(paneCaption.textContent).toMatch(/^you · /);
    expect(paneCaption.previousElementSibling).not.toBeNull();
    pane.unmount();
    render(<ConversationView {...props} itemId="1" onClose={vi.fn()} />);
    const viewCaption = document.querySelector('.detail-bubble-you .detail-pending-caption')!;
    expect(viewCaption.textContent).toMatch(/^You · /);
    expect(viewCaption.previousElementSibling).toBeNull();
  });
});
