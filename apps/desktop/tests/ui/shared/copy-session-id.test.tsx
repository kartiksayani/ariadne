import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CopySessionId } from '../../../src/ui/shared/CopySessionId';
import { copyText } from '../../../src/ui/shared/clipboard';

vi.mock('../../../src/ui/shared/clipboard', () => ({ copyText: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });

const sessionId = '00000000-0000-4000-8000-0000000000ab';
const purpose = "Copy this session's ID to connect another Claude conversation";
async function click(button: HTMLElement) {
  await act(async () => { fireEvent.click(button); });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('copy a session ID', () => {
  it('copies the exact ID without rendering it and shows the same temporary check feedback as message copy', async () => {
    vi.useFakeTimers();
    const writing = deferred();
    vi.mocked(copyText).mockReturnValue(writing.promise);
    const { container } = render(<CopySessionId sessionId={sessionId} />);
    const button = screen.getByRole('button', { name: 'Copy ID' });
    expect(button.title).toBe(purpose);
    expect(container.innerHTML).not.toContain(sessionId);
    await click(button);
    expect(copyText).toHaveBeenCalledExactlyOnceWith(sessionId);
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
    await act(async () => { writing.resolve(); });
    expect(screen.getByRole('button', { name: 'Copied' })).toBe(button);
    expect(button.querySelector('.ph-check')).not.toBeNull();
    expect(button.title).toBe(purpose);
    expect(container.innerHTML).not.toContain(sessionId);
    act(() => { vi.advanceTimersByTime(1499); });
    expect(screen.getByRole('button', { name: 'Copied' })).toBe(button);
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByRole('button', { name: 'Copy ID' })).toBe(button);
    expect(button.querySelector('.ph-copy')).not.toBeNull();
  });

  it('is keyboard reachable and copies on Enter', async () => {
    vi.mocked(copyText).mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<CopySessionId sessionId={sessionId} />);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Copy ID' }));
    await user.keyboard('{Enter}');
    expect(copyText).toHaveBeenCalledExactlyOnceWith(sessionId);
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('reports a failed write and allows another attempt', async () => {
    vi.mocked(copyText).mockRejectedValueOnce(new Error('Denied')).mockResolvedValueOnce(undefined);
    render(<CopySessionId sessionId={sessionId} />);
    await click(screen.getByRole('button', { name: 'Copy ID' }));
    const failed = screen.getByRole('button', { name: 'Copy failed' });
    expect(failed.querySelector('.ph-check')).toBeNull();
    await click(failed);
    expect(screen.getByRole('button', { name: 'Copied' })).toBe(failed);
    expect(copyText).toHaveBeenCalledTimes(2);
  });

  it('resets feedback on a new copy and clears its timer on unmount', async () => {
    vi.useFakeTimers();
    vi.mocked(copyText).mockResolvedValue(undefined);
    const { unmount } = render(<CopySessionId sessionId={sessionId} />);
    await click(screen.getByRole('button', { name: 'Copy ID' }));
    act(() => { vi.advanceTimersByTime(1000); });
    await click(screen.getByRole('button', { name: 'Copied' }));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops pending feedback when the session changes or the control unmounts', async () => {
    vi.useFakeTimers();
    const first = deferred(), second = deferred();
    vi.mocked(copyText).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { rerender, unmount } = render(<CopySessionId sessionId={sessionId} />);
    await click(screen.getByRole('button', { name: 'Copy ID' }));
    const otherId = '00000000-0000-4000-8000-0000000000ac';
    rerender(<CopySessionId sessionId={otherId} />);
    await act(async () => { first.resolve(); });
    expect(screen.getByRole('button', { name: 'Copy ID' })).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
    await click(screen.getByRole('button', { name: 'Copy ID' }));
    expect(copyText).toHaveBeenLastCalledWith(otherId);
    unmount();
    await act(async () => { second.resolve(); });
    expect(vi.getTimerCount()).toBe(0);
  });
});
