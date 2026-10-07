// Pending removals (handoff README "Remove"; Ariadne.dc.html:1318-1368). A
// confirmed Remove hides its rows at once and shows a note above the main
// column. Items and topics of a session whose agent is told wait 5 seconds for
// Undo; the others (closed session, session, project) wait until Dismiss or the
// next remove. Only then does the command run, once per op id: navigation does
// not cancel it, hiding or closing the window flushes it, and a failure keeps
// the op id for Retry.
import { createContext, useContext, useSyncExternalStore } from 'react';
import { CoreFailure, type RendererService } from '../../data/service';
import type { Immutable } from '../../data/session-store';
import type { SessionRef } from '../../generated/core';
import type { Session } from '../../generated/domain/models';
import type { RemoveSubject, RemoveTarget } from '../dialogs/remove';
import type { NoticeInput, NoticeStore } from '../pages/notices';
import { Hidden, NOTHING_HIDDEN, removeLabel, targetKey, targetSession } from './model';

export const UNDO_MS = 5000;
type Mode = 'tell' | 'queued' | 'closed' | 'local';
type Stage = 'pending' | 'sending' | 'done' | 'failed';
type Params = { readonly gone: true } | { readonly gone: false; readonly call: () => Promise<unknown> };

interface Entry {
  readonly opId: string;
  readonly target: RemoveTarget;
  readonly label: string;
  readonly agent: string;
  readonly mode: Mode;
  readonly pronoun: 'it' | 'them';
  readonly restore?: () => void;
  stage: Stage;
  timer: ReturnType<typeof setTimeout> | null;
  /** The exact command of the first attempt; kept for retries unless that attempt definitely failed. */
  params: Params | null;
  running: Promise<void> | null;
}

export interface RemovalDeps {
  readonly service: RendererService;
  readonly notices: NoticeStore;
  /** The session's current snapshot, read fresh before the command. */
  readonly read: (route: SessionRef) => Promise<Immutable<Session> | null>;
  /** After the command: refresh what shows the target, close its tabs. */
  readonly removed?: (target: RemoveTarget) => Promise<void> | void;
  readonly operationId?: () => string;
}
export interface ScheduleOptions {
  /** Undo puts the selection, detail or page back. */
  readonly restore?: () => void;
}

const uncertain = (error: unknown) => !(error instanceof CoreFailure) || ['commit_uncertain', 'delivery_uncertain'].includes(error.error.code);

export class RemovalQueue {
  private readonly entries = new Map<string, Entry>();
  private hidden: Hidden = NOTHING_HIDDEN;
  private readonly listeners = new Set<() => void>();
  private readonly operationId: () => string;
  constructor(private readonly deps: RemovalDeps) { this.operationId = deps.operationId ?? (() => crypto.randomUUID()); }
  readonly getSnapshot = () => this.hidden;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  /** Starts a removal the owner confirmed; returns its op id. */
  schedule(target: RemoveTarget, subject: RemoveSubject, options: ScheduleOptions = {}): string {
    // "Undo stays until the next remove": a waiting removal without a timer runs now.
    [...this.entries.values()].filter(entry => entry.stage === 'pending' && !entry.timer).forEach(entry => { void this.fire(entry); });
    const tell = subject.kind === 'item' || subject.kind === 'topic' ? subject.tell : null;
    const entry: Entry = { opId: this.operationId(), target, label: removeLabel(subject), agent: tell?.agent ?? '',
      mode: tell?.mode ?? 'local', pronoun: subject.kind === 'topic' || (subject.kind === 'item' && subject.items > 1) ? 'them' : 'it',
      restore: options.restore, stage: 'pending', timer: null, params: null, running: null };
    this.entries.set(entry.opId, entry);
    if (entry.mode === 'tell' || entry.mode === 'queued') entry.timer = setTimeout(() => { void this.fire(entry); }, UNDO_MS);
    this.republish();
    this.note(entry);
    return entry.opId;
  }
  /** Undo during the window: nothing is sent and the rows come back. */
  undo(opId: string): void {
    const entry = this.entries.get(opId);
    if (!entry || entry.stage !== 'pending') return;
    this.clearTimer(entry);
    this.entries.delete(opId);
    this.deps.notices.dismiss(this.noticeId(entry));
    this.republish();
    entry.restore?.();
  }
  /** Runs a failed removal again with the same op id. */
  retry(opId: string): Promise<void> {
    const entry = this.entries.get(opId);
    if (!entry || entry.stage !== 'failed') return Promise.resolve();
    entry.stage = 'pending';
    this.republish();
    return this.fire(entry);
  }
  /** Runs every removal still in its window now (the window hides or the app quits). */
  flush(): Promise<void> {
    return Promise.all([...this.entries.values()].filter(entry => entry.stage === 'pending' || entry.stage === 'sending')
      .map(entry => entry.stage === 'pending' ? this.fire(entry) : entry.running ?? Promise.resolve())).then(() => {});
  }
  /** Op ids still in their undo window. */
  pending(): readonly string[] { return [...this.entries.values()].filter(entry => entry.stage === 'pending').map(entry => entry.opId); }
  /** Flushes on pagehide, beforeunload and when the window is hidden; returns the detach. */
  attach(target: Window = window): () => void {
    const flush = () => { void this.flush(); };
    const hidden = () => { if (target.document.visibilityState === 'hidden') flush(); };
    target.addEventListener('pagehide', flush);
    target.addEventListener('beforeunload', flush);
    target.document.addEventListener('visibilitychange', hidden);
    return () => {
      target.removeEventListener('pagehide', flush);
      target.removeEventListener('beforeunload', flush);
      target.document.removeEventListener('visibilitychange', hidden);
    };
  }

