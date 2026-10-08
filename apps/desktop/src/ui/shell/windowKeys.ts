// Window-level keyboard routing. The workspace keymap (ui/keys) listens on the
// app root, so a key pressed while nothing inside it has focus (right after
// launch, or after a click on a non-focusable area) lands on <body> and is lost.
// This hook hands such keys to the element that would own them had focus been
// there, and keeps Esc away from macOS (which would otherwise leave full screen).
import { useEffect, useRef, type RefObject } from 'react';
import { workspaceIntent } from '../keys';
import type { ItemHistoryControls } from './itemHistory';
import type { TextSizeIntent } from './textScale';

const editable = 'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]';
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
 * while the field is disabled the characters and Backspaces are held (`hold`) until it is enabled again; in the short
 * window after that (HOLD_MS) the field takes focus back and the key goes into it.
 */
export function routeWindowKey(event: KeyboardEvent, root: HTMLElement, stranded: Stranded | null = null,
  history?: Pick<ItemHistoryControls, 'back' | 'forward'>, changeTextSize?: (intent: TextSizeIntent) => void): void {
  const target = event.target, page = root.ownerDocument;
  const outside = !(target instanceof Node && root.contains(target));
  const field = stranded && stranded.field.isConnected ? stranded.field : null;
  const toBody = outside && !event.defaultPrevented && !within(target, `${editable},${dialogs}`) && !page.querySelector(openDialogs);
  const intent = workspaceIntent(event);
  // These chords always belong to the app, including in fields and dialogs.
  // Consume them even at a size limit or during a save so WebView zoom stays off.
  if (changeTextSize && (intent?.kind === 'text-smaller' || intent?.kind === 'text-larger' || intent?.kind === 'text-default')) {
    if (!event.defaultPrevented && !event.isComposing) {
      event.preventDefault();
      changeTextSize(intent.kind);
    }
    return;
  }
  if (history && (intent?.kind === 'history-back' || intent?.kind === 'history-forward')) {
    if (!event.defaultPrevented && !event.isComposing && !field && !within(target, `${editable},${dialogs}`)
      && !within(page.activeElement, editable) && !page.querySelector(openDialogs)) {
      if ((intent.kind === 'history-back' ? history.back : history.forward)()) event.preventDefault();
    }
    return;
  }
  if (toBody && field) {
    if (field.matches(':disabled')) { if (typed(event) || backspace(event)) stranded!.hold(event.key); }
    else {
      stranded!.resume();
      if ((typed(event) || backspace(event)) && insertText(field, typed(event) ? event.key : '', backspace(event) ? 1 : 0)) event.preventDefault();
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

/**
 * How long after a stranded field is enabled again a key on <body> still counts as the owner typing into it. Later than
 * that, the owner has moved on and the key is a shortcut again.
 */
export const HOLD_MS = 1500;
/** The most text held for a disabled field; further keys are dropped. */
export const HOLD_MAX = 1000;

/** The text field the owner was typing in when it was disabled under their hands, and what to do with keys meanwhile. */
export interface Stranded {
  readonly field: Element;
  /** The field is disabled: keep this character, or this Backspace, for it. Nothing else is ever held. */
  readonly hold: (key: string) => void;
  /** The field is enabled again: focus it and give it the held keys. */
  readonly resume: () => void;
}

/** A key that types a character (not a shortcut chord, not a named key such as Enter or ArrowDown). */
const typed = (event: KeyboardEvent) => event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;
/** A plain Backspace. Enter and chords are never held or replayed, so nothing can be sent twice. */
const backspace = (event: KeyboardEvent) => event.key === 'Backspace' && !event.metaKey && !event.ctrlKey && !event.altKey;

/** Types `text` at the caret of a text field the way the owner would (after `erase` Backspaces), so its change handlers run. False for anything else. */
function insertText(field: Element, text: string, erase = 0): boolean {
  if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) || field.disabled || field.readOnly) return false;
  let start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  // A selection goes with the first Backspace; the rest remove the characters before it.
  start = Math.max(0, start - (start === end ? erase : Math.max(0, erase - 1)));
  const setter = Object.getOwnPropertyDescriptor(field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set;
  if (!setter) return false;
  setter.call(field, field.value.slice(0, start) + text + field.value.slice(end));
  field.setSelectionRange(start + text.length, start + text.length);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

/** Installs `routeWindowKey` on the window for the lifetime of the app root. */
export function useWindowKeys(root: RefObject<HTMLElement | null>, history?: Pick<ItemHistoryControls, 'back' | 'forward'>,
  changeTextSize?: (intent: TextSizeIntent) => void): void {
  const latestHistory = useRef(history);
  latestHistory.current = history;
  const latestTextSize = useRef(changeTextSize);
  latestTextSize.current = changeTextSize;
  useEffect(() => {
    // The last text field focused, forgotten as soon as focus goes elsewhere or the owner clicks away.
    let field: Element | null = null;
    // It is stranded once seen disabled: the browser dropped its focus to <body>, and enabling it again does not bring focus back.
    // `held` and `erase` are the characters and Backspaces typed meanwhile; `enabledAt` is when it was first seen enabled again.
    let stranded = false, held = '', erase = 0, enabledAt: number | null = null;
    const watch = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => settle());
    const reset = () => { held = ''; erase = 0; enabledAt = null; };
    const forget = (next: Element | null) => { field = next; stranded = false; reset(); watch?.disconnect(); if (next) watch?.observe(next, { attributes: true, attributeFilter: ['disabled'] }); };
    const resume = () => {
      const target = field, text = held, back = erase, since = enabledAt ?? Date.now();
      if (!(target instanceof HTMLElement) || !target.isConnected || target.matches(':disabled')) return;
      target.focus({ preventScroll: true });
      if (text || back) insertText(target, text, back);
      // Focusing forgets the field. The key that caused this is still aimed at <body>, so keep redirecting for the window.
      field = target; stranded = true; reset(); enabledAt = since;
    };
    // The field changed state. Disabled: stranded, keys are held. Removed: whatever was held goes with it. Enabled again: hand back
    // what was held (focus and insert); with nothing held, the owner's keys still go to it for HOLD_MS, then they are shortcuts again.
    function settle() {
      if (!field) return;
      if (!field.isConnected) { forget(null); return; }
      if (field.matches(':disabled')) { stranded = true; enabledAt = null; return; }
      if (!stranded) return;
      const now = Date.now();
      enabledAt ??= now;
      const page = field.ownerDocument;
      if (held || erase) { if (page.activeElement === page.body || page.activeElement === field) resume(); }
      else if (now - enabledAt > HOLD_MS) stranded = false;
    }
    const hold = (key: string) => {
      if (key === 'Backspace') { if (held) held = held.slice(0, -1); else erase = Math.min(erase + 1, HOLD_MAX); }
      else if (held.length + key.length <= HOLD_MAX) held += key;
    };
    const focused = (event: FocusEvent) => { forget(event.target instanceof Element && event.target.matches(editable) ? event.target : null); };
    const clicked = () => { forget(null); };
    const listener = (event: KeyboardEvent) => {
      if (!root.current) return;
      settle();
      routeWindowKey(event, root.current, field && stranded ? { field, hold, resume } : null, latestHistory.current, latestTextSize.current);
    };
    // Some editors stop bubbling keys. Reserve the text chords in capture so
    // they still work there, before the browser can apply its own zoom.
    const textListener = (event: KeyboardEvent) => {
      const intent = workspaceIntent(event);
      if (root.current && (intent?.kind === 'text-smaller' || intent?.kind === 'text-larger' || intent?.kind === 'text-default')) {
        routeWindowKey(event, root.current, null, undefined, latestTextSize.current);
      }
    };
    window.addEventListener('focusin', focused);
    window.addEventListener('pointerdown', clicked, true);
    window.addEventListener('mousedown', clicked, true);
    window.addEventListener('keydown', listener);
    window.addEventListener('keydown', textListener, true);
    return () => {
      window.removeEventListener('focusin', focused);
      window.removeEventListener('pointerdown', clicked, true);
      window.removeEventListener('mousedown', clicked, true);
      window.removeEventListener('keydown', listener);
      window.removeEventListener('keydown', textListener, true);
      watch?.disconnect();
      reset();
    };
  }, [root]);
}
