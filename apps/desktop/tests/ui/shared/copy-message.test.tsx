import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CopyMessage } from '../../../src/ui/detail/CopyMessage';
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

describe('message copy', () => {
  it('copies raw source text and confirms only after the clipboard write finishes', async () => {
    const writing = deferred();
    vi.mocked(copyText).mockReturnValue(writing.promise);
    const raw = '  **bold**\n\n- literal source\n\n```js\nconst emoji = "🧶";\n```\n';
    const { container } = render(<><CopyMessage text={raw} /><Notices /></>);
    const button = screen.getByRole('button', { name: 'Copy message' }), original = button.outerHTML;
    await click(button);
    expect(copyText).toHaveBeenCalledExactlyOnceWith(raw);
    showNotices();
    expect(notices.getSnapshot()).toEqual([]);
    expect(screen.queryByText('Message copied.')).toBeNull();
    await act(async () => { writing.resolve(); });
    act(() => { vi.advanceTimersByTime(299); });
    expect(screen.queryByText('Message copied.')).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByText('Message copied.')).toBeTruthy();
    expect(button.outerHTML).toBe(original);
    expect(container.textContent).not.toContain(raw);
  });

  it('is keyboard reachable and copies on Enter without moving focus', async () => {
    vi.useRealTimers();
    vi.mocked(copyText).mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<><div className="detail-msg"><CopyMessage text="keyboard" /></div><Notices /></>);
    await user.tab();
    const button = screen.getByRole('button', { name: 'Copy message' });
    expect(document.activeElement).toBe(button);
    await user.keyboard('{Enter}');
    expect(copyText).toHaveBeenCalledExactlyOnceWith('keyboard');
    await waitFor(() => { expect(screen.getByText('Message copied.')).toBeTruthy(); });
    expect(document.activeElement).toBe(button);
  });

  it('reports generic failure without claiming success and permits retry', async () => {
    vi.mocked(copyText).mockRejectedValueOnce(new Error('Denied: secret message')).mockResolvedValueOnce(undefined);
    const { container } = render(<><CopyMessage text="private source" /><Notices /></>);
    const button = screen.getByRole('button', { name: 'Copy message' });
    await click(button);
    showNotices();
    expect(screen.getByText('Copy failed. Try again.')).toBeTruthy();
    expect(screen.queryByText('Message copied.')).toBeNull();
    expect(container.textContent).not.toContain('private source');
    expect(container.textContent).not.toContain('secret message');
    expect(screen.getByRole('button', { name: 'Copy message' })).toBe(button);
    await click(button);
    showNotices();
    expect(screen.getByText('Message copied.')).toBeTruthy();
    expect(copyText).toHaveBeenCalledTimes(2);
  });

  it.each(['resolve', 'reject'] as const)('drops a stale %s after a message change or unmount', async settle => {
    const first = deferred(), second = deferred();
    vi.mocked(copyText).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { rerender } = render(<><CopyMessage text="first" /><Notices /></>);
    await click(screen.getByRole('button', { name: 'Copy message' }));
    rerender(<><CopyMessage text="second" /><Notices /></>);
    await act(async () => { first[settle](new Error('Stale')); });
    showNotices();
    expect(notices.getSnapshot()).toEqual([]);
    await click(screen.getByRole('button', { name: 'Copy message' }));
    expect(copyText).toHaveBeenLastCalledWith('second');
    rerender(<Notices />);
    await act(async () => { second[settle](new Error('Stale')); });
    showNotices();
    expect(notices.getSnapshot()).toEqual([]);
    expect(screen.queryByText('Message copied.')).toBeNull();
    expect(screen.queryByText('Copy failed. Try again.')).toBeNull();
  });

  it('ignores an older failure after a newer copy succeeds', async () => {
    const first = deferred();
    vi.mocked(copyText).mockReturnValueOnce(first.promise).mockResolvedValueOnce(undefined);
    render(<><CopyMessage text="again" /><Notices /></>);
    const button = screen.getByRole('button', { name: 'Copy message' });
    await click(button); await click(button);
    await act(async () => { first.reject(new Error('Old failure')); });
    showNotices();
    expect(screen.getByText('Message copied.')).toBeTruthy();
    expect(screen.queryByText('Copy failed. Try again.')).toBeNull();
    expect(notices.getSnapshot()).toHaveLength(1);
  });

  it('reserves the button slot and reveals it through pointer or keyboard focus', () => {
    const css = readFileSync(resolve(__dirname, '../../../src/ui/detail/copy.css'), 'utf8');
    expect(css).toMatch(/\.detail-message-copy\s*\{[^}]*flex:\s*none;[^}]*width:\s*24px;[^}]*opacity:\s*0;/s);
    expect(css).toContain('.detail-msg:hover .detail-message-copy');
    expect(css).toContain('.detail-msg:focus-within .detail-message-copy');
    expect(css).toContain('.detail-message-copy:focus-visible');
    expect(css).not.toMatch(/display:\s*none|visibility:\s*hidden|pointer-events:\s*none/);
  });
});
