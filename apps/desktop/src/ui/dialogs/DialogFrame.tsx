// The redesign's dialog card (SPEC 5.14, board dialogs): a scrim over the whole window, a 10px-radius card, buttons at
// the bottom right with their keys. Focus stays inside; Esc cancels; Tab wraps. Pure presentation (contract C8).
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { dialogControls } from '../../components/accessibility/dialog-focus';
import { copyIcon, copyLabel, focusReturnTarget, Keycap, useCopy } from '../parts/parts';
import { copyText } from '../shared/clipboard';
import './dialog-frame.css';

export interface DialogFrameProps {
  /** The dialog's accessible name; the visible title is part of `children`. */
  readonly label: string;
  /** 520 by default; 560 for Continue's summary step and the bin. */
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

/**
 * Button kinds (SPEC 5.10): primary and danger are filled; secondary has an edge ring; ghost has none; focus is the safe
 * default (a secondary that shows the accent ring whenever it holds focus, e.g. "Keep them").
 */
export type DialogButtonKind = 'primary' | 'danger' | 'secondary' | 'focus' | 'ghost';

export function DialogButton({ kind, icon, kbd, children, ...rest }: {
  readonly kind: DialogButtonKind; readonly icon?: string; readonly kbd?: string; readonly children: ReactNode;
  readonly onClick?: () => void; readonly disabled?: boolean; readonly autoFocus?: boolean; readonly type?: 'button' | 'submit';
  readonly title?: string;
}) {
  return <button type="button" {...rest} className={`dg-btn dg-btn-${kind}`}>{icon && <i className={icon} aria-hidden="true" />}{children}{kbd && <Keycap>{kbd}</Keycap>}</button>;
}

/** Copy → Copied (or "Couldn't copy" when the write failed) for one exact text. */
export function DialogCopy({ text, label = 'Copy', name }: { readonly text: string; readonly label?: string; readonly name?: string }) {
  const [state, copy] = useCopy();
  return <button type="button" className="dg-copy" aria-label={name ? `${copyLabel(state, label)} ${name}` : undefined}
    onClick={() => { copy(() => copyText(text).then(() => true)); }}>
    <i className={copyIcon(state)} aria-hidden="true" />{copyLabel(state, label)}</button>;
}

/**
 * Quoted words with Copy (SPEC 10.1, 10.2, 10.11): an optional label ("Your cancelled message, about “x”") and the text
 * exactly as written. `inList` is the card variant that sits under a list-box row.
 */
export function DialogQuote({ label, text, inList = false }: { readonly label?: ReactNode; readonly text: string; readonly inList?: boolean }) {
  return <figure className={inList ? 'dg-quote dg-quote-card' : 'dg-quote'} data-testid="dialog-quote">
    {label !== undefined
      ? <figcaption className="dg-quote-head"><span className="dg-quote-label">{label}</span><DialogCopy text={text} /></figcaption>
      : null}
    <div className="dg-quote-row">
      <blockquote className="dg-quote-text">{text}</blockquote>
      {label === undefined && <DialogCopy text={text} />}
    </div>
  </figure>;
}

/** The list box (SPEC 10.11): rows divided by 1px lines on the window background. */
export function DialogList({ label, children }: { readonly label?: string; readonly children: ReactNode }) {
  return <ul className="dg-list" aria-label={label}>{children}</ul>;
}

/** One list-box row: icon, name, sub, an action at the right, and anything below (e.g. a quote card). */
export function DialogListRow({ icon = 'ph ph-trash', name, sub, action, dim = false, children }: {
  readonly icon?: string; readonly name: ReactNode; readonly sub?: ReactNode; readonly action?: ReactNode; readonly dim?: boolean;
  readonly children?: ReactNode;
}) {
  return <li className={dim ? 'dg-list-row dg-list-row-dim' : 'dg-list-row'}>
    <i className={`${icon} dg-list-icon`} aria-hidden="true" />
    <div className="dg-list-main">
      <div className="dg-list-name">{name}</div>
      {sub !== undefined && <div className="dg-list-sub">{sub}</div>}
      {children}
    </div>
    {action !== undefined && <div className="dg-list-action">{action}</div>}
  </li>;
}
