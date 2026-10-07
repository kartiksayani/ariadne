// The detail panel's owner input: the full answer control for a waiting item,
// a message box for the other intents, and the saved/uncertain states of the
// draft store. Interim home until the detail redesign (P8.3 WP3) splits the
// actions by status; the submission logic stays in `useSubmit`.
import { useEffect, useRef, useState } from 'react';
import { useSession, type SessionStore } from '../../data/session-store';
import { useOwnerDrafts, ownerActions, type OwnerDraftStore, type OwnerIntent } from '../../state/drafts/store';
import { useWorkspaceKeys } from '../keys';
import { AnswerControl, defaultSelection } from './AnswerControl';
import { useSubmit, type PendingSubmission } from './useSubmit';
import './answer.css';

const labels: Record<OwnerIntent, string> = { answer: 'Answer', bring: 'Bring up', reply: 'Reply', note: 'Note', followup: 'Follow up', drop: 'Drop', reopen: 'Reopen' };
const changedText = 'This item changed. Review the current question and options; your text is retained.';

/** A keyboard request to open the input for an intent, optionally choosing option `optionIndex`. */
export interface OwnerFocusRequest { intent: OwnerIntent; token: number; optionIndex?: number }

export interface ComposerProps {
  readonly drafts: OwnerDraftStore;
  readonly session: SessionStore;
  readonly itemId: string;
  readonly initialIntent?: OwnerIntent;
  readonly focusRequest?: OwnerFocusRequest;
  readonly onFocusRequestConsumed?: (token: number) => void;
  readonly later?: boolean;
  readonly onLater?: (value: boolean) => Promise<boolean>;
  readonly onEscape?: () => void;
  readonly onAgentNotRunning?: (submission: PendingSubmission) => void;
}

