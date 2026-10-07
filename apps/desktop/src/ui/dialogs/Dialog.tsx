// The Paperwhite dialog of Ariadne.dc.html (lines 485-520): a backdrop of
// neutral-900 at 55% over the whole window and a `.dialog` card. Focus stays
// inside while it is open; Esc cancels and Enter confirms (README, Dialogs).
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { dialogControls } from '../../components/accessibility/dialog-focus';
import './dialogs.css';

export interface DialogProps {
  /** Accessible name; the visible title is part of `children`. */
  readonly label: string;
  readonly width: number;
  readonly role?: 'dialog' | 'alertdialog';
  readonly onCancel: () => void;
  /** Enter on the dialog itself (not on a control) runs this. */
  readonly onConfirm?: () => void;
  readonly children: ReactNode;
}

const interactive = 'button,a[href],input,select,textarea,[contenteditable="true"]';

export function Dialog({ label, width, role = 'dialog', onCancel, onConfirm, children }: DialogProps) {
  const element = useRef<HTMLDivElement>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = element.current;
    if (!dialog) return undefined;
    dialog.focus();
    const contain = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) dialog.focus();
    };
    document.addEventListener('focusin', contain);
    return () => {
      document.removeEventListener('focusin', contain);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel.current(); return; }
    if (event.key === 'Enter' && onConfirm && !(event.target instanceof Element && event.target.closest(interactive))) {
      event.preventDefault(); event.stopPropagation(); onConfirm(); return;
    }
    if (event.key !== 'Tab') return;
    const controls = dialogControls(event.currentTarget), first = controls[0], last = controls.at(-1);
    if (!first || !last) { event.preventDefault(); event.currentTarget.focus(); return; }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return <div className="pw-overlay" onClick={() => cancel.current()}>
    <div ref={element} className="dialog pw-dialog" role={role} aria-modal="true" aria-label={label} tabIndex={-1}
      style={{ width: `min(${width}px, 100%)` }} onClick={event => event.stopPropagation()} onKeyDown={keys}>{children}</div>
  </div>;
}
