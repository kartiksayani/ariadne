// One question's answer, wherever it shows: the dock, Details, the peek and other sessions. The answer cards
// (ui/answer/AnswerControl.tsx), sent through `useSubmit`, so every place answers the same way and shares one draft and
// one send lock. After Send the same cards stay, sealed, with the delivery bar (ui/answer/QuestionDelivery.tsx).
import { useEffect, useRef, useState } from 'react';
import { useSession, type SessionStore } from '../../data/session-store';
import { plainFailure } from '../../data/plain';
import { receiptWithdrawn, useOwnerDrafts, type DraftEntry, type DraftState, type OwnerDraftStore } from '../../state/drafts/store';
import { AnswerControl, defaultSelection, type AnswerBar } from '../answer/AnswerControl';
import { useSubmit, type OwnerFocusRequest, type PendingSubmission } from '../answer/useSubmit';
import { ownerReplied } from '../../selectors/waiting/replied';
import { answerStanding, useQuestionDelivery } from '../answer/QuestionDelivery';
import { sessionEnded, sessionAnswerBlocked } from '../../selectors/sessionClosed';
import { copyText } from '../shared/clipboard';
import { waitingAge } from '../dock/model';

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
  /** Where the cards sit: the dock (3 columns), Details (one column), Details' bigger view, the peek, or the other-sessions list. */
  readonly layout?: 'dock' | 'details' | 'wide' | 'compact' | 'list';
  /** The idle bar text in place of the default hint. */
  readonly hint?: string;
  /** "? Waiting on you … Waiting 34 min" above the cards (Details, peek). */
  readonly head?: boolean;
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

const barButton = (label: string, icon: string, onClick: () => void, options: { primary?: boolean; disabled?: boolean; title?: string } = {}) =>
  <button type="button" key={label} className="answer-bar-button" data-primary={options.primary || undefined} disabled={options.disabled} title={options.title}
    onClick={event => { event.stopPropagation(); onClick(); }}><i className={icon} aria-hidden="true" />{label}</button>;

