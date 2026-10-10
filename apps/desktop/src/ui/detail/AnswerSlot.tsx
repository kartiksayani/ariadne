// The detail panel's "Your answer": the shared Answer Control in its full
// variant (ui/answer/AnswerControl.tsx), sent through `useSubmit` so the tree,
// the Waiting cards and the detail all answer the same way. The slot adds the
// keyboard focus requests and the saved-input states of the draft store.
import { useEffect, useRef, useState } from 'react';
import { useSession, type SessionStore } from '../../data/session-store';
import { plainFailure } from '../../data/plain';
import { useOwnerDrafts, type DraftEntry, type DraftState, type OwnerDraftStore } from '../../state/drafts/store';
import { AnswerControl, defaultSelection } from '../answer/AnswerControl';
import { useSubmit, type OwnerFocusRequest, type PendingSubmission } from '../answer/useSubmit';

/** The handoff's wording for a saved draft written against an older item revision or binding. */
export const changedText ='This item changed. Review the current question and options; your text is retained.';
const loadingError = "Ariadne is still loading this session's latest changes. Try again.";

/** The failure this slot displays, including its loading and saved-input views. */
export function answerSlotError(state: DraftState, entry: DraftEntry | undefined): string | null {
  const error = state.ready && entry && entry.receipt?.data.kind !== 'input_submit' ? entry.error ?? state.error : state.error;
  return error ? plainFailure(error) : null;
}

export interface AnswerSlotProps {
  readonly drafts: OwnerDraftStore;
  readonly store: SessionStore;
  readonly itemId: string;
  /** Why the detail model blocks answering (closed session, reconnecting), if it does. */
  readonly blocked?: string | null;
  readonly focusRequest?: OwnerFocusRequest;
  readonly onFocusRequestConsumed?: (token: number) => void;
  /** Esc in the control: leave it and return focus to the workspace. */
  readonly onEscape: () => void;
  /** Send while the agent isn't running: the "Agent isn't running" dialog (1ad). */
  readonly onAgentNotRunning?: (submission: PendingSubmission) => void;
  /** The core accepted a message sent from here. */
  readonly onSent?: () => void;
  /** False when another box (the follow-up) is the detail's owner input: the slot then carries no data-owner-input. */
  readonly marked?: boolean;
}

