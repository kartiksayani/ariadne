import { useEffect, useRef } from 'react';
import { notices } from '../pages/notices';
import { copyText } from './clipboard';

/** Copy the connection reference without showing it in the owner's view. */
export function CopySessionId({ sessionId, className = 'btn btn-ghost', role }: { readonly sessionId: string; readonly className?: string; readonly role?: 'menuitem' }) {
  const attempt = useRef(0);

  useEffect(() => {
    return () => { attempt.current += 1; };
  }, [sessionId]);

  async function copy() {
    const current = ++attempt.current;
    try {
      await copyText(sessionId);
      if (current !== attempt.current) return;
      notices.push({ icon: 'ph ph-check-circle', text: 'Connection reference copied.' });
    } catch {
      if (current === attempt.current) notices.push({ icon: 'ph ph-warning-circle', iconColor: 'var(--a-warn)', tone: 'problem', text: 'Copy failed. Try again.' });
    }
  }

  return <button type="button" className={className} role={role}
    title="Copy this session's ID to connect another Claude conversation" onClick={() => { void copy(); }}>
    <i className="ph ph-copy" aria-hidden="true" /><span>Copy ID</span>
  </button>;
}
