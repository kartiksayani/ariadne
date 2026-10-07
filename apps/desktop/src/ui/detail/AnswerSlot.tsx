// The detail panel's "Your answer": the shared Answer Control in its full
// variant (ui/answer/AnswerControl.tsx), sent through `useSubmit` so the tree,
// the Waiting cards and the detail all answer the same way. The slot adds the
// keyboard focus requests and the saved-input states of the draft store.
import { useEffect, useRef } from 'react';
import { useSession, type SessionStore } from '../../data/session-store';
import { useOwnerDrafts, type OwnerDraftStore } from '../../state/drafts/store';
import { AnswerControl, defaultSelection } from '../answer/AnswerControl';
import { useSubmit, type OwnerFocusRequest, type PendingSubmission } from '../answer/useSubmit';

const changedText = 'This item changed. Review the current question and options; your text is retained.';

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
}

export function AnswerSlot({ drafts, store, itemId, blocked, focusRequest, onFocusRequestConsumed, onEscape, onAgentNotRunning }: AnswerSlotProps) {
  const root = useRef<HTMLDivElement>(null), handled = useRef<number | null>(null);
  const state = useOwnerDrafts(drafts), current = useSession(store), session = current.snapshot?.session;
  const item = session?.items[itemId];
  const live = current.status === 'ready' && !current.error;
  const submit = useSubmit({ drafts, session, current: live, itemId, intent: 'answer', onAgentNotRunning });
  const { entry } = submit;
  // Keyboard requests (a, 1–9) arrive as focus requests; a number is a deliberate choice.
  useEffect(() => {
    if (!focusRequest || focusRequest.intent !== 'answer' || handled.current === focusRequest.token || !entry) return;
    handled.current = focusRequest.token;
    onFocusRequestConsumed?.(focusRequest.token);
    const buttons = root.current?.querySelectorAll<HTMLButtonElement>('[data-answer-option]');
    if (focusRequest.optionIndex !== undefined) {
      const choice = item?.options[focusRequest.optionIndex], button = buttons?.[focusRequest.optionIndex];
      if (choice && button && !button.disabled) { drafts.edit(entry.draft.op_id, { selected_option_id: choice.id }); button.focus(); }
      return;
    }
    if (entry.saving || entry.uncertain || entry.receipt || state.preferenceUncertain) return;
    root.current?.querySelector<HTMLElement>('[data-answer-option]:not(:disabled),textarea:not(:disabled)')?.focus();
  }, [focusRequest, entry, item, drafts, state.preferenceUncertain, onFocusRequestConsumed]);
  if (!item) return null;
  if (!state.ready || !entry) return <div className="detail-answer-slot" role="status">Loading saved drafts…{state.error && <p role="alert">{state.error.message}</p>}</div>;
  const preferences = state.preferenceUncertain && <button type="button" className="btn btn-secondary" onClick={submit.retryPreferences}>Retry saving draft preferences</button>;
  // Saved: the input is queued; the stepper above follows it once the session shows it.
  if (entry.receipt?.data.kind === 'input_submit') return <div className="detail-answer-slot">
    <p role="status">Saved · Queue position #{entry.receipt.data.input_seq}</p>
    <div className="detail-actions"><button type="button" className="btn btn-secondary" disabled={state.preferenceUncertain || entry.saving || !live} onClick={submit.another}>Write another input</button></div>
    {state.error && <p className="detail-error" role="alert">{state.error.message}</p>}
    {preferences}
  </div>;
  const draft = entry.draft, options = item.options;
  // The frozen choice of an attempted answer, else the draft's or the recommended one.
  const selected = entry.uncertain ? options.findIndex(option => option.id === draft.selected_option_id) : defaultSelection(options, draft.selected_option_id);
  const review = { label: 'Review current target', onAction: submit.review };
  return <div ref={root} className="detail-answer-slot">
    <AnswerControl variant="full" options={options} selected={selected} draft={draft.text} label="Answer"
      locked={submit.locked || submit.changed || !live}
      warn={submit.changed && !entry.uncertain ? changedText : undefined} warnAction={submit.changed && !entry.uncertain ? review : undefined}
      blocked={entry.uncertain || submit.changed ? undefined : submit.blocked ?? blocked ?? undefined}
      onSelect={index => { const option = options[index]; if (option) submit.select(option.id); }}
      onDraft={submit.write} onSendOption={index => { const option = options[index]; if (option) submit.sendOption(option.id); }}
      onSendText={submit.sendText} onEscape={onEscape} />
    {entry.uncertain && <div className="detail-answer-retry">
      <p role="status">{entry.rejected ? 'This input was rejected before save.' : 'Save completion is unknown.'} Retry the same saved input to confirm it; its operation and contents are retained.</p>
      <div className="detail-actions">
        <button type="button" className="btn btn-secondary" disabled={entry.saving || state.preferenceUncertain} onClick={() => { void submit.retry(); }}>Retry saved input</button>
        {entry.rejected && <button type="button" className="btn btn-secondary" disabled={entry.saving || state.preferenceUncertain} onClick={submit.prepareRevised}>Prepare revised input</button>}
      </div>
    </div>}
    {submit.error && <p className="detail-error" role="alert">{submit.error}</p>}
    {preferences}
  </div>;
}
