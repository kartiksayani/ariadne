import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CopySessionId } from '../../../src/ui/shared/CopySessionId';
import { Notices, notices } from '../../../src/ui/pages/notices';
import { copyText } from '../../../src/ui/shared/clipboard';

vi.mock('../../../src/ui/shared/clipboard', () => ({ copyText: vi.fn() }));
beforeEach(() => { vi.useFakeTimers(); notices.clear(); });
afterEach(() => { cleanup(); notices.clear(); vi.resetAllMocks(); vi.useRealTimers(); });

function deferred() {
  let resolve!: (value?: Error) => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = () => yes(); reject = no; });
  return { promise, resolve, reject };
}
async function click(button: HTMLElement) { await act(async () => { fireEvent.click(button); }); }
function showNotices() { act(() => { vi.advanceTimersByTime(300); }); }

const sessionId = '00000000-0000-4000-8000-0000000000ab';
const purpose = "Copy this session's ID to connect another Claude conversation";

describe('connection reference copy', () => {
  it('copies the exact reference without exposing it and confirms only after the clipboard write finishes', async () => {
    const writing = deferred();
    vi.mocked(copyText).mockReturnValue(writing.promise);
    const raw = sessionId;
    const { container } = render(<><CopySessionId sessionId={raw} /><Notices /></>);
    const button = screen.getByRole('button', { name: 'Copy ID' }), original = button.outerHTML;
    expect(button.title).toBe(purpose);
    expect(container.innerHTML).not.toContain(sessionId);
    await click(button);
    expect(copyText).toHaveBeenCalledExactlyOnceWith(raw);
    showNotices();
    expect(notices.getSnapshot()).toEqual([]);
    expect(screen.queryByText('Connection reference copied.')).toBeNull();
    await act(async () => { writing.resolve(); });
    act(() => { vi.advanceTimersByTime(299); });
    expect(screen.queryByText('Connection reference copied.')).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByText('Connection reference copied.')).toBeTruthy();
    expect(button.outerHTML).toBe(original);
    expect(container.textContent).not.toContain(raw);
  });

  it('is keyboard reachable and copies on Enter without moving focus', async () => {
    vi.useRealTimers();
    vi.mocked(copyText).mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<><CopySessionId sessionId={sessionId} /><Notices /></>);
    await user.tab();
    const button = screen.getByRole('button', { name: 'Copy ID' });
    expect(document.activeElement).toBe(button);
    await user.keyboard('{Enter}');
    expect(copyText).toHaveBeenCalledExactlyOnceWith(sessionId);
    await waitFor(() => { expect(screen.getByText('Connection reference copied.')).toBeTruthy(); });
    expect(document.activeElement).toBe(button);
  });

  it('reports generic failure without claiming success and permits retry', async () => {
    vi.mocked(copyText).mockRejectedValueOnce(new Error('Denied: secret reference')).mockResolvedValueOnce(undefined);
    const { container } = render(<><CopySessionId sessionId="private reference" /><Notices /></>);
    const button = screen.getByRole('button', { name: 'Copy ID' });
    await click(button);
    showNotices();
    expect(screen.getByText('Copy failed. Try again.')).toBeTruthy();
    expect(screen.queryByText('Connection reference copied.')).toBeNull();
    expect(container.textContent).not.toContain('private reference');
    expect(container.textContent).not.toContain('secret reference');
    expect(screen.getByRole('button', { name: 'Copy ID' })).toBe(button);
    await click(button);
    showNotices();
    expect(screen.getByText('Connection reference copied.')).toBeTruthy();
    expect(copyText).toHaveBeenCalledTimes(2);
  });

  it.each(['resolve', 'reject'] as const)('drops a stale %s after a session change or unmount', async settle => {
    const first = deferred(), second = deferred();
    vi.mocked(copyText).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { rerender } = render(<><CopySessionId sessionId="first" /><Notices /></>);
    await click(screen.getByRole('button', { name: 'Copy ID' }));
    rerender(<><CopySessionId sessionId="second" /><Notices /></>);
    await act(async () => { first[settle](new Error('Stale')); });
    showNotices();
    expect(notices.getSnapshot()).toEqual([]);
    await click(screen.getByRole('button', { name: 'Copy ID' }));
    expect(copyText).toHaveBeenLastCalledWith('second');
    rerender(<Notices />);
    await act(async () => { second[settle](new Error('Stale')); });
    showNotices();
    expect(notices.getSnapshot()).toEqual([]);
    expect(screen.queryByText('Connection reference copied.')).toBeNull();
    expect(screen.queryByText('Copy failed. Try again.')).toBeNull();
  });

  it('ignores an older failure after a newer copy succeeds', async () => {
    const first = deferred();
    vi.mocked(copyText).mockReturnValueOnce(first.promise).mockResolvedValueOnce(undefined);
    render(<><CopySessionId sessionId="again" /><Notices /></>);
    const button = screen.getByRole('button', { name: 'Copy ID' });
    await click(button); await click(button);
    await act(async () => { first.reject(new Error('Old failure')); });
    showNotices();
    expect(screen.getByText('Connection reference copied.')).toBeTruthy();
    expect(screen.queryByText('Copy failed. Try again.')).toBeNull();
    expect(notices.getSnapshot()).toHaveLength(1);
  });

});
