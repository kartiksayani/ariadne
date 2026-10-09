import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
    expect(screen.getByTitle('Press 1 to select, ⌥1 to send with your note')).toBeTruthy();
    expect(screen.getByText('Enter sends with your note')).toBeTruthy();
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
