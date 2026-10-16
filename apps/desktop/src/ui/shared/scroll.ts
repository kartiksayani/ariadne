import { nearestDelta } from '../tree/scroll';

export interface ScrollRoom {
  /** The floating dock's height over the bottom of the scroller (`useDockInset`); a row under it counts as hidden. */
  readonly bottomInset?: number;
  /** Room kept clear at the top, such as a sticky header. */
  readonly top?: number;
  /** Room kept above the visible bottom edge. */
  readonly bottom?: number;
}

/** Whether all of `element` shows in the scroller, clear of the top room and of the dock. */
export function isVisibleInScroller(scroller: Element, element: Element, room: ScrollRoom = {}): boolean {
  const a = scroller.getBoundingClientRect(), b = element.getBoundingClientRect();
  return b.top >= a.top + (room.top ?? 0) && b.bottom <= a.bottom - (room.bottomInset ?? 0) - (room.bottom ?? 0);
}

/**
 * Scrolls the least distance that shows `element` (`block: 'nearest'`), above the dock; nothing moves when it shows
 * already. An element taller than the visible area lines up its top instead.
 */
export function scrollIntoViewIfHidden(scroller: HTMLElement, element: Element, room: ScrollRoom = {}): void {
  const a = scroller.getBoundingClientRect(), b = element.getBoundingClientRect();
  const delta = nearestDelta(a.height - (room.bottom ?? 0), b.top - a.top, b.height, room.top ?? 0, 0, room.bottomInset ?? 0);
  if (delta) scroller.scrollTop += delta;
}
