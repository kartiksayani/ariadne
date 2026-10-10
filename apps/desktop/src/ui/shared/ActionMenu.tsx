import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import './menu.css';

/** Pointer clicks stay in place; keyboard opening moves focus into the menu. */
export function ActionMenu({ label, title = label, icon, active, disabled, dismissKey, className = '', buttonClassName = 'btn btn-ghost', children }: {
  readonly label: string; readonly title?: string; readonly icon: ReactNode; readonly active?: boolean; readonly disabled?: boolean;
  readonly dismissKey?: string; readonly className?: string; readonly buttonClassName?: string;
  readonly children: (close: (restoreFocus?: boolean) => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), id = useId();
  const keyboard = useRef(false), initialFocus = useRef<'first' | 'last' | null>(null);
  const tabDismiss = useRef<ReturnType<typeof setTimeout> | null>(null);
  const close = (restoreFocus = keyboard.current) => { setOpen(false); if (restoreFocus) button.current?.focus(); };
  useEffect(() => { setOpen(false); }, [dismissKey]);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelectorAll<HTMLButtonElement>('button').forEach(option => { option.tabIndex = -1; });
    const options = menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
    if (initialFocus.current) options?.[initialFocus.current === 'last' ? options.length - 1 : 0]?.focus();
    initialFocus.current = null;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    window.addEventListener('pointerdown', outside);
    return () => {
      window.removeEventListener('pointerdown', outside);
      if (tabDismiss.current !== null) clearTimeout(tabDismiss.current);
    };
  }, [open]);
  return <div ref={root} className={`action-menu ${className}`} onPointerDown={() => { keyboard.current = false; }} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.stopPropagation(); event.preventDefault(); close(true); }
    else if (event.key === 'Tab' && open) {
      event.stopPropagation();
      // Keep the focused item until the browser has moved focus past the menu.
      tabDismiss.current = setTimeout(() => { tabDismiss.current = null; close(false); }, 0);
    }
    else if (!event.altKey && !event.ctrlKey && !event.metaKey && (['ArrowDown', 'ArrowUp'].includes(event.key)
      || (open && ['Home', 'End'].includes(event.key)))) {
      event.stopPropagation(); event.preventDefault(); keyboard.current = true;
      if (!open) { initialFocus.current = event.key === 'ArrowUp' ? 'last' : 'first'; setOpen(true); return; }
      const options = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      const at = options.findIndex(option => option === document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
        : at < 0 ? (event.key === 'ArrowUp' ? options.length - 1 : 0)
        : (at + (event.key === 'ArrowUp' ? -1 : 1) + options.length) % options.length;
      options[next]?.focus();
    } else if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof HTMLButtonElement) {
      event.stopPropagation(); keyboard.current = true;
    }
  }}>
    <button ref={button} type="button" className={buttonClassName} aria-label={label} title={title} disabled={disabled}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} data-active={active || undefined}
      onClick={event => {
        keyboard.current = event.detail === 0;
        initialFocus.current = keyboard.current && !open ? 'first' : null;
        setOpen(value => !value);
      }}>{icon}</button>
    {open && <div ref={menu} id={id} role="menu" aria-label={label} className="action-menu-options">{children(close)}</div>}
  </div>;
}
