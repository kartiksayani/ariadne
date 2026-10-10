import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService, type HintPayloads, type Unsubscribe } from '../../../src/data/service';
import { notices } from '../../../src/ui/pages/notices';
import { LINK_NOT_OPENED } from '../../../src/ui/shared/openers';
import { AppTransport } from './transport';

const event = 'ariadne://open_link_failed';
afterEach(() => { cleanup(); notices.clear(); });

describe('native link failure notice', () => {
  it('shows the existing dismissible note and removes its listener on unmount', async () => {
    const transport = new AppTransport();
    const { unmount } = render(<DesktopApp service={createDesktopService(transport)} />);
    await screen.findByRole('button', { name: 'Text size' });
    await waitFor(() => expect(transport.listeners.get(event)?.size).toBe(1));
    act(() => { transport.emit(event, null); });
    expect(await screen.findByText(LINK_NOT_OPENED)).toBeTruthy();
    act(() => { transport.emit(event, null); });
    expect(screen.getAllByText(LINK_NOT_OPENED)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(LINK_NOT_OPENED)).toBeNull();
    const staleReceive = [...transport.listeners.get(event)!][0]!;
    unmount();
    expect(transport.listeners.get(event)?.size).toBe(0);
    staleReceive(null as never);
    expect(notices.getSnapshot()).toHaveLength(0);
  });

  it('keeps one active listener through StrictMode effect replay', async () => {
    const transport = new AppTransport();
    const { unmount } = render(<StrictMode><DesktopApp service={createDesktopService(transport)} /></StrictMode>);
    await screen.findByRole('button', { name: 'Text size' });
    await waitFor(() => expect(transport.listeners.get(event)?.size).toBe(1));
    const push = vi.spyOn(notices, 'push');
    act(() => { transport.emit(event, null); });
    expect(push).toHaveBeenCalledTimes(1);
    push.mockRestore();
    unmount();
    expect(transport.listeners.get(event)?.size).toBe(0);
  });

  it('detaches a listener whose subscription completes after unmount', async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    class DelayedTransport extends AppTransport {
      override async listen<E extends keyof HintPayloads>(name: E, receive: (hint: HintPayloads[E]) => void): Promise<Unsubscribe> {
        const unsubscribe = await super.listen(name, receive);
        if (name === event) await pending;
        return unsubscribe;
      }
    }
    const transport = new DelayedTransport();
    const { unmount } = render(<DesktopApp service={createDesktopService(transport)} />);
    await screen.findByRole('button', { name: 'Text size' });
    await waitFor(() => expect(transport.listeners.get(event)?.size).toBe(1));
    unmount();
    transport.emit(event, null);
    expect(notices.getSnapshot()).toHaveLength(0);
    await act(async () => { finish(); });
    expect(transport.listeners.get(event)?.size).toBe(0);
  });

  it('stays quiet when registering the failure listener fails', async () => {
    class UnavailableTransport extends AppTransport {
      override async listen<E extends keyof HintPayloads>(name: E, receive: (hint: HintPayloads[E]) => void): Promise<Unsubscribe> {
        if (name === event) throw new Error('listener unavailable');
        return super.listen(name, receive);
      }
    }
    render(<DesktopApp service={createDesktopService(new UnavailableTransport())} />);
    await screen.findByRole('button', { name: 'Text size' });
    expect(screen.queryByText(LINK_NOT_OPENED)).toBeNull();
    expect(notices.getSnapshot()).toHaveLength(0);
  });
});
