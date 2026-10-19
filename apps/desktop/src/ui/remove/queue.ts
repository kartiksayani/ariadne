// Pending removals (handoff README "Remove"; E28). A confirmed Remove hides its
// rows at once. Items and topics wait 5 seconds for Undo in every connection
// state, with a toast and a strip in the Map; sessions and projects keep a note
// and wait until Dismiss or the next remove. Only then does the command run, once
// per op id: navigation does not cancel it, hiding or closing the window flushes
// it, and a failure keeps the op id for Retry.
//
// Never lose typed text: the owner reviewed the scope and the words a removal
// deletes (E27). At commit the queue first waits for any send being saved in that
// session, then reads the session again; if anything new appeared in scope (an
// item, an input, a draft) it doesn't commit and puts the rows back. Retry after
// an uncertain failure runs the same recheck before it reuses the kept command.
import { createContext, useContext, useSyncExternalStore } from 'react';
import { CoreFailure, type RendererService } from '../../data/service';
import type { Immutable } from '../../data/session-store';
import { plainFailure } from '../../data/plain';
import type { SessionRef } from '../../generated/core';
import type { Session } from '../../generated/domain/models';
import { itemRemoved } from '../../selectors/removed';
import type { RemoveSubject, RemoveTarget } from '../dialogs/remove';
import type { NoticeInput, NoticeStore } from '../pages/notices';
import { Hidden, NOTHING_HIDDEN, removeLabel, targetKey, targetSession } from './model';
import { toasts as toastStore } from '../shell/toast';
import type { Topic } from '../../generated/domain/models';
import type { WaitingState } from '../../selectors/waiting/store';
import { hasFamily, readArchived, type FamilyCheck } from './words';

export const UNDO_MS = 5000;
/** How long the family check waits for a settling waiting reader, before and after asking it to read again. */
const FAMILY_SETTLE_MS = 5000;
/** The reader is only catching up: 'stale' or 'loading' with no error and nothing known to be unreadable. */
const settling = (waiting: WaitingState) => (waiting.status === 'stale' || waiting.status === 'loading') && waiting.error == null
  && waiting.unavailableProjects.length === 0 && (!waiting.counts || waiting.counts.completeness === 'complete' && waiting.counts.unavailable_session_ids.length === 0);
type Mode = 'tell' | 'queued' | 'closed' | 'local';
type Stage = 'pending' | 'sending' | 'done' | 'failed';
type Params = { readonly gone: true; readonly changed?: true } | { readonly gone: false; readonly call: () => Promise<unknown> };
/** A fresh read found words or items the owner didn't review: nothing is removed. */
const CHANGED: Params = { gone: true, changed: true };
type Placed = Extract<RemoveTarget, { kind: 'item' | 'topic' }>;
/** The scope (item and topic ids) and the words inventory keys the owner reviewed; the commit compares a fresh read. */
export interface Pinned { readonly scope: readonly string[]; readonly words: readonly string[] }

