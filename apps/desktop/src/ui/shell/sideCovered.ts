import { createContext } from 'react';

/** The bigger view (the conversation overlay) covers the side column: the shell body tells the column, which goes out of reach. */
export const SideCovered = createContext(false);
