// The one workspace keymap (SPEC §6.1). This module decides which key means what and when a key belongs to
// the workspace rather than a text field or dialog. Keys that act on the whole window or the current view's
// selected item ask for an intent (ui/intents.ts, the `keyIntents` table); the views that own them answer.
// Keys that only make sense where focus is (moving along rows, Enter, Space, digits, Esc, ⌘↵) stay with
// the focused row, editor or dock.
// `a` acknowledges an eligible finding or explanation; `r` opens its reply flow.
import { useCallback, useRef, type KeyboardEvent } from 'react';
import { dispatchIntent, type Intent } from './intents';

export type IntentKind =
  | 'move-down' | 'move-up' | 'first' | 'last' | 'unfold' | 'fold' | 'enter' | 'send'
  | 'answer' | 'choose' | 'bring' | 'respond' | 'drop' | 'later' | 'hide' | 'reopen'
  | 'search' | 'graph' | 'escape' | 'remove' | 'history-back' | 'history-forward'
  | 'text-smaller' | 'text-larger' | 'text-default' | 'peek' | 'recent'
  | 'switcher' | 'help' | 'filter' | 'focus' | 'continue' | 'next-unseen' | 'back-to-selected' | 'dock-prev' | 'dock-next'
  | 'choose-send' | 'details-up' | 'details-down';

export type WorkspaceIntent =
  | { readonly kind: Exclude<IntentKind, 'choose' | 'choose-send'> }
  | { readonly kind: 'choose' | 'choose-send'; readonly index: number };

/** The keys that ask for an intent. A view registers the intent; the key never presses a button. */
export const keyIntents: Readonly<Partial<Record<IntentKind, Intent>>> = {
  switcher: 'switcher.open', help: 'help.toggle', focus: 'focus.toggle', recent: 'recent.open', continue: 'topic.continue',
  answer: 'item.ack', drop: 'item.drop', hide: 'item.hide', remove: 'item.remove',
  bring: 'item.bring', respond: 'item.respond', later: 'item.later', reopen: 'item.reopen',
  graph: 'view.toggleGraph', search: 'search.focus', filter: 'filter.toggle', 'next-unseen': 'map.nextUnseen',
  'back-to-selected': 'map.backToSelected',
  'dock-prev': 'dock.prev', 'dock-next': 'dock.next',
};

/** Workspace handlers that pass every intent key on to `dispatchIntent`. Merge them under scoped handlers. */
export function intentKeyHandlers<T extends Element>(): WorkspaceHandlers<T> {
  return Object.fromEntries(Object.entries(keyIntents).map(([kind, intent]) =>
    [kind, (_intent: WorkspaceIntent, event: KeyboardEvent<T>) => dispatchIntent(intent, { repeat: event.repeat })])) as WorkspaceHandlers<T>;
}

export interface KeyLike {
  readonly key: string;
  readonly code?: string;
  readonly repeat?: boolean;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
}

const plain: Readonly<Record<string, Exclude<IntentKind, 'choose' | 'choose-send'>>> = {
  ArrowDown: 'move-down', j: 'move-down', ArrowUp: 'move-up', k: 'move-up', Home: 'first', End: 'last',
  ArrowRight: 'unfold', ArrowLeft: 'fold', Enter: 'enter',
  a: 'answer', b: 'bring', r: 'respond', d: 'drop', z: 'later', x: 'hide', o: 'reopen',
  '/': 'search', g: 'graph', f: 'filter', c: 'continue', n: 'next-unseen', '?': 'help',
  '[': 'dock-prev', ']': 'dock-next', '.': 'back-to-selected',
  Escape: 'escape', Backspace: 'remove', Delete: 'remove', ' ': 'peek',
};

