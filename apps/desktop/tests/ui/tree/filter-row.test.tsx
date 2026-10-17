import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { FilterRow } from '../../../src/ui/tree/FilterRow';
import { useLocalChips } from '../../../src/ui/tree/useLocalChips';
import { CHIP_ORDER, LOCAL_CHIPS_KEY, type Chip } from '../../../src/selectors/tree/filter';

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); localStorage.clear(); });

const none = Object.fromEntries(CHIP_ORDER.map(chip => [chip, 0])) as Record<Chip, number>;
function row(props: Partial<Parameters<typeof FilterRow>[0]> = {}) {
  const onChip = vi.fn(), onClear = vi.fn();
  render(<FilterRow counts={{ ...none, waiting: 2, open: 3 }} picked={[]} shown={5} total={20} disabled={false} onChip={onChip} onClear={onClear} {...props} />);
  const group = screen.getByRole('group', { name: 'Filter items' });
  return { group, onChip, onClear, // The chips carry "<status> <count>" as their name; Clear is named by its text.
    names: () => within(group).getAllByRole('button').flatMap(button => button.getAttribute('aria-label') ?? []) };
}

describe('the chip row', () => {
  it('shows a chip when it counts something, in board order, named "<status> <count>"', () => {
    const { names } = row({ counts: { ...none, replaced: 1, done: 4, waiting: 2, toack: 3, sent: 1 } });
    expect(names()).toEqual(['Waiting on me 2', 'To ack 3', 'Sent 1', 'Done 4', 'Replaced 1']);
  });

  it('keeps a picked chip at zero and hides an unpicked zero', () => {
    const { names } = row({ counts: { ...none, open: 3 }, picked: ['blocked'] });
    expect(names()).toEqual(['Open 3', 'Blocked 0']);
  });

  it('marks the picked chips pressed', () => {
    const { group } = row({ picked: ['open'] });
    expect(within(group).getByRole('button', { name: 'Open 3' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(group).getByRole('button', { name: 'Waiting on me 2' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('asks for a status, with no summary and no Clear, while nothing is picked', () => {
    const { group } = row();
    expect(within(group).getByText('Pick a status')).toBeTruthy();
    expect(within(group).queryByRole('button', { name: 'Clear' })).toBeNull();
    expect(within(group).queryByRole('status')).toBeNull();
  });

  it('shows the summary in a wide and a narrow form, and Clear, once something is picked', () => {
    const { group, onClear } = row({ picked: ['open'], shown: 7, total: 20 });
    expect(within(group).queryByText('Pick a status')).toBeNull();
    expect(within(group).getByRole('status').textContent).toContain('Showing 7 of 20 items');
    expect(within(group).getByText('7 of 20').getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(within(group).getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('reports the chip that was clicked', () => {
    const { group, onChip } = row({ counts: { ...none, toack: 1, later: 2 } });
    fireEvent.click(within(group).getByRole('button', { name: 'Later 2' }));
    fireEvent.click(within(group).getByRole('button', { name: 'To ack 1' }));
    expect(onChip.mock.calls).toEqual([['later'], ['toack']]);
  });

  it('disables every chip and Clear while a write is unconfirmed', () => {
    const { group, onChip, onClear } = row({ picked: ['open'], disabled: true });
    for (const button of within(group).getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(group).getByRole('button', { name: 'Open 3' }));
    fireEvent.click(within(group).getByRole('button', { name: 'Clear' }));
    expect(onChip).not.toHaveBeenCalled(); expect(onClear).not.toHaveBeenCalled();
  });
});

describe('the local chips store (D15)', () => {
  const stored = () => JSON.parse(localStorage.getItem(LOCAL_CHIPS_KEY) ?? '{}') as Record<string, string[]>;

  it('starts empty and keeps one array while nothing changes', () => {
    const { result, rerender } = renderHook(() => useLocalChips('s1'));
    const first = result.current.chips;
    expect(first).toEqual([]);
    rerender();
    expect(result.current.chips).toBe(first);
  });

  it('saves a pick in the browser under the session and updates every reader of it', () => {
    const both = renderHook(() => ({ a: useLocalChips('s1'), b: useLocalChips('s1'), other: useLocalChips('s2') }));
    act(() => both.result.current.a.set(['sent', 'toack']));
    expect(stored()).toEqual({ s1: ['toack', 'sent'] });
    expect(both.result.current.a.chips).toEqual(['toack', 'sent']);
    expect(both.result.current.b.chips).toEqual(['toack', 'sent']);
    expect(both.result.current.other.chips).toEqual([]);
  });

  it('reads a pick saved before it mounted, and drops the session from storage when emptied', () => {
    localStorage.setItem(LOCAL_CHIPS_KEY, JSON.stringify({ s1: ['later'] }));
    const { result } = renderHook(() => useLocalChips('s1'));
    expect(result.current.chips).toEqual(['later']);
    act(() => result.current.set([]));
    expect(result.current.chips).toEqual([]);
    expect(stored()).toEqual({});
  });

  it.each(['not json', '[]', '{"s1":"sent"}', '{"s1":[1,"nope"]}'])('falls back to no chips for %s', raw => {
    localStorage.setItem(LOCAL_CHIPS_KEY, raw);
    const { result } = renderHook(() => useLocalChips('s1'));
    expect(result.current.chips).toEqual([]);
    act(() => result.current.set(['blocked']));
    expect(result.current.chips).toEqual(['blocked']);
    expect(stored()).toEqual({ s1: ['blocked'] });
  });

  it('keeps the 50 most recently changed sessions and drops the oldest', () => {
    const { result } = renderHook(() => ({ first: useLocalChips('s0'), last: useLocalChips('s50') }));
    for (let index = 0; index <= 50; index++) {
      const { result: one } = renderHook(() => useLocalChips(`s${index}`));
      act(() => one.current.set(['sent']));
    }
    expect(Object.keys(stored())).toHaveLength(50);
    expect(stored().s0).toBeUndefined();
    expect(result.current.first.chips).toEqual([]);
    expect(result.current.last.chips).toEqual(['sent']);
  });
});
