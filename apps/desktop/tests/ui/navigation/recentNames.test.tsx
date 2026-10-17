import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { RecentPopover } from '../../../src/ui/navigation/Recent';
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
  const props = { session, entries, onReveal: vi.fn(), onClose: vi.fn() };
  const view = render(<RecentPopover {...props} />);
  const cached = peekNames(session);
  expect(labels).toHaveBeenCalledTimes(1);
  view.rerender(<RecentPopover {...props} entries={[...entries]} />);
  expect(peekNames(session)).toBe(cached);
  expect(labels).toHaveBeenCalledTimes(1);
});
