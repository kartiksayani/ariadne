import { useRecoveredNotices } from './useRecoveredNotices';
import { useStuckNotices, type StuckNoticesOptions } from './useStuckNotices';

/**
 * Mounts the stuck and recovered-words notices (alpha.21 E17, E18) for the session on screen. It stays mounted for the whole
 * app run, so a notice told once is not told again after a visit to a page.
 */
export function NoticeHooks(options: StuckNoticesOptions) {
  useStuckNotices(options);
  useRecoveredNotices(options);
  return null;
}