  private fire(entry: Entry): Promise<void> {
    if (entry.stage !== 'pending') return entry.running ?? Promise.resolve();
    this.clearTimer(entry);
    entry.stage = 'sending';
    if (entry.mode === 'tell' || entry.mode === 'queued') this.note(entry);
    entry.running = this.execute(entry);
    return entry.running;
  }
  private async execute(entry: Entry): Promise<void> {
    try {
      const params = entry.params ?? await this.command(entry);
      entry.params = params;
      if (!params.gone) await params.call();
      entry.stage = 'done';
      if (entry.mode === 'tell' || entry.mode === 'queued') this.note(entry);
      else this.deps.notices.dismiss(this.noticeId(entry));
      try { await this.deps.removed?.(entry.target); } catch { /* The next reconciliation shows the result. */ }
      this.entries.delete(entry.opId);
    } catch (error: unknown) {
      entry.stage = 'failed';
      // A definite rejection committed nothing: the retry reads the revision again under the same op id.
      if (!uncertain(error)) entry.params = null;
      this.note(entry, error instanceof Error ? error.message : 'Ariadne could not finish it.');
    } finally { entry.running = null; this.republish(); }
  }
  /** The command for the target against the session as it is now. */
  private async command(entry: Entry): Promise<Params> {
    const { service } = this.deps, target = entry.target, opId = entry.opId;
    if (target.kind === 'project') return { gone: false, call: () => service.removeProject({ project_id: target.project_id }, opId) };
    const route = targetSession(target), session = await this.deps.read(route);
    if (!session) throw new Error('The session could not be read.');
    if (target.kind === 'session') {
      return { gone: false, call: () => service.removeSession({ project_id: route.project_id, session_id: route.session_id, expected_revision: session.revision }, opId) };
    }
    if (target.kind === 'topic') {
      const topic = session.topics[target.topic_id];
      return topic ? { gone: false, call: () => service.removeTopic(route, { topic_id: topic.id, expected_revision: topic.revision }, opId) } : { gone: true };
    }
    const item = session.items[target.item.item_id];
    return item ? { gone: false, call: () => service.removeItem(route, { item_id: item.id, expected_revision: item.revision }, opId) } : { gone: true };
  }

  private noticeId(entry: Entry) { return `remove:${entry.opId}`; }
  /** The note for the entry's stage (Ariadne.dc.html:1349-1360 removeVals). */
  private note(entry: Entry, failure?: string): void {
    const base = `Removed ${entry.label}.`, agent = entry.agent, id = this.noticeId(entry);
    const undo = { label: 'Undo', run: () => this.undo(entry.opId) };
    const dismiss = () => {
      if (entry.stage === 'pending') void this.fire(entry);
      else if (entry.stage === 'failed' || entry.stage === 'done') this.entries.delete(entry.opId);
    };
    let notice: NoticeInput;
    if (entry.stage === 'failed') {
      notice = { id, icon: 'ph ph-warning-circle', iconColor: 'var(--a-danger)', text: `Couldn’t remove ${entry.label}. ${failure ?? ''}`.trim(),
        actions: [{ label: 'Retry', run: () => { void this.retry(entry.opId); } }], dismissible: true, onDismiss: dismiss };
    } else if (entry.mode === 'local' || entry.mode === 'closed') {
      notice = { id, icon: 'ph ph-trash', text: entry.mode === 'closed' ? `${base} The session is closed, so ${agent} isn’t told.` : base,
        actions: [undo], dismissible: true, onDismiss: dismiss };
    } else if (entry.stage === 'pending') {
      notice = { id, icon: 'ph ph-hourglass', text: `${base} ${agent} is told in 5 seconds unless you undo.`, actions: [undo] };
    } else if (entry.mode === 'queued') {
      notice = { id, icon: 'ph ph-hourglass-medium', iconColor: 'var(--st-open)', text: `${base} ${agent} isn’t running; it’s told when it runs again.`,
        dismissible: entry.stage === 'done', onDismiss: dismiss };
    } else if (entry.stage === 'sending') {
      notice = { id, icon: 'ph ph-paper-plane-right', iconColor: 'var(--st-progress)', text: `${base} Telling ${agent}…` };
    } else {
      notice = { id, icon: 'ph-fill ph-check-circle', iconColor: 'var(--st-done)', text: `${base} ${agent} was told and won’t bring ${entry.pronoun} up again.`,
        dismissible: true, onDismiss: dismiss };
    }
    this.deps.notices.push(notice);
  }
  private clearTimer(entry: Entry) { if (entry.timer) clearTimeout(entry.timer); entry.timer = null; }
  private republish() {
    const keys = [...this.entries.values()].filter(entry => entry.stage !== 'failed').map(entry => targetKey(entry.target));
    this.hidden = keys.length ? new Hidden(new Set(keys)) : NOTHING_HIDDEN;
    this.listeners.forEach(listener => listener());
  }
}

export const RemovalContext = createContext<RemovalQueue | null>(null);
const noSubscription = () => () => {};
const nothing = () => NOTHING_HIDDEN;
/** What the app's pending removals hide; nothing outside a RemovalContext. */
export function useHidden(): Hidden {
  const queue = useContext(RemovalContext);
  return useSyncExternalStore(queue?.subscribe ?? noSubscription, queue?.getSnapshot ?? nothing, queue?.getSnapshot ?? nothing);
}