export function AnswerSlot({ drafts, store, itemId, blocked, focusRequest, onFocusRequestConsumed, onEscape, onAgentNotRunning, onSent, marked = true }: AnswerSlotProps) {
  const mark = marked ? itemId : undefined;
  const root = useRef<HTMLDivElement>(null), handled = useRef<number | null>(null);
  const [shortcutStatus, setShortcutStatus] = useState<string | null>(null);
  const state = useOwnerDrafts(drafts), current = useSession(store), session = current.snapshot?.session;
  const item = session?.items[itemId];
  const live = current.status === 'ready' && !current.error;
  const presence = session?.active_binding_id ? current.presence[session.active_binding_id] ?? null : null;
  const submit = useSubmit({ drafts, session, current: live, itemId, intent: 'answer', onAgentNotRunning, onSaved: onSent, presence });
  const { entry } = submit;
  const error = answerSlotError(state, entry);
  useEffect(() => { setShortcutStatus(null); }, [itemId, store]);
  useEffect(() => {
    if (state.ready && live && session) setShortcutStatus(status => status === loadingError ? null : status);
  }, [state.ready, live, current.snapshot, session]);
  // Keyboard requests (a, 1–9) arrive as focus requests; a number is a deliberate choice.
  useEffect(() => {
    if (!focusRequest || focusRequest.intent !== 'answer' || handled.current === focusRequest.token || !entry) return;
    handled.current = focusRequest.token;
    onFocusRequestConsumed?.(focusRequest.token);
    setShortcutStatus(null);
    if (focusRequest.sendOption) {
      const target = focusRequest.answerTarget, choice = item?.options[focusRequest.optionIndex ?? -1];
      const sameTarget = target && item?.revision === target.revision && item.question_revision === target.questionRevision
        && session?.active_binding_id === target.bindingId && choice?.id === target.optionId;
      const latest = store.getSnapshot();
      if (!live || latest.status !== 'ready' || latest.error || latest.snapshot?.session !== session) {
        setShortcutStatus(loadingError);
      } else if (!sameTarget || submit.changed) setShortcutStatus('This item changed. Review it before sending. Your note is kept.');
      else if (blocked || submit.blocked) setShortcutStatus(submit.blocked ?? blocked ?? null);
      else if (entry.receipt) setShortcutStatus('This reply has already been sent.');
      else if (submit.locked) setShortcutStatus('This reply is being saved or needs a retry. Your note is kept.');
      else if (choice) submit.sendOption(choice.id);
      return;
    }
    if (focusRequest.ownWords) {
      root.current?.querySelector<HTMLTextAreaElement>('textarea:not(:disabled)')?.focus();
      return;
    }
    const choices = root.current?.querySelector('details');
    if (choices) choices.open = true;
    const buttons = root.current?.querySelectorAll<HTMLButtonElement>('[data-answer-option]');
    if (focusRequest.optionIndex !== undefined) {
      const choice = item?.options[focusRequest.optionIndex], button = buttons?.[focusRequest.optionIndex];
      if (choice && button && !button.disabled && button.getAttribute('aria-disabled') !== 'true') { drafts.edit(entry.draft.op_id, { selected_option_id: choice.id }); button.focus(); }
      return;
    }
    if (entry.saving || entry.uncertain || entry.receipt || state.preferenceUncertain) return;
    root.current?.querySelector<HTMLElement>('[data-answer-option]:not(:disabled):not([aria-disabled="true"]),textarea:not(:disabled)')?.focus();
  }, [focusRequest, entry, item, drafts, state.preferenceUncertain, onFocusRequestConsumed, live, blocked, submit, session, store]);
  if (!item) return null;
  // data-owner-input marks every owner input of the detail (this slot and the action box) for native tests.
  if (!state.ready || !entry) return <div className="detail-answer-slot" data-owner-input={mark} role="status">Loading saved drafts…{error && <p role="alert">{error}</p>}</div>;
  const preferences = state.preferenceUncertain && <button type="button" className="btn btn-secondary" onClick={submit.retryPreferences}>Try saving your draft again</button>;
  // Saved: the input is queued; the stepper above follows it once the session shows it.
  if (entry.receipt?.data.kind === 'input_submit') return <div className="detail-answer-slot" data-owner-input={mark}>
    <p role="status">Saved · Queue position #{entry.receipt.data.input_seq}</p>
    {shortcutStatus && <p role="alert">{shortcutStatus}</p>}
    <div className="detail-actions"><button type="button" className="btn btn-secondary" disabled={state.preferenceUncertain || entry.saving || !live} onClick={submit.another}>Write another input</button></div>
    {error && <p className="detail-error" role="alert">{error}</p>}
    {preferences}
  </div>;
  const draft = entry.draft, options = item.options;
  // The frozen choice of an attempted answer, else the draft's or the recommended one.
  const selected = entry.uncertain ? options.findIndex(option => option.id === draft.selected_option_id) : defaultSelection(options, draft.selected_option_id);
  const review = { label: 'Review current target', onAction: () => { setShortcutStatus(null); submit.review(); } };
  return <div ref={root} className="detail-answer-slot" data-owner-input={mark}>
    {shortcutStatus && <p role="alert">{shortcutStatus}</p>}
    <AnswerControl variant="chat" options={options} selected={selected} draft={draft.text} label="Answer"
      locked={submit.locked || submit.changed} frozen={!live}
      warn={submit.changed && !entry.uncertain ? changedText : undefined} warnAction={submit.changed && !entry.uncertain ? review : undefined}
      blocked={entry.uncertain || submit.changed ? undefined : submit.blocked ?? blocked ?? undefined}
      onSelect={index => { const option = options[index]; if (option) submit.select(option.id); }}
      onDraft={submit.write} onSendOption={(index, note) => { const option = options[index]; if (option) submit.sendOption(option.id, note); }}
      onSendText={submit.sendText} onEscape={onEscape} />
    {entry.uncertain && <div className="detail-answer-retry">
      <p role="status">{entry.rejected ? 'This reply was rejected before it was saved.' : 'Ariadne isn’t sure this reply was saved.'} Retry it to confirm; your text is kept.</p>
      <div className="detail-actions">
        <button type="button" className="btn btn-secondary" disabled={entry.saving || state.preferenceUncertain} onClick={() => { void submit.retry(); }}>Try sending again</button>
        {entry.rejected && <button type="button" className="btn btn-secondary" disabled={entry.saving || state.preferenceUncertain} onClick={submit.prepareRevised}>Edit and send again</button>}
      </div>
    </div>}
    {error && <p className="detail-error" role="alert">{error}</p>}
    {preferences}
  </div>;
}
