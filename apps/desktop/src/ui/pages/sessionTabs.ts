import type { SessionsTab } from './page-types';

/** The tabs of All sessions, in order. */
export const SESSION_TABS: ReadonlyArray<{ readonly id: SessionsTab; readonly label: string }> = [
  { id: 'open', label: 'Open' },
  { id: 'closed', label: 'Closed' },
  { id: 'all', label: 'All' },
];
