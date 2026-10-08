// Window-level keyboard routing. The workspace keymap (ui/keys) listens on the
// app root, so a key pressed while nothing inside it has focus (right after
// launch, or after a click on a non-focusable area) lands on <body> and is lost.
// This hook hands such keys to the element that would own them had focus been
// there, and keeps Esc away from macOS (which would otherwise leave full screen).
import { useEffect, type RefObject } from 'react';
import { workspaceIntent } from '../keys';

const editable = 'input,textarea,select,[contenteditable="true"],[role="textbox"]';
const dialogs = 'dialog,[role="dialog"],[role="alertdialog"]';
const openDialogs = 'dialog[open],[role="dialog"],[role="alertdialog"]';
// The tree's roving row, then the graph's roving node, then the graph scroller.
const anchors = ['.tree-column [data-row][tabindex="0"]', '.graph-scroll [tabindex="0"]', '.graph-scroll'];

const within = (target: EventTarget | null, selector: string) => target instanceof Element && !!target.closest(selector);

/** The element a body-targeted key goes to: the tree/graph focus anchor, else the app root. */
export function keyAnchor(root: HTMLElement): HTMLElement {
  for (const selector of anchors) {
    const found = root.querySelector<HTMLElement>(selector);
    if (found) return found;
  }
  return root;
}

/**
 * Routes one window keydown. Keys typed inside the app root already reach its
 * own handlers; a workspace key aimed at <body> (or anything else outside the
 * root, other than a field) is replayed on the focus anchor while no dialog is
 * open. Plain Esc is always consumed unless it belongs to a dialog, so macOS
 * never takes it as "leave full screen".
 */
export function routeWindowKey(event: KeyboardEvent, root: HTMLElement): void {
  const target = event.target, page = root.ownerDocument;
  const outside = !(target instanceof Node && root.contains(target));
  if (outside && !event.defaultPrevented && workspaceIntent(event) && !within(target, `${editable},${dialogs}`)
    && !page.querySelector(openDialogs)) {
    const anchor = keyAnchor(root);
    if (anchor !== root) anchor.focus({ preventScroll: true });
    const replay = new KeyboardEvent('keydown', {
      key: event.key, code: event.code, repeat: event.repeat, bubbles: true, cancelable: true,
      metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey,
    });
    if (!anchor.dispatchEvent(replay)) event.preventDefault();
  }
  // An input method uses Esc to cancel its composition; leave that to it.
  if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.isComposing
    && !within(target, dialogs) && !page.querySelector('dialog[open]')) event.preventDefault();
}

/** Installs `routeWindowKey` on the window for the lifetime of the app root. */
export function useWindowKeys(root: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (root.current) routeWindowKey(event, root.current); };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [root]);
}
