// A question with Cancel and one confirming button. The `danger` variant is the
// Remove dialog of Ariadne.dc.html:498-507: a trash icon in --a-danger beside the
// title, a warning line, and an outlined danger button.
import type { ReactNode } from 'react';
import { Dialog } from './Dialog';

export interface ConfirmDialogProps {
  readonly title: string;
  readonly body: ReactNode;
  /** A line in --a-danger, e.g. "2 questions waiting on you go with it." */
  readonly warn?: string;
  readonly confirmLabel: string;
  readonly danger?: boolean;
  /** Disables Confirm, e.g. while the action runs. */
  readonly busy?: boolean;
  /** Shown under the body when the action failed. */
  readonly error?: string | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function ConfirmDialog({ title, body, warn, confirmLabel, danger = false, busy = false, error, onConfirm, onCancel }: ConfirmDialogProps) {
  const confirm = () => { if (!busy) onConfirm(); };
  return <Dialog label={title} width={danger ? 500 : 520} role={danger ? 'alertdialog' : 'dialog'} onCancel={onCancel} onConfirm={confirm}>
    {danger
      ? <div className="dialog-title pw-dialog-danger-title"><i className="ph ph-trash" aria-hidden="true" /><span>{title}</span></div>
      : <div className="dialog-title">{title}</div>}
    <div className="pw-dialog-body">{body}</div>
    {warn && <div className="pw-dialog-warn"><i className="ph-fill ph-question" aria-hidden="true" /><span>{warn}</span></div>}
    {error && <div className="pw-dialog-error" role="alert">{error}</div>}
    <div className="dialog-actions">
      <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      <button type="button" className={`btn btn-primary${danger ? ' pw-danger' : ''}`} disabled={busy} onClick={confirm}>
        {danger && <i className="ph ph-trash" aria-hidden="true" />}{confirmLabel}</button>
    </div>
  </Dialog>;
}
