import { useSyncExternalStore } from 'react';
import type { MutationReceipt, OwnerDraft, OwnerMutationRequest, PreferencesPatchEntry, SessionRef } from '../../generated/core';
import type { Item, InputKind, SavedReceipt, Session } from '../../generated/domain/models';
import { immutable, type Immutable } from '../../data/session-store';
import { CoreFailure, ServiceFailure, type RendererService } from '../../data/service';

export type OwnerIntent = Exclude<InputKind, 'continue'>;
type Failure = CoreFailure | ServiceFailure;
export interface DraftEntry {
  readonly draft: Immutable<OwnerDraft>;
  readonly saving: boolean;
  readonly uncertain: boolean;
  readonly error: Failure | null;
  readonly receipt: Immutable<SavedReceipt> | null;
  readonly rejected: boolean;
}
export interface DraftState {
  readonly entries: Readonly<Record<string, DraftEntry>>;
  readonly ready: boolean;
  readonly error: Failure | null;
  readonly preferenceUncertain: boolean;
}
const sameSession = (a: SessionRef, b: SessionRef) => a.project_id === b.project_id && a.session_id === b.session_id;
const failure = (error: unknown): Failure => error instanceof CoreFailure || error instanceof ServiceFailure ? error : new ServiceFailure('transport');
const unknownCommit = (error: Failure) => error instanceof ServiceFailure || error.error.code === 'commit_uncertain';
// These core submit guards run before publishing the transaction. Replay wins
// before guards, so this response establishes the exact operation was not saved.
const definitiveRejection = (error: Failure) => error instanceof CoreFailure &&
  ['question_changed', 'revision_conflict', 'binding_mismatch', 'invalid_transition', 'queue_full'].includes(error.error.code);
const terminal = (item: Immutable<Item>) => ['decided', 'done', 'dropped', 'replaced'].includes(item.status);

export function ownerActions(item: Immutable<Item>): OwnerIntent[] {
  return ['bring', ...(item.status === 'waiting_on_me' ? ['answer' as const] : []), 'reply', 'note', 'followup', 'drop',
    ...(terminal(item) && item.status !== 'replaced' ? ['reopen' as const] : [])];
}
export function blockedDraft(draft: Immutable<OwnerDraft>, session: Immutable<Session>): string | null {
  const item = draft.target.item_id ? session.items[draft.target.item_id] : null;
  if (!sameSession(draft.session, { project_id: session.project_id, session_id: session.id }) || !item || item.topic_id !== draft.target.topic_id) return 'The saved target is unavailable. Open its registered session.';
  if (session.state !== 'active') return 'Reopen this session before sending an input.';
  if (session.topics[item.topic_id]?.archived_at !== null) return 'Restore this topic before sending an input.';
  if (session.active_binding_id !== draft.binding_id || !session.bindings[draft.binding_id]) return 'The selected binding changed. Review the current target before sending.';
  if (item.revision !== draft.target_revision || item.question_revision !== draft.question_revision) return 'This item changed. Review the current question and options before sending.';
  if (!ownerActions(item).includes(draft.intent as OwnerIntent)) return 'This action is no longer available for the current item.';
  if (draft.intent === 'answer') {
    if (item.recipient_binding_id !== draft.binding_id) return 'The current question belongs to another binding.';
    const round = item.current_round_id ? session.rounds[item.current_round_id] : null;
    if (!round || round.closed_at !== null || round.question_revision !== item.question_revision) return 'The current question is no longer open for an answer.';
    if (draft.selected_option_id && !item.options.some(option => option.id === draft.selected_option_id)) return 'Choose one of the current options.';
  }
  if (!draft.selected_option_id && !draft.text.trim()) return 'Choose an option or enter a message before sending.';
  if (new TextEncoder().encode(draft.text).length > 16 * 1024) return 'Keep the message within 16 KiB.';
  return null;
}

