import { createContext, useEffect, useState } from 'react';

/** One subscription per Map; every measured preview follows the same font epoch. */
export const TreeFonts = createContext(0);

export function useTreeFonts(): number {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const fonts = document.fonts;
    let live = true;
    const changed = () => { if (live) setEpoch(value => value + 1); };
    void fonts?.ready.then(changed);
    fonts?.addEventListener('loadingdone', changed);
    return () => { live = false; fonts?.removeEventListener('loadingdone', changed); };
  }, []);
  return epoch;
}
