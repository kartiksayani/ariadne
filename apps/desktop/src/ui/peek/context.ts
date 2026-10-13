import { createContext, useContext, type KeyboardEvent, type MouseEvent } from 'react';
import type { ItemRoute, SessionRef } from '../../generated/core';
import type { DisplayStatus } from '../../selectors/waiting/replied';

export interface PeekNavigation {
  open(route: ItemRoute, anchor: HTMLElement): void;
  close(): void;
  reference(route: ItemRoute): { readonly name: string; readonly question: string; readonly status: DisplayStatus } | null;
  chipProps(route: ItemRoute): {
    onClick(event: MouseEvent<HTMLElement>): void;
    onKeyDown(event: KeyboardEvent<HTMLElement>): void;
    onMouseEnter(event: MouseEvent<HTMLElement>): void;
    onMouseMove(event: MouseEvent<HTMLElement>): void;
    onMouseLeave(): void;
  };
}

export const PeekContext = createContext<PeekNavigation | null>(null);
/** The session of references in this surface, independent of its local item-link provider. */
export const ItemRefSession = createContext<SessionRef | null>(null);
export const usePeek = () => useContext(PeekContext);
