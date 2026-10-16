import { createContext, useContext, type ReactNode } from 'react';

/** The height in CSS pixels the floating dock covers at the bottom of the body; 0 while no dock is open. */
const DockInset = createContext(0);

/**
 * Publishes the dock's height to the body. The shell body sets `--dock-inset: <height>px` from it, so the Map's
 * scrollers keep room under the dock, and the scroll helpers count a row under the dock as hidden.
 */
export function DockInsetProvider({ height, children }: { readonly height: number; readonly children?: ReactNode }) {
  return <DockInset.Provider value={Math.max(0, height)}>{children}</DockInset.Provider>;
}

/** The dock's height over the bottom of the body; 0 outside a provider. */
export function useDockInset(): number {
  return useContext(DockInset);
}
