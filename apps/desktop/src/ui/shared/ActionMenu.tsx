import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './menu.css';

/** Pointer clicks stay in place; keyboard opening moves focus into the menu. */
export function ActionMenu({ label, title = label, icon, active, disabled, dismissKey, align = 'end', gap = 4, className = '', buttonClassName = 'btn btn-ghost', panelClassName = '', children }: {
  readonly label: string; readonly title?: string; readonly icon: ReactNode; readonly active?: boolean; readonly disabled?: boolean;
  readonly dismissKey?: string; readonly className?: string; readonly buttonClassName?: string;
  readonly align?: 'start' | 'end';
  /** Pixels between the button and the panel. */
  readonly gap?: number;
  /** Extra class on the panel (portaled out of the host). */
  readonly panelClassName?: string;
  readonly children: (close: (restoreFocus?: boolean) => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), id = useId();
  const keyboard = useRef(false), initialFocus = useRef<'first' | 'last' | null>(null);
  const tabDismiss = useRef<ReturnType<typeof setTimeout> | null>(null);
  const close = (restoreFocus = keyboard.current) => { setOpen(false); if (restoreFocus) button.current?.focus(); };
  useEffect(() => { setOpen(false); }, [dismissKey]);
  // Keep the menu outside scrolling/clipping columns and fit it to the window before painting.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = button.current, panel = menu.current;
      if (!anchor || !panel) return;
      const bounds = anchor.getBoundingClientRect(), edge = 8;
      const width = document.documentElement.clientWidth || window.innerWidth;
      const height = document.documentElement.clientHeight || window.innerHeight;
      panel.style.maxWidth = `${Math.max(0, width - edge * 2)}px`;
      panel.style.maxHeight = `${Math.max(0, height - edge * 2)}px`;
      const size = panel.getBoundingClientRect();
      const left = align === 'start' ? bounds.left : bounds.right - size.width;
      const below = bounds.bottom + gap;
      const top = below + size.height <= height - edge ? below : bounds.top - gap - size.height;
      panel.style.left = `${Math.max(edge, Math.min(left, width - edge - size.width))}px`;
      panel.style.top = `${Math.max(edge, Math.min(top, height - edge - size.height))}px`;
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    if (button.current) observer?.observe(button.current);
    if (root.current?.parentElement) observer?.observe(root.current.parentElement);
    if (menu.current) observer?.observe(menu.current);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); observer?.disconnect(); };
  }, [open, align, gap]);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelectorAll<HTMLButtonElement>('button').forEach(option => { option.tabIndex = -1; });
    const options = menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
    if (initialFocus.current) options?.[initialFocus.current === 'last' ? options.length - 1 : 0]?.focus();
    initialFocus.current = null;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target) && !menu.current?.contains(event.target)) setOpen(false);
    };
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
      // The portal is outside the trigger's tab order. Resume native Tab from the trigger.
      if (event.target instanceof Node && menu.current?.contains(event.target)) {
        button.current?.focus();
        if (event.shiftKey) event.preventDefault();
      }
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
    {open && createPortal(<div ref={menu} id={id} role="menu" aria-label={label} className={`action-menu-options ${panelClassName}`.trim()}>{children(close)}</div>, root.current?.closest('.product-app') ?? document.body)}
  </div>;
}
