import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import demo from '../../../../../fixtures/domain/demo/session.json';
import type { Session } from '../../../src/generated/domain/models';
import { immutable } from '../../../src/data';
import { ItemRow, type ItemRowProps, type RowAction } from '../../../src/ui/tree/ItemRow';
import { TopicRow, type TopicAction, type TopicRowProps } from '../../../src/ui/tree/TopicRow';

afterEach(cleanup);

function itemProps(actions: readonly RowAction[]): ItemRowProps {
  const template = (demo as Session).items['1']!;
  const item = immutable({ ...template, question: 'Choose the orchard planting order', status: 'open' as const,
    outcome: 'Plant the pear trees first.', ask: null, note: null });
  return { row: { kind: 'item', key: item.id, item, status: 'open', ack: null, depth: 1, hasKids: false,
    expanded: false, context: false, guides: [], later: false, hidden: false, segments: [{ text: item.question, hit: false }],
    replacedBy: null, rounds: 3, relatedCount: 2, collapsed: null, delivery: null, badge: 'Open' },
  selected: false, focused: true, highlight: null, note: null, actions, answer: null, unfolded: false,
  onUnfold: vi.fn(), remember: vi.fn(), onFocus: vi.fn(), onKeyDown: vi.fn(), onSelect: vi.fn(),
  onToggle: vi.fn(), onJump: vi.fn(), onHover: vi.fn() };
}

function topicProps(actions: readonly TopicAction[]): TopicRowProps {
  const topic = immutable({ ...Object.values((demo as Session).topics)[0]!, name: 'Orchard plans' });
  return { row: { kind: 'topic', key: topic.id, topic, depth: 0, expanded: true, first: true, guides: [],
    counts: [{ text: '2 open', icon: 'ph ph-circle', color: 'var(--st-open)' },
      { text: '1 closed', icon: 'ph ph-check', color: 'var(--st-done)' }],
    earlier: false, chip: null, allClosed: false, delivery: null }, focused: true, actions, prompt: null,
  remember: vi.fn(), onFocus: vi.fn(), onKeyDown: vi.fn(), onToggle: vi.fn() };
}

