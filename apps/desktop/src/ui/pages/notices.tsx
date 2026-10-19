import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import './pages.css';
import './notices.css';

export interface NoticeAction {
  readonly label: string;
  readonly run: () => void;
  readonly disabled?: boolean;
  /** Opt in for actions that complete synchronously. Async producers dismiss on success themselves. */
  readonly dismissOnRun?: boolean;
}
export type NoticeTone = 'problem' | 'warn' | 'neutral';
export interface Notice {
  readonly id: string;
  readonly icon: string;
  readonly iconColor?: string;
  /** problem (danger ring), warn (warn ring) or neutral. Without it, a warning icon or a warn/danger colour reads as problem. */
  readonly tone?: NoticeTone;
  readonly text: string;
  readonly actions?: readonly NoticeAction[];
  /** Runs on owner dismissal, before the notice goes. */
  readonly onDismiss?: () => void;
}
export type NoticeInput = Omit<Notice, 'id'> & { readonly id?: string };
type Timer = ReturnType<typeof setTimeout>;
type PauseSource = 'hover' | 'focus';
interface Entry {
  notice: Notice;
  readonly contentDedupe: boolean;
  visible: boolean;
  displayTimer?: Timer;
  lifetimeTimer?: Timer;
  remaining?: number;
  startedAt?: number;
  readonly pauses: Set<PauseSource>;
}
const toneOf = (notice: NoticeInput): NoticeTone => notice.tone ?? (/warn|danger/.test(notice.iconColor ?? '') || /warning/.test(notice.icon) ? 'problem' : 'neutral');
const sameContent = (left: Notice, right: NoticeInput) => left.text === right.text && left.icon === right.icon
  && left.iconColor === right.iconColor && toneOf(left) === toneOf(right)
  && (left.actions ?? []).map(action => action.label).join('\0') === (right.actions ?? []).map(action => action.label).join('\0');

export class NoticeStore {
  private list: readonly Notice[] = [];
  private visible: readonly Notice[] = [];
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private next = 0;
  /** Producer snapshot remains immediate, including notices awaiting display. */
  readonly getSnapshot = () => this.list;
  readonly getVisibleSnapshot = () => this.visible;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish() {
    this.list = Object.freeze([...this.entries.values()].map(entry => entry.notice));
    this.visible = Object.freeze([...this.entries.values()].filter(entry => entry.visible).map(entry => entry.notice));
    this.listeners.forEach(listener => listener());
  }
  /** Repeated content or ids refresh in place. Only information without actions expires. */
  push(input: NoticeInput, timeoutMs?: number): string {
    const repeated = input.id === undefined ? [...this.entries.values()].find(entry => entry.contentDedupe && sameContent(entry.notice, input)) : undefined;
    let id = input.id ?? repeated?.notice.id;
    if (id === undefined) {
      do { id = `notice-${++this.next}`; } while (this.entries.has(id));
    }
    const entry = this.entries.get(id) ?? { notice: { ...input, id }, contentDedupe: input.id === undefined, visible: false, pauses: new Set<PauseSource>() };
    this.clearLifetime(entry);
    entry.notice = { ...input, id };
    entry.remaining = toneOf(input) === 'neutral' && !input.actions?.length ? Math.max(0, timeoutMs ?? 6000) : undefined;
    this.entries.set(id, entry);
    if (entry.visible) this.startLifetime(entry);
    else if (entry.displayTimer === undefined) entry.displayTimer = setTimeout(() => {
      entry.displayTimer = undefined;
      entry.visible = true;
      this.startLifetime(entry);
      this.publish();
    }, 300);
    this.publish();
    return id;
  }
  dismiss(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.clearTimers(entry);
    this.entries.delete(id);
    this.publish();
  }
  clear(): void {
    this.entries.forEach(entry => this.clearTimers(entry));
    this.entries.clear();
    this.publish();
  }
  pause(id: string, source: PauseSource): void {
    const entry = this.entries.get(id);
    if (!entry || entry.pauses.has(source)) return;
    if (!entry.pauses.size && entry.startedAt !== undefined && entry.remaining !== undefined) {
      entry.remaining = Math.max(0, entry.remaining - (Date.now() - entry.startedAt));
      if (entry.lifetimeTimer !== undefined) clearTimeout(entry.lifetimeTimer);
      entry.lifetimeTimer = undefined;
      entry.startedAt = undefined;
    }
    entry.pauses.add(source);
  }
  resume(id: string, source: PauseSource): void {
    const entry = this.entries.get(id);
    if (!entry || !entry.pauses.delete(source) || entry.pauses.size) return;
    this.startLifetime(entry);
  }
  private startLifetime(entry: Entry) {
    if (!entry.visible || entry.pauses.size || entry.remaining === undefined) return;
    entry.startedAt = Date.now();
    entry.lifetimeTimer = setTimeout(() => this.dismiss(entry.notice.id), entry.remaining);
  }
  private clearTimers(entry: Entry) {
    if (entry.displayTimer !== undefined) clearTimeout(entry.displayTimer);
    entry.displayTimer = undefined;
    this.clearLifetime(entry);
  }
  private clearLifetime(entry: Entry) {
    if (entry.lifetimeTimer !== undefined) clearTimeout(entry.lifetimeTimer);
    entry.lifetimeTimer = undefined;
    entry.startedAt = undefined;
  }
}

export const notices = new NoticeStore();

