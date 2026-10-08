import { useEffect, useRef, useState } from 'react';
import { copyText } from '../shared/clipboard';
import './copy.css';

/** Place beside the message content; its button always reserves the same space. */
export function CopyMessage({ text }: { text: string }) {
  const [feedback, setFeedback] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempt = useRef(0);

  useEffect(() => {
    setFeedback('idle');
    return () => {
      attempt.current += 1;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [text]);

  async function copy() {
    const current = ++attempt.current;
    if (timer.current !== null) clearTimeout(timer.current);
    setFeedback('idle');
    try {
      await copyText(text);
      if (current !== attempt.current) return;
      setFeedback('copied');
      timer.current = setTimeout(() => setFeedback('idle'), 1500);
    } catch {
      if (current === attempt.current) setFeedback('failed');
    }
  }

  const label = feedback === 'copied' ? 'Copied' : feedback === 'failed' ? 'Copy failed' : 'Copy message';
  return <button type="button" className={`detail-message-copy${feedback === 'idle' ? '' : ' detail-message-copy-feedback'}`}
    title={label} aria-label={label} onClick={() => { void copy(); }}>
    <i className={feedback === 'copied' ? 'ph ph-check' : 'ph ph-copy'} aria-hidden="true" />
  </button>;
}
