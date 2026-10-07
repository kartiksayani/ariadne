// The one workspace keymap (handoff README, "Keyboard"). Components register
// handlers for the intents they own; this module decides which key means what
// and when a key belongs to the workspace rather than a text field or dialog.
import { useCallback, useRef, type KeyboardEvent } from 'react';

export type IntentKind =
  | 'move-down' | 'move-up' | 'first' | 'last' | 'unfold' | 'fold' | 'enter' | 'send'
  | 'answer' | 'choose' | 'bring' | 'respond' | 'drop' | 'later' | 'reopen' | 'archive'
  | 'search' | 'graph' | 'messages' | 'escape' | 'remove';

export type WorkspaceIntent =
  | { readonly kind: Exclude<IntentKind, 'choose'> }
  | { readonly kind: 'choose'; readonly index: number };

export interface KeyLike {
  readonly key: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
}

const plain: Readonly<Record<string, Exclude<IntentKind, 'choose'>>> = {
  ArrowDown: 'move-down', j: 'move-down', ArrowUp: 'move-up', k: 'move-up', Home: 'first', End: 'last',
  ArrowRight: 'unfold', l: 'unfold', ArrowLeft: 'fold', h: 'fold', Enter: 'enter',
  a: 'answer', b: 'bring', r: 'respond', d: 'drop', z: 'later', o: 'reopen', e: 'archive',
  '/': 'search', g: 'graph', m: 'messages', Escape: 'escape', Backspace: 'remove', Delete: 'remove',
};

/** The intent a key press means, or null when it is not a workspace key. */
export function workspaceIntent(event: KeyLike): WorkspaceIntent | null {
  if (event.metaKey && !event.ctrlKey && !event.altKey) {
    if (event.key.toLowerCase() === 'f') return { kind: 'search' };
    if (event.key === 'Enter') return { kind: 'send' };
    return null;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
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

const editableSelector = 'input,textarea,select,[contenteditable="true"],[role="textbox"]';
const inside = (target: EventTarget, selector: string) => target instanceof Element && !!target.closest(selector);

export function accepts(scope: KeyScope, event: Pick<KeyboardEvent<Element>, 'target' | 'currentTarget' | 'defaultPrevented'>, intent: WorkspaceIntent): boolean {
  if (scope === 'workspace') return !event.defaultPrevented && !inside(event.target, `${editableSelector},[role="dialog"]`);
  if (scope === 'row') return event.target === event.currentTarget && !inside(event.target, editableSelector);
  if (intent.kind === 'escape' || intent.kind === 'send') return true;
  return !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement);
}

/** A keydown handler that dispatches workspace intents to `handlers`. */
export function useWorkspaceKeys<T extends Element = HTMLElement>(handlers: WorkspaceHandlers<T>, options: { readonly scope: KeyScope }): (event: KeyboardEvent<T>) => void {
  const latest = useRef(handlers);
  latest.current = handlers;
  const { scope } = options;
  return useCallback((event: KeyboardEvent<T>) => {
    const intent = workspaceIntent(event);
    if (!intent || !accepts(scope, event, intent)) return;
    const handler = latest.current[intent.kind];
    if (handler?.(intent, event) === true) event.preventDefault();
  }, [scope]);
}
