import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ActionMenu } from '../../../src/ui/shared/ActionMenu';
import { FilterBar } from '../../../src/ui/tree/FilterBar';

afterEach(cleanup);

function menu() {
  return <ActionMenu label="Actions" icon={<span>More</span>}>
    {close => <><button type="button" role="menuitem" onClick={() => close()}>First</button>
      <button type="button" role="menuitem">Last</button></>}
  </ActionMenu>;
}

it('preserves mouse focus, opens into the menu with keyboard, and supports ArrowUp opening at the end', async () => {
  const user = userEvent.setup(); render(menu());
  const trigger = screen.getByRole('button', { name: 'Actions' });
  await user.click(trigger);
  expect(document.activeElement).toBe(trigger);
  await user.click(trigger); await user.keyboard('{ArrowUp}');
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Last' }));
  await user.keyboard('{Escape}{Enter}');
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'First' }));
  await user.keyboard('{Enter}');
  expect(screen.queryByRole('menu')).toBeNull(); expect(document.activeElement).toBe(trigger);
});

it('lets unhandled app shortcuts propagate from the closed trigger and open menu', () => {
  const shortcut = vi.fn(); render(<div onKeyDown={shortcut}>{menu()}</div>);
  const trigger = screen.getByRole('button', { name: 'Actions' });
  for (const key of ['/', 'g', 'Escape', 'Home', 'End']) fireEvent.keyDown(trigger, { key });
  expect(shortcut.mock.calls.map(([event]) => event.key)).toEqual(['/', 'g', 'Escape', 'Home', 'End']);
  shortcut.mockClear();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const first = screen.getByRole('menuitem', { name: 'First' });
  for (const key of ['/', 'g']) fireEvent.keyDown(first, { key });
  expect(shortcut.mock.calls.map(([event]) => event.key)).toEqual(['/', 'g']);
  shortcut.mockClear();
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Escape']) fireEvent.keyDown(first, { key });
  expect(shortcut).not.toHaveBeenCalled();
});

it.each([false, true])('lets native Tab leave the menu with shift=%s', async shift => {
  const user = userEvent.setup();
  render(<><button type="button">Before</button>{menu()}<button type="button">After</button></>);
  const trigger = screen.getByRole('button', { name: 'Actions' });
  trigger.focus(); await user.keyboard('{ArrowDown}'); await user.tab({ shift });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(shift ? trigger : screen.getByRole('button', { name: 'After' }));
});

it('keeps checkbox focus and menu open across pending status preference renders and WebKit blur', () => {
  const onChip = vi.fn(), counts = { all: 4, waiting: 1, open: 1, progress: 1, closed: 1 };
  const { rerender } = render(<FilterBar chips={new Set(['all'])} counts={counts} disabled={false} dismissKey="first" onChip={onChip} />);
  const trigger = screen.getByRole('button', { name: 'Filter' });
  trigger.focus(); fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const waiting = screen.getByRole<HTMLButtonElement>('menuitemcheckbox', { name: /Waiting on me/ });
  expect(document.activeElement).toBe(waiting);
  fireEvent.mouseDown(waiting); fireEvent.blur(waiting, { relatedTarget: null }); fireEvent.click(waiting, { detail: 1 });
  expect(onChip).toHaveBeenCalledExactlyOnceWith('waiting');
  rerender(<FilterBar chips={new Set(['waiting'])} counts={counts} disabled={false} dismissKey="first" onChip={onChip} />);
  expect(waiting.disabled).toBe(false); expect(waiting.getAttribute('aria-checked')).toBe('true');
  expect(document.activeElement).toBe(waiting); expect(screen.getByRole('menu')).toBeTruthy();
  fireEvent.keyDown(waiting, { key: 'ArrowDown' });
  const open = screen.getByRole('menuitemcheckbox', { name: /Open/ });
  expect(document.activeElement).toBe(open); fireEvent.click(open, { detail: 1 });
  expect(onChip).toHaveBeenLastCalledWith('open');
  rerender(<FilterBar chips={new Set(['open'])} counts={counts} disabled={false} dismissKey="second" onChip={onChip} />);
  expect(screen.queryByRole('menu')).toBeNull();
});