function NoticeCard({ notice, store, order }: { readonly notice: Notice; readonly store: NoticeStore; readonly order: number }) {
  useEffect(() => () => { store.resume(notice.id, 'hover'); store.resume(notice.id, 'focus'); }, [notice.id, store]);
  const dismiss = () => { notice.onDismiss?.(); if (store.getSnapshot().includes(notice)) store.dismiss(notice.id); };
  return <div className="pw-note" data-testid="notice" role={toneOf(notice) === 'neutral' ? 'status' : 'alert'} aria-atomic="false" data-tone={toneOf(notice)} data-notice-id={notice.id} tabIndex={-1} style={{ order }}
    onMouseEnter={() => store.pause(notice.id, 'hover')} onMouseLeave={() => store.resume(notice.id, 'hover')}
    onFocusCapture={() => store.pause(notice.id, 'focus')}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) store.resume(notice.id, 'focus'); }}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); }
    }}>
    <i className={notice.icon} aria-hidden="true" style={notice.iconColor ? { color: notice.iconColor } : undefined} />
    <span className="pw-note-text">{notice.text}</span>
    {notice.actions?.map(action => <button key={action.label} type="button" className="btn btn-secondary pw-note-action" disabled={action.disabled} onClick={() => {
      const result: unknown = action.run();
      // A callback may replace its own receipt synchronously; never dismiss that replacement.
      const pending = typeof result === 'object' && result !== null && 'then' in result;
      if (action.dismissOnRun && !pending && store.getSnapshot().includes(notice)) store.dismiss(notice.id);
    }}>{action.label}</button>)}
    <button type="button" className="btn btn-ghost btn-icon pw-note-dismiss" title="Dismiss ( esc )" aria-label="Dismiss"
      onClick={dismiss}><i className="ph ph-x" aria-hidden="true" /></button>
  </div>;
}

/** At most this many cards show; the rest fold into the pill (SPEC 5.11). */
export const NOTICES_SHOWN = 2;

/** One persistent app region. F6 enters it without stealing focus on arrival. Newest on top, two show, the rest fold. */
export function Notices({ store = notices }: { readonly store?: NoticeStore }) {
  const visible = useSyncExternalStore(store.subscribe, store.getVisibleSnapshot, store.getVisibleSnapshot);
  const [expanded, setExpanded] = useState(false);
  const list = [...visible].reverse();
  const folded = list.length > NOTICES_SHOWN;
  const shown = expanded || !folded ? list : list.slice(0, NOTICES_SHOWN);
  const region = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const focusedNotice = useRef<string | null>(null);
  const pill = useRef<HTMLButtonElement>(null);
  const newest = useRef<string | undefined>(undefined);
  newest.current = list[0]?.id;
  const restoreFocus = () => {
    const previous = previousFocus.current;
    previousFocus.current = null;
    focusedNotice.current = null;
    if (previous?.isConnected) previous.focus();
  };
  useEffect(() => { if (!folded) setExpanded(false); }, [folded]);
  useLayoutEffect(() => {
    if (focusedNotice.current && !shown.some(notice => notice.id === focusedNotice.current)) {
      const here = document.activeElement === document.body || region.current?.contains(document.activeElement);
      // A card a newer notice folded away is still there behind "N more": focus follows it to the pill, not out of the stack.
      if (here && pill.current && list.some(notice => notice.id === focusedNotice.current)) { focusedNotice.current = null; pill.current.focus(); }
      else if (here) restoreFocus();
      else { previousFocus.current = null; focusedNotice.current = null; }
    }
  }, [shown]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'F6' || event.altKey || event.ctrlKey || event.metaKey) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      // The newest card is on top, in whichever live region its tone put it.
      const cards = [...region.current?.querySelectorAll<HTMLElement>('.pw-note') ?? []];
      const first = cards.find(card => card.dataset.noticeId === newest.current) ?? cards[0];
      if (!first) return;
      event.preventDefault();
      if (region.current?.contains(document.activeElement) && previousFocus.current?.isConnected) restoreFocus();
      else {
        previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        first.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [store]);
  const dismissAll = () => {
    for (const notice of list) { notice.onDismiss?.(); store.dismiss(notice.id); }
    setExpanded(false);
  };
  return <div className="pw-notices" role="region" aria-label="Notifications" aria-keyshortcuts="F6" ref={region}
    onFocusCapture={event => {
      if (event.relatedTarget instanceof HTMLElement && !event.currentTarget.contains(event.relatedTarget)) previousFocus.current = event.relatedTarget;
      focusedNotice.current = (event.target as HTMLElement).closest<HTMLElement>('[data-notice-id]')?.dataset.noticeId ?? null;
    }}>
    <div className="pw-notice-stack">
      {/* Two live regions stay mounted so the first notice of either tone is announced; CSS `order` keeps the stack newest on top. */}
      {(['polite', 'assertive'] as const).map(mode => <div key={mode} className="pw-notice-live" aria-live={mode} aria-atomic="false" aria-relevant="additions text">
        {shown.map((notice, order) => ({ notice, order })).filter(({ notice }) => (toneOf(notice) === 'neutral') === (mode === 'polite'))
          .map(({ notice, order }) => <NoticeCard key={notice.id} notice={notice} store={store} order={order} />)}
      </div>)}
      {folded && <div className="pw-notice-pill" data-testid="notice-pill">
        <button type="button" ref={pill} className="pw-notice-more" aria-expanded={expanded} onClick={() => setExpanded(open => !open)}>
          {expanded ? '⌃ Show fewer' : `⌄ ${list.length - NOTICES_SHOWN} more`}</button>
        <button type="button" className="pw-notice-all" onClick={dismissAll}>Dismiss all</button>
      </div>}
    </div>
  </div>;
}