describe('compact row actions', () => {
  it('keeps every item action in its existing order with the same names, tab behavior and callbacks', () => {
    const names = ['Ack → Done', 'Bring it up (b)', 'Reply (r)', 'Drop (d)', 'Later (z)', 'Back to Open (o)', 'Hide (x)', 'Remove (⌫)'];
    const actions: RowAction[] = names.map((title, index) => ({ title, icon: 'ph ph-check', run: vi.fn(),
      ...(index === 0 ? { label: 'Ack', persistent: true } : {}),
      ...(title === 'Hide (x)' ? { glyph: <svg aria-hidden="true" data-testid="hide-icon" /> } : {}) }));
    const props = itemProps(actions), { container } = render(<ItemRow {...props} />);
    const grid = container.querySelector('.tree-action-grid')!, buttons = within(grid as HTMLElement).getAllByRole('button');
    expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual(names);
    expect(buttons.map(button => button.title)).toEqual(names);
    expect(buttons.map(button => button.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1, -1]);
    expect(container.querySelectorAll('.tree-ack-slot')).toHaveLength(1);
    expect(container.querySelectorAll('.tree-actions')).toHaveLength(1);
    expect(buttons[0]!.closest('.tree-actions')).toBeNull();
    expect(within(buttons[6]!).getByTestId('hide-icon')).toBeTruthy();
    for (const [index, button] of buttons.entries()) {
      expect(button.getAttribute('type')).toBe('button');
      expect(button.classList.contains('tree-action')).toBe(true);
      fireEvent.click(button);
      expect(actions[index]!.run).toHaveBeenCalledOnce();
    }
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(container.querySelector('.tree-row-status')?.textContent).toBe('1Open');
    expect(container.querySelector('.tree-related')?.getAttribute('aria-label')).toBe('2 related items');
    expect(container.querySelector('.tree-round')?.textContent).toBe('Round 3');
  });

  it('preserves disabled Ack and keeps action markup stable when hovering and selecting a row', () => {
    const ack = vi.fn(), reply = vi.fn(), props = itemProps([
      { title: 'Ack → Done', icon: 'ph ph-check', label: 'Ack', persistent: true, disabled: true, run: ack },
      { title: 'Reply (r)', icon: 'ph ph-chat-text', run: reply },
    ]);
    const { container, rerender } = render(<ItemRow {...props} />);
    const row = container.querySelector('.tree-item')!, grid = container.querySelector('.tree-action-grid')!, before = grid.innerHTML;
    const button = within(grid as HTMLElement).getByRole('button', { name: 'Ack → Done' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button); expect(ack).not.toHaveBeenCalled();
    fireEvent.mouseEnter(row); expect(props.onHover).toHaveBeenCalledWith('1');
    rerender(<ItemRow {...props} selected />);
    expect(container.querySelector('.tree-action-grid')?.innerHTML).toBe(before);
    expect(within(grid as HTMLElement).getByRole('button', { name: 'Reply (r)' }).tabIndex).toBe(-1);
    const selections = vi.mocked(props.onSelect).mock.calls.length;
    fireEvent.click(within(grid as HTMLElement).getByRole('button', { name: 'Reply (r)' }));
    expect(reply).toHaveBeenCalledOnce(); expect(props.onSelect).toHaveBeenCalledTimes(selections);
  });

  it('retains item metadata without an empty action grid or hover placeholder', () => {
    const { container } = render(<ItemRow {...itemProps([])} />);
    expect(container.querySelector('.tree-action-grid')).toBeNull();
    expect(container.querySelector('.tree-actions')).toBeNull();
    expect(container.querySelector('.tree-ack-slot')).toBeNull();
    expect(container.querySelector('.tree-row-status')?.textContent).toBe('1Open');
    expect(container.querySelector('.tree-question')?.textContent).toBe('Choose the orchard planting order');
    expect(container.querySelector('.tree-outcome')?.textContent).toBe('Plant the pear trees first.');
  });

  it('preserves topic action order, accessible names, shortcut marker and callbacks beside grouped counts', () => {
    const names = ['Reply to topic', 'Continue here', 'Archive', 'Remove'];
    const actions: TopicAction[] = names.map(label => ({ label, title: `${label} in this topic`, icon: 'ph ph-check',
      run: vi.fn(), archive: label === 'Archive' }));
    const props = topicProps(actions), { container } = render(<TopicRow {...props} />);
    const grid = container.querySelector('.tree-topic-actions')!, buttons = within(grid as HTMLElement).getAllByRole('button');
    expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual(names);
    expect(buttons.map(button => button.title)).toEqual(names.map(name => `${name} in this topic`));
    for (const [index, button] of buttons.entries()) {
      expect(button.tabIndex).toBe(-1); expect(button.getAttribute('type')).toBe('button');
      expect(button.classList.contains('tree-topic-action')).toBe(true);
      expect(button.getAttribute('data-shortcut-archive-topic')).toBe(index === 2 ? props.row.topic.id : null);
      fireEvent.click(button); expect(actions[index]!.run).toHaveBeenCalledOnce();
    }
    expect(props.onToggle).not.toHaveBeenCalled();
    expect([...container.querySelectorAll('.tree-topic-counts .tree-count')].map(count => count.textContent)).toEqual(['2 open', '1 closed']);
  });

  it('omits empty topic actions and counts while retaining the topic name and toggle', () => {
    const props = topicProps([]), { container } = render(<TopicRow {...props} row={{ ...props.row, counts: [] }} />);
    expect(container.querySelector('.tree-topic-actions')).toBeNull();
    expect(container.querySelector('.tree-topic-counts')).toBeNull();
    expect(container.querySelector('.tree-topic-name')?.textContent).toBe('Orchard plans');
    fireEvent.click(within(container).getByRole('button', { name: 'Expand or collapse topic' }));
    expect(props.onToggle).toHaveBeenCalledWith(props.row.topic.id);
  });
});
