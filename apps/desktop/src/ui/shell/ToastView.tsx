import { useEffect, useSyncExternalStore } from 'react';
import { toasts } from './toast';
import './toast.css';

/** The one toast, at the Map's lower left above the dock (SPEC 6.15). × closes it and never undoes. */
export function Toast() {
  const toast = useSyncExternalStore(toasts.subscribe, toasts.current, toasts.current);
  const id = toast?.id;
  // A toast that unmounts with the shell must not leave a timer behind.
  useEffect(() => () => { if (id) toasts.resume(id); }, [id]);
  if (!toast) return null;
  return <div className="toast" role="status" aria-live="polite" data-testid="toast" data-toast-id={toast.id}
    onMouseEnter={() => toasts.pause(toast.id)} onMouseLeave={() => toasts.resume(toast.id)}
    onFocusCapture={() => toasts.pause(toast.id)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) toasts.resume(toast.id); }}>
    <span className="toast-text">{toast.text}</span>
    {toast.undo && !toast.expired && <button type="button" className="btn btn-ghost toast-undo" onClick={() => toasts.runUndo(toast.id)}>
      <i className="ph ph-arrow-u-up-left" aria-hidden="true" />Undo</button>}
    <button type="button" className="btn btn-ghost btn-icon toast-dismiss" title="Dismiss" aria-label="Dismiss" onClick={() => toasts.dismiss(toast.id)}>
      <i className="ph ph-x" aria-hidden="true" /></button>
  </div>;
}
