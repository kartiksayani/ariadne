import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AnswerControl, defaultSelection, type AnswerControlProps } from '../../../src/ui/answer/AnswerControl';

afterEach(() => { cleanup(); });
const options = [
  { id: 'yes', label: 'Keep the design', consequence: 'Keep the current plan.', recommended: true },
  { id: 'no', label: 'Change the design', consequence: 'Review the alternatives first.', recommended: false },
];
const props = (changes: Partial<AnswerControlProps> = {}): AnswerControlProps => ({ options, layout: 'dock', selected: 0,
  draft: ' A note with exact spaces \n', onSelect: vi.fn(), onDraft: vi.fn(), onSendOption: vi.fn(), onSendText: vi.fn(), ...changes });
const send = () => screen.getByRole('button', { name: 'Send' });

describe('answer cards', () => {
  it('picks only an explicit owner choice; ★ marks the recommended one', () => {
    expect(defaultSelection(options, null)).toBe(-1);
    expect(defaultSelection(options, undefined)).toBe(-1);
    expect(defaultSelection(options, 'removed')).toBe(-1);
    expect(defaultSelection(options, 'yes')).toBe(0);
    const view = render(<AnswerControl {...props({ selected: -1, draft: '' })} />);
    expect(view.container.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
    expect(view.container.querySelector('[data-answer-option="0"] .answer-recommended')?.textContent).toBe('Recommended');
    expect(view.container.querySelector('[data-answer-option="1"] .answer-recommended')).toBeNull();
    expect((send() as HTMLButtonElement).disabled).toBe(true);
    expect(send().title).toBe('Pick an option or write an answer first');
    expect(screen.getByText('Pick an option with 1–2 or write your own, then send with ↵.')).toBeTruthy();
  });

  it('carries the dock hint in both widths, and the keys it names pick and send', () => {
    const onSelect = vi.fn(), onSendOption = vi.fn();
    const view = render(<AnswerControl {...props({ selected: 0, draft: '', onSelect, onSendOption })} />);
    expect(view.container.querySelector('.answer-bar-wide')?.textContent).toBe('Pick an option with 1–2 or write your own, then send with ↵.');
    expect(view.container.querySelector('.answer-bar-narrow')?.textContent).toBe('Pick with 1–2, send with ↵.');
    const card = view.container.querySelector<HTMLElement>('[data-answer-option="1"]')!;
    card.focus(); fireEvent.keyDown(card, { key: '2' });
    expect(onSelect).toHaveBeenCalledWith(1); expect(onSendOption).not.toHaveBeenCalled();
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onSendOption).toHaveBeenCalledTimes(1);
  });

  it('lays out a check on every card and on "Write my own answer", visible only on the picked one', () => {
    const view = render(<AnswerControl {...props({ selected: 0, draft: '' })} />);
    const checks = [...view.container.querySelectorAll('.answer-option')].map(card => card.querySelector('.answer-check'));
    expect(checks.every(Boolean)).toBe(true);
    expect(checks.map(check => check!.classList.contains('answer-check-off'))).toEqual([false, true, true]);
  });

  it.each(['dock', 'details', 'wide'] as const)('keeps multiline words, plain Enter and Escape in the note box (%s)', layout => {
    const values = props({ layout, onEscape: vi.fn() });
    const view = render(<AnswerControl {...values} />);
    const box = screen.getByRole('textbox', { name: 'Add a note for the agent' });
    box.focus();
    expect(fireEvent.keyDown(box, { key: 'Enter', cancelable: true })).toBe(true);
    fireEvent.change(box, { target: { value: ' first line\nsecond line ' } });
    expect(values.onDraft).toHaveBeenCalledExactlyOnceWith(' first line\nsecond line ');
    view.rerender(<AnswerControl {...values} draft={' first line\nsecond line '} />);
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(values.onEscape).toHaveBeenCalledExactlyOnceWith();
    expect((box as HTMLTextAreaElement).value).toBe(' first line\nsecond line ');
    expect(values.onSendText).not.toHaveBeenCalled();
    expect(values.onSendOption).not.toHaveBeenCalled();
    expect(view.container.querySelector(`.answer-${layout}`)).toBeTruthy();
  });

  it('opens the note box from "+ Add a note" only on the picked card', () => {
    const values = props({ draft: '' }), view = render(<AnswerControl {...values} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    const links = screen.getAllByRole('button', { name: '+ Add a note' });
    expect(links).toHaveLength(1);
    expect(view.container.querySelector('.answer-card-on')!.contains(links[0]!)).toBe(true);
    fireEvent.click(links[0]!);
    const box = screen.getByRole('textbox', { name: 'Add a note for the agent' });
    expect(document.activeElement).toBe(box);
    expect(box.getAttribute('placeholder')).toBe('Add a note for the agent…');
  });

  it('sends only the picked mode and keeps the words when the mode changes', () => {
    const values = props(), view = render(<AnswerControl {...values} />);
    const box = screen.getByRole('textbox', { name: 'Add a note for the agent' });
    fireEvent.click(send());
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(values.onSendOption).toHaveBeenCalledTimes(2);
    expect(values.onSendOption).toHaveBeenLastCalledWith(0, values.draft);
    expect(values.onSendText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Write my own answer' }));
    expect(values.onSelect).toHaveBeenCalledExactlyOnceWith(-1);
    expect(values.onDraft).not.toHaveBeenCalled();
    view.rerender(<AnswerControl {...values} selected={-1} />);
    const own = screen.getByRole('textbox', { name: 'Reply in your own words' }) as HTMLTextAreaElement;
    expect(own.value).toBe(values.draft);
    expect(own.getAttribute('placeholder')).toBe('Answer in your own words…');
    expect(screen.getByRole('button', { name: 'Write my own answer' }).getAttribute('aria-pressed')).toBe('true');
    expect(view.container.querySelectorAll('[data-answer-option][aria-pressed="true"]')).toHaveLength(0);
    fireEvent.click(send());
    expect(values.onSendText).toHaveBeenCalledExactlyOnceWith(values.draft);
    fireEvent.click(view.container.querySelector('[data-answer-option="0"]')!);
    expect(values.onSelect).toHaveBeenLastCalledWith(0);
    view.rerender(<AnswerControl {...values} />);
    // Own words become the picked option's note.
    expect((screen.getByRole('textbox', { name: 'Add a note for the agent' }) as HTMLTextAreaElement).value).toBe(values.draft);
    expect(screen.getByRole('button', { name: 'Write my own answer' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps Send disabled until an option or nonempty own answer exists', () => {
    const values = props({ selected: -1, draft: '  ' }), view = render(<AnswerControl {...values} />);
    expect((send() as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<AnswerControl {...values} selected={0} />);
    expect((send() as HTMLButtonElement).disabled).toBe(false);
    view.rerender(<AnswerControl {...values} draft="My words" />);
    expect((send() as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('Draft kept. It stays here until you send it.')).toBeTruthy();
  });

  it('a compact card list has no text box and sends the saved note', () => {
    const values = props({ layout: 'compact' }); render(<AnswerControl {...values} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Write my own answer' })).toBeNull();
    expect(screen.getByText('Sends from here; nothing else opens.')).toBeTruthy();
    fireEvent.click(send());
    expect(values.onSendOption).toHaveBeenCalledExactlyOnceWith(0, undefined);
  });

  it.each(['compact', 'list'] as const)('the %s cards show the consequence only in the other-sessions list', layout => {
    const values = props({ layout }); render(<AnswerControl {...values} />);
    const option = values.options.find(value => value.consequence)!;
    const card = screen.getByRole('button', { name: new RegExp(`^${option.label}`) });
    expect(card.textContent?.includes(option.consequence)).toBe(layout === 'list');
    expect(card.title.includes(option.consequence)).toBe(layout === 'compact');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Write my own answer' })).toBeNull();
  });

  it.each(['blocked', 'frozen', 'locked'] as const)('keeps every send gated while %s without losing the note', state => {
    const values = props({ ...(state === 'blocked' ? { blocked: 'Review the current question' } : { [state]: true }) });
    const view = render(<AnswerControl {...values} />);
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.click(send());
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    fireEvent.keyDown(view.container.querySelector('[data-answer-option="0"]')!, { key: 'Enter' });
    expect(values.onSendOption).not.toHaveBeenCalled(); expect(values.onSendText).not.toHaveBeenCalled();
    expect(box.value).toBe(values.draft);
    expect(box.disabled).toBe(state === 'locked');
    view.rerender(<AnswerControl {...values} blocked={undefined} frozen={false} locked={false} />);
    fireEvent.click(send());
    expect(values.onSendOption).toHaveBeenCalledExactlyOnceWith(0, values.draft);
  });

  it('keeps 1–9 picking separate from sending; Enter on a card sends that card', async () => {
    const user = userEvent.setup(), many = Array.from({ length: 9 }, (_, index) => ({ ...options[1]!, id: `choice-${index}`, label: `Choice ${index + 1}` }));
    const values = props({ options: many, selected: -1, draft: '' });
    const view = render(<AnswerControl {...values} />);
    (view.container.querySelector('[data-answer-option="0"]') as HTMLElement).focus();
    await user.keyboard('9');
    expect(values.onSelect).toHaveBeenCalledExactlyOnceWith(8);
    expect(values.onSendOption).not.toHaveBeenCalled();
    view.rerender(<AnswerControl {...values} selected={8} />);
    (view.container.querySelector('[data-answer-option="8"]') as HTMLElement).focus(); await user.keyboard('{Enter}');
    expect(values.onSendOption).toHaveBeenCalledExactlyOnceWith(8, '');
  });

  it('offers just own words for a free-text question', async () => {
    const user = userEvent.setup(), values = props({ options: [], selected: -1 });
    render(<AnswerControl {...values} />);
    expect(screen.queryByRole('button', { name: '+ Add a note' })).toBeNull();
    screen.getByRole('textbox', { name: 'Reply in your own words' }).focus(); await user.keyboard('{Meta>}{Enter}{/Meta}');
    expect(values.onSendText).toHaveBeenCalledExactlyOnceWith(values.draft);
  });

  it('a sealed bar locks the cards, dims the unpicked ones and replaces Send', () => {
    const values = props({ bar: { icon: 'ph ph-check', tone: 'done', text: 'Sent at 21:25. Waiting for the agent to pick it up.', narrow: 'Sent at 21:25.', sealed: true,
      actions: <button type="button">Undo</button> } });
    const view = render(<AnswerControl {...values} />);
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: '+ Add a note' })).toBeNull();
    expect(screen.getByText(values.draft.trim(), { exact: false })).toBeTruthy();
    expect(view.container.querySelectorAll('.answer-card-dim')).toHaveLength(2);
    expect(view.container.querySelector('.answer-card-on .answer-check')).toBeTruthy();
    fireEvent.click(view.container.querySelector('[data-answer-option="1"]')!);
    fireEvent.keyDown(view.container.querySelector('.answer')!, { key: '2' });
    expect(values.onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('Sent at 21:25. Waiting for the agent to pick it up.');
    expect(view.container.querySelector('.answer-bar')!.getAttribute('data-tone')).toBe('done');
  });
});
