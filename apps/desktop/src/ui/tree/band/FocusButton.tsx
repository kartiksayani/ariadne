import { useLayoutEffect, useRef } from 'react';

/**
 * The band's Focus / Unfocus button (D9): one fixed 92px slot, so the word changing never moves its neighbours.
 * It acts on the selected item's root, like ⇧F. It is not drawn while nothing is focused and nothing is selected (SPEC 4.3: the board
 * draws no Focus then), but its 92px slot stays as a hidden placeholder, so Ack all, Continue and "…" never slide into its place.
 * Pressing Unfocus with nothing selected hides the button under the owner's keyboard focus: focus moves to the selected row, else to
 * the band, rather than dropping to the page.
 */
export function FocusButton({ focusedName, canFocus, busy, onToggle }: {
  /** The focused item's name while Focus is on, else null. */
  readonly focusedName: string | null;
  /** An item is selected (or being acted on), so Focus has something to act on. */
  readonly canFocus: boolean;
  /** A view change is being saved. */
  readonly busy: boolean;
  readonly onToggle: () => void;
}) {
  const on = focusedName !== null;
  const hidden = !on && !canFocus;
  const button = useRef<HTMLButtonElement>(null);
  // Read before the commit: a browser may blur a button the moment it is disabled, and focus must be handed on from where it was.
  const wasFocused = typeof document !== 'undefined' && !!button.current && document.activeElement === button.current;
  useLayoutEffect(() => {
    const element = button.current;
    if (!hidden || !element || !wasFocused) return;
    const tree = element.closest('[role="tree"]');
    const target = tree?.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]') ?? element.closest<HTMLElement>('[role="treeitem"]');
    target?.focus({ preventScroll: true });
  }, [hidden]); // `wasFocused` is the reading taken in the render that hid the button.
  return <button ref={button} type="button" className="tree-band-focus" data-testid="band-focus" data-on={on || undefined} data-hidden={hidden || undefined}
    disabled={busy || hidden} tabIndex={hidden ? -1 : undefined} aria-hidden={hidden || undefined}
    aria-label={on ? `Unfocus “${focusedName}”` : 'Focus'} aria-pressed={on}
    title={on ? 'Show the whole Map again ( ⇧F )' : 'Focus on the selected item and its branch ( ⇧F )'}
    onClick={onToggle}><i className="ph ph-crosshair-simple" aria-hidden="true" />{on ? 'Unfocus' : 'Focus'}</button>;
}
