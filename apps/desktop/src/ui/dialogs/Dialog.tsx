// The Paperwhite dialog of Ariadne.dc.html (lines 485-520): a backdrop of
// neutral-900 at 55% over the whole window and a `.dialog` card. Focus stays
// inside while it is open; Esc cancels and Enter confirms (README, Dialogs).
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { dialogControls } from '../../components/accessibility/dialog-focus';
import { focusReturnTarget } from '../parts/parts';
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
/** How long after opening a backdrop click still counts as part of the opening click (a slow double-click). */
const SETTLE_MS = 500;

export function Dialog({ label, width, role = 'dialog', onCancel, onConfirm, children }: DialogProps) {
  const element = useRef<HTMLDivElement>(null);
  // Capture before the opening action's menu or popover unmounts; its trigger survives the clicked item.
  const [previous] = useState(focusReturnTarget);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  const opened = useRef(Date.now());
  useEffect(() => {
    const dialog = element.current;
    opened.current = Date.now();
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
  }, [previous]);
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel.current(); return; }
    if (event.key === 'Enter' && onConfirm && !(event.target instanceof Element && event.target.closest(interactive))) {
      // A held ↵ that repeats onto the dialog (the key that opened it) confirms nothing: only a fresh press does.
      event.preventDefault(); event.stopPropagation(); if (!event.repeat) onConfirm(); return;
    }
    if (event.key !== 'Tab') return;
    const controls = dialogControls(event.currentTarget), first = controls[0], last = controls.at(-1);
    if (!first || !last) { event.preventDefault(); event.currentTarget.focus(); return; }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  // A press on the backdrop cancels, unless it is the rest of the click that opened the dialog: a double-click's second
  // click (detail 2+), or any click in the first moments after opening, would otherwise close it at once, unseen.
  return <div className="pw-overlay" onClick={event => { if (event.detail < 2 && Date.now() - opened.current >= SETTLE_MS) cancel.current(); }}>
    <div ref={element} className="dialog pw-dialog" role={role} aria-modal="true" aria-label={label} tabIndex={-1}
      style={{ width: `min(${width}px, 100%)` }} onClick={event => event.stopPropagation()} onKeyDown={keys}>{children}</div>
  </div>;
}
