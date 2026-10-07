import { useEffect, useRef, type ReactNode } from 'react';
import { dialogControls } from '../accessibility/dialog-focus';
import '../../styles/reference.css';

type DialogProps = { title: string; children: ReactNode; actions: ReactNode; onCancel: () => void; width?: number };
export function ReferenceDialog({ title, children, actions, onCancel, width = 580 }: DialogProps) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = element.current;
    if (!dialog) return;
    const focusInside = () => { (dialogControls(dialog)[0] ?? dialog).focus(); };
    focusInside();
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) focusInside();
    };
    document.addEventListener('focusin', containFocus);
    return () => {
      document.removeEventListener('focusin', containFocus);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return <div className="ariadne-reference ref-overlay" onClick={onCancel}><div ref={element} className="ref-dialog" role="dialog" tabIndex={-1} aria-modal="true" aria-label={title} style={{ width: `min(${width}px, 100%)` }} onClick={event => event.stopPropagation()} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); }
    if (event.key === 'Tab') {
      const controls = dialogControls(event.currentTarget);
      const first = controls[0], last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); event.currentTarget.focus(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}><div className="ref-dialog-title">{title}</div>{children}<div className="ref-dialog-actions">{actions}</div></div></div>;
}
