/**
 * The band's Focus / Unfocus button (D9): one fixed 92px slot, so the word changing never moves its neighbours.
 * It acts on the selected item's root, like ⇧F. It is disabled only when nothing is focused and nothing is selected.
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
  const on = focusedName !== null, disabled = busy || (!on && !canFocus);
  return <button type="button" className="tree-band-focus" data-on={on || undefined} disabled={disabled}
    aria-label={on ? `Unfocus “${focusedName}”` : 'Focus'} aria-pressed={on}
    title={on ? 'Show the whole Map again ( ⇧F )' : canFocus ? 'Focus on the selected item and its branch ( ⇧F )' : 'Select an item to focus'}
    onClick={onToggle}><i className="ph ph-crosshair" aria-hidden="true" />{on ? 'Unfocus' : 'Focus'}</button>;
}
