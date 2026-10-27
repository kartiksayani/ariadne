import { createContext, useContext, type KeyboardEvent, type MouseEvent } from 'react';
import type { ItemRoute, SessionRef } from '../../generated/core';
import type { DisplayStatus } from '../../selectors/waiting/replied';

/** A name under a resting pointer opens its card after this long. */
export const PEEK_OPEN_MS = 1000;
/** A card the pointer left closes after this long, unless the pointer reaches the card first. */
export const PEEK_CLOSE_MS = 260;

/**
 * The one peek card. Rows, Graph nodes and name chips call only these.
 * - Explicit opens (`open`, `toggle`, a chip's click or key) focus the card and count as a Recent visit.
 * - Hover opens (`hoverStart`) do neither.
 * - Nothing here marks an item seen or moves the Map.
 */
export interface PeekNavigation {
  /** Opens the card for an item, on the owner's click or key. */
  open(route: ItemRoute, anchor: HTMLElement): void;
  /** Space: closes the card when it shows this item, else opens it as `open` does. */
  toggle(route: ItemRoute, anchor: HTMLElement): void;
  /** Closes the card, returning focus to where it came from. */
  close(): void;
  /**
   * The Map moved under the card: a scroll, a search step, a new selection.
   * Closes the card unless a send is in flight or the owner is typing in it.
   */
  closeAll(): void;
  /**
   * The pointer rests on a name: opens its card after PEEK_OPEN_MS.
   * Safe to call on every pointer move; only a new route or anchor restarts the wait.
   * `suppressed` (the Map's and the Graph's selected item) is asked now and again when the wait ends: no card opens while it holds.
   */
  hoverStart(route: ItemRoute, anchor: HTMLElement, suppressed?: () => boolean): void;
  /**
   * The selection landed on this item: a hover card waiting for it does not open, and a hover card open on it closes.
   * A card the owner opened (Space, a click) stays.
   */
  dropHover(route: ItemRoute): void;
  /**
   * The pointer left the name: closes a hover card after PEEK_CLOSE_MS.
   * The card stays if the pointer reaches it, or if it has focus, a pick, a send in flight or an explicit open.
   */
  hoverEnd(): void;
  reference(route: ItemRoute): { readonly name: string; readonly question: string; readonly status: DisplayStatus } | null;
  /** Name chips: click or Space/Enter open, hover peeks. */
  chipProps(route: ItemRoute): {
    onClick(event: MouseEvent<HTMLElement>): void;
    onKeyDown(event: KeyboardEvent<HTMLElement>): void;
    onMouseEnter(event: MouseEvent<HTMLElement>): void;
    onMouseMove(event: MouseEvent<HTMLElement>): void;
    onMouseLeave(): void;
  };
  /** Rows and nodes whose click does something else (select): hover only. */
  hoverProps(route: ItemRoute): {
    onMouseEnter(event: MouseEvent<HTMLElement>): void;
    onMouseLeave(): void;
  };
}

export const PeekContext = createContext<PeekNavigation | null>(null);
/** The session of references in this surface, independent of its local item-link provider. */
export const ItemRefSession = createContext<SessionRef | null>(null);
export const usePeek = () => useContext(PeekContext);
