import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { STATUS, StatusBadge } from '../../../apps/desktop/src/components/reference/StatusBadge';
import { TreeRow, type TreeRowProps } from '../../../apps/desktop/src/components/reference/TreeRow';

afterEach(cleanup);
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