interface Entry {
  readonly opId: string;
  readonly target: RemoveTarget;
  readonly label: string;
  /** The item's or topic's name alone, for "“x” changed while you were removing it". */
  readonly name: string;
  readonly agent: string;
  readonly mode: Mode;
  readonly pronoun: 'it' | 'them';
  readonly restore?: () => void;
  /** What the owner reviewed (items and topics). */
  readonly pinned: Pinned | null;
  /** The toast that offers Undo (items and topics). */
  toast: string | null;
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
  /** Resolves once no owner send is being saved in the session (the shared submit lock), so the recheck sees its input. */
  readonly settled?: (route: SessionRef) => Promise<void>;
  /** The target's scope and words in a fresh snapshot; null when it is gone. */
  readonly review?: (session: Immutable<Session>, target: Placed) => Pinned | null;
  /** "Remove again" on a removal that found new words at commit. */
  readonly again?: (target: Placed) => void;
  readonly toasts?: Pick<typeof toastStore, 'show' | 'expire' | 'dismiss'>;
  /** The cross-session reader, for the continuation-family test (E34); without it the family is unknown. */
  readonly waiting?: () => WaitingState;
  /** Told whenever the waiting reader publishes; the family check waits on it while the reader settles. */
  readonly subscribeWaiting?: (receive: () => void) => () => void;
  /** Asks the waiting reader to read again (called at most once per family check). */
  readonly refreshWaiting?: () => Promise<void>;
}
export interface ScheduleOptions {
  /** Undo puts the selection, detail or page back. */
  readonly restore?: () => void;
  /** What the owner reviewed; the commit stops when a fresh read finds more. */
  readonly pinned?: Pinned;
}
/** Bin entries Empty deletes for good, and what failed. */
export interface DeleteResult { readonly deleted: readonly Placed[]; readonly failed: readonly { readonly target: Placed; readonly error: string }[] }
const placed = (target: RemoveTarget): target is Placed => target.kind === 'item' || target.kind === 'topic';
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
/** The toast of a pending item or topic removal (SPEC 10.3, 10.14, 6.2). */
export function removeToast(subject: Extract<RemoveSubject, { kind: 'item' | 'topic' }>): string {
  const what = subject.kind === 'topic' ? `“${subject.name}”` : subject.items > 1 ? `“${subject.short}” and the ${plural(subject.items - 1, 'item')} below it` : `“${subject.short}”`;
  const tell = subject.tell;
  const after = !tell ? '' : tell.mode === 'tell' ? ` ${tell.agent} is told in 5 s.` : tell.mode === 'queued' ? ` ${tell.agent} is told when it runs again.`
    : ` The session is closed, so ${tell.agent} isn’t told.`;
  return `Removed ${what}.${after}`;
}

