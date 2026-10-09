import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CopyMessage } from '../../../src/ui/detail/CopyMessage';
import { copyText } from '../../../src/ui/shared/clipboard';

vi.mock('../../../src/ui/shared/clipboard', () => ({ copyText: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function click(button: HTMLElement) {
  await act(async () => { fireEvent.click(button); });
}

describe('message copy', () => {
  it('copies raw source text and confirms success only after the write completes for 1.5 seconds', async () => {
    vi.useFakeTimers();
    const writing = deferred();
    vi.mocked(copyText).mockReturnValue(writing.promise);
    const raw = '  **bold**\n\n- literal source\n\n```js\nconst emoji = "🧶";\n```\n';
    render(<CopyMessage text={raw} />);
    const button = screen.getByRole('button', { name: 'Copy message' });
    expect(button.getAttribute('title')).toBe('Copy message');
    expect(button.querySelector('i.ph-copy')).not.toBeNull();
    await click(button);
    expect(copyText).toHaveBeenCalledExactlyOnceWith(raw);
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
    await act(async () => { writing.resolve(); });
    expect(screen.getByRole('button', { name: 'Copied' })).toBe(button);
    expect(button.getAttribute('title')).toBe('Copied');
    expect(button.querySelector('i.ph-check')).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1499); });
    expect(button.getAttribute('aria-label')).toBe('Copied');
    act(() => { vi.advanceTimersByTime(1); });
    expect(button.getAttribute('aria-label')).toBe('Copy message');
    expect(button.querySelector('i.ph-copy')).not.toBeNull();
  });

  it('stays keyboard reachable and copies on Enter', async () => {
    vi.mocked(copyText).mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<div className="detail-msg"><CopyMessage text="keyboard" /></div>);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Copy message' }));
    await user.keyboard('{Enter}');
    expect(copyText).toHaveBeenCalledWith('keyboard');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('reports a failure without claiming success and permits retry', async () => {
    vi.mocked(copyText).mockRejectedValueOnce(new Error('Denied')).mockResolvedValueOnce(undefined);
    render(<CopyMessage text="retry" />);
    await click(screen.getByRole('button', { name: 'Copy message' }));
    const button = screen.getByRole('button', { name: 'Copy failed' });
    expect(button.querySelector('i.ph-check')).toBeNull();
    await click(button);
    expect(screen.getByRole('button', { name: 'Copied' })).toBe(button);
    expect(copyText).toHaveBeenCalledTimes(2);
  });

  it('restarts feedback on another successful copy and clears the timer when unmounted', async () => {
    vi.useFakeTimers();
    vi.mocked(copyText).mockResolvedValue(undefined);
    const { unmount } = render(<CopyMessage text="again" />);
    await click(screen.getByRole('button', { name: 'Copy message' }));
    act(() => { vi.advanceTimersByTime(1000); });
    await click(screen.getByRole('button', { name: 'Copied' }));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops pending feedback from a different message and from an unmounted control', async () => {
    vi.useFakeTimers();
    const first = deferred(); const second = deferred();
    vi.mocked(copyText).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { rerender, unmount } = render(<CopyMessage text="first" />);
    await click(screen.getByRole('button', { name: 'Copy message' }));
    rerender(<CopyMessage text="second" />);
    await act(async () => { first.resolve(); });
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
    await click(screen.getByRole('button', { name: 'Copy message' }));
    unmount();
    await act(async () => { second.resolve(); });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the button slot reserved and reveals it through pointer or keyboard focus', () => {
    const css = readFileSync(resolve(__dirname, '../../../src/ui/detail/copy.css'), 'utf8');
    expect(css).toMatch(/\.detail-message-copy\s*\{[^}]*flex:\s*none;[^}]*width:\s*24px;[^}]*opacity:\s*0;/s);
    expect(css).toContain('.detail-msg:hover .detail-message-copy');
    expect(css).toContain('.detail-msg:focus-within .detail-message-copy');
    expect(css).toContain('.detail-message-copy:focus-visible');
    expect(css).toContain('.detail-message-copy-feedback');
    expect(css).not.toMatch(/display:\s*none|visibility:\s*hidden|pointer-events:\s*none/);
  });
});
