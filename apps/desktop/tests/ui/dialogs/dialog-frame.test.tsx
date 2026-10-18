// DialogFrame (contract §5.9): the focus kind for the safe default, quoted words with Copy → Copied, the list box, the
// width prop, and a scrim that never cancels unless asked to. The old `Dialog` keeps its scrim behaviour.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DialogButton, DialogFrame, DialogList, DialogListRow, DialogQuote } from '../../../src/ui/dialogs/DialogFrame';
import { Dialog } from '../../../src/ui/dialogs/Dialog';
import { copyText } from '../../../src/ui/shared/clipboard';

vi.mock('../../../src/ui/shared/clipboard', () => ({ copyText: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });

const words = 'Skip the script;\n  keep the budget.';

describe('DialogFrame', () => {
  it('gives the safe default the focus kind and holds focus on it', () => {
    render(<DialogFrame label="Empty the bin" onCancel={() => undefined}>
      <DialogButton kind="focus" autoFocus>Keep them</DialogButton>
      <DialogButton kind="danger">Delete for good</DialogButton>
    </DialogFrame>);
    const keep = screen.getByRole('button', { name: 'Keep them' });
    expect(document.activeElement).toBe(keep);
    expect(keep.className).toContain('dg-btn-focus');
  });

  it('quotes the exact words and says Copied only after the write lands', async () => {
    let land!: () => void;
    vi.mocked(copyText).mockReturnValue(new Promise<void>(resolve => { land = resolve; }));
    render(<DialogFrame label="Remove" onCancel={() => undefined}><DialogQuote label="Your reply, about “x”" text={words} /></DialogFrame>);
    expect(screen.getByTestId('dialog-quote').querySelector('blockquote')?.textContent).toBe(words);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(copyText).toHaveBeenCalledExactlyOnceWith(words);
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
    await act(async () => { land(); await Promise.resolve(); });
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('says it could not copy when the write fails', async () => {
    vi.mocked(copyText).mockRejectedValue(new Error('denied'));
    render(<DialogFrame label="Bin" onCancel={() => undefined}><DialogQuote inList text={words} /></DialogFrame>);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy' })); await Promise.resolve(); });
    expect(screen.getByRole('button', { name: 'Couldn’t copy' })).toBeTruthy();
  });

  it('lists rows in a list box with their action and anything under them', () => {
    render(<DialogFrame label="Bin" width={560} onCancel={() => undefined}>
      <DialogList label="Removed items">
        <DialogListRow name="cache warm-up script" sub="3 items in all" action={<button type="button">Restore</button>}>
          <DialogQuote inList text={words} />
        </DialogListRow>
        <DialogListRow name="fallback logging" dim />
      </DialogList>
    </DialogFrame>);
    const list = screen.getByRole('list', { name: 'Removed items' });
    expect(list.querySelectorAll('li')).toHaveLength(2);
    expect(screen.getByRole('dialog').style.width).toContain('560px');
  });

  it('defaults to 520 wide and ignores a press on the scrim', () => {
    const cancel = vi.fn();
    const { container } = render(<DialogFrame label="Remove" onCancel={cancel}><p>body</p></DialogFrame>);
    expect(screen.getByRole('dialog').style.width).toContain('520px');
    fireEvent.click(container.querySelector('.dg-scrim')!);
    expect(cancel).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('leaves the old Dialog cancelling on a settled scrim press', () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const { container } = render(<Dialog label="Old" width={400} onCancel={cancel}><p>body</p></Dialog>);
    act(() => { vi.advanceTimersByTime(600); });
    fireEvent.click(container.querySelector('.pw-overlay')!, { detail: 1 });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
