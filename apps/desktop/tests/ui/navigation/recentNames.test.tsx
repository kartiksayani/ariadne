import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RecentDialog, RecentTrail } from '../../../src/ui/navigation/Recent';
import { peekNames } from '../../../src/ui/peek/names';
import * as short from '../../../src/ui/shared/short';
import { AppTransport, route } from '../app/transport';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('shares one cached name pass across Recent rerenders for a 2000-item session', () => {
  const session = new AppTransport().sessions.get(route.session_id)!;
  for (let index = 20; index < 2020; index++) {
    const id = `large-${index}`;
    session.items[id] = { ...session.items['1']!, id, short: `Name ${index}`, question: `Question ${index}` };
  }
  const labels = vi.spyOn(short, 'itemLabels');
  const entries = [{ item_id: '1', action: 'viewed' as const, visited_at: session.updated_at }];
  const props = { session, entries, onReveal: vi.fn() };
  const view = render(<><RecentTrail {...props} nextWaiting={null} /><RecentDialog {...props} seen={null} onClose={() => {}} /></>);
  const cached = peekNames(session);
  expect(labels).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Changed only' }));
  view.rerender(<><RecentTrail {...props} nextWaiting={session.items['2']!} /><RecentDialog {...props} seen={null} onClose={() => {}} /></>);
  expect(peekNames(session)).toBe(cached);
  expect(labels).toHaveBeenCalledTimes(1);
});
