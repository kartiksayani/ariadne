import { useEffect, useRef, useState } from 'react';
import type { Viewport } from '../layout/viewport';

// Accumulate every input against the latest requested transform, but commit the
// transform and its culling query together at most once per animation frame.
export function useViewport(initial: Viewport) {
  const [viewport, commit] = useState(initial);
  const current = useRef(initial), frame = useRef<number | null>(null), pending = useRef(false);
  const schedule = () => {
    if (frame.current !== null) return;
    if (typeof window.requestAnimationFrame !== 'function') { pending.current = false; commit(current.current); return; }
    frame.current = window.requestAnimationFrame(() => { frame.current = null; pending.current = false; commit(current.current); });
  };
  const setViewport = (update: Viewport | ((previous: Viewport) => Viewport)) => {
    current.current = typeof update === 'function' ? update(current.current) : update;
    pending.current = true; schedule();
  };
  useEffect(() => {
    // Effect replay cancels the old frame, but preserves its requested transform.
    // Resume it even when the consumer's initial-Fit effect has already run.
    if (pending.current) schedule();
    return () => {
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, []);
  return { viewport, current, setViewport };
}