// Composition owns one store for all owner controls. Preferences patches use a
// fresh canonical revision and only draft entries; navigation is never copied.
export class OwnerDraftStore {
  private state: DraftState = Object.freeze({ entries: {}, ready: false, error: null, preferenceUncertain: false });
  private readonly listeners = new Set<() => void>();
  private saves: Promise<boolean> = Promise.resolve(true);
  private pendingPreference: OwnerMutationRequest | null = null;
  private pendingPreferenceEntries: PreferencesPatchEntry[] = [];
  private readonly deferredPreferences: PreferencesPatchEntry[][] = [];
  private readonly pendingInputs = new Map<string, OwnerMutationRequest>();
  private readonly flights = new Map<string, Promise<boolean>>();
  private loadFlight: Promise<void> | null = null;
  constructor(private readonly service: RendererService, private readonly operationId: () => string = () => crypto.randomUUID()) {}
  readonly getSnapshot = () => this.state;
  readonly subscribe = (receive: () => void) => { this.listeners.add(receive); return () => { this.listeners.delete(receive); }; };
  private publish(update: Partial<DraftState>): void {
    this.state = Object.freeze({ ...this.state, ...update }); this.listeners.forEach(receive => receive());
  }
  private entry(id: string, update: Partial<DraftEntry>): void {
    const current = this.state.entries[id];
    if (current) this.publish({ entries: Object.freeze({ ...this.state.entries, [id]: Object.freeze({ ...current, ...update }) }) });
  }
  load(): Promise<void> {
    if (this.loadFlight) return this.loadFlight;
    this.loadFlight = this.loadPreferences().finally(() => { this.loadFlight = null; }); return this.loadFlight;
  }
  private async loadPreferences(): Promise<void> {
    try {
      const preferences = await this.service.query({ session: null, request: { command: 'preferences_get', params: {} } });
      const entries = { ...this.state.entries };
      for (const draft of preferences.drafts) if (!entries[draft.op_id]) {
        entries[draft.op_id] = Object.freeze({ draft: immutable(draft), saving: false, uncertain: draft.submission_attempted ?? false, error: null, receipt: null, rejected: false });
        if (draft.submission_attempted) this.pendingInputs.set(draft.op_id, this.inputRequest(draft));
      }
      this.publish({ entries: Object.freeze(entries), ready: true, error: null });
    } catch (error: unknown) { this.publish({ error: failure(error) }); }
  }
  find(session: SessionRef, itemId: string, intent: OwnerIntent): DraftEntry | undefined {
    return Object.values(this.state.entries).reverse().find(entry => sameSession(entry.draft.session, session) && entry.draft.target.item_id === itemId && entry.draft.intent === intent);
  }
  begin(session: Immutable<Session>, itemId: string, intent: OwnerIntent, revised = false): string | null {
    const route = { project_id: session.project_id, session_id: session.id }, existing = this.find(route, itemId, intent);
    if (existing && !revised) return existing.draft.op_id;
    const item = session.items[itemId], binding = session.active_binding_id;
    if (!this.state.ready || !item || !binding || !ownerActions(item).includes(intent)) return null;
    const draft: OwnerDraft = { submission_attempted: false, op_id: this.operationId(), session: route, binding_id: binding, target: { topic_id: item.topic_id, item_id: item.id },
      intent, text: '', selected_option_id: null, target_revision: item.revision, question_revision: item.question_revision,
      supersedes_answer_id: intent === 'answer' ? session.answers.filter(answer => answer.item_id === item.id && answer.question_revision === item.question_revision).sort((a, b) => b.seq - a.seq)[0]?.id ?? null : null };
    this.publish({ entries: Object.freeze({ ...this.state.entries, [draft.op_id]: Object.freeze({ draft: immutable(draft), saving: false, uncertain: false, error: null, receipt: null, rejected: false }) }) });
    return draft.op_id;
  }
  edit(id: string, change: Pick<Partial<OwnerDraft>, 'text' | 'selected_option_id'>): void {
    const entry = this.state.entries[id];
    if (!entry || entry.saving || entry.uncertain || entry.receipt || this.state.preferenceUncertain) return;
    const draft = { ...structuredClone(entry.draft), ...change } as OwnerDraft;
    this.entry(id, { draft: immutable(draft), error: null }); void this.save([{ kind: 'upsert_draft', draft }]);
  }
  review(id: string, session: Immutable<Session>): void {
    const entry = this.state.entries[id], itemId = entry?.draft.target.item_id, item = itemId ? session.items[itemId] : null;
    if (!entry || !item || !sameSession(entry.draft.session, { project_id: session.project_id, session_id: session.id }) || entry.saving || entry.uncertain || this.state.preferenceUncertain || !session.active_binding_id) return;
    const previous = session.answers.filter(answer => answer.item_id === item.id && answer.question_revision === item.question_revision).sort((a, b) => b.seq - a.seq)[0];
    const draft: OwnerDraft = { ...structuredClone(entry.draft), target: { topic_id: item.topic_id, item_id: item.id }, binding_id: session.active_binding_id,
      target_revision: item.revision, question_revision: item.question_revision, selected_option_id: null,
      supersedes_answer_id: entry.draft.intent === 'answer' ? previous?.id ?? null : null };
    this.entry(id, { draft: immutable(draft), error: null }); void this.save([{ kind: 'upsert_draft', draft }]);
  }
  another(id: string, session: Immutable<Session>): void {
    const entry = this.state.entries[id]; if (!entry?.receipt || !entry.draft.target.item_id) return;
    const entries = { ...this.state.entries }; delete entries[id]; this.publish({ entries: Object.freeze(entries) });
    this.begin(session, entry.draft.target.item_id, entry.draft.intent as OwnerIntent, true);
  }
  prepareRevised(id: string, session: Immutable<Session>): void {
    const previous = this.state.entries[id];
    if (!previous?.rejected || previous.saving || this.state.preferenceUncertain || !previous.draft.target.item_id) return;
    const nextId = this.begin(session, previous.draft.target.item_id, previous.draft.intent as OwnerIntent, true);
    if (!nextId) return;
    const draft = { ...structuredClone(this.state.entries[nextId]!.draft), text: previous.draft.text, question_revision: null } as OwnerDraft;
    this.entry(nextId, { draft: immutable(draft) }); void this.save([{ kind: 'upsert_draft', draft }]);
  }
  private save(entries: PreferencesPatchEntry[]): Promise<boolean> {
    const next = this.saves.then(() => {
      // Later logical edits remain ordered separately from the exact in-flight
      // request. They cannot be discarded or overwrite its operation body.
      this.deferredPreferences.push(structuredClone(entries)); return this.flushPreferences();
    });
    this.saves = next; return next;
  }
  private async flushPreferences(): Promise<boolean> {
    if (this.pendingPreference) return false;
    let saved = true;
    while (this.deferredPreferences.length) {
      const entries = this.deferredPreferences.shift()!;
      if (!await this.writePreferences(entries)) {
        // An uncertain write is now held by pendingPreference. Definite
        // rejections retain local content/error while later edits can correct it.
        if (this.pendingPreference) return false;
        saved = false;
      }
    }
    return saved;
  }
  private async writePreferences(entries: PreferencesPatchEntry[]): Promise<boolean> {
    // A definite revision_conflict means the patch was not applied (an interleaved
    // navigation patch bumped the revision). Re-read and re-issue the same draft
    // bookkeeping entries under a fresh patch op_id, at most three attempts. Draft
    // entries are keyed by draft op_id, so replay is idempotent. input_submit is
    // never involved and commit_uncertain is never retried.
    for (let attempt = 1; ; attempt++) {
      try {
        const preferences = await this.service.query({ session: null, request: { command: 'preferences_get', params: {} } });
        this.pendingPreference = { session: null, command: { api_version: 1, command: 'preferences_patch', op_id: this.operationId(), params: { expected_preferences_revision: preferences.revision, entries: structuredClone(entries) } } };
        this.pendingPreferenceEntries = entries;
        if (await this.commitPreferences()) return true;
        const reason = this.state.error;
        if (attempt >= 3 || this.pendingPreference || !(reason instanceof CoreFailure) || reason.error.code !== 'revision_conflict') return false;
      } catch (error: unknown) { this.publish({ error: failure(error) }); return false; }
    }
  }
  private async commitPreferences(): Promise<boolean> {
    if (!this.pendingPreference) return true;
    try {
      const receipt = await this.service.executeOwner(this.pendingPreference);
      if (!('preferences_revision' in receipt) || this.pendingPreference.command.command !== 'preferences_patch'
        || receipt.operation_id !== this.pendingPreference.command.op_id || receipt.preferences_revision <= this.pendingPreference.command.params.expected_preferences_revision) throw new ServiceFailure('invalid_response');
      for (const entry of this.pendingPreferenceEntries) if (entry.kind === 'upsert_draft' && entry.draft.submission_attempted) {
        this.pendingInputs.set(entry.draft.op_id, this.inputRequest(entry.draft));
        this.entry(entry.draft.op_id, { draft: immutable(entry.draft), uncertain: true });
      }
      this.pendingPreference = null; this.pendingPreferenceEntries = []; this.publish({ preferenceUncertain: false, error: null }); return true;
    } catch (error: unknown) {
      const reason = failure(error), uncertain = unknownCommit(reason);
      if (!uncertain) { this.pendingPreference = null; this.pendingPreferenceEntries = []; }
      this.publish({ preferenceUncertain: uncertain, error: reason }); return false;
    }
  }
  retryPreferences(): Promise<boolean> {
    const next = this.saves.then(async () => {
      const reconciled = await this.commitPreferences();
      if (!reconciled && this.pendingPreference) return false;
      // Resolve the old operation first, then use fresh IDs/revisions for the
      // queued logical edits. Reconciliation never invokes input_submit.
      return await this.flushPreferences() && reconciled;
    });
    this.saves = next; return next;
  }
  private inputRequest(draft: Immutable<OwnerDraft>): OwnerMutationRequest {
    return immutable({ session: draft.session, command: { api_version: 1, command: 'input_submit', op_id: draft.op_id, params: {
      binding_id: draft.binding_id, target: draft.target, kind: draft.intent, text: draft.text, selected_option_id: draft.selected_option_id,
      expected_question_revision: draft.question_revision, supersedes_answer_id: draft.supersedes_answer_id } } } as OwnerMutationRequest) as OwnerMutationRequest;
  }
  submit(id: string): Promise<boolean> {
    const flight = this.flights.get(id); if (flight) return flight;
    const entry = this.state.entries[id]; if (!entry || entry.receipt || this.state.preferenceUncertain) return Promise.resolve(false);
    this.entry(id, { saving: true, error: null });
    const next = this.send(id).finally(() => { this.flights.delete(id); this.entry(id, { saving: false }); });
    this.flights.set(id, next); return next;
  }
  private async send(id: string): Promise<boolean> {
    try {
      const entry = this.state.entries[id]; if (!entry) return false;
      let request = this.pendingInputs.get(id);
      if (!request) {
        const draft = structuredClone(entry.draft) as OwnerDraft;
        const snapshot = await this.service.query({ session: draft.session, request: { command: 'session_get', params: {} } });
        if (snapshot.freshness !== 'fresh') throw new ServiceFailure('transport');
        const blocked = blockedDraft(draft, snapshot.session);
        if (blocked) throw new CoreFailure({ code: 'question_changed', message: blocked, hint: 'Review this input before sending again.', retryable: false, field_errors: [] });
        draft.submission_attempted = true;
        if (!await this.save([{ kind: 'upsert_draft', draft }])) return false;
        this.entry(id, { draft: immutable(draft) });
        request = this.inputRequest(draft); this.pendingInputs.set(id, request);
      }
      const receipt: MutationReceipt = await this.service.executeOwner(request);
      if (!('session_id' in receipt) || receipt.operation_id !== id || receipt.session_id !== entry.draft.session.session_id
        || !Number.isSafeInteger(receipt.revision) || receipt.revision <= 0 || receipt.data.kind !== 'input_submit'
        || !receipt.data.input_id || !receipt.data.message_id || receipt.data.input_seq <= 0 || receipt.data.message_number <= 0) throw new ServiceFailure('invalid_response');
      this.pendingInputs.delete(id); this.entry(id, { receipt: immutable(receipt), uncertain: false, error: null,
        draft: immutable({ ...structuredClone(entry.draft), text: '', selected_option_id: null } as OwnerDraft) });
      // A failed cleanup leaves the durable draft recoverable. A validated input
      // receipt, never local button acceptance, authorizes its removal.
      await this.save([{ kind: 'delete_draft', operation_id: id }]); return true;
    } catch (error: unknown) {
      const reason = failure(error), uncertain = this.pendingInputs.has(id);
      this.entry(id, { uncertain, error: reason, rejected: uncertain && definitiveRejection(reason) }); return false;
    }
  }
}
export function useOwnerDrafts(store: OwnerDraftStore): DraftState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
