import { useEffect, useRef } from 'react';
import { notices } from '../pages/notices';
import { copyText } from '../shared/clipboard';
import './copy.css';

/** Place beside the message content; its button always reserves the same space. */
export function CopyMessage({ text }: { text: string }) {
  const attempt = useRef(0);

  useEffect(() => {
    return () => { attempt.current += 1; };
  }, [text]);

  async function copy() {
    const current = ++attempt.current;
    try {
      await copyText(text);
      if (current !== attempt.current) return;
      notices.push({ icon: 'ph ph-check-circle', text: 'Message copied.' });
    } catch {
      if (current === attempt.current) notices.push({ icon: 'ph ph-warning-circle', iconColor: 'var(--a-warn)', tone: 'problem', text: 'Copy failed. Try again.' });
    }
  }

  return <button type="button" className="detail-message-copy"
    title="Copy message" aria-label="Copy message" onClick={() => { void copy(); }}>
    <i className="ph ph-copy" aria-hidden="true" />
  </button>;
}
