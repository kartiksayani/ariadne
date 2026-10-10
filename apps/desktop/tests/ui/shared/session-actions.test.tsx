import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionBar } from '../../../src/ui/tree/SessionBar';
import type { SessionBar as Bar } from '../../../src/ui/tree/model';
import { ActionMenu } from '../../../src/ui/shared/ActionMenu';
import { copyText } from '../../../src/ui/shared/clipboard';

vi.mock('../../../src/ui/shared/clipboard', () => ({ copyText: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const bar: Bar = {
  sessionId: '00000000-0000-4000-8000-0000000000ab', title: 'Review the full reply history and follow-up questions',
  secondary: 'demo.local · iTerm window 1', description: 'Keep the next review easy to find', named: true,
  agent: 'codex', where: 'iTerm', meta: '3 topics', running: false, connection: 'not_running', closed: false,
};
const trigger = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Session actions' });
const option = (name: string) => screen.getByRole<HTMLButtonElement>('menuitem', { name });

describe('session actions', () => {
  it('exposes lifecycle busy state and omits unknown topic counts', () => {
    const { container, rerender } = render(<SessionBar bar={{ ...bar, meta: '' }} busy onClose={() => {}} />);
    expect(container.querySelector('.tree-session-bar')?.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelector('.tree-session-meta')).toBeNull();
    rerender(<SessionBar bar={bar} busy={false} onClose={() => {}} />);
    expect(container.querySelector('.tree-session-bar')?.getAttribute('aria-busy')).toBe('false');
    expect(screen.getByTitle('3 topics').textContent).toBe('3 topics');
  });
  it.each(['Copy ID', 'Rename', 'Close session'])('delivers the WebKit blur-before-click sequence to %s', async name => {
    vi.mocked(copyText).mockResolvedValue(undefined);
    const close = vi.fn();
    render(<SessionBar bar={bar} busy={false} onClose={close} onRename={async () => null} />);
    trigger().focus(); fireEvent.click(trigger(), { detail: 1 });
    const target = option(name);
    fireEvent.mouseDown(target);
    fireEvent.blur(trigger(), { relatedTarget: null });
    expect(target.isConnected).toBe(true);
    fireEvent.mouseUp(target);
    await act(async () => { fireEvent.click(target, { detail: 1 }); });
    if (name === 'Copy ID') {
      expect(copyText).toHaveBeenCalledExactlyOnceWith(bar.sessionId);
      expect(screen.getByRole('menuitem', { name: 'Copied' })).toBeTruthy();
    } else if (name === 'Rename') {
      expect(screen.getByRole('textbox', { name: 'Session name' })).toBe(document.activeElement);
      expect(screen.queryByRole('menu')).toBeNull();
    } else {
      expect(close).toHaveBeenCalledOnce();
      expect(screen.queryByRole('menu')).toBeNull();
    }
  });

  it('dismisses session actions when switching to another session', () => {
    const { rerender } = render(<SessionBar bar={bar} busy={false} onClose={() => {}} />);
    fireEvent.click(trigger(), { detail: 1 });
    rerender(<SessionBar bar={{ ...bar, sessionId: 'another-session' }} busy={false} onClose={() => {}} />);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keeps the full session title available and reveals secondary actions only in the menu', () => {
    render(<SessionBar bar={bar} busy={false} onClose={() => {}} onRename={async () => null} />);
    expect(screen.getByText(bar.title).getAttribute('title')).toBe(bar.title);
    expect(screen.getByText(bar.title).parentElement?.getAttribute('title')).toBe(`${bar.title} · ${bar.secondary} · ${bar.description}`);
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menuitem')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close session' })).toBeNull();
    fireEvent.click(trigger(), { detail: 1 });
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('menu').id).toBe(trigger().getAttribute('aria-controls'));
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Copy ID', 'Rename', 'Close session']);
    expect(document.activeElement).not.toBe(option('Copy ID'));
  });

  it('copies without closing the menu so feedback remains available', async () => {
    vi.mocked(copyText).mockResolvedValue(undefined);
    const user = userEvent.setup();
    const { container } = render(<SessionBar bar={bar} busy={false} onClose={() => {}} />);
    await user.click(trigger());
    await user.click(option('Copy ID'));
    expect(copyText).toHaveBeenCalledExactlyOnceWith(bar.sessionId);
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(document.activeElement).toBe(option('Copied'));
    expect(container.innerHTML).not.toContain(bar.sessionId);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('closes the menu for Rename, saves the fields and returns focus to the trigger', async () => {
    const rename = vi.fn(async () => null), close = vi.fn(), user = userEvent.setup();
    render(<SessionBar bar={bar} busy={false} onClose={close} onRename={rename} />);
    await user.click(trigger());
    await user.click(option('Rename'));
    expect(screen.queryByRole('menu')).toBeNull();
    const field = screen.getByRole('textbox', { name: 'Session name' });
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: 'Next review' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    expect(rename).toHaveBeenCalledExactlyOnceWith('Next review', bar.description);
    expect(close).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Session name' })).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it.each(['Escape', 'Cancel', 'Save'])('returns focus after pointer Rename ends with %s without changing the name', async finish => {
    const rename = vi.fn(async () => null), user = userEvent.setup();
    render(<SessionBar bar={bar} busy={false} onClose={() => {}} onRename={rename} />);
    await user.click(trigger());
    await user.click(option('Rename'));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Session name' }));
    if (finish === 'Escape') await user.keyboard('{Escape}');
    else await user.click(screen.getByRole('button', { name: finish }));
    expect(screen.queryByRole('textbox', { name: 'Session name' })).toBeNull();
    expect(rename).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger());
  });

  it('invokes Close once and dismisses its menu with focus on the trigger', async () => {
    const close = vi.fn(), user = userEvent.setup();
    render(<SessionBar bar={bar} busy={false} onClose={close} />);
    await user.click(trigger());
    await user.keyboard('{End} ');
    expect(close).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('focuses the trigger before a pointer Close hands control to the lifecycle review', async () => {
    const close = vi.fn(() => { expect(document.activeElement).toBe(trigger()); }), user = userEvent.setup();
    render(<SessionBar bar={bar} busy={false} onClose={close} />);
    await user.click(trigger());
    await user.click(option('Close session'));
    expect(close).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('keeps Copy available while busy and skips disabled Rename and Close during navigation', async () => {
    vi.mocked(copyText).mockResolvedValue(undefined);
    const close = vi.fn(), rename = vi.fn(async () => null), user = userEvent.setup();
    render(<SessionBar bar={bar} busy onClose={close} onRename={rename} />);
    expect(trigger().disabled).toBe(false);
    await user.click(trigger());
    expect(option('Rename').disabled).toBe(true);
    expect(option('Close session').disabled).toBe(true);
    await user.keyboard('{ArrowDown}{ArrowUp}{End}{Home}');
    expect(document.activeElement).toBe(option('Copy ID'));
    fireEvent.click(option('Rename')); fireEvent.click(option('Close session'));
    expect(rename).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    await user.click(option('Copy ID'));
    expect(copyText).toHaveBeenCalledExactlyOnceWith(bar.sessionId);
  });

  it.each([
    { label: 'Reopen session', state: { closed: true } },
    { label: 'Restore session', state: { closed: true, archived: true } },
  ])('keeps $label as a visible primary action', ({ label, state }) => {
    const close = vi.fn();
    const { rerender } = render(<SessionBar bar={{ ...bar, ...state }} busy={false} onClose={close} />);
    fireEvent.click(screen.getByRole('button', { name: label })); expect(close).toHaveBeenCalledOnce();
    fireEvent.click(trigger());
    expect(screen.queryByRole('menuitem', { name: 'Close session' })).toBeNull();
    rerender(<SessionBar bar={{ ...bar, ...state }} busy onClose={close} />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: label }).disabled).toBe(true);
  });
});

describe('action menu keyboard and dismissal', () => {
  function setup() {
    render(<><ActionMenu label="Session actions" icon={<span>More</span>}>
      {() => <><button type="button" role="menuitem">First</button><button type="button" role="menuitem" disabled>Unavailable</button>
        <button type="button" role="menuitem">Last</button></>}
    </ActionMenu><button type="button">Outside</button></>);
    return userEvent.setup();
  }
  it.each(['{Enter}', ' '])('opens from the trigger using %s', async key => {
    const user = setup(); await user.tab(); await user.keyboard(key);
    expect(document.activeElement).toBe(option('First'));
  });
  it('cycles enabled items with arrows, Home and End and returns focus with Escape', async () => {
    const user = setup(); await user.click(trigger());
    await user.keyboard('{ArrowDown}'); expect(document.activeElement).toBe(option('First'));
    await user.keyboard('{ArrowDown}'); expect(document.activeElement).toBe(option('Last'));
    await user.keyboard('{ArrowUp}'); expect(document.activeElement).toBe(option('First'));
    await user.keyboard('{ArrowUp}'); expect(document.activeElement).toBe(option('Last'));
    await user.keyboard('{Home}'); expect(document.activeElement).toBe(option('First'));
    await user.keyboard('{End}'); expect(document.activeElement).toBe(option('Last'));
    await user.keyboard('{Escape}'); expect(screen.queryByRole('menu')).toBeNull(); expect(document.activeElement).toBe(trigger());
    await user.keyboard('{ArrowDown}'); expect(document.activeElement).toBe(option('First'));
  });
  it('dismisses on outside pointer and Tab while preserving focus during blur', async () => {
    const user = setup(), outside = screen.getByRole('button', { name: 'Outside' });
    await user.click(trigger()); await user.click(outside);
    expect(screen.queryByRole('menu')).toBeNull(); expect(document.activeElement).toBe(outside);
    await user.click(trigger()); act(() => { outside.focus(); });
    expect(screen.getByRole('menu')).toBeTruthy(); expect(document.activeElement).toBe(outside);
    await user.click(trigger()); await user.click(trigger()); await user.keyboard('{End}'); await user.tab();
    expect(screen.queryByRole('menu')).toBeNull(); expect(document.activeElement).toBe(outside);
  });
});
