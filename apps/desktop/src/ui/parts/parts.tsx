// Small presentational parts shared by the redesign's top bar, pages and dialogs (contract C8). No stores.
import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import type { RunState } from '../topbar/model';
import './parts.css';

/** A key as a cap: "/", "⌘O", "esc". */
export function Keycap({ children, size = 'sm' }: { readonly children: ReactNode; readonly size?: 'sm' | 'md' }) {
  return <span className={size === 'md' ? 'p-key p-key-md' : 'p-key'}>{children}</span>;
}

/** The "? 3" pill: questions waiting on me. The words travel in `title` and the accessible name. */
export function WaitPill({ count, label, title }: { readonly count: number; readonly label: string; readonly title?: string }) {
  return <span className="p-wait" title={title ?? label} role="img" aria-label={label}><i className="ph-fill ph-question" aria-hidden="true" />{count}</span>;
}

/** Green dot = running, hollow ring = not running, lock = closed. Decorative: the row's words carry the state. */
export function RunDot({ run }: { readonly run: RunState }) {
  if (run === 'closed') return <i className="ph ph-lock-simple p-lock" aria-hidden="true" />;
  return <span className={run === 'live' ? 'p-dot p-dot-live' : 'p-dot p-dot-off'} aria-hidden="true" />;
}

export function OutlineButton({ icon, children, className = '', ...rest }: { readonly icon?: string; readonly children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...rest} className={`p-btn ${className}`.trim()}>{icon && <i className={icon} aria-hidden="true" />}{children}</button>;
}

/** The label flips to the copied word for a moment after a copy. */
export function useCopied(ms = 2000): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  const mark = useCallback(() => {
    setCopied(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; setCopied(false); }, ms);
  }, [ms]);
  return [copied, mark];
}

/**
 * Closes a popover on Esc (anywhere, in the capture phase so a window key never also fires) and on a press outside it.
 * `onClose(true)` asks the owner of the trigger to give focus back to it.
 */
export function usePopover(open: boolean, onClose: (restoreFocus: boolean) => void, panel: RefObject<HTMLElement | null>, trigger?: RefObject<HTMLElement | null> | string): void {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return undefined;
    const node = panel.current;
    if (node && trigger) openers.set(node, trigger);
    // A press on the trigger is the trigger's own toggle: closing here too would reopen the popover.
    const onTrigger = (target: Node) => typeof trigger === 'string' ? target instanceof Element && !!target.closest(trigger) : !!trigger?.current?.contains(target);
    const press = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || panel.current?.contains(target) || onTrigger(target)) return;
      close.current(false);
    };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      close.current(true);
    };
    window.addEventListener('pointerdown', press);
    document.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', press); document.removeEventListener('keydown', key, true);
      if (node) openers.delete(node);
    };
  }, [open, panel, trigger]);
}

/** Each open popover panel and the button that opened it (usePopover's `trigger`). */
const openers = new WeakMap<Element, RefObject<HTMLElement | null> | string>();
const openerOf = (panel: Element): HTMLElement | null => {
  const trigger = openers.get(panel);
  return typeof trigger === 'string' ? document.querySelector<HTMLElement>(trigger) : trigger?.current ?? null;
};

/**
 * Where a dialog gives focus back when it closes: the control focused as it opened, unless that control sits in a
 * menu or popover the opening action unmounts (a card's "Close session", a menu's "Remove project…"); then the
 * button that opened that menu or popover, which outlives it.
 */
export function focusReturnTarget(): HTMLElement | null {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const menu = focused?.closest('[role="menu"]');
  const menuTrigger = menu?.id ? [...document.querySelectorAll<HTMLElement>('[aria-haspopup="menu"][aria-controls]')]
    .find(control => control.getAttribute('aria-controls') === menu.id) : null;
  if (menuTrigger) return menuTrigger;
  for (let node: Element | null = focused; node; node = node.parentElement) {
    const opener = openers.has(node) ? openerOf(node) : null;
    if (opener) return opener;
  }
  return focused;
}

/** A popover that took focus on open gives it back to whatever had it, when it closes and focus is still inside it or lost. */
export function useRestoreFocus(panel: RefObject<HTMLElement | null>): void {
  // Read while rendering: an autoFocus inside the popover has not moved focus yet.
  const [before] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => {
    const node = panel.current;
    return () => {
      const now = document.activeElement;
      if (before?.isConnected && (now === document.body || now === null || node?.contains(now))) before.focus();
    };
  }, [panel, before]);
}

const MENU_ITEM = 'button:not(:disabled)';

/** Arrow keys, Home and End move between a menu's buttons; Tab leaves it and closes it. */
export function menuKeys(event: KeyboardEvent<HTMLElement>, onClose: (restoreFocus: boolean) => void): void {
  if (event.key === 'Tab') { onClose(false); return; }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(MENU_ITEM)];
  if (!items.length) return;
  event.preventDefault();
  event.stopPropagation();
  const at = items.findIndex(item => item === document.activeElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
    : (at + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
  items[next]!.focus();
}

/** Focus the first item of a menu that was opened from the keyboard. */
export function useFocusFirst(ref: RefObject<HTMLElement | null>, on: boolean): void {
  useEffect(() => { if (on) ref.current?.querySelector<HTMLButtonElement>(MENU_ITEM)?.focus(); }, [ref, on]);
}

export interface PopItem {
  readonly key: string;
  readonly label: string;
  readonly sub?: string;
  readonly icon: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  /** A divider above the row. */
  readonly separated?: boolean;
  readonly onSelect: () => void;
}

/** The board's "…" popover: icon, label, and a quieter line under it. */
export function PopMenu({ items, label, className = '', focusFirst = false, onClose, menuRef }: {
  readonly items: readonly PopItem[]; readonly label: string; readonly className?: string; readonly focusFirst?: boolean;
  readonly onClose: (restoreFocus: boolean) => void; readonly menuRef?: RefObject<HTMLDivElement | null>;
}) {
  const own = useRef<HTMLDivElement>(null), ref = menuRef ?? own;
  useFocusFirst(ref, focusFirst);
  return <div ref={ref} role="menu" aria-label={label} className={`p-menu ${className}`.trim()} onKeyDown={event => menuKeys(event, onClose)}>
    {items.map(item => <div key={item.key} className="p-menu-item">
      {item.separated && <div className="p-menu-sep" role="separator" />}
      <button type="button" role="menuitem" className={item.danger ? 'p-menu-row p-menu-danger' : 'p-menu-row'} disabled={item.disabled}
        onClick={event => { event.stopPropagation(); onClose(false); item.onSelect(); }}>
        <i className={item.icon} aria-hidden="true" />
        <span className="p-menu-text"><span className="p-menu-label">{item.label}</span>{item.sub && <span className="p-menu-sub">{item.sub}</span>}</span>
      </button>
    </div>)}
  </div>;
}
