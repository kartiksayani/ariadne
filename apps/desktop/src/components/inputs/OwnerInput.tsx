import { useEffect, useRef, useState } from 'react';
import { useSession, type SessionStore } from '../../data/session-store';
import { OwnerDraftStore, blockedDraft, ownerActions, useOwnerDrafts, type OwnerIntent } from '../../state/drafts/store';
import { useWorkspaceKeys } from '../../ui/keys';
import '../../styles/reference.css';
import './inputs.css';

const labels: Record<OwnerIntent, string> = { answer: 'Answer', bring: 'Bring up', reply: 'Reply', note: 'Note', followup: 'Follow up', drop: 'Drop', reopen: 'Reopen' };

export interface OwnerFocusRequest { intent: OwnerIntent; token: number; optionIndex?: number }

// This module consumes the composition-owned current session and draft store;
// Waiting/detail can share it without creating another persistence boundary.
export function OwnerInput({ drafts, session: store, itemId, initialIntent = 'answer', later = false, onLater, onEscape, focusRequest, onFocusRequestConsumed }: {
  drafts: OwnerDraftStore; session: SessionStore; itemId: string; initialIntent?: OwnerIntent;
  focusRequest?: OwnerFocusRequest; onFocusRequestConsumed?: (token: number) => void;
  later?: boolean; onLater?: (value: boolean) => Promise<boolean>; onEscape?: () => void;
}) {
  const editor = useRef<HTMLDivElement>(null), focusedRequest = useRef<number | null>(null);
  const state = useOwnerDrafts(drafts), current = useSession(store), session = current.snapshot?.session;
  const item = session?.items[itemId];
  const [intent, setIntent] = useState<OwnerIntent>(initialIntent), [laterError, setLaterError] = useState(false);
  const actions = item ? ownerActions(item) : [];
  const preferred = session ? drafts.find({ project_id: session.project_id, session_id: session.id }, itemId, intent) : undefined;
  // Mutable item eligibility controls new input forms. It must not hide an
  // attempted operation whose frozen request still needs explicit replay.
  const activeIntent = preferred?.saving || preferred?.uncertain || actions.includes(intent) ? intent : item && ['done', 'decided', 'dropped', 'replaced'].includes(item.status) ? 'followup' : 'reply';
  const entry = session ? drafts.find({ project_id: session.project_id, session_id: session.id }, itemId, activeIntent) : undefined;
  useEffect(() => { void drafts.load(); }, [drafts]);
  useEffect(() => {
    if (session && item && state.ready && !entry) drafts.begin(session, itemId, activeIntent);
  }, [drafts, session, item, itemId, activeIntent, state.ready, entry]);
  useEffect(() => {
    if (!focusRequest || focusedRequest.current === focusRequest.token || !entry || activeIntent !== focusRequest.intent) return;
    const consume = () => { focusedRequest.current = focusRequest.token; onFocusRequestConsumed?.(focusRequest.token); };
    // A number is a deliberate choice now, never a deferred edit after review
    // or reconciliation. Use exactly the rendered choice's enabled state.
    if (focusRequest.optionIndex !== undefined) {
      consume();
      const choice = item?.options[focusRequest.optionIndex];
      const button = editor.current?.querySelectorAll<HTMLButtonElement>('.owner-options button')[focusRequest.optionIndex];
      if (focusRequest.intent === 'answer' && choice && button && !button.disabled) {
        drafts.edit(entry.draft.op_id, { selected_option_id: choice.id }); button.focus();
      }
      return;
    }
    if (entry.saving || entry.uncertain || entry.receipt || state.preferenceUncertain) { consume(); return; }
    const control = focusRequest.intent === 'answer' ? editor.current?.querySelector<HTMLElement>('.owner-options button:not(:disabled),textarea:not(:disabled)')
      : editor.current?.querySelector<HTMLElement>('textarea:not(:disabled)');
    consume();
    control?.focus();
  }, [focusRequest, entry, state.preferenceUncertain, activeIntent, item, drafts, onFocusRequestConsumed]);
  // The answer box's share of the workspace keymap. The form below fills in
  // what ⌘↵ and 1–9 act on; Esc closes the box before detail closes.
  const form = useRef<{ readonly submit: () => void; readonly choose: (index: number) => boolean } | null>(null);
  const key = useWorkspaceKeys<HTMLDivElement>({
    escape: (_intent, event) => { event.stopPropagation(); onEscape?.(); return false; },
    send: (_intent, event) => {
      if (!event.currentTarget.contains(document.activeElement)) return false;
      event.stopPropagation(); form.current?.submit(); return true;
    },
    choose: (intent, event) => {
      if (intent.kind !== 'choose' || !form.current?.choose(intent.index)) return false;
      event.stopPropagation(); return true;
    },
  }, { scope: 'editor' });
  if (!session || !item) return <p role="status">The current item is unavailable. Refresh its registered session.</p>;
  if (!state.ready || !entry) return <div role="status">Loading saved drafts…{state.error && <p role="alert">{state.error.message}</p>}</div>;
  const retained = Object.values(state.entries).filter(value => value.uncertain && !value.receipt && value.draft.intent !== activeIntent
    && value.draft.session.project_id === session.project_id && value.draft.session.session_id === session.id && value.draft.target.item_id === itemId);
  const retainedControls = retained.map(value => <button type="button" className="ref-button ref-secondary" key={value.draft.op_id}
    onClick={() => setIntent(value.draft.intent as OwnerIntent)}>Review saved {labels[value.draft.intent as OwnerIntent].toLowerCase()} input</button>);
  if (entry.receipt?.data.kind === 'input_submit') return <div className="ariadne-reference owner-input">{retainedControls}<p role="status">Saved · Queue position #{entry.receipt.data.input_seq}</p>
    <button type="button" className="ref-button ref-secondary" disabled={state.preferenceUncertain || entry.saving || current.status !== 'ready'} onClick={() => drafts.another(entry.draft.op_id, session)}>Write another input</button>
    {state.error && <p role="alert">{state.error.message}</p>}
    {state.preferenceUncertain && <button type="button" onClick={() => { void drafts.retryPreferences(); }}>Retry saving draft preferences</button>}</div>;
  const draft = entry.draft, option = item.options.find(option => option.id === draft.selected_option_id);
  const changed = item.revision !== draft.target_revision || item.question_revision !== draft.question_revision || session.active_binding_id !== draft.binding_id;
  const blocked = current.status !== 'ready' ? 'The session is unavailable or stale. Refresh before sending.' : blockedDraft(draft, session);
  const locked = entry.saving || entry.uncertain || state.preferenceUncertain;
  const optionsDisabled = locked || changed || current.status !== 'ready' || !!current.error;
  const submit = () => { if (!entry.saving && !state.preferenceUncertain && (!blocked || entry.uncertain)) void drafts.submit(draft.op_id); };
  form.current = { submit, choose: index => {
    const choice = item.options[index];
    if (locked || activeIntent !== 'answer' || optionsDisabled || !choice) return false;
    drafts.edit(draft.op_id, { selected_option_id: choice.id }); return true;
  } };
  const changeLater = async () => { try { setLaterError(!await onLater?.(!later)); } catch { setLaterError(true); } };
  return <div ref={editor} className="ariadne-reference owner-input ref-answer" onKeyDown={key} aria-label={`Owner input for #${item.id}`}>
    {retainedControls}
    <div className="owner-actions" role="group" aria-label="Owner actions">
      {actions.map(action => <button type="button" key={action} className="ref-button ref-secondary" aria-pressed={activeIntent === action}
        disabled={locked} onClick={() => setIntent(action)}>{labels[action]}</button>)}
      {onLater && <button type="button" className="ref-button ref-secondary" aria-pressed={later} disabled={locked || current.status !== 'ready'} onClick={() => { void changeLater(); }}>Later</button>}
    </div>
    {changed && <div className="ref-warning" role="alert"><span>This item changed. Review the current question and options; your text is retained.</span>
      <button type="button" className="ref-button ref-secondary" disabled={locked} onClick={() => drafts.review(draft.op_id, session)}>Review current target</button></div>}
    {activeIntent === 'answer' && <div className="ref-options owner-options">
      {item.options.map((choice, index) => <button type="button" className={`ref-button ref-option ${choice.recommended ? 'ref-primary' : 'ref-secondary'}`}
        key={choice.id} aria-pressed={draft.selected_option_id === choice.id} disabled={optionsDisabled}
        onClick={() => drafts.edit(draft.op_id, { selected_option_id: choice.id })}>
        <span className="ref-option-title"><span className="ref-keycap">{index + 1}</span>{choice.label}{draft.selected_option_id === choice.id && <span aria-label="Selected">✓</span>}</span>
        <span className="ref-consequence">{choice.recommended && <span className="ref-recommended">★ Recommended</span>}{choice.consequence}</span>
      </button>)}
    </div>}
    <label className="owner-editor-label">{activeIntent === 'answer' ? 'Reply in your own words' : `${labels[activeIntent]} message`}
      <textarea className="ref-input" rows={3} value={draft.text} disabled={locked} onChange={event => drafts.edit(draft.op_id, { text: event.target.value })} />
    </label>
    <div className="ref-send-row"><button type="button" className="ref-button ref-primary" disabled={entry.saving || state.preferenceUncertain || (!!blocked && !entry.uncertain)} onClick={submit}>
      {entry.saving ? 'Saving…' : entry.uncertain ? 'Retry saved input' : option ? `Send “${option.label}”` : `Send ${labels[activeIntent].toLowerCase()}`}
    </button><span className="ref-hint">⌘↵ sends · Esc keeps your draft</span></div>
    {blocked && <p className="ref-blocked">{blocked}</p>}
    {entry.uncertain && <p role="status">{entry.rejected ? 'This input was rejected before save.' : 'Save completion is unknown.'} Retry the same saved input to confirm it; its operation and contents are retained.</p>}
    {entry.rejected && <button type="button" className="ref-button ref-secondary" disabled={entry.saving || state.preferenceUncertain}
      onClick={() => drafts.prepareRevised(draft.op_id, session)}>Prepare revised input</button>}
    {(entry.error || state.error) && <p className="ref-warning" role="alert">{entry.error?.message ?? state.error?.message}</p>}
    {state.preferenceUncertain && <button type="button" className="ref-button ref-secondary" onClick={() => { void drafts.retryPreferences(); }}>Retry saving draft preferences</button>}
    {laterError && <p role="alert">Later was not saved. Keep the current view and try again.</p>}
  </div>;
}
