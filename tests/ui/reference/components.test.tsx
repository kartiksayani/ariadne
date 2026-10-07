import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { STATUS, StatusBadge } from '../../../apps/desktop/src/components/reference/StatusBadge';
import { AnswerControl, type AnswerControlProps } from '../../../apps/desktop/src/components/reference/AnswerControl';
import { TreeRow, type TreeRowProps } from '../../../apps/desktop/src/components/reference/TreeRow';

afterEach(cleanup);
const options = [
  { id: 'approve', label: 'Approve', consequence: 'Continue with the current plan.', recommended: true },
  { id: 'change', label: 'Change the plan', consequence: 'Keep the question open.' },
];
const answerProps = (): AnswerControlProps => ({ options, selected: null, draft: '', onSelect: vi.fn(), onDraft: vi.fn(), onSubmit: vi.fn(), onEscape: vi.fn() });
const rowProps = (): TreeRowProps => ({ item: { id: 'Q-42', question: 'Should we continue?', status: 'open' }, onSelect: vi.fn(), onToggle: vi.fn(), onEnter: vi.fn(), onLeave: vi.fn() });

describe('source presentation primitives', () => {
  it('renders every source status label, regular/fill icon and badge variant', () => {
    for (const status of Object.keys(STATUS) as (keyof typeof STATUS)[]) {
      const { container, unmount } = render(<><StatusBadge status={status} /><StatusBadge status={status} variant="text" /><StatusBadge status={status} variant="icon" /></>);
      expect(screen.getAllByText(STATUS[status].label)).toHaveLength(2);
      expect(screen.getByRole('img').className).toBe(STATUS[status].icon);
      expect(container.querySelectorAll('i')).toHaveLength(2);
      unmount();
    }
    render(<StatusBadge status="open" label="Later" variant="icon" size={20} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Later');
    expect(screen.getByRole('img').style.fontSize).toBe('20px');
  });

  it('starts without a selected recommendation; click and number keys only select', () => {
    const props = answerProps();
    const { rerender } = render(<AnswerControl {...props} />);
    expect(screen.queryByText('Send “Approve”')).toBeNull();
    expect(screen.getAllByRole('button').filter(button => button.getAttribute('aria-pressed') === 'true')).toHaveLength(0);
    fireEvent.click(screen.getByTitle('Press 1 to select'));
    fireEvent.keyDown(screen.getByTitle('Press 1 to select'), { key: '2' });
    fireEvent.keyDown(screen.getByTitle('Press 1 to select'), { key: '9' });
    fireEvent.keyDown(screen.getByTitle('Press 1 to select'), { key: '1', ctrlKey: true });
    expect(props.onSelect).toHaveBeenNthCalledWith(1, 'approve');
    expect(props.onSelect).toHaveBeenNthCalledWith(2, 'change');
    expect(props.onSubmit).not.toHaveBeenCalled();
    rerender(<AnswerControl {...props} selected="change" variant="compact" noText />);
    expect(screen.getByTitle('Press 2 to select').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Send answer')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('submits option, combined option/text and text-only once; preserves the draft on Escape', () => {
    const props = answerProps();
    const { rerender } = render(<AnswerControl {...props} selected="approve" />);
    fireEvent.click(screen.getByText('Send “Approve”'));
    expect(props.onSubmit).toHaveBeenLastCalledWith({ optionId: 'approve' });
    rerender(<AnswerControl {...props} selected="approve" draft="  Extra context  " />);
    const area = screen.getByRole('textbox');
    area.focus();
    fireEvent.keyDown(area, { key: 'Enter', metaKey: true });
    expect(props.onSubmit).toHaveBeenCalledTimes(2);
    expect(props.onSubmit).toHaveBeenLastCalledWith({ optionId: 'approve', text: 'Extra context' });
    fireEvent.keyDown(area, { key: 'Enter' });
    fireEvent.keyDown(area, { key: '1' });
    expect(props.onSubmit).toHaveBeenCalledTimes(2);
    expect(props.onSelect).not.toHaveBeenCalled();
    fireEvent.change(area, { target: { value: 'Edited draft' } });
    expect(props.onDraft).toHaveBeenCalledWith('Edited draft');
    fireEvent.keyDown(area, { key: 'Escape' });
    expect(props.onEscape).toHaveBeenCalledOnce();
    expect((area as HTMLTextAreaElement).value).toBe('  Extra context  ');
    rerender(<AnswerControl {...props} selected="missing" draft="Text alone" />);
    screen.getByRole('textbox').focus();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', metaKey: true });
    expect(props.onSubmit).toHaveBeenLastCalledWith({ text: 'Text alone' });
    fireEvent.click(screen.getByText('Send reply'));
    expect(props.onSubmit).toHaveBeenCalledTimes(4);
  });

  it('uses plain Enter to activate the focused option/Send button, never to submit from the container', async () => {
    const user = userEvent.setup();
    const props = answerProps();
    render(<AnswerControl {...props} selected="approve" draft="Kept context" />);
    screen.getByTitle('Press 2 to select').focus();
    await user.keyboard('{Enter}');
    expect(props.onSelect).toHaveBeenCalledExactlyOnceWith('change');
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByText(/Enter sends/)).toBeNull();
    expect(screen.getByText('⌘↵ sends · Esc closes, keeps your draft')).toBeTruthy();
    const area = screen.getByRole('textbox');
    fireEvent.keyDown(area, { key: 'Enter', metaKey: true });
    expect(props.onSubmit).not.toHaveBeenCalled();
    area.focus();
    await user.keyboard('{End}{Enter}');
    expect(props.onDraft).toHaveBeenCalledWith('Kept context\n');
    expect(props.onSubmit).not.toHaveBeenCalled();
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith({ optionId: 'approve', text: 'Kept context' });
    screen.getByText('Send “Approve”').closest('button')!.focus();
    await user.keyboard('{Enter}');
    expect(props.onSubmit).toHaveBeenCalledTimes(2);
    expect(props.onSubmit).toHaveBeenLastCalledWith({ optionId: 'approve', text: 'Kept context' });
  });

  it('rejects invalid focused input and freezes submission while blocked/saving', () => {
    const props = answerProps();
    const { rerender } = render(<AnswerControl {...props} />);
    screen.getByRole('textbox').focus();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', metaKey: true });
    expect(props.onSubmit).not.toHaveBeenCalled();
    rerender(<AnswerControl {...props} selected="approve" blocked="Offline · your draft is kept" warning="Review the changed question" />);
    expect(screen.getByText('Send “Approve”').closest('button')?.disabled).toBe(true);
    screen.getByRole('textbox').focus();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', metaKey: true });
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('Review the changed question')).toBeTruthy();
    rerender(<AnswerControl {...props} selected="approve" draft="Kept" saving error="Could not save" />);
    fireEvent.keyDown(screen.getByTitle('Press 1 to select'), { key: '2' });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', metaKey: true });
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe('Saving…');
    expect(screen.getByRole('alert').textContent).toBe('Could not save');
    rerender(<AnswerControl {...props} selected="approve" stateLabel="Sent locally" />);
    fireEvent.click(screen.getByText('Send “Approve”'));
    expect(props.onSubmit).toHaveBeenCalledWith({ optionId: 'approve' });
    expect(screen.getByRole('status').textContent).toBe('Sent locally');
    for (const stateLabel of ['Saved', 'Queued', 'Delivering', 'Received', 'Delivery uncertain']) {
      rerender(<AnswerControl {...props} stateLabel={stateLabel} />);
      expect(screen.getByRole('status').textContent).toBe(stateLabel);
    }
  });

  it('keeps row selection separate from child toggles/actions, delivery retry and inline answer', () => {
    const props = rowProps();
    const retry = vi.fn(), action = vi.fn();
    const { rerender } = render(<TreeRow {...props} depth={2} selected focused hasChildren expanded touched="strong" guides={[{ x: 18 }, { x: 42, accent: true }, { x: 42, elbowWidth: 16 }]} segments={[{ text: 'Should ', match: true }, { text: 'we continue?' }]} roundTag="2" actions={[{ kind: 'reply', label: 'Reply', icon: 'ph ph-chat-circle', onClick: action }]} delivery={{ text: 'Awaiting acknowledgement', icon: 'ph ph-clock', action: 'Retry', onAction: retry }} collapsedSummary="3 hidden questions" answer={<button type="button">Inline answer</button>} />);
    const row = screen.getByRole('treeitem');
    expect(row.getAttribute('aria-level')).toBe('3');
    expect(row.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByLabelText('Expand or collapse'));
    fireEvent.click(screen.getByText('3 hidden questions'));
    expect(props.onToggle).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByLabelText('Reply'));
    fireEvent.click(screen.getByText('Retry'));
    fireEvent.click(screen.getByText('Inline answer'));
    expect(action).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
    expect(props.onSelect).not.toHaveBeenCalled();
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.mouseEnter(row); fireEvent.mouseLeave(row);
    expect(props.onSelect).toHaveBeenCalledTimes(2);
    expect(props.onEnter).toHaveBeenCalledOnce(); expect(props.onLeave).toHaveBeenCalledOnce();
    rerender(<TreeRow {...props} hovered hasChildren touched="weak" collapsedSummary="Hidden" />);
    expect(screen.getByRole('treeitem').getAttribute('aria-expanded')).toBe('false');
    rerender(<TreeRow {...props} context />);
    expect(screen.getByRole('treeitem').getAttribute('aria-expanded')).toBeNull();
  });

  it('moves keyboard focus to the selected tree root', async () => {
    const user = userEvent.setup();
    render(<TreeRow {...rowProps()} selected />);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('treeitem'));
    expect(document.activeElement?.matches('.ariadne-reference:focus')).toBe(true);
  });

  it('renders exactly one supporting line in source priority, preserving Later and Explained roles', () => {
    const props = rowProps();
    const { rerender } = render(<TreeRow {...props} item={{ ...props.item, later: true }} delivery={{ text: 'Delivery wins', icon: 'ph ph-clock' }} />);
    expect(screen.queryByText('Parked for later · still open')).toBeNull();
    expect(screen.getByText('Later')).toBeTruthy();
    rerender(<TreeRow {...props} item={{ ...props.item, later: true }} />);
    expect(screen.getByText('Parked for later · still open')).toBeTruthy();
    rerender(<TreeRow {...props} item={{ ...props.item, status: 'waiting', ask: 'Choose a path', outcome: 'Hidden outcome' }} />);
    expect(screen.getByText('Choose a path')).toBeTruthy();
    expect(screen.queryByText('Hidden outcome')).toBeNull();
    rerender(<TreeRow {...props} item={{ ...props.item, status: 'progress', note: 'Agent is checking' }} />);
    expect(screen.getByText('Agent is checking')).toBeTruthy();
    for (const status of ['decided', 'done', 'dropped'] as const) {
      rerender(<TreeRow {...props} item={{ ...props.item, status, outcome: 'Confirmed result', explanation: status === 'done' }} />);
      expect(screen.getByText('Confirmed result')).toBeTruthy();
      if (status === 'done') expect(screen.getByText('Explained')).toBeTruthy();
    }
    const reveal = vi.fn();
    rerender(<TreeRow {...props} selected item={{ ...props.item, status: 'replaced', outcome: 'Old outcome' }} replacement={{ question: 'Replacement question', status: 'open', onReveal: reveal }} actions={[{ kind: 'reopen', label: 'Reopen', icon: 'ph ph-arrow-clockwise', onClick: vi.fn() }, { kind: 'followup', label: 'Follow up', icon: 'ph ph-plus', onClick: vi.fn() }]} />);
    expect(screen.queryByLabelText('Reopen')).toBeNull();
    expect(screen.getByLabelText('Follow up')).toBeTruthy();
    expect(screen.queryByText('Old outcome')).toBeNull();
    fireEvent.click(screen.getByText('Replacement question'));
    expect(reveal).toHaveBeenCalledOnce();
    expect(props.onSelect).not.toHaveBeenCalled();
  });
});
