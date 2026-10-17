/** "Continue elsewhere" (`c`): the label shows only on a wide band, the icon always (D10). It opens the existing continue picker. */
export function ContinueButton({ disabled, title, onContinue }: {
  readonly disabled: boolean;
  /** Why it is unavailable, when it is. */
  readonly title?: string;
  readonly onContinue: () => void;
}) {
  return <button type="button" className="tree-band-continue" disabled={disabled} aria-label="Continue elsewhere"
    title={disabled && title ? title : 'Continue this topic in another session ( c )'} onClick={onContinue}>
    <i className="ph ph-arrow-bend-down-right" aria-hidden="true" /><span className="tree-band-continue-label">Continue elsewhere</span>
  </button>;
}
