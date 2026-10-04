import { useEffect, useRef, useState } from 'react';
import type { Viewport } from '../layout/viewport';

// Accumulate every input against the latest requested transform, but commit the
// transform and its culling query together at most once per animation frame.
export function useViewport(initial: Viewport) {
  const [viewport, commit] = useState(initial);
  const current = useRef(initial), frame = useRef<number | null>(null);
  const setViewport = (update: Viewport | ((previous: Viewport) => Viewport)) => {
    current.current = typeof update === 'function' ? update(current.current) : update;
    if (frame.current !== null) return;
    if (typeof window.requestAnimationFrame !== 'function') { commit(current.current); return; }
    frame.current = window.requestAnimationFrame(() => { frame.current = null; commit(current.current); });
  };
  useEffect(() => () => {
    if (frame.current !== null) window.cancelAnimationFrame(frame.current);
  }, []);
  return { viewport, current, setViewport };
}
