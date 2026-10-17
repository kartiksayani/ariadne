/** View state only. Drafts and delivery belong to OwnerDraftStore/Core. No Map commands live here. */
export interface DockQuestion { readonly id: string; readonly itemId: string; readonly question: string }
export interface DockState {
  /** The session the questions belong to (`dockSessionKey`). */
  readonly session: string | null;
  /** The unsent waiting questions, oldest first. A question just sent stays in its place during the Sent hold. */
  readonly questions: readonly DockQuestion[];
  readonly current: DockQuestion | null;
  readonly open: boolean;
}

export const SENT_HOLD_MS = 2700;
export const dockSessionKey = (route: { readonly project_id: string; readonly session_id: string }) => JSON.stringify([route.project_id, route.session_id]);

/**
 * The dock's view model. It lives in `DockProvider`, above the dock, so a remount keeps the current question and the
 * open state. Only owner actions open it (`show`, `step`, `openAt`); `sync` never does.
 */
export class DockStore {
  private state: DockState = { session: null, questions: [], current: null, open: false };
  private readonly listeners = new Set<() => void>();
  private advance: ReturnType<typeof setTimeout> | null = null;
  /** The question shown as Sent until the hold ends. */
  private held: DockQuestion | null = null;
  /** The held question has left the unsent list at least once; seeing it again means Undo returned it. */
  private heldLeft = false;
  /** An `openAt` for a session the dock has not synced yet (the switcher navigates first). */
  private pending: { readonly session: string; readonly itemId: string } | null = null;
  private ready = false;
  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(change: Partial<DockState>) { this.state = { ...this.state, ...change }; this.listeners.forEach(listener => listener()); }
  private cancel() { if (this.advance) clearTimeout(this.advance); this.advance = null; this.held = null; this.heldLeft = false; }
  /** The question id being held as Sent, if any. */
  holding(): string | null { return this.held?.id ?? null; }
  /** `ready` is false while the session is still loading: a pending `openAt` waits for the loaded questions. */
  sync(session: string | null, incoming: readonly DockQuestion[], ready = true) {
    const changed = session !== this.state.session;
    if (changed) this.cancel();
    this.ready = ready;
    const held = this.held;
    let questions = incoming;
    if (held) {
      const back = incoming.some(question => question.id === held.id);
      if (back && this.heldLeft) this.cancel();
      else if (!back) {
        // Keep the held question in its place so "1 of N" stays true during the Sent hold.
        this.heldLeft = true;
        const before = this.state.questions.slice(0, Math.max(0, this.state.questions.findIndex(question => question.id === held.id)))
          .filter(question => incoming.some(next => next.id === question.id)).length;
        questions = [...incoming.slice(0, before), held, ...incoming.slice(before)];
      }
    }
    // A revised question has a new id (it carries the question revision): the dock stays on the same item, never jumps.
    const shown = this.state.current;
    const current = changed ? questions[0] ?? null
      : this.held && this.held.id === shown?.id ? this.held
        : questions.find(question => question.id === shown?.id) ?? questions.find(question => question.itemId === shown?.itemId)
          ?? questions[0] ?? null;
    this.publish({ session, questions, current, open: !changed && !!current && this.state.open });
    const pending = this.pending;
    if (pending && pending.session === session && ready) {
      // The owner asked for the dock: open it at that question, or at the first one if it was answered meanwhile.
      this.pending = null;
      this.show(questions.find(question => question.itemId === pending.itemId)?.id);
    }
  }
  show(id?: string) {
    const current = this.state.questions.find(question => question.id === id) ?? this.state.current ?? this.state.questions[0] ?? null;
    if (current && current.id !== this.held?.id) this.cancel();
    if (current) this.publish({ current, open: true });
  }
  /** Opens at a question by item, now or once its session is synced. */
  openAt(session: string, itemId: string) {
    this.pending = null;
    if (session === this.state.session && this.ready) {
      this.show(this.state.questions.find(question => question.itemId === itemId)?.id);
      return;
    }
    this.pending = { session, itemId };
  }
  /** `[` and `]`: folded, open at the current question; open, move one question. */
  step(direction: -1 | 1) {
    if (!this.state.open) { this.show(); return; }
    const index = this.state.questions.findIndex(question => question.id === this.state.current?.id);
    const next = Math.max(0, Math.min(this.state.questions.length - 1, index + direction));
    this.show(this.state.questions[next]?.id);
  }
  fold() { if (this.state.open) this.publish({ open: false }); }
  sent(id: string) {
    if (this.state.current?.id !== id || this.held?.id === id) return;
    this.cancel(); this.held = this.state.current;
    const session = this.state.session;
    this.advance = setTimeout(() => {
      const held = this.held;
      this.advance = null; this.held = null; this.heldLeft = false;
      if (!held || this.state.session !== session || this.state.current?.id !== held.id) return;
      const at = this.state.questions.findIndex(question => question.id === held.id);
      const following = this.state.questions.slice(at + 1).map(question => question.id);
      const questions = this.state.questions.filter(question => question.id !== held.id);
      const next = following.map(id => questions.find(question => question.id === id)).find(Boolean) ?? questions[0] ?? null;
      this.publish({ questions, current: next, open: !!next && this.state.open });
    }, SENT_HOLD_MS);
  }
  dispose() { this.cancel(); this.pending = null; this.listeners.clear(); }
}
