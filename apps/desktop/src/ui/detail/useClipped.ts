import { useLayoutEffect, useState } from 'react';

/**
 * Whether a line-clamped element hides part of its text. It is measured, so a short text shows no expand control, and it
 * follows the element's width (window resizes) and its text (edits by the agent).
 */
export function useClipped(node: HTMLElement | null, text: string): boolean {
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    if (!node) { setClipped(false); return undefined; }
    const measure = () => setClipped(node.scrollHeight > node.clientHeight + 1);
    measure();
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => { window.removeEventListener('resize', measure); observer?.disconnect(); };
  }, [node, text]);
  return clipped;
}
