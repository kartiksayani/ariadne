import { createContext } from 'react';

/** The Waiting column's fold, provided by the shell body to the column's frame. */
export interface WaitingFoldState {
  readonly folded: boolean;
  /** Absent where the column cannot fold (previews, tests). */
  readonly toggle?: () => void;
}

export const WaitingFold = createContext<WaitingFoldState>({ folded: false });
