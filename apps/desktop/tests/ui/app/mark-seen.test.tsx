// The change box's "Mark seen" in Details marks the item seen through the app's navigation (alpha.21 E10), before the 1 s dwell would have done it.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import type { ItemChangeRecord } from '../../../src/generated/domain/models';
import { applySeen } from '../../../src/state/preferences/seen';
import { notices } from '../../../src/ui/pages/notices';
import { resetBoxOpen } from '../../../src/ui/changes/boxOpen';
import { AppTransport, route } from './transport';

afterEach(() => { cleanup(); notices.clear(); resetBoxOpen(); });

describe('Mark seen in the app', () => {
  it('turns the unseen change box to seen at once, inside the dwell', async () => {
    const transport = new AppTransport();
    const item = transport.sessions.get(route.session_id)!.items['4']!;
    item.revision = 2; item.created_at = '2026-09-30T00:00:00.000Z';
    const record: ItemChangeRecord = { revision: 2, at: '2026-10-04T09:30:00.000Z', cause_message_id: item.created_message_id, reason: 'The agent narrowed it.', before: { note: 'Earlier note.' } };
    item.changes = [record];
    transport.preferences.global.selected_navigation = { kind: 'session', session: route };
    Object.assign(transport.preferences.sessions[0]!, { tab_open: true, selected_item_id: '4' });
    applySeen(transport.preferences, { kind: 'mark_seen', session: route, at: '2026-10-01T00:00:00.000Z', items: [], topics: [] });
    render(<DesktopApp service={createDesktopService(transport)} />);
    const mark = await screen.findByRole('button', { name: 'Mark seen' });
    // The reading state changes at once (the save is batched for a second): the box turns to "Changed at" and the button goes, well before the 1 s dwell.
    const box = await screen.findByTestId('change-box');
    expect(box.getAttribute('data-state')).toBe('unseen');
    fireEvent.click(mark);
    await waitFor(() => expect(screen.getByTestId('change-box').getAttribute('data-state')).toBe('seen'), { timeout: 700 });
    expect(screen.queryByRole('button', { name: 'Mark seen' })).toBeNull();
  });
});
