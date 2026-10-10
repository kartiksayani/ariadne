import { useEffect, useRef, useState } from 'react';
import { copyText } from './clipboard';

/** Copy the connection reference without showing it in the owner's view. */
export function CopySessionId({ sessionId, className = 'btn btn-ghost', role }: { readonly sessionId: string; readonly className?: string; readonly role?: 'menuitem' }) {
  const [feedback, setFeedback] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempt = useRef(0);

  useEffect(() => {
    setFeedback('idle');
    return () => {
      attempt.current += 1;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [sessionId]);

  async function copy() {
    const current = ++attempt.current;
    if (timer.current !== null) clearTimeout(timer.current);
    setFeedback('idle');
    try {
      await copyText(sessionId);
      if (current !== attempt.current) return;
      setFeedback('copied');
      timer.current = setTimeout(() => setFeedback('idle'), 1500);
    } catch {
      if (current === attempt.current) setFeedback('failed');
    }
  }

  const label = feedback === 'copied' ? 'Copied' : feedback === 'failed' ? 'Copy failed' : 'Copy ID';
  return <button type="button" className={className} role={role}
    title="Copy this session's ID to connect another Claude conversation" onClick={() => { void copy(); }}>
    <i className={feedback === 'copied' ? 'ph ph-check' : 'ph ph-copy'} aria-hidden="true" /><span aria-live="polite">{label}</span>
  </button>;
}
