// Short notes above the main column, e.g. "Removed …  Undo" (Ariadne.dc.html:115-129).
// Anything can push a note; it disappears after its timeout or when dismissed.
import { useSyncExternalStore } from 'react';
import './pages.css';

export interface NoticeAction { readonly label: string; readonly run: () => void }
export interface Notice {
  readonly id: string;
  readonly icon: string;
  readonly iconColor?: string;
  readonly text: string;
  readonly actions?: readonly NoticeAction[];
  /** Shows the × button. */
  readonly dismissible?: boolean;
  /** Runs when the owner presses ×, before the note goes. */
  readonly onDismiss?: () => void;
}
export type NoticeInput = Omit<Notice, 'id'> & { readonly id?: string };

export class NoticeStore {
  private list: readonly Notice[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<() => void>();
  private next = 0;
  readonly getSnapshot = () => this.list;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(list: readonly Notice[]) { this.list = Object.freeze(list); this.listeners.forEach(listener => listener()); }
  /** Shows `input` (replacing a note with the same id) and removes it after `timeoutMs`, when given. Returns its id. */
  push(input: NoticeInput, timeoutMs?: number): string {
    const id = input.id ?? `notice-${++this.next}`;
    this.clearTimer(id);
    this.publish([...this.list.filter(notice => notice.id !== id), { ...input, id }]);
    if (timeoutMs !== undefined) this.timers.set(id, setTimeout(() => this.dismiss(id), timeoutMs));
    return id;
  }
  dismiss(id: string): void {
    this.clearTimer(id);
    if (this.list.some(notice => notice.id === id)) this.publish(this.list.filter(notice => notice.id !== id));
  }
  clear(): void { [...this.timers.keys()].forEach(id => this.clearTimer(id)); this.publish([]); }
  private clearTimer(id: string) { const timer = this.timers.get(id); if (timer !== undefined) clearTimeout(timer); this.timers.delete(id); }
}

/** The app's notes. */
export const notices = new NoticeStore();

export function Notices({ store = notices }: { readonly store?: NoticeStore }) {
  const list = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  if (!list.length) return null;
  return <div className="pw-notices" role="status">
    {list.map(notice => <div key={notice.id} className="pw-note">
      <i className={notice.icon} aria-hidden="true" style={notice.iconColor ? { color: notice.iconColor } : undefined} />
      <span className="pw-note-text">{notice.text}</span>
      {notice.actions?.map(action => <button key={action.label} type="button" className="btn btn-ghost pw-note-action" onClick={action.run}>{action.label}</button>)}
      {notice.dismissible && <button type="button" className="btn btn-ghost btn-icon pw-note-dismiss" title="Dismiss" aria-label="Dismiss"
        onClick={() => { notice.onDismiss?.(); store.dismiss(notice.id); }}><i className="ph ph-x" aria-hidden="true" /></button>}
    </div>)}
  </div>;
}
