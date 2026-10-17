// First run in the composed app: a Copy button says Copied only when the clipboard write landed, and the Codex step
// without a setup receipt is labelled for what it does (it opens Register), never "Copy instruction" / "Copied".
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService, type DesktopTransport } from '../../../src/data/service';
import { copyText } from '../../../src/ui/shared/clipboard';
import { notices } from '../../../src/ui/pages/notices';
import { AppTransport } from './transport';

vi.mock('../../../src/ui/shared/clipboard', () => ({ copyText: vi.fn() }));
afterEach(() => { cleanup(); notices.clear(); vi.resetAllMocks(); });

class EmptyTransport extends AppTransport {
  override async invoke<T>(name: string, args: Parameters<DesktopTransport['invoke']>[1]): Promise<T> {
    const result = await super.invoke<{ data: { data: { projects?: { items: unknown[] }; sessions?: { items: unknown[] } } } }>(name, args);
    const data = result.data.data;
    if (data.projects) data.projects.items = [];
    if (data.sessions) data.sessions.items = [];
    return result as T;
  }
}
async function firstRun() {
  render(<DesktopApp service={createDesktopService(new EmptyTransport())} />);
  return screen.findByRole('region', { name: 'No projects yet' });
}

describe('first run copy buttons', { timeout: 15_000 }, () => {
  it('says Copied after a write that landed, and "Couldn’t copy" after one that failed', async () => {
    const page = await firstRun();
    vi.mocked(copyText).mockRejectedValueOnce(new Error('no clipboard')).mockResolvedValueOnce(undefined);
    const copy = page.querySelector<HTMLButtonElement>('.fr-line .p-btn-copy')!;
    await act(async () => { fireEvent.click(copy); });
    expect(copy.textContent).toBe('Couldn’t copy');
    await act(async () => { fireEvent.click(copy); });
    expect(copy.textContent).toBe('Copied');
    expect(copyText).toHaveBeenCalledWith('/ariadne-connect');
  });

  it('without a setup receipt the Codex step opens Register and never claims a copy', async () => {
    const page = await firstRun();
    expect(page.textContent).not.toContain('Copy instruction');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Register a project' })); });
    await screen.findByRole('dialog', { name: 'Register a project' });
    await waitFor(() => expect(copyText).not.toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
  });
});