export function Composer({ drafts, session: store, itemId, initialIntent = 'answer', later = false, onLater, onEscape, focusRequest, onFocusRequestConsumed, onAgentNotRunning }: ComposerProps) {
  const editor = useRef<HTMLDivElement>(null), focusedRequest = useRef<number | null>(null);
  const state = useOwnerDrafts(drafts), current = useSession(store), session = current.snapshot?.session;
  const item = session?.items[itemId];
  const [intent, setIntent] = useState<OwnerIntent>(initialIntent), [laterError, setLaterError] = useState(false);
  const actions = item ? ownerActions(item) : [];
  const preferred = session ? drafts.find({ project_id: session.project_id, session_id: session.id }, itemId, intent) : undefined;
  // Mutable item eligibility controls new input forms. It must not hide an
  // attempted operation whose frozen request still needs explicit replay.
  const activeIntent = preferred?.saving || preferred?.uncertain || actions.includes(intent) ? intent : item && ['done', 'decided', 'dropped', 'replaced'].includes(item.status) ? 'followup' : 'reply';
  const submit = useSubmit({ drafts, session, current: current.status === 'ready' && !current.error, itemId, intent: activeIntent, onAgentNotRunning });
  const { entry } = submit;
  useEffect(() => {
    if (!focusRequest || focusedRequest.current === focusRequest.token || !entry || activeIntent !== focusRequest.intent) return;
    const consume = () => { focusedRequest.current = focusRequest.token; onFocusRequestConsumed?.(focusRequest.token); };
    // A number is a deliberate choice now, never a deferred edit after review
    // or reconciliation. Use exactly the rendered choice's enabled state.
    if (focusRequest.optionIndex !== undefined) {
      consume();
      const choice = item?.options[focusRequest.optionIndex];
      const button = editor.current?.querySelectorAll<HTMLButtonElement>('[data-answer-option]')[focusRequest.optionIndex];
      if (focusRequest.intent === 'answer' && choice && button && !button.disabled) {
        drafts.edit(entry.draft.op_id, { selected_option_id: choice.id }); button.focus();
      }
      return;
    }
    if (entry.saving || entry.uncertain || entry.receipt || state.preferenceUncertain) { consume(); return; }
    const control = focusRequest.intent === 'answer' ? editor.current?.querySelector<HTMLElement>('[data-answer-option]:not(:disabled),textarea:not(:disabled)')
      : editor.current?.querySelector<HTMLElement>('textarea:not(:disabled)');
    consume();
    control?.focus();
  }, [focusRequest, entry, state.preferenceUncertain, activeIntent, item, drafts, onFocusRequestConsumed]);
  // The message box's share of the keymap; the answer control handles its own.
  const key = useWorkspaceKeys<HTMLDivElement>({
    escape: (_intent, event) => { event.stopPropagation(); onEscape?.(); return false; },
    send: (_intent, event) => {
      if (!event.currentTarget.contains(document.activeElement)) return false;
      event.stopPropagation(); submit.send(); return true;
    },
  }, { scope: 'editor' });
  if (!session || !item) return <p role="status">The current item is unavailable. Refresh its registered session.</p>;
  if (!state.ready || !entry) return <div role="status">Loading saved drafts…{state.error && <p role="alert">{state.error.message}</p>}</div>;
  const retained = Object.values(state.entries).filter(value => value.uncertain && !value.receipt && value.draft.intent !== activeIntent
    && value.draft.session.project_id === session.project_id && value.draft.session.session_id === session.id && value.draft.target.item_id === itemId);
  const retainedControls = retained.map(value => <button type="button" className="btn btn-secondary" key={value.draft.op_id}
    onClick={() => setIntent(value.draft.intent as OwnerIntent)}>Review saved {labels[value.draft.intent as OwnerIntent].toLowerCase()} input</button>);
  const preferences = state.preferenceUncertain && <button type="button" className="btn btn-secondary" onClick={submit.retryPreferences}>Retry saving draft preferences</button>;
  if (entry.receipt?.data.kind === 'input_submit') return <div className="owner-input composer" aria-label={`Owner input for #${item.id}`}>{retainedControls}
    <p role="status">Saved · Queue position #{entry.receipt.data.input_seq}</p>
    <div><button type="button" className="btn btn-secondary" disabled={state.preferenceUncertain || entry.saving || current.status !== 'ready'} onClick={submit.another}>Write another input</button></div>
    {state.error && <p className="composer-error" role="alert">{state.error.message}</p>}
    {preferences}</div>;
  const draft = entry.draft;
  const changeLater = async () => { try { setLaterError(!await onLater?.(!later)); } catch { setLaterError(true); } };
  const review = { label: 'Review current target', onAction: submit.review };
  // The frozen choice of an attempted answer, else the draft's or the recommended one.
  const selected = entry.uncertain ? item.options.findIndex(option => option.id === draft.selected_option_id) : defaultSelection(item.options, draft.selected_option_id);
  return <div ref={editor} className="owner-input composer" onKeyDown={key} aria-label={`Owner input for #${item.id}`}>
    {retainedControls}
    <div className="composer-actions" role="group" aria-label="Owner actions">
      {actions.map(action => <button type="button" key={action} className="btn btn-secondary" aria-pressed={activeIntent === action}
        disabled={submit.locked} onClick={() => setIntent(action)}>{labels[action]}</button>)}
      {onLater && <button type="button" className="btn btn-secondary" aria-pressed={later} disabled={submit.locked || current.status !== 'ready'} onClick={() => { void changeLater(); }}>Later</button>}
    </div>
    {activeIntent === 'answer' ? <AnswerControl variant="full" options={item.options} selected={selected} draft={draft.text} label="Answer"
      locked={submit.locked || submit.changed || current.status !== 'ready' || !!current.error}
      warn={submit.changed && !entry.uncertain ? changedText : undefined} warnAction={submit.changed && !entry.uncertain ? review : undefined}
      blocked={entry.uncertain || submit.changed ? undefined : submit.blocked ?? undefined}
      onSelect={index => { const option = item.options[index]; if (option) submit.select(option.id); }}
      onDraft={submit.write} onSendOption={index => { const option = item.options[index]; if (option) submit.sendOption(option.id); }}
      onSendText={submit.sendText} onEscape={onEscape} />
      : <>
        {submit.changed && !entry.uncertain && <div className="answer-warn" role="alert"><i className="ph ph-warning" aria-hidden="true" /><span>{changedText}</span>
          <button type="button" className="btn btn-secondary answer-warn-action" disabled={submit.locked} onClick={submit.review}>{review.label}</button></div>}
        <textarea className="input answer-text" aria-label={`${labels[activeIntent]} message`} rows={3} value={draft.text} disabled={submit.locked}
          onChange={event => submit.write(event.target.value)} />
        <div className="answer-send-row">
          <button type="button" className="btn btn-primary answer-send" disabled={submit.locked || !!submit.blocked || submit.changed || !draft.text.trim()} onClick={submit.send}>
            <i className="ph ph-paper-plane-right" aria-hidden="true" /><span className="answer-send-label">Send {labels[activeIntent].toLowerCase()}</span></button>
          <span className="answer-hint">⌘↵ sends · Esc keeps your draft</span>
        </div>
        {submit.blocked && !submit.changed && !entry.uncertain && <div className="answer-blocked" role="status"><i className="ph ph-wifi-slash" aria-hidden="true" /><span>{submit.blocked}</span></div>}
      </>}
    {entry.uncertain && <>
      <p role="status">{entry.rejected ? 'This input was rejected before save.' : 'Save completion is unknown.'} Retry the same saved input to confirm it; its operation and contents are retained.</p>
      <div className="composer-actions">
        <button type="button" className="btn btn-secondary" disabled={entry.saving || state.preferenceUncertain} onClick={() => { void submit.retry(); }}>Retry saved input</button>
        {entry.rejected && <button type="button" className="btn btn-secondary" disabled={entry.saving || state.preferenceUncertain} onClick={submit.prepareRevised}>Prepare revised input</button>}
      </div>
    </>}
    {submit.error && <p className="composer-error" role="alert">{submit.error}</p>}
    {preferences}
    {laterError && <p role="alert">Later was not saved. Keep the current view and try again.</p>}
  </div>;
}