const capital = (text: string) => text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
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
    const entry: Entry = { opId: this.operationId(), target, label: removeLabel(subject),
      name: subject.kind === 'item' ? `“${capital(subject.short)}”` : subject.kind === 'topic' ? `“${subject.name}”` : subject.name ?? '', agent: tell?.agent ?? '',
      mode: tell?.mode ?? 'local', pronoun: subject.kind === 'topic' || (subject.kind === 'item' && subject.items > 1) ? 'them' : 'it',
      restore: options.restore, pinned: options.pinned ?? null, toast: null, stage: 'pending', timer: null, params: null, running: null };
    this.entries.set(entry.opId, entry);
    // One deadline for items and topics, in every connection state (E28).
    if (placed(target) || entry.mode === 'tell' || entry.mode === 'queued') entry.timer = setTimeout(() => { void this.fire(entry); }, UNDO_MS);
    this.republish();
    if (placed(target) && (subject.kind === 'item' || subject.kind === 'topic')) {
      entry.toast = this.toasts.show({ text: removeToast(subject), undo: () => this.undo(entry.opId), ms: UNDO_MS + 1000 });
    } else this.note(entry);
    return entry.opId;
  }
  private get toasts() { return this.deps.toasts ?? toastStore; }
  /**
   * E34: whether removing `topic` would reach other sessions; archived sessions are read now (5 s at most), once. A waiting reader that is
   * only 'stale' or 'loading' (no error) is waited for, up to 5 s; then it is asked to read once more and given up to 5 s again. A real
   * error, an unavailable project or session, a reader that never settles or an unread archive count as family.
   */
  async family(topic: Immutable<Topic>, session: Immutable<Session>): Promise<FamilyCheck> {
    const read = this.deps.waiting;
    if (!read) return { family: true, sessions: [] };
    const archived = readArchived(this.deps.service);
    let waiting = await this.untilSettled(read, FAMILY_SETTLE_MS);
    if (settling(waiting) && this.deps.refreshWaiting) {
      void this.deps.refreshWaiting().catch(() => {});
      waiting = await this.untilSettled(read, FAMILY_SETTLE_MS);
    }
    return hasFamily(topic, [session], waiting, await archived);
  }
  /** The waiting state as soon as it is not merely settling (immediately when it already is not), else what it is after `ms`. */
  private untilSettled(read: () => WaitingState, ms: number): Promise<WaitingState> {
    const subscribe = this.deps.subscribeWaiting;
    if (!settling(read()) || !subscribe) return Promise.resolve(read());
    return new Promise(resolve => {
      let unsubscribe = () => {};
      const done = () => { clearTimeout(timer); unsubscribe(); resolve(read()); };
      unsubscribe = subscribe(() => { if (!settling(read())) done(); });
      const timer = setTimeout(done, ms);
    });
  }
  /** Undo for the pending removal that hides `key` (a strip's click). */
  undoKey(key: string): void {
    const entry = [...this.entries.values()].find(value => value.stage === 'pending' && targetKey(value.target) === key);
    if (entry) this.undo(entry.opId);
  }
  /**
   * Empty the bin (E31): deletes each entry at once, one fresh op id each, with no window and no note per entry. An entry
   * that left the bin meanwhile (restored) is not deleted and counts as failed.
   */
  async deleteNow(targets: readonly Placed[]): Promise<DeleteResult> {
    const deleted: Placed[] = [], failed: { target: Placed; error: string }[] = [];
    for (const target of targets) {
      try {
        const route = targetSession(target), session = await this.deps.read(route);
        if (!session) throw new Error('The session could not be read.');
        const opId = this.operationId();
        if (target.kind === 'topic') {
          const topic = session.topics[target.topic_id];
          if (!topic?.removed_at) { failed.push({ target, error: 'It isn’t in the bin any more.' }); continue; }
          await this.deps.service.removeTopic(route, { topic_id: topic.id, expected_revision: topic.revision }, opId);
        } else {
          const item = session.items[target.item.item_id];
          if (!item || !itemRemoved(session, item.id)) { failed.push({ target, error: 'It isn’t in the bin any more.' }); continue; }
          await this.deps.service.removeItem(route, { item_id: item.id, expected_revision: item.revision }, opId);
        }
        deleted.push(target);
      } catch (error: unknown) {
        failed.push({ target, error: plainFailure(error, 'Ariadne couldn’t delete it. Try again.') });
      }
    }
    const routes = new Map([...deleted, ...failed.map(value => value.target)].map(target => [targetKey({ kind: 'session', session: targetSession(target) }), target]));
    for (const target of routes.values()) { try { await this.deps.removed?.(target); } catch { /* The next reconciliation shows the result. */ } }
    return { deleted, failed };
  }
  /** Undo during the window: nothing is sent and the rows come back. */
  undo(opId: string): void {
    const entry = this.entries.get(opId);
    if (!entry || entry.stage !== 'pending') return;
    this.clearTimer(entry);
    this.entries.delete(opId);
    this.deps.notices.dismiss(this.noticeId(entry));
    if (entry.toast) this.toasts.dismiss(entry.toast);
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
    // The window ended: the toast's and the strip's Undo go at once.
    this.republish();
    if (entry.toast) this.toasts.expire(entry.toast);
    else if (entry.mode === 'tell' || entry.mode === 'queued') this.note(entry);
    entry.running = this.execute(entry);
    return entry.running;
  }
  private async execute(entry: Entry): Promise<void> {
    try {
      let params = entry.params;
      // Retry after an uncertain failure: the rows came back meanwhile and the owner may have typed, so the kept command
      // runs (same op id) only after the same recheck finds nothing new (E28).
      if (params && !params.gone && placed(entry.target) && entry.pinned && (await this.recheck(entry, targetSession(entry.target))).changed) params = CHANGED;
      params ??= await this.command(entry);
      entry.params = params;
      if (params.gone && params.changed) {
        // New words or items appeared after the review: nothing is removed and the rows come back.
        this.entries.delete(entry.opId);
        entry.restore?.();
        const target = entry.target;
        this.deps.notices.push({ id: this.noticeId(entry), icon: 'ph ph-warning-circle', tone: 'problem',
          text: `${entry.name} changed while you were removing it. Nothing was removed.`,
          actions: placed(target) && this.deps.again ? [{ label: 'Remove again', dismissOnRun: true, run: () => { this.deps.again?.(target); } }] : undefined });
        return;
      }
      if (!params.gone) await params.call();
      entry.stage = 'done';
      if (entry.toast) { /* The toast said it all; nothing more to note. */ }
      else if (entry.mode === 'tell' || entry.mode === 'queued') this.note(entry);
      else this.deps.notices.dismiss(this.noticeId(entry));
      try { await this.deps.removed?.(entry.target); } catch { /* The next reconciliation shows the result. */ }
      this.entries.delete(entry.opId);
    } catch (error: unknown) {
      entry.stage = 'failed';
      // A definite rejection committed nothing: the retry reads the revision again under the same op id.
      if (!uncertain(error)) entry.params = null;
      this.note(entry, plainFailure(error, 'Ariadne couldn’t finish removing it. Try again.'));
    } finally { entry.running = null; this.republish(); }
  }
  /** The command for the target against the session as it is now. */
  private async command(entry: Entry): Promise<Params> {
    const { service } = this.deps, target = entry.target, opId = entry.opId;
    if (target.kind === 'project') return { gone: false, call: () => service.removeProject({ project_id: target.project_id }, opId) };
    const route = targetSession(target);
    const { session, changed } = await this.recheck(entry, route);
    if (changed) return CHANGED;
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

  /**
   * The session read again, and whether it holds anything in scope the owner didn't review (E28). A send being saved now
   * lands first, so its input is seen. Without a pinned review (sessions, projects, a leaf with no words) nothing changes.
   */
  private async recheck(entry: Entry, route: SessionRef): Promise<{ readonly session: Immutable<Session>; readonly changed: boolean }> {
    const target = entry.target, pinned = entry.pinned;
    if (placed(target) && pinned) await this.deps.settled?.(route);
    const session = await this.deps.read(route);
    if (!session) throw new Error('The session could not be read.');
    const now = placed(target) && pinned && this.deps.review ? this.deps.review(session, target) : null;
    return { session, changed: !!now && !!pinned && (now.scope.some(id => !pinned.scope.includes(id)) || now.words.some(key => !pinned.words.includes(key))) };
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
        actions: [{ label: 'Retry', run: () => { void this.retry(entry.opId); } }], onDismiss: dismiss };
    } else if (entry.mode === 'local' || entry.mode === 'closed') {
      notice = { id, icon: 'ph ph-trash', text: entry.mode === 'closed' ? `${base} The session is closed, so ${agent} isn’t told.` : base,
        actions: [undo], onDismiss: dismiss };
    } else if (entry.stage === 'pending') {
      notice = { id, icon: 'ph ph-hourglass', text: `${base} ${agent} is told in 5 seconds unless you undo.`, actions: [undo] };
    } else if (entry.mode === 'queued') {
      notice = { id, icon: 'ph ph-hourglass-medium', iconColor: 'var(--st-open)', text: `${base} ${agent} isn’t running; it’s told when it runs again.`,
        onDismiss: dismiss };
    } else if (entry.stage === 'sending') {
      notice = { id, icon: 'ph ph-paper-plane-right', iconColor: 'var(--st-progress)', text: `${base} Telling ${agent}…` };
    } else {
      notice = { id, icon: 'ph-fill ph-check-circle', iconColor: 'var(--st-done)', text: `${base} ${agent} was told and won’t bring ${entry.pronoun} up again.`,
        onDismiss: dismiss };
    }
    this.deps.notices.push(notice);
  }
  private clearTimer(entry: Entry) { if (entry.timer) clearTimeout(entry.timer); entry.timer = null; }
  private republish() {
    const shown = [...this.entries.values()].filter(entry => entry.stage !== 'failed');
    // A strip offers Undo only while its entry is in the window (E29).
    this.hidden = shown.length ? new Hidden(new Set(shown.map(entry => targetKey(entry.target))),
      new Set(shown.filter(entry => entry.stage === 'pending').map(entry => targetKey(entry.target)))) : NOTHING_HIDDEN;
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
