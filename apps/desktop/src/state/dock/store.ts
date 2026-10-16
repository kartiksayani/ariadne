/** View state only. Drafts and delivery belong to OwnerDraftStore/Core. No Map commands live here. */
export interface DockQuestion { readonly id: string; readonly itemId: string; readonly question: string }
export interface DockState {
  readonly session: string | null;
  readonly questions: readonly DockQuestion[];
  readonly current: DockQuestion | null;
  readonly open: boolean;
}
export class DockStore {
  private state: DockState = { session: null, questions: [], current: null, open: false };
  private readonly listeners = new Set<() => void>();
  private advance: ReturnType<typeof setTimeout> | null = null;
  private held: string | null = null;
  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(change: Partial<DockState>) { this.state = { ...this.state, ...change }; this.listeners.forEach(listener => listener()); }
  private cancel() { if (this.advance) clearTimeout(this.advance); this.advance = null; this.held = null; }
  sync(session: string | null, questions: readonly DockQuestion[]) {
    const changed = session !== this.state.session;
    if (changed) this.cancel();
    // A confirmed Undo returns the held question to the unsent queue.
    if (this.held && !this.state.questions.some(question => question.id === this.held)
      && questions.some(question => question.id === this.held)) this.cancel();
    const current = changed ? questions[0] ?? null : this.held === this.state.current?.id ? this.state.current
      : questions.find(question => question.id === this.state.current?.id) ?? questions[0] ?? null;
    this.publish({ session, questions, current, open: !changed && !!current && this.state.open });
  }
  show(id?: string) {
    this.cancel();
    const current = this.state.questions.find(question => question.id === id) ?? this.state.current ?? this.state.questions[0] ?? null;
    if (current) this.publish({ current, open: true });
  }
  step(direction: -1 | 1) {
    const index = this.state.questions.findIndex(question => question.id === this.state.current?.id);
    const next = Math.max(0, Math.min(this.state.questions.length - 1, index + direction));
    this.show(this.state.questions[next]?.id);
  }
  fold() { this.publish({ open: false }); }
  sent(id: string) {
    if (this.state.current?.id !== id || this.held === id) return;
    this.cancel(); this.held = id;
    const session = this.state.session;
    const at = this.state.questions.findIndex(question => question.id === id);
    const following = this.state.questions.slice(at + 1).map(question => question.id);
    this.advance = setTimeout(() => {
      this.advance = null; this.held = null;
      if (this.state.session !== session || this.state.current?.id !== id) return;
      const questions = this.state.questions.filter(question => question.id !== id);
      const next = following.map(id => questions.find(question => question.id === id)).find(Boolean) ?? questions[0] ?? null;
      this.publish({ questions, current: next, open: !!next && this.state.open });
    }, 2700);
  }
  dispose() { this.cancel(); this.listeners.clear(); }
}
