import { createContext } from 'react';

/** The side column's place in the body, provided by the shell body to the column it lays out (`DetailsColumn`). */
export interface SideLayout {
  /** The width the column shows at now, in CSS pixels. */
  readonly width: number;
  /** The widest the column can be without the body scrolling sideways. */
  readonly max: number;
  /** The width being dragged or stepped, until it is saved. */
  readonly drag: number | null;
  /** Shows `width` while the owner drags; null drops the preview. */
  readonly preview: (width: number | null) => void;
  /** Shows `width` and passes it to `save` once the owner stops stepping, even if the column has closed by then. */
  readonly step: (width: number, save: (width: number) => void) => void;
  /** Drops the preview and passes `width` to `save` now. */
  readonly commit: (width: number, save: (width: number) => void) => void;
  /** Saves a stepped width now instead of after the pause; nothing while no step waits. */
  readonly flush: (save: (width: number) => void) => void;
  /** The conversation view covers the column. */
  readonly covered: boolean;
}

export const SideLayoutContext = createContext<SideLayout | null>(null);
