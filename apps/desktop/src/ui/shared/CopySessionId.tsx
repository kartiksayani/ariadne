import { notices } from '../pages/notices';
import { copyText } from './clipboard';

/**
 * Copies a session's connection reference and says so in a notice. `current` reports whether the owner still
 * waits for this copy; a superseded copy reports nothing. Resolves to whether the copy landed.
 */
export async function copySessionReference(sessionId: string, current: () => boolean = () => true): Promise<boolean> {
  try {
    await copyText(sessionId);
    if (current()) notices.push({ icon: 'ph ph-check-circle', text: 'Connection reference copied.' });
    return true;
  } catch {
    if (current()) notices.push({ icon: 'ph ph-warning-circle', iconColor: 'var(--a-warn)', tone: 'problem', text: 'Copy failed. Try again.' });
    return false;
  }
}
