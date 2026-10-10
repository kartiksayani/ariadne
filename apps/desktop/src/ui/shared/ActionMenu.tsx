import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import './menu.css';

/** The text-size popover's dismissal and focus pattern, with menu-key navigation. */
export function ActionMenu({ label, title = label, icon, active, disabled, className = '', buttonClassName = 'btn btn-ghost', children }: {
  readonly label: string; readonly title?: string; readonly icon: ReactNode; readonly active?: boolean; readonly disabled?: boolean;
  readonly className?: string; readonly buttonClassName?: string; readonly children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), id = useId();
  const close = () => { setOpen(false); button.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    window.addEventListener('pointerdown', outside);
    return () => window.removeEventListener('pointerdown', outside);
  }, [open]);
  return <div ref={root} className={`action-menu ${className}`} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }} onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Escape' && open) { event.preventDefault(); close(); }
    else if (event.key === 'Tab' && open) close();
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!open) { setOpen(true); return; }
      const options = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      const at = options.findIndex(option => option === document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
        : (at + (event.key === 'ArrowUp' ? -1 : 1) + options.length) % options.length;
      options[next]?.focus();
    }
  }}>
    <button ref={button} type="button" className={buttonClassName} aria-label={label} title={title} disabled={disabled}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} data-active={active || undefined}
      onClick={() => setOpen(value => !value)}>{icon}</button>
    {open && <div ref={menu} id={id} role="menu" aria-label={label} className="action-menu-options">{children(close)}</div>}
  </div>;
}
