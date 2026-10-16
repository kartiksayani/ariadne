import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AnswerControl, defaultSelection, type AnswerControlProps } from '../../../src/ui/answer/AnswerControl';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const options = [{ id: 'yes', label: 'Keep the design', consequence: 'Keep the current plan.', recommended: true }];
const props = (changes: Partial<AnswerControlProps> = {}): AnswerControlProps => ({ options, variant: 'full', selected: 0,
  draft: ' A note with exact spaces \n', onSelect: vi.fn(), onDraft: vi.fn(), onSendOption: vi.fn(), onSendText: vi.fn(), ...changes });

describe('shared answer control pinning', () => {
  it.each(['full', 'chat'] as const)('keeps multiline words, plain Enter and Escape in the %s editor', variant => {
    const values = props({ variant, onEscape: vi.fn() });
    const view = render(<AnswerControl {...values} />);
    const box = screen.getByRole('textbox', { name: 'Reply in your own words' });
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
  });
});

describe('exclusive answer modes with an optional note', () => {
  it('selects only an explicit owner choice, including when one is recommended', () => {
    expect(defaultSelection(options, null)).toBe(-1);
    expect(defaultSelection(options, undefined)).toBe(-1);
    expect(defaultSelection(options, 'removed')).toBe(-1);
    expect(defaultSelection(options, 'yes')).toBe(0);
  });
  it.each([{ variant: 'full' as const, compactOptions: false }, { variant: 'chat' as const, compactOptions: false }, { variant: 'chat' as const, compactOptions: true }])('sends only the selected mode in the $variant control (compact=$compactOptions), preserving words when it changes', ({ variant, compactOptions }) => {
    const values = props({ variant, compactOptions }), view = render(<AnswerControl {...values} />);
    const box = screen.getByRole('textbox');
    const send = screen.getByRole('button', { name: 'Send “Keep the design” with your note' });
    expect(send.classList.contains('btn-primary')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Send as a reply only' })).toBeNull();
    expect(box.getAttribute('placeholder')).toBe('Add a note for the agent…');
    fireEvent.click(send);
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(values.onSendOption).toHaveBeenCalledTimes(2);
    expect(values.onSendOption).toHaveBeenLastCalledWith(0, values.draft);
    expect(values.onSendText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Write my own answer' }));
    expect(values.onSelect).toHaveBeenCalledExactlyOnceWith(-1);
    expect(values.onDraft).not.toHaveBeenCalled();
    view.rerender(<AnswerControl {...values} selected={-1} />);
    expect((box as HTMLTextAreaElement).value).toBe(values.draft);
    expect(box.getAttribute('placeholder')).toBe('Answer in your own words…');
    expect(screen.getByRole('button', { name: 'Write my own answer' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(values.onSendText).toHaveBeenCalledExactlyOnceWith(values.draft);
    fireEvent.click(view.container.querySelector('[data-answer-option="0"]')!);
    expect(values.onSelect).toHaveBeenLastCalledWith(0);
    view.rerender(<AnswerControl {...values} />);
    expect((box as HTMLTextAreaElement).value).toBe(values.draft);
    expect(screen.getByRole('button', { name: 'Write my own answer' }).getAttribute('aria-pressed')).toBe('false');
  });
  it.each([{ variant: 'compact' as const }, { variant: 'full' as const, noText: true }])('uses the saved note for a control without a text box: %o', changes => {
    const values = props(changes); render(<AnswerControl {...values} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: changes.variant === 'compact' ? 'Send answer' : 'Send “Keep the design”' }));
    expect(values.onSendOption).toHaveBeenCalledExactlyOnceWith(0, undefined);
  });
  it('keeps Send disabled until an option or nonempty own answer exists', () => {
    const values = props({ selected: -1, draft: '  ' }), view = render(<AnswerControl {...values} />);
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<AnswerControl {...values} selected={0} />);
    expect((screen.getByRole('button', { name: 'Send “Keep the design”' }) as HTMLButtonElement).disabled).toBe(false);
    view.rerender(<AnswerControl {...values} draft="My words" />);
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('compact chat choices', () => {
  const choices = [
    { ...options[0]!, consequence: 'Keep the current plan and check each example before sending it. '.repeat(12) },
    { id: 'no', label: 'Change the design after comparing the alternatives', consequence: 'Review the alternatives and explain the tradeoffs in the conversation. '.repeat(12), recommended: false },
  ];
  it('keeps the active editor and exact draft when words become a selected option note', () => {
    const values = props({ variant: 'chat', compactOptions: true, selected: -1, draft: '' });
    const view = render(<AnswerControl {...values} />);
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    box.focus();
    const draft = ' My exact words \n';
    fireEvent.change(box, { target: { value: draft } });
    expect(values.onDraft).toHaveBeenCalledExactlyOnceWith(draft);
    view.rerender(<AnswerControl {...values} draft={draft} />);
    expect(document.activeElement).toBe(box);
    fireEvent.click(view.container.querySelector('[data-answer-option="0"]')!);
    expect(values.onSelect).toHaveBeenCalledExactlyOnceWith(0);
    view.rerender(<AnswerControl {...values} selected={0} draft={draft} />);
    expect(box.value).toBe(draft);
    expect(box.getAttribute('placeholder')).toBe('Add a note for the agent…');
    fireEvent.click(screen.getByRole('button', { name: 'Send “Keep the design” with your note' }));
    expect(values.onSendOption).toHaveBeenCalledExactlyOnceWith(0, draft);
    expect(values.onSendText).not.toHaveBeenCalled();
  });
  it('shows the more-options cue only below actual overflow and updates on scroll, resize and content growth', () => {
    const observers: { update: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal('ResizeObserver', class {
      observe = vi.fn(); disconnect = vi.fn();
      constructor(readonly update: () => void) { observers.push(this); }
    });
    const values = props({ options: choices, variant: 'chat', compactOptions: true });
    const view = render(<AnswerControl {...values} />);
    const region = view.container.querySelector('.answer-choices') as HTMLElement;
    let height = 100, content = 100, top = 0;
    Object.defineProperties(region, {
      clientHeight: { configurable: true, get: () => height },
      scrollHeight: { configurable: true, get: () => content },
      scrollTop: { configurable: true, get: () => top },
    });
    const observer = observers[0]!;
    expect(observer.observe).toHaveBeenCalledWith(region);
    expect(observer.observe).toHaveBeenCalledWith(region.firstElementChild);
    act(() => observer.update());
    expect(region.hasAttribute('data-more-below')).toBe(false);
    content = 200; act(() => observer.update());
    expect(region.getAttribute('data-more-below')).toBe('true');
    top = 100; fireEvent.scroll(region);
    expect(region.hasAttribute('data-more-below')).toBe(false);
    top = 50; fireEvent.scroll(region);
    expect(region.getAttribute('data-more-below')).toBe('true');
    height = 200; fireEvent(window, new Event('resize'));
    expect(region.hasAttribute('data-more-below')).toBe(false);
    content = 300; act(() => observer.update());
    expect(region.getAttribute('data-more-below')).toBe('true');
    content = 200; fireEvent.click(screen.getByRole('button', { name: `More about ${choices[0]!.label}` }));
    expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(region.hasAttribute('data-more-below')).toBe(false);
    height = 100; content = 200;
    view.rerender(<AnswerControl {...values} draft="A longer note" />);
    expect(region.getAttribute('data-more-below')).toBe('true');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('A longer note');
    expect(region.querySelector('[aria-pressed="true"]')?.getAttribute('data-answer-option')).toBe('0');
    expect(values.onSelect).not.toHaveBeenCalled(); expect(values.onDraft).not.toHaveBeenCalled();
    expect(values.onSendOption).not.toHaveBeenCalled(); expect(values.onSendText).not.toHaveBeenCalled();
    view.rerender(<AnswerControl {...values} compactOptions={false} />);
    expect(region.hasAttribute('data-more-below')).toBe(false);
    expect(observers.every(value => value.disconnect.mock.calls.length === 1)).toBe(true);
    view.unmount();
  });
  it('keeps conversation option labels and Recommended inline while More reveals consequences without sending', () => {
    const values = props({ options: choices, variant: 'chat', compactOptions: true }), view = render(<AnswerControl {...values} />);
    const option = view.container.querySelector('[data-answer-option="0"]')!;
    expect(option.querySelector('.answer-option-head .answer-recommended')?.textContent).toBe('Recommended');
    const more = screen.getByRole('button', { name: `More about ${choices[0]!.label}` });
    const consequence = document.getElementById(more.getAttribute('aria-controls')!)!;
    expect(consequence.hidden).toBe(true);
    fireEvent.click(more);
    expect(consequence.hidden).toBe(false);
    expect(consequence.textContent).toBe(choices[0]!.consequence);
    expect(values.onSelect).not.toHaveBeenCalled(); expect(values.onDraft).not.toHaveBeenCalled();
    expect(values.onSendOption).not.toHaveBeenCalled(); expect(values.onSendText).not.toHaveBeenCalled();
    view.rerender(<AnswerControl {...values} compactOptions={false} />);
    expect(option.querySelector('.answer-option-head .answer-recommended')).toBeNull();
    expect(view.container.querySelector('.answer-options-compact')).toBeNull();
    expect(option.querySelector('.answer-consequence .answer-recommended')).toBeTruthy();
  });
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
  it.each([false, true])('collapses the saved words on Escape while keeping every choice and the exact note for sending (compact=%s)', async compactOptions => {
    const user = userEvent.setup(), values = props({ options: choices, variant: 'chat', compactOptions, onEscape: vi.fn() });
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
    expect(values.onSendText).not.toHaveBeenCalled();
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
  it.each(['blocked', 'frozen', 'locked'] as const)('keeps compact choice and reply sends gated while %s without losing the saved note', state => {
    const values = props({ options: choices, variant: 'chat', compactOptions: true,
      ...(state === 'blocked' ? { blocked: 'Review the current question' } : { [state]: true }) });
    const view = render(<AnswerControl {...values} />);
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.click(screen.getByRole('button', { name: 'Send “Keep the design” with your note' }));
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    fireEvent.keyDown(view.container.querySelector('[data-answer-option="0"]')!, { key: 'Enter' });
    expect(values.onSendOption).not.toHaveBeenCalled(); expect(values.onSendText).not.toHaveBeenCalled();
    expect(box.value).toBe(values.draft);
    expect(box.disabled).toBe(state === 'locked');
    view.rerender(<AnswerControl {...values} blocked={undefined} frozen={false} locked={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send “Keep the design” with your note' }));
    expect(values.onSendOption).toHaveBeenCalledExactlyOnceWith(0, values.draft);
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
    expect(screen.getByText('1–9 select · Enter sends · ⌘↵ sends · Esc keeps draft')).toBeTruthy();
    screen.getByRole('button', { name: /9Choice 9/ }).focus(); await user.keyboard('{Enter}');
    expect(values.onSendOption).toHaveBeenCalledExactlyOnceWith(8, values.draft);
  });
  it('offers just the composer and its shortcuts for a free-text question', async () => {
    const user = userEvent.setup(), values = props({ options: [], variant: 'chat', selected: -1 });
    const view = render(<AnswerControl {...values} />);
    expect(screen.queryByRole('button', { name: /More about|Send “/ })).toBeNull();
    expect(view.container.querySelector('details.answer-choices')).toBeNull();
    expect(screen.getByText('⌘↵ sends · Esc keeps draft')).toBeTruthy();
    screen.getByRole('textbox').focus(); await user.keyboard('{Meta>}{Enter}{/Meta}');
    expect(values.onSendText).toHaveBeenCalledExactlyOnceWith(values.draft);
  });
});
