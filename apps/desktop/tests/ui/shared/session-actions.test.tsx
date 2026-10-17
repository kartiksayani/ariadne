import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ActionMenu } from '../../../src/ui/shared/ActionMenu';

afterEach(() => { cleanup(); });

const trigger = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Session actions' });
const option = (name: string) => screen.getByRole<HTMLButtonElement>('menuitem', { name });

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
