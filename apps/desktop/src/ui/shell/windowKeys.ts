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
 *
 * `stranded` is the text field the owner was typing in when it was disabled under their hands (a save started, so the
 * browser dropped focus to <body>), if they have not moved on. Keys on <body> are then their words, never shortcuts:
 * while the field is disabled they are held (`hold`, for a short while only); once it is enabled again the field takes
 * focus back and the key goes into it.
 */
export function routeWindowKey(event: KeyboardEvent, root: HTMLElement, stranded: Stranded | null = null): void {
  const target = event.target, page = root.ownerDocument;
  const outside = !(target instanceof Node && root.contains(target));
  const field = stranded && stranded.field.isConnected ? stranded.field : null;
  const toBody = outside && !event.defaultPrevented && !within(target, `${editable},${dialogs}`) && !page.querySelector(openDialogs);
  if (toBody && field) {
    if (field.matches(':disabled')) { if (typed(event)) stranded!.hold(event.key); }
    else {
      stranded!.resume();
      if (typed(event) && insertText(field, event.key)) event.preventDefault();
    }
  } else if (toBody && workspaceIntent(event)) {
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

/** How long keys typed into a disabled field are held for it. A field disabled for longer (a send that must be reconciled) drops them. */
export const HOLD_MS = 1500;

/** The text field the owner was typing in when it was disabled under their hands, and what to do with keys meanwhile. */
export interface Stranded {
  readonly field: Element;
  /** The field is disabled: keep this key for it. */
  readonly hold: (key: string) => void;
  /** The field is enabled again: focus it and give it the held keys. */
  readonly resume: () => void;
}

/** A key that types a character (not a shortcut chord, not a named key such as Enter or ArrowDown). */
const typed = (event: KeyboardEvent) => event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;

/** Types `text` at the caret of a text field the way the owner would, so its change handlers run. False for anything else. */
function insertText(field: Element, text: string): boolean {
  if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) || field.disabled || field.readOnly) return false;
  const start = field.selectionStart ?? field.value.length, end = field.selectionEnd ?? start;
  const setter = Object.getOwnPropertyDescriptor(field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set;
  if (!setter) return false;
  setter.call(field, field.value.slice(0, start) + text + field.value.slice(end));
  field.setSelectionRange(start + text.length, start + text.length);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

/** Installs `routeWindowKey` on the window for the lifetime of the app root. */
export function useWindowKeys(root: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    // The last text field focused, forgotten as soon as focus goes elsewhere or the owner clicks away.
    let field: Element | null = null;
    // It is stranded once seen disabled: the browser dropped its focus to <body>, and enabling it again does not bring focus back.
    let stranded = false, held = '', closed = false, timer: ReturnType<typeof setTimeout> | undefined;
    const watch = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => settle());
    const reset = () => { clearTimeout(timer); timer = undefined; held = ''; closed = false; };
    const forget = (next: Element | null) => { field = next; stranded = false; reset(); watch?.disconnect(); if (next) watch?.observe(next, { attributes: true, attributeFilter: ['disabled'] }); };
    const resume = () => {
      const text = held;
      reset();
      if (!(field instanceof HTMLElement) || !field.isConnected || field.matches(':disabled')) return;
      field.focus({ preventScroll: true });
      if (text) insertText(field, text);
    };
    // The field changed state: disabled means stranded; enabled hands back what was held for it, if the owner is still on <body>.
    function settle() {
      if (!field) return;
      if (field.matches(':disabled')) { stranded = true; return; }
      closed = false;
      const page = field.ownerDocument;
      if (stranded && held && (page.activeElement === page.body || page.activeElement === field)) resume();
    }
    const hold = (key: string) => {
      if (closed) return;
      held += key;
      // Bounded: a field that stays disabled gives up the keys; they are never replayed as shortcuts.
      timer ??= setTimeout(() => { held = ''; timer = undefined; closed = true; }, HOLD_MS);
    };
    const focused = (event: FocusEvent) => { forget(event.target instanceof Element && event.target.matches(editable) ? event.target : null); };
    const clicked = () => { forget(null); };
    const listener = (event: KeyboardEvent) => {
      if (!root.current) return;
      settle();
      routeWindowKey(event, root.current, field && stranded ? { field, hold, resume } : null);
    };
    window.addEventListener('focusin', focused);
    window.addEventListener('pointerdown', clicked, true);
    window.addEventListener('mousedown', clicked, true);
    window.addEventListener('keydown', listener);
    return () => {
      window.removeEventListener('focusin', focused);
      window.removeEventListener('pointerdown', clicked, true);
      window.removeEventListener('mousedown', clicked, true);
      window.removeEventListener('keydown', listener);
      watch?.disconnect();
      reset();
    };
  }, [root]);
}
