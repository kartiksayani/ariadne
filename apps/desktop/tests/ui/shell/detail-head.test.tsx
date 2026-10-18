// The Details head (alpha.21 E1-E3): the controls, the "…" menu, the path that folds past three levels.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DetailHead, MENU_ORDER, menuActions, type DetailHeadControls } from '../../../src/ui/shell/DetailHead';
import { ItemHistoryContext } from '../../../src/ui/shell/itemHistory';
import { pathSlots } from '../../../src/ui/detail/DetailPath';
import type { ItemActionView } from '../../../src/ui/detail/itemActions';

const original = window.innerWidth;
const viewport = (width: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  act(() => { window.dispatchEvent(new Event('resize')); });
};
beforeEach(() => viewport(1280));
afterEach(() => { cleanup(); viewport(original); });

const history = { canBack: true, canForward: true, back: vi.fn(() => true), forward: vi.fn(() => true) };
const action = (id: ItemActionView['id'], extra: Partial<ItemActionView> = {}): ItemActionView =>
  ({ id, label: id, icon: 'ph ph-copy', run: vi.fn(), applies: true, ...extra });
const mount = (props: { head?: DetailHeadControls; bigger?: boolean; onBackToMap?: () => void } = {}) => render(
  <ItemHistoryContext.Provider value={history}><DetailHead path={<span>The path</span>} {...props.head} bigger={props.bigger} onBackToMap={props.onBackToMap} /></ItemHistoryContext.Provider>);
const menu = () => fireEvent.click(screen.getByRole('button', { name: 'More actions' }));

describe('the head controls', () => {
  it.each([[1280, true], [1100, true], [1099, false], [900, false]])('shows Back and Forward only in a wide window (%ipx: %s)', (width, shown) => {
    viewport(width);
    mount();
    expect(!!screen.queryByRole('button', { name: 'Back' })).toBe(shown);
    expect(!!screen.queryByRole('button', { name: 'Forward' })).toBe(shown);
  });

  it('has no Close × and no Hide or Remove buttons', () => {
    mount({ head: { close: vi.fn(), actions: [action('hide'), action('remove')] } });
    expect(screen.queryByRole('button', { name: /^Close|Hide item|Remove item/ })).toBeNull();
  });

  it.each([[false, 'Read in a bigger view'], [true, 'Back to the Map']])('names the Read toggle for open=%s and runs it', (open, name) => {
    const toggle = vi.fn();
    mount({ head: { read: { open, toggle } } });
    const button = screen.getByRole('button', { name });
    fireEvent.click(button); expect(toggle).toHaveBeenCalledOnce();
  });

  it.each([[false, 'Focus'], [true, 'Unfocus']])('names Focus for on=%s and runs it', (on, name) => {
    const toggle = vi.fn();
    mount({ head: { focus: { on, toggle } } });
    fireEvent.click(screen.getByRole('button', { name })); expect(toggle).toHaveBeenCalledOnce();
  });

  it('shows "← Map" first in the bigger view only, and it goes back to the Map', () => {
    const back = vi.fn();
    const { container, rerender } = mount({ bigger: true, onBackToMap: back });
    expect(container.querySelector('.shell-detail-head')?.firstElementChild).toBe(screen.getByRole('button', { name: 'Back to Map' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to Map' })); expect(back).toHaveBeenCalledOnce();
    expect(container.querySelector('.conversation-header')).not.toBeNull();
    rerender(<DetailHead path={<span>p</span>} />);
    expect(screen.queryByRole('button', { name: 'Back to Map' })).toBeNull();
  });

  it('topic mode (no Read, no Focus, no actions) has the menu with Close Details only', () => {
    const close = vi.fn();
    mount({ head: { close } });
    expect(screen.queryByRole('button', { name: /bigger view|Focus/ })).toBeNull();
    menu();
    expect(screen.getAllByRole('menuitem').map(row => row.textContent)).toEqual(['Close Details ( esc )']);
    expect(screen.queryByRole('separator')).toBeNull();
    fireEvent.click(screen.getByRole('menuitem')); expect(close).toHaveBeenCalledOnce();
  });
});

describe('the "…" menu', () => {
  it('lists the applicable rows in the plan order, then a divider and Close Details; the actions row ids that are not menu rows stay out', () => {
    const ids = ['bring', 'remove', 'later', 'drop', 'unhide', 'hide', 'copyRef', 'reopen', 'followUp'] as const;
    mount({ head: { close: vi.fn(), actions: ids.map(id => action(id, { applies: id !== 'hide' && id !== 'drop' })) } });
    menu();
    expect(screen.getAllByRole('menuitem').map(row => row.textContent)).toEqual(['copyRef', 'followUp', 'reopen', 'unhide', 'remove', 'Close Details ( esc )']);
    expect(screen.getAllByRole('separator')).toHaveLength(1);
  });

  it('greys a row that cannot run, with its reason, and runs the others once, then closes', () => {
    const run = vi.fn(), blocked = vi.fn();
    mount({ head: { actions: [action('followUp', { run: blocked, disabledReason: 'The session is archived.' }), action('copyRef', { run })] } });
    menu();
    const grey = screen.getByRole('menuitem', { name: 'followUp' });
    expect((grey as HTMLButtonElement).disabled).toBe(true); expect(grey.title).toBe('The session is archived.');
    fireEvent.click(grey); expect(blocked).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('menuitem', { name: 'copyRef' })); expect(run).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keeps the menu order table in step with the rows menuActions accepts', () => {
    expect(menuActions(MENU_ORDER.map(id => action(id)))).toHaveLength(MENU_ORDER.length);
    expect(menuActions(null)).toEqual([]);
  });

  it('shows Close Details disabled when nothing can close', () => {
    mount();
    menu();
    expect((within(screen.getByRole('menu')).getByRole('menuitem') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('path levels', () => {
  it.each([
    [0, false, []], [1, false, [0]], [3, false, [0, 1, 2]],
    [4, false, [0, 1, 'fold', 3]], [6, false, [0, 1, 'fold', 5]],
    [4, true, [0, 1, 2, 3]], [6, true, [0, 1, 2, 3, 4, 5]],
  ])('%i levels, expanded=%s', (count, expanded, slots) => {
    expect(pathSlots(count, expanded)).toEqual(slots);
  });
});
