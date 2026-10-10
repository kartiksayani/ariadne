import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AnswerControl, type AnswerControlProps } from '../../../src/ui/answer/AnswerControl';

afterEach(cleanup);
const options = [{ id: 'yes', label: 'Keep the design', consequence: 'Keep the current plan.', recommended: true }];
const props = (changes: Partial<AnswerControlProps> = {}): AnswerControlProps => ({ options, variant: 'full', selected: 0,
  draft: ' A note with exact spaces \n', onSelect: vi.fn(), onDraft: vi.fn(), onSendOption: vi.fn(), onSendText: vi.fn(), ...changes });

describe('answer choice with an optional note', () => {
  it.each(['full', 'chat'] as const)('sends option and note together in the %s control and keeps reply-only secondary', variant => {
    const values = props({ variant }); render(<AnswerControl {...values} />);
    const send = screen.getByRole('button', { name: 'Send “Keep the design” with your note' });
    expect(send.classList.contains('btn-primary')).toBe(true);
    expect(screen.getByTitle(/Press 1 to select, ⌥1 to send with your note/).getAttribute('title')).toBe(variant === 'chat'
      ? 'Keep the design\nKeep the current plan.\nPress 1 to select, ⌥1 to send with your note' : 'Press 1 to select, ⌥1 to send with your note');
    expect(screen.getByText(variant === 'chat' ? 'Enter sends · ⌘↵ reply only · Esc keeps draft' : 'Enter sends with your note')).toBeTruthy();
    expect(screen.getByRole('textbox').getAttribute('placeholder')).toBe('Add a note to your choice, or reply on its own…');
    fireEvent.click(send);
    expect(values.onSendOption).toHaveBeenCalledExactlyOnceWith(0, values.draft);
    expect(values.onSendText).not.toHaveBeenCalled();
    const reply = screen.getByRole('button', { name: 'Send as a reply only' });
    expect(reply.classList.contains('btn-secondary')).toBe(true);
    fireEvent.click(reply);
    expect(values.onSendText).toHaveBeenCalledExactlyOnceWith(values.draft);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', metaKey: true });
    expect(values.onSendText).toHaveBeenCalledTimes(2);
    expect(values.onSendOption).toHaveBeenCalledTimes(1);
  });
  it.each([{ variant: 'compact' as const }, { variant: 'full' as const, noText: true }])('uses the saved draft note for a control without a text box: %o', changes => {
    const values = props(changes); render(<AnswerControl {...values} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: changes.variant === 'compact' ? 'Send answer' : 'Send “Keep the design”' }));
    expect(values.onSendOption).toHaveBeenCalledExactlyOnceWith(0, undefined);
    expect(screen.getByTitle('Press 1 to select, ⌥1 to send with your note')).toBeTruthy();
  });
  it('offers a reply without a selected option and labels an empty note as a plain option send', () => {
    const values = props({ selected: -1 }), view = render(<AnswerControl {...values} />);
    expect(screen.queryByRole('button', { name: /Send “/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send as a reply only' }));
    expect(values.onSendText).toHaveBeenCalledExactlyOnceWith(values.draft);
    view.rerender(<AnswerControl {...values} selected={0} draft="   " />);
    expect(screen.getByRole('button', { name: 'Send “Keep the design”' })).toBeTruthy();
    expect(screen.getByTitle('Press 1 to select, ⌥1 to send')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Send as a reply only' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('compact chat choices', () => {
  const choices = [
    { ...options[0]!, consequence: 'Keep the current plan and check each example before sending it. '.repeat(12) },
    { id: 'no', label: 'Change the design after comparing the alternatives', consequence: 'Review the alternatives and explain the tradeoffs in the conversation. '.repeat(12), recommended: false },
  ];
  it.each(['', '  \n'])('shows every choice for an empty note %j and keeps sending separate from selection', async draft => {
    const user = userEvent.setup(), values = props({ options: choices, variant: 'chat', draft });
    const view = render(<AnswerControl {...values} />);
    const cards = view.container.querySelector('.answer-choices')!;
    expect(cards.querySelectorAll('[data-answer-option]')).toHaveLength(2);
    expect(cards.closest('details')).toBeNull();
    const send = screen.getByRole('button', { name: 'Send “Keep the design”' });
    expect(cards.contains(send)).toBe(false);
    fireEvent.click(send);
    expect(values.onSendOption).toHaveBeenCalledExactlyOnceWith(0, draft);
    await user.click(within(cards as HTMLElement).getByRole('button', { name: new RegExp(`2${choices[1]!.label}`) }));
    expect(values.onSelect).toHaveBeenCalledExactlyOnceWith(1);
    expect(values.onSendOption).toHaveBeenCalledTimes(1);
    view.rerender(<AnswerControl {...values} selected={1} />);
    expect(screen.getByRole('button', { name: new RegExp(`2${choices[1]!.label}`) }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(view.container.querySelector('.answer')!, { key: '2' });
    expect(values.onSelect).toHaveBeenLastCalledWith(1);
    expect(values.onSendOption).toHaveBeenCalledTimes(1);
  });
  it('collapses the saved words on Escape while keeping every choice and the exact note for sending', async () => {
    const user = userEvent.setup(), values = props({ options: choices, variant: 'chat', onEscape: vi.fn() });
    const view = render(<AnswerControl {...values} />);
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    box.focus(); await user.keyboard('{Escape}');
    expect(view.container.querySelector('.answer')!.classList.contains('answer-collapsed')).toBe(true);
    expect(view.container.querySelector('.answer-choices')!.querySelectorAll('[data-answer-option]')).toHaveLength(2);
    expect(box.value).toBe(values.draft);
    expect(document.activeElement).not.toBe(box);
    expect(values.onDraft).not.toHaveBeenCalled();
    expect(values.onEscape).toHaveBeenCalledExactlyOnceWith();
    fireEvent.click(screen.getByRole('button', { name: 'Send “Keep the design” with your note' }));
    expect(values.onSendOption).toHaveBeenCalledExactlyOnceWith(0, values.draft);
    fireEvent.click(screen.getByRole('button', { name: 'Send as a reply only' }));
    expect(values.onSendText).toHaveBeenCalledExactlyOnceWith(values.draft);
  });
  it('expands with a click or Enter while keeping the full accessible name, selection and draft', async () => {
    const user = userEvent.setup(), values = props({ options: choices, variant: 'chat', selected: 1 });
    const view = render(<AnswerControl {...values} />);
    const choice = screen.getByRole('button', { name: `1${choices[0]!.label}Recommended${choices[0]!.consequence.trim()}` });
    expect(choice.title).toContain(choices[0]!.consequence);
    const more = screen.getByRole('button', { name: `More about ${choices[0]!.label}` });
    const description = document.getElementById(more.getAttribute('aria-controls')!)!;
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(description.textContent).toBe(choices[0]!.consequence);
    await user.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(description.classList.contains('answer-description-open')).toBe(true);
    await user.keyboard('{Enter}');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(description.classList.contains('answer-description-open')).toBe(false);
    expect(values.onSelect).not.toHaveBeenCalled(); expect(values.onDraft).not.toHaveBeenCalled();
    expect(values.onSendOption).not.toHaveBeenCalled(); expect(values.onSendText).not.toHaveBeenCalled();
    fireEvent(window, new Event('resize'));
    view.rerender(<AnswerControl {...values} options={[...choices]} />);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(values.draft);
    expect(screen.getByRole('button', { name: new RegExp(`2${choices[1]!.label}`) }).getAttribute('aria-pressed')).toBe('true');
    expect(choice.getAttribute('aria-pressed')).toBe('false');
    await user.click(more);
    view.rerender(<AnswerControl {...values} selected={0} draft="Changed note" />);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Changed note');
    choice.focus(); await user.keyboard('{Enter}');
    expect(values.onSendOption).toHaveBeenCalledExactlyOnceWith(0, 'Changed note');
  });
  it('keeps 1–9 selection separate from sending and shows one shortcut line', async () => {
    const user = userEvent.setup(), many = Array.from({ length: 9 }, (_, index) => ({ ...choices[1]!, id: `choice-${index}`, label: `Choice ${index + 1}` }));
    const values = props({ options: many, variant: 'chat' });
    const view = render(<AnswerControl {...values} />);
    screen.getByRole('button', { name: 'More about Choice 1' }).focus();
    await user.keyboard('9');
    expect(values.onSelect).toHaveBeenCalledExactlyOnceWith(8);
    expect(values.onSendOption).not.toHaveBeenCalled();
    view.rerender(<AnswerControl {...values} selected={8} />);
    expect(view.container.querySelectorAll('.answer-hint')).toHaveLength(1);
    expect(screen.getByText('1–9 select · Enter sends · ⌘↵ reply only · Esc keeps draft')).toBeTruthy();
    screen.getByRole('button', { name: /9Choice 9/ }).focus(); await user.keyboard('{Enter}');
    expect(values.onSendOption).toHaveBeenCalledExactlyOnceWith(8, values.draft);
  });
  it('offers just the composer and its shortcuts for a free-text question', async () => {
    const user = userEvent.setup(), values = props({ options: [], variant: 'chat', selected: -1 });
    const view = render(<AnswerControl {...values} />);
    expect(screen.queryByRole('button', { name: /More about|Send “/ })).toBeNull();
    expect(view.container.querySelector('details.answer-choices')).toBeNull();
    expect(screen.getByText('⌘↵ reply only · Esc keeps draft')).toBeTruthy();
    screen.getByRole('textbox').focus(); await user.keyboard('{Meta>}{Enter}{/Meta}');
    expect(values.onSendText).toHaveBeenCalledExactlyOnceWith(values.draft);
  });
});
