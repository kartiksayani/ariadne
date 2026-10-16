import { useEffect, useRef } from 'react';
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

/** Copy the connection reference without showing it in the owner's view. */
export function CopySessionId({ sessionId, className = 'btn btn-ghost', role }: { readonly sessionId: string; readonly className?: string; readonly role?: 'menuitem' }) {
  const attempt = useRef(0);

  useEffect(() => {
    return () => { attempt.current += 1; };
  }, [sessionId]);

  function copy() {
    const current = ++attempt.current;
    return copySessionReference(sessionId, () => current === attempt.current);
  }

  return <button type="button" className={className} role={role}
    title="Copy this session's ID to connect another Claude conversation" onClick={() => { void copy(); }}>
    <i className="ph ph-copy" aria-hidden="true" /><span>Copy ID</span>
  </button>;
}
