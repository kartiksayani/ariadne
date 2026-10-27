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
  render(<FilterRow counts={{ ...none, waiting: 2, open: 3 }} picked={[]} active={!!props.picked?.length} shown={5} total={20} disabled={false}
    onChip={onChip} onClear={onClear} {...props} />);
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

  it.each([['owners'], ['hide later'], ['a leftover saved status']])('shows the summary and Clear when the filter is active with no chip picked (%s)', () => {
    const { group, onClear } = row({ picked: [], active: true, shown: 4, total: 20 });
    expect(within(group).queryByText('Pick a status')).toBeNull();
    expect(within(group).getByRole('status').textContent).toContain('Showing 4 of 20 items');
    fireEvent.click(within(group).getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('reports the chip that was clicked', () => {
    const { group, onChip } = row({ counts: { ...none, toack: 1, later: 2 } });
    fireEvent.click(within(group).getByRole('button', { name: 'Later 2' }));
    fireEvent.click(within(group).getByRole('button', { name: 'To ack 1' }));
    expect(onChip.mock.calls).toEqual([['later'], ['toack']]);
  });

  it('G3: shows a chip with nothing visible but hidden items behind it, named "<status> 0, N more hidden"', () => {
    const { group, names } = row({ counts: { ...none, waiting: 2 }, hidden: { ...none, open: 2, done: 1 } });
    expect(names()).toEqual(['Waiting on me 2', 'Open 0, 2 more hidden', 'Done 0, 1 more hidden']);
    expect(within(group).getByRole('button', { name: 'Open 0, 2 more hidden' }).textContent).toContain('+2 hidden');
  });

  it('G3: a chip with both sides says both, and a chip with no hidden items keeps its plain name', () => {
    const { names } = row({ counts: { ...none, open: 3, done: 4 }, hidden: { ...none, open: 1 } });
    expect(names()).toEqual(['Open 3, 1 more hidden', 'Done 4']);
  });

  it('G6: with no chip to draw and no filter, says "Nothing to filter", not "Pick a status"', () => {
    const { group } = row({ counts: none, hidden: none });
    expect(within(group).getByText('Nothing to filter')).toBeTruthy();
    expect(within(group).queryByText('Pick a status')).toBeNull();
    expect(within(group).queryByRole('button')).toBeNull();
  });

  it('G6: a filter that is active with no chip drawn still shows the summary and Clear, never an empty strip', () => {
    const { group, onClear } = row({ counts: none, hidden: none, active: true, shown: 0, total: 0 });
    expect(within(group).queryByText('Nothing to filter')).toBeNull();
    expect(within(group).getByRole('status').textContent).toContain('Showing 0 of 0 items');
    fireEvent.click(within(group).getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('G3, G15: before the reveal, says how many hidden items match and offers "Show them"', () => {
    const onShowHidden = vi.fn();
    const { group } = row({ picked: ['open'], shown: 0, total: 5, note: { remaining: 2, shown: 0, outside: 0, owned: false }, onShowHidden, onHideShown: vi.fn() });
    expect(group.textContent).toContain('Showing 0 of 5 items');
    expect(group.textContent).toContain('+2 hidden match');
    expect(within(group).queryByRole('button', { name: 'Hide them' })).toBeNull();
    fireEvent.click(within(group).getByRole('button', { name: 'Show them' }));
    expect(onShowHidden).toHaveBeenCalledTimes(1);
  });

  it('G10, G15: names the matches outside Focus beside the ones Show them can reach', () => {
    const { group } = row({ picked: ['open'], note: { remaining: 2, shown: 0, outside: 3, owned: false }, onShowHidden: vi.fn(), onHideShown: vi.fn() });
    expect(group.textContent).toContain('+2 hidden match (3 outside Focus)');
    expect(within(group).getByRole('button', { name: 'Show them' })).toBeTruthy();
  });

  it('G15: with every hidden match outside Focus there is nothing to show, only the count', () => {
    const { group } = row({ picked: ['open'], note: { remaining: 0, shown: 0, outside: 3, owned: false }, onShowHidden: vi.fn(), onHideShown: vi.fn() });
    expect(group.textContent).toContain('3 hidden match outside Focus');
    expect(within(group).queryByRole('button', { name: 'Show them' })).toBeNull();
    expect(group.textContent).not.toContain('+0');
  });

  it('G15: after the reveal, says how many are shown and offers "Hide them"', () => {
    const onHideShown = vi.fn();
    const { group } = row({ picked: ['open'], note: { remaining: 0, shown: 2, outside: 0, owned: true }, onShowHidden: vi.fn(), onHideShown });
    expect(group.textContent).toContain('2 hidden shown');
    expect(within(group).queryByRole('button', { name: 'Show them' })).toBeNull();
    fireEvent.click(within(group).getByRole('button', { name: 'Hide them' }));
    expect(onHideShown).toHaveBeenCalledTimes(1);
  });

  it('G15: "Hide them" stays while the reveal holds anything, whatever the remaining count; both parts show when both apply', () => {
    const { group } = row({ picked: ['open'], note: { remaining: 1, shown: 2, outside: 0, owned: true }, onShowHidden: vi.fn(), onHideShown: vi.fn() });
    expect(group.textContent).toContain('2 hidden shown');
    expect(group.textContent).toContain('+1 hidden match');
    expect(within(group).getByRole('button', { name: 'Hide them' })).toBeTruthy();
    expect(within(group).getByRole('button', { name: 'Show them' })).toBeTruthy();
  });

  it('G15: a reveal that holds state but shows nothing now still offers "Hide them", without "0 hidden shown"', () => {
    const { group } = row({ picked: ['open'], note: { remaining: 0, shown: 0, outside: 0, owned: true }, onShowHidden: vi.fn(), onHideShown: vi.fn() });
    expect(within(group).getByRole('button', { name: 'Hide them' })).toBeTruthy();
    expect(group.textContent).not.toContain('0 hidden shown');
  });

  it('G5: the Graph passes no actions; the note is text only', () => {
    const { group } = row({ picked: ['open'], note: { remaining: 3, shown: 0, outside: 0, owned: false } });
    expect(group.textContent).toContain('+3 hidden match');
    expect(within(group).queryByRole('button', { name: 'Show them' })).toBeNull();
    expect(within(group).queryByRole('button', { name: 'Hide them' })).toBeNull();
  });

  it('draws no note when nothing hidden matches', () => {
    const { group } = row({ picked: ['open'], note: { remaining: 0, shown: 0, outside: 0, owned: false }, onShowHidden: vi.fn(), onHideShown: vi.fn() });
    expect(group.textContent).not.toContain('hidden');
    expect(within(group).queryByRole('button', { name: 'Show them' })).toBeNull();
    expect(within(group).queryByRole('button', { name: 'Hide them' })).toBeNull();
  });

  it('disables the note actions with the rest while a write is unconfirmed', () => {
    const { group } = row({ picked: ['open'], disabled: true, note: { remaining: 1, shown: 1, outside: 0, owned: true }, onShowHidden: vi.fn(), onHideShown: vi.fn() });
    for (const name of ['Show them', 'Hide them']) expect((within(group).getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
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

  it('keeps a refused write for this page: the pick shows, and stays, until reload', () => {
    const refuse = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    const { result } = renderHook(() => ({ a: useLocalChips('refused'), b: useLocalChips('refused'), other: useLocalChips('s2') }));
    act(() => result.current.a.set(['sent']));
    expect(refuse).toHaveBeenCalled();
    expect(result.current.a.chips).toEqual(['sent']);
    expect(result.current.b.chips).toEqual(['sent']);
    expect(result.current.other.chips).toEqual([]);
    act(() => result.current.a.set(['sent', 'later']));
    expect(result.current.b.chips).toEqual(['sent', 'later']);
    act(() => result.current.a.set([]));
    expect(result.current.b.chips).toEqual([]);
    expect(localStorage.getItem(LOCAL_CHIPS_KEY)).toBeNull();
    refuse.mockRestore();
  });

  it('keeps a refused clear: the stored pick does not come back, and the next accepted write takes over', () => {
    const { result } = renderHook(() => useLocalChips('refused-clear'));
    act(() => result.current.set(['blocked']));
    const refuse = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    act(() => result.current.set([]));
    expect(result.current.chips).toEqual([]);
    refuse.mockRestore();
    act(() => result.current.set(['later']));
    expect(result.current.chips).toEqual(['later']);
    expect(stored()).toEqual({ 'refused-clear': ['later'] });
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
