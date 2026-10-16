// The redesign's dialog card (SPEC 5.14, board dialogs): a scrim over the whole window, a 10px-radius card, buttons at
// the bottom right with their keys. Focus stays inside; Esc cancels; Tab wraps. Pure presentation (contract C8).
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { dialogControls } from '../../components/accessibility/dialog-focus';
import { focusReturnTarget, Keycap } from '../parts/parts';
import './dialog-frame.css';

export interface DialogFrameProps {
  /** The dialog's accessible name; the visible title is part of `children`. */
  readonly label: string;
  readonly width?: number;
  readonly onCancel: () => void;
  /** A press on the scrim cancels too. Leave it off when the dialog holds words that must not be lost by a stray click. */
  readonly cancelOnScrim?: boolean;
  readonly children: ReactNode;
}

export function DialogFrame({ label, width = 520, onCancel, cancelOnScrim = false, children }: DialogFrameProps) {
  const card = useRef<HTMLDivElement>(null);
  // The control that had focus before the dialog opened gets it back; if the opener unmounted its menu or popover,
  // the button that opened that menu or popover does.
  const [previous] = useState(focusReturnTarget);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    const node = card.current;
    if (!node) return undefined;
    // A field or button that took focus on mount (autoFocus) keeps it; otherwise the card holds it.
    if (!node.contains(document.activeElement)) node.focus();
    const contain = (event: FocusEvent) => { if (event.target instanceof Node && !node.contains(event.target)) node.focus(); };
    document.addEventListener('focusin', contain);
    return () => {
      document.removeEventListener('focusin', contain);
      if (previous?.isConnected) previous.focus();
    };
  }, [previous]);
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel.current(); return; }
    if (event.key !== 'Tab') return;
    const controls = dialogControls(event.currentTarget), first = controls[0], last = controls.at(-1);
    if (!first || !last) { event.preventDefault(); event.currentTarget.focus(); return; }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return <div className="dg-scrim" onClick={() => { if (cancelOnScrim) cancel.current(); }}>
    <div ref={card} className="dg" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} style={{ width: `min(${width}px, calc(100vw - 48px))` }}
      onClick={event => event.stopPropagation()} onKeyDown={keys}>{children}</div>
  </div>;
}

export function DialogTitle({ children }: { readonly children: ReactNode }) {
  return <h2 className="dg-title">{children}</h2>;
}

export function DialogText({ children }: { readonly children: ReactNode }) {
  return <p className="dg-text">{children}</p>;
}

/** An amber note: what else goes with the choice. */
export function DialogWarn({ children }: { readonly children: ReactNode }) {
  return <div className="dg-warn"><i className="ph ph-warning-circle" aria-hidden="true" /><span>{children}</span></div>;
}

export function DialogError({ children }: { readonly children: ReactNode }) {
  return <div className="dg-error" role="alert"><i className="ph ph-warning-circle" aria-hidden="true" /><span>{children}</span></div>;
}

export function DialogActions({ children }: { readonly children: ReactNode }) {
  return <div className="dg-actions">{children}</div>;
}

export function DialogButton({ kind, icon, kbd, children, ...rest }: {
  readonly kind: 'primary' | 'danger' | 'ghost'; readonly icon?: string; readonly kbd?: string; readonly children: ReactNode;
  readonly onClick?: () => void; readonly disabled?: boolean; readonly autoFocus?: boolean; readonly type?: 'button' | 'submit';
}) {
  return <button type="button" {...rest} className={`dg-btn dg-btn-${kind}`}>{icon && <i className={icon} aria-hidden="true" />}{children}{kbd && <Keycap>{kbd}</Keycap>}</button>;
}
