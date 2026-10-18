/** One toast at a time (SPEC 6.15). The producer owns Undo's life; the store owns only the display time. */
export interface ToastSpec {
  readonly id?: string;
  readonly text: string;
  readonly undo?: () => void | Promise<void>;
  /** Display time in milliseconds; default 6000. */
  readonly ms?: number;
}
export type CurrentToast = ToastSpec & { readonly id: string; readonly expired: boolean };

const DISPLAY_MS = 6000;
type Timer = ReturnType<typeof setTimeout>;

class ToastStore {
  private shown: CurrentToast | null = null;
  private used = false;
  private timer: Timer | undefined;
  private remaining = DISPLAY_MS;
  private startedAt: number | undefined;
  private paused = false;
  private next = 0;
  private readonly listeners = new Set<() => void>();

  /** Shows `t`, replacing the toast on screen. The replaced toast's Undo is not run: its producer keeps its own window. */
  show(t: ToastSpec): string {
    const id = t.id ?? `toast-${++this.next}`;
    this.clearTimer();
    this.shown = { ...t, id, expired: false };
    this.used = false;
    this.remaining = Math.max(0, t.ms ?? DISPLAY_MS);
    this.paused = false;
    this.start();
    this.emit();
    return id;
  }
  /** The producer's Undo window ended: Undo goes at once, whatever the hover. The text stays until its display time ends. */
  expire(id: string): void {
    if (this.shown?.id !== id || this.shown.expired) return;
    this.shown = { ...this.shown, expired: true };
    this.emit();
  }
  /** Closes the toast. This never runs Undo. */
  dismiss(id: string): void {
    if (this.shown?.id !== id) return;
    this.clearTimer();
    this.shown = null;
    this.emit();
  }
  /** Runs Undo once, then closes. Nothing runs for an expired or already used Undo. */
  runUndo(id: string): void {
    const toast = this.shown;
    if (toast?.id !== id || toast.expired || this.used || !toast.undo) return;
    this.used = true;
    this.dismiss(id);
    void toast.undo();
  }
  /** Hover pauses only the display timer. */
  pause(id: string): void {
    if (this.shown?.id !== id || this.paused) return;
    this.paused = true;
    if (this.startedAt !== undefined) this.remaining = Math.max(0, this.remaining - (Date.now() - this.startedAt));
    this.clearTimer();
  }
  resume(id: string): void {
    if (this.shown?.id !== id || !this.paused) return;
    this.paused = false;
    this.start();
  }
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  current = (): CurrentToast | null => this.shown;

  private start() {
    const shown = this.shown;
    if (!shown) return;
    this.startedAt = Date.now();
    this.timer = setTimeout(() => this.dismiss(shown.id), this.remaining);
  }
  private clearTimer() {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.startedAt = undefined;
  }
  private emit() { this.listeners.forEach(listener => listener()); }
}

export const toasts: {
  show(t: ToastSpec): string;
  expire(id: string): void;
  dismiss(id: string): void;
  runUndo(id: string): void;
  pause(id: string): void;
  resume(id: string): void;
  subscribe(fn: () => void): () => void;
  current(): CurrentToast | null;
} = new ToastStore();
export type { ToastStore };
