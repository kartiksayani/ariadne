import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ActionMenu } from '../../../src/ui/shared/ActionMenu';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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

it('returns focus with Escape after pointer opening, including after a menu item takes focus', async () => {
  const user = userEvent.setup(); render(menu());
  const trigger = screen.getByRole('button', { name: 'Actions' });
  await user.click(trigger); await user.keyboard('{Escape}');
  expect(screen.queryByRole('menu')).toBeNull(); expect(document.activeElement).toBe(trigger);
  await user.click(trigger); await user.click(screen.getByRole('menuitem', { name: 'Last' }));
  await user.keyboard('{Escape}');
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

it('opens outside clipped columns, fits the window edges and keeps pointer actions working after resize and scroll', async () => {
  vi.stubGlobal('innerWidth', 300); vi.stubGlobal('innerHeight', 200);
  let left = 280, top = 170;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return this.getAttribute('role') === 'menu'
      ? { width: 140, height: 90 } as DOMRect
      : { left, right: left + 20, top, bottom: top + 20 } as DOMRect;
  });
  const user = userEvent.setup();
  const { container } = render(<div style={{ overflow: 'hidden' }}>{menu()}</div>);
  const trigger = screen.getByRole('button', { name: 'Actions' });
  await user.click(trigger);
  const panel = screen.getByRole('menu');
  expect(panel.parentElement).toBe(document.body);
  expect(container.contains(panel)).toBe(false);
  expect(trigger.getAttribute('aria-controls')).toBe(panel.id);
  expect(Number.parseFloat(panel.style.left) + 140).toBeLessThanOrEqual(window.innerWidth - 8);
  expect(Number.parseFloat(panel.style.top) + 90).toBeLessThan(top);
  left = 0; top = 0;
  fireEvent.resize(window); fireEvent.scroll(container.firstChild!);
  expect(Number.parseFloat(panel.style.left)).toBeGreaterThanOrEqual(8);
  expect(Number.parseFloat(panel.style.top)).toBeGreaterThanOrEqual(top + 20);
  await user.click(screen.getByRole('menuitem', { name: 'First' }));
  expect(screen.queryByRole('menu')).toBeNull();
});

it('keeps oversized menus scrollable inside small windows and leaves outside clicks free to dismiss them', async () => {
  vi.stubGlobal('innerWidth', 100); vi.stubGlobal('innerHeight', 70);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return this.getAttribute('role') === 'menu'
      ? { width: 84, height: 54 } as DOMRect
      : { left: 0, right: 20, top: 25, bottom: 45 } as DOMRect;
  });
  const user = userEvent.setup(); render(<>{menu()}<button type="button">Outside</button></>);
  await user.click(screen.getByRole('button', { name: 'Actions' }));
  const panel = screen.getByRole('menu');
  expect(panel.style.maxWidth).toBe('84px'); expect(panel.style.maxHeight).toBe('54px');
  expect(panel.style.left).toBe('8px'); expect(panel.style.top).toBe('8px');
  await user.click(screen.getByRole('button', { name: 'Outside' }));
  expect(screen.queryByRole('menu')).toBeNull();
});

it('keeps app accessibility styles while opening outside the scrolling shell', async () => {
  const user = userEvent.setup();
  const { container } = render(<div className="product-app"><div className="shell" style={{ overflow: 'hidden' }}>{menu()}</div></div>);
  await user.click(screen.getByRole('button', { name: 'Actions' }));
  const panel = screen.getByRole('menu');
  expect(panel.parentElement).toBe(container.querySelector('.product-app'));
  expect(container.querySelector('.shell')!.contains(panel)).toBe(false);
});