/** The intent a key press means, or null when it is not a workspace key. */
export function workspaceIntent(event: KeyLike): WorkspaceIntent | null {
  if (event.metaKey && !event.ctrlKey && !event.altKey) {
    if (event.key === '-') return { kind: 'text-smaller' };
    if (event.key === '+' || event.key === '=') return { kind: 'text-larger' };
    if (!event.shiftKey && event.key === '0') return { kind: 'text-default' };
    if (!event.shiftKey && event.key === '[') return { kind: 'history-back' };
    if (!event.shiftKey && event.key === ']') return { kind: 'history-forward' };
    if (event.key.toLowerCase() === 'f') return { kind: 'search' };
    if (!event.shiftKey && event.key.toLowerCase() === 'e') return { kind: 'recent' };
    if (!event.shiftKey && event.key.toLowerCase() === 'o') return { kind: 'switcher' };
    if (event.key === 'Enter') return { kind: 'send' };
    return null;
  }
  if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
    // ⌥1–9 sends option N; macOS types ¡™£ for ⌥digits, so it matches the physical key. A held key sends once.
    if (!event.repeat && /^Digit[1-9]$/.test(event.code ?? '')) return { kind: 'choose-send', index: Number(event.code!.slice(-1)) - 1 };
    // ⌥↑ / ⌥↓ scroll Details. A key-repeat press resolves too, so the handler can swallow it.
    if (event.key === 'ArrowUp') return { kind: 'details-up' };
    if (event.key === 'ArrowDown') return { kind: 'details-down' };
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.shiftKey && event.key.toLowerCase() === 'f') return { kind: 'focus' };
  // As before the redesign: n with caps lock on (or Shift) still outlines the next unseen row.
  if (event.key === 'N') return { kind: 'next-unseen' };
  if (/^[1-9]$/.test(event.key)) return { kind: 'choose', index: Number(event.key) - 1 };
  const kind = plain[event.key];
  return kind ? { kind } : null;
}

/**
 * Where the handlers listen:
 * - `workspace`: the app root. Ignores keys already handled below and keys typed
 *   in text fields or dialogs.
 * - `row`: a focusable row. Only keys pressed on the row itself.
 * - `editor`: an answer box. Escape and ⌘↵ always reach it; other keys are
 *   ignored while a text field inside it has focus.
 */
export type KeyScope = 'workspace' | 'row' | 'editor';

/** Return true when the key was handled; the hook then prevents the default action. */
export type IntentHandler<T extends Element> = (intent: WorkspaceIntent, event: KeyboardEvent<T>) => boolean | void;
export type WorkspaceHandlers<T extends Element = HTMLElement> = Partial<Record<IntentKind, IntentHandler<T>>>;

export const editableSelector = 'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]';
/**
 * Open overlays own their keys even when focus is still on an underlying row. The peek (a hover card, also
 * role="dialog") is not one of them: the Map keeps its keys while a peek is showing (SPEC §6.13).
 */
export const workspaceOverlaySelector = 'dialog[open],[role="dialog"]:not(.item-peek),[role="alertdialog"],[data-workspace-overlay]';
const inside = (target: EventTarget, selector: string) => target instanceof Element && !!target.closest(selector);

export function accepts(scope: KeyScope, event: Pick<KeyboardEvent<Element>, 'target' | 'currentTarget' | 'defaultPrevented'>, intent: WorkspaceIntent): boolean {
  if (event.defaultPrevented) return false;
  if (event.currentTarget.ownerDocument.querySelector(workspaceOverlaySelector)
    && (scope !== 'editor' || !inside(event.target, workspaceOverlaySelector))) return false;
  if (scope === 'workspace') return !inside(event.target, `${editableSelector},dialog,[role="dialog"],[role="alertdialog"]`);
  if (scope === 'row') return event.target === event.currentTarget && !inside(event.target, editableSelector);
  if (intent.kind === 'escape' || intent.kind === 'send') return true;
  return !inside(event.target, editableSelector);
}

/** A keydown handler that dispatches workspace intents to `handlers`. */
export function useWorkspaceKeys<T extends Element = HTMLElement>(handlers: WorkspaceHandlers<T>, options: { readonly scope: KeyScope }): (event: KeyboardEvent<T>) => void {
  const latest = useRef(handlers);
  latest.current = handlers;
  const { scope } = options;
  return useCallback((event: KeyboardEvent<T>) => {
    if (event.nativeEvent.isComposing) return;
    const intent = workspaceIntent(event);
    if (!intent || !accepts(scope, event, intent)) return;
    const handler = latest.current[intent.kind];
    if (handler?.(intent, event) === true) event.preventDefault();
  }, [scope]);
}
