import { useEffect, useState } from 'react';
import { NARROW_BELOW } from './model';

const viewport = () => window.innerWidth;

/** True while the window is narrower than NARROW_BELOW; follows the window as it is resized. */
export function useNarrow(width: () => number = viewport): boolean {
  const [narrow, setNarrow] = useState(() => width() < NARROW_BELOW);
  useEffect(() => {
    const update = () => setNarrow(width() < NARROW_BELOW);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [width]);
  return narrow;
}
