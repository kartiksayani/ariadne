import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { ItemDetail } from '../../../src/ui/detail/ItemDetail';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { AppTransport, route } from '../app/transport';
import { sessionButton } from '../app/open';

// Hold acknowledgments at the component boundary to reproduce an older editor
// reporting completion after a newer ordinary App request has been published.
const editor = vi.hoisted(() => ({ acknowledgments: new Map<number, () => void>() }));
vi.mock('../../../src/ui/detail/ItemDetail', () => ({
  DetailPath: () => null,
  ItemDetail: ({ focusRequest, onFocusRequestConsumed }: ComponentProps<typeof ItemDetail>) => {
    if (focusRequest) editor.acknowledgments.set(focusRequest.token, () => onFocusRequestConsumed?.(focusRequest.token));
    return <p role="status" aria-label="Current owner request">{focusRequest?.token ?? 'consumed'}</p>;
  },
}));
afterEach(() => { cleanup(); editor.acknowledgments.clear(); });
it('an older editor acknowledgment cannot clear the newer owner request', async () => {
  const transport = new AppTransport(); render(<DesktopApp service={createDesktopService(transport)} />);
  fireEvent.click(await sessionButton(route)); await screen.findByRole('tree', { name: 'Session items' });
  await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready');
      expect(screen.getByLabelText('Session').getAttribute('aria-busy')).toBe('false');
    });
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
