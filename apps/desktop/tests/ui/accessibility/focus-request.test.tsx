import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { OwnerItemDetail } from '../../../src/components/inputs/OwnerItemDetail';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { AppTransport, route } from '../app/transport';

// Hold acknowledgments at the component boundary to reproduce an older editor
// reporting completion after a newer ordinary App request has been published.
const editor = vi.hoisted(() => ({ acknowledgments: new Map<number, () => void>() }));
vi.mock('../../../src/components/inputs/OwnerItemDetail', () => ({
  OwnerItemDetail: ({ focusRequest, onFocusRequestConsumed }: ComponentProps<typeof OwnerItemDetail>) => {
    if (focusRequest) editor.acknowledgments.set(focusRequest.token, () => onFocusRequestConsumed?.(focusRequest.token));
    return <p role="status" aria-label="Current owner request">{focusRequest?.token ?? 'consumed'}</p>;
  },
}));
afterEach(() => { cleanup(); editor.acknowledgments.clear(); });
it('an older editor acknowledgment cannot clear the newer owner request', async () => {
  const transport = new AppTransport(); render(<DesktopApp service={createDesktopService(transport)} />);
  const session = await waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>(`[data-session-id="${route.session_id}"]`)!;
    expect(button).not.toBeNull(); expect(button.disabled).toBe(false); return button;
  });
  fireEvent.click(session); await screen.findByRole('tree', { name: 'Sentences' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Pause dispatch' }).hasAttribute('disabled')).toBe(false));
  const row = document.querySelector<HTMLElement>('[role="treeitem"][data-item-id="4"]')!;
  row.focus(); fireEvent.keyDown(row, { key: 'r' });
  await waitFor(() => expect(editor.acknowledgments.size).toBe(1));
  const old = [...editor.acknowledgments.values()][0];
  row.focus(); fireEvent.keyDown(row, { key: 'd' });
  await waitFor(() => expect(editor.acknowledgments.size).toBe(2));
  const [token, latest] = [...editor.acknowledgments.entries()][1];
  act(() => { old(); }); expect(screen.getByRole('status', { name: 'Current owner request' }).textContent).toBe(String(token));
  act(() => { latest(); }); expect(screen.getByRole('status', { name: 'Current owner request' }).textContent).toBe('consumed');
});