export function AnswerSlot({ drafts, store, itemId, layout = 'details', hint, head = false, blocked, focusRequest, onFocusRequestConsumed, onEscape, onAgentNotRunning, onSent, marked = true }: AnswerSlotProps) {
  const mark = marked ? itemId : undefined;
  const root = useRef<HTMLDivElement>(null), handled = useRef<number | null>(null);
  const [shortcutStatus, setShortcutStatus] = useState<string | null>(null);
  const state = useOwnerDrafts(drafts), current = useSession(store), session = current.snapshot?.session;
  const item = session?.items[itemId];
  const ended = !!session && sessionEnded(session);
  const live = current.status === 'ready' && !current.error;
  const presence = session?.active_binding_id ? current.presence[session.active_binding_id] ?? null : null;
  const submit = useSubmit({ drafts, session, current: live, itemId, intent: 'answer', onAgentNotRunning, onSaved: onSent, presence });
  const delivery = useQuestionDelivery({ drafts, store, itemId });
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
      const own = root.current?.querySelector<HTMLButtonElement>('[data-answer-own]:not(:disabled)');
      if (own && live) own.click();
      else root.current?.querySelector<HTMLTextAreaElement>('textarea:not(:disabled)')?.focus();
      return;
    }
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
  const preferences = state.preferenceUncertain && <div className="answer-preferences">
    <p>Saving your draft could not be confirmed. Sending waits until it is.</p>
    <button type="button" className="btn btn-secondary" onClick={submit.retryPreferences}>Try saving your draft again</button></div>;
  const options = item.options, draft = entry.draft;
  const heading = head && item.status === 'waiting_on_me' && <div className="answer-head">
    <i className="ph-fill ph-question" aria-hidden="true" /><span className="answer-head-title">Waiting on you</span>
    {item.waiting_since && <span className="answer-head-age">Waiting {waitingAge(Date.parse(item.waiting_since), Date.now())}</span>}</div>;
  // Sent: the same cards stay, sealed, with the delivery bar. An answer already on its way locks every place.
  // The owner's own unknown or failed send is reconciled here first, even when another input (a note) left the queue.
  const recovering = !entry.receipt && (entry.uncertain || !!entry.error && !entry.saving && !answerStanding(session, itemId));
  // A cancelled or skipped answer's receipt no longer stands: the cards open at once, before `another` swaps the draft.
  const delivered = !recovering && (entry.receipt?.data.kind === 'input_submit' && !(session && receiptWithdrawn(entry, session)) || entry.saving && !entry.uncertain
    || !!session && (ownerReplied(session, item) || answerStanding(session, itemId)));
  if (delivered && delivery.bar) {
    const content = delivery.content;
    return <div ref={root} className="detail-answer-slot" data-owner-input={mark}>
      {heading}
      <AnswerControl layout={layout} options={options} label="Answer" selected={defaultSelection(options, content?.selected_option_id)} draft={content?.text ?? ''}
        bar={delivery.bar} onSelect={() => {}} onDraft={() => {}} onSendOption={() => {}} onSendText={() => {}} onEscape={onEscape} />
      {delivery.extra}
      {ended && <p role="status">{sessionAnswerBlocked(session!)}</p>}
      {shortcutStatus && <p role="alert">{shortcutStatus}</p>}
      {preferences}
    </div>;
  }
  // An attempted answer keeps its choice; recommendations never choose for the owner.
  const selected = defaultSelection(options, draft.selected_option_id);
  const review = { label: 'Review this question', onAction: () => { setShortcutStatus(null); submit.review(); } };
  const words = [options[selected]?.label, draft.text].filter(Boolean).join('\n\n');
  const copy = barButton('Copy', 'ph ph-copy', () => { void copyText(words).catch(() => {}); }, { title: 'Copy your answer' });
  const busy = entry.saving || state.preferenceUncertain;
  const bar: AnswerBar | null = entry.uncertain && !entry.rejected
    ? { icon: 'ph-fill ph-question', tone: 'accent', text: 'Ariadne isn’t sure this was sent. Check before sending again; your words are kept.', narrow: 'Not sure it was sent. Words kept.',
      actions: <>{copy}{barButton('Check delivery', 'ph ph-arrows-clockwise', () => { void submit.retry(); }, { primary: true, disabled: busy })}</> }
    : entry.uncertain
      ? { icon: 'ph ph-warning-circle', tone: 'danger', text: 'Not sent. Your words are kept.',
        actions: <>{copy}{barButton('Edit and send again', 'ph ph-pencil-simple', submit.prepareRevised, { disabled: ended || busy })}
          {barButton('Try sending again', 'ph ph-arrow-clockwise', () => { void submit.retry(); }, { primary: true, disabled: ended || busy, title: 'Send the same answer again, once' })}</> }
      : entry.error
        ? { icon: 'ph ph-warning-circle', tone: 'danger', text: 'Not sent. Your words are kept.',
          actions: <>{copy}{barButton('Retry', 'ph ph-arrow-clockwise', () => { void submit.retry(); }, { primary: true, disabled: busy || !!submit.blocked || submit.changed, title: 'Send again ( ↵ )' })}</> }
        : null;
  return <div ref={root} className="detail-answer-slot" data-owner-input={mark}>
    {heading}
    {shortcutStatus && <p role="alert">{shortcutStatus}</p>}
    <AnswerControl layout={layout} options={options} selected={selected} draft={draft.text} label="Answer" hint={hint} bar={bar}
      locked={submit.locked || submit.changed || ended} frozen={!live}
      warn={submit.changed && !entry.uncertain ? changedText : undefined} warnAction={submit.changed && !entry.uncertain ? review : undefined}
      blocked={ended ? sessionAnswerBlocked(session!) : entry.uncertain || submit.changed ? undefined : submit.blocked ?? blocked ?? undefined}
      onSelect={index => { const option = options[index]; if (index === -1) submit.select(null); else if (option) submit.select(option.id); }}
      onDraft={submit.write} onSendOption={(index, note) => { const option = options[index]; if (option) submit.sendOption(option.id, note); }}
      onSendText={submit.sendText} onEscape={onEscape} />
    {/* The one alert: why it failed, under the bar that offers the way on. */}
    {error && <p className="detail-error" role="alert">{error}</p>}
    {preferences}
  </div>;
}
