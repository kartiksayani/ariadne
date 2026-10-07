// The answer control (handoff "Answer Control.dc.html"): numbered options, the
// Send row and, in the full variant, a reply box. Waiting cards (compact), the
// tree's inline answer and the detail panel (full) all render this one control.
import { useRef } from 'react';
import { useWorkspaceKeys } from '../keys';
import './answer.css';

export interface AnswerOption {
  readonly id: string;
  readonly label: string;
  readonly consequence: string;
  readonly recommended: boolean;
}

/**
 * Props of the answer control. The control keeps no state: the caller owns the
 * selection and the draft (normally `useSubmit`, backed by the draft store).
 *
 * - `variant`: `compact` (Waiting card, tree row) or `full` (detail; adds the
 *   reply box and the "Send “label”" wording).
 * - `selected`: index of the selected option, or -1. Callers pass the draft's
 *   choice, else the recommended option (`defaultSelection`).
 * - `draft`: the reply text, shown in the full variant unless `noText`.
 * - `warn`: a warn-coloured line above the options, with an optional action.
 * - `blocked`: why sending is impossible now (closed, reconnecting, stale…).
 *   Selection still works; both Send buttons are disabled and the hint hides.
 * - `locked`: a send or save is in progress or must be reconciled first; the
 *   options, the reply box and both Send buttons are disabled.
 * - `onSendOption(index)` sends the option only; `onSendText(text)` sends the
 *   reply only. A reply never also sends the option.
 * - `onEscape`: Esc closes the control; the draft is kept by the caller.
 *
 * Keys (through `ui/keys.ts`, editor scope): 1–9 select and never send, Enter
 * sends the selected option, ⌘↵ in the reply box sends the reply, Esc closes.
 */
export interface AnswerControlProps {
  readonly options: readonly AnswerOption[];
  readonly variant: 'compact' | 'full';
  readonly selected: number;
  readonly draft: string;
  readonly warn?: string;
  readonly warnAction?: { readonly label: string; readonly onAction: () => void };
  readonly blocked?: string;
  readonly locked?: boolean;
  readonly noText?: boolean;
  /** Accessible name of the control's group. */
  readonly label?: string;
  readonly onSelect: (index: number) => void;
  readonly onDraft: (text: string) => void;
  readonly onSendOption: (index: number) => void;
  readonly onSendText: (text: string) => void;
  readonly onEscape?: () => void;
}

/** The option selected when the draft has no choice: the recommended one, else none. */
export function defaultSelection(options: readonly Pick<AnswerOption, 'id' | 'recommended'>[], chosen: string | null | undefined): number {
  const index = chosen ? options.findIndex(option => option.id === chosen) : -1;
  return index >= 0 ? index : options.findIndex(option => option.recommended);
}

export function AnswerControl({ options, variant, selected, draft, warn, warnAction, blocked, locked = false, noText = false, label,
  onSelect, onDraft, onSendOption, onSendText, onEscape }: AnswerControlProps) {
  const root = useRef<HTMLDivElement>(null);
  const full = variant === 'full', picked = options[selected];
  const canSend = !!picked && !blocked && !locked;
  const sendOption = (index: number) => { if (options[index] && !blocked && !locked) onSendOption(index); };
  const sendText = () => { if (draft.trim() && !blocked && !locked) onSendText(draft); };
  const optionIndex = (target: EventTarget) => target instanceof HTMLElement && root.current?.contains(target)
    ? Number(target.closest<HTMLElement>('[data-answer-option]')?.dataset.answerOption ?? -1) : -1;
  const keys = useWorkspaceKeys<HTMLDivElement>({
    choose: (intent, event) => {
      if (intent.kind !== 'choose' || !options[intent.index]) return false;
      event.stopPropagation();
      if (!locked) onSelect(intent.index);
      return true;
    },
    enter: (_intent, event) => {
      // Enter on an option sends that option; on the control itself, the
      // selected one. Other buttons (Send, Retry) keep their own Enter.
      const focused = optionIndex(event.target);
      if (focused < 0 && event.target !== event.currentTarget) return false;
      event.stopPropagation();
      const index = focused >= 0 ? focused : selected;
      if (focused >= 0 && focused !== selected && !locked) onSelect(focused);
      sendOption(index);
      return true;
    },
    send: (_intent, event) => {
      event.stopPropagation();
      if (event.target instanceof HTMLTextAreaElement) sendText(); else if (canSend) sendOption(selected);
      return true;
    },
    escape: (_intent, event) => {
      event.stopPropagation();
      if (document.activeElement instanceof HTMLElement && root.current?.contains(document.activeElement)) document.activeElement.blur();
      onEscape?.();
      return true;
    },
  }, { scope: 'editor' });
  const hint = blocked ? '' : full && options.length > 1 ? `1–${options.length} to change · Enter sends · Esc closes, keeps your draft` : 'Enter sends';
  return <div ref={root} className={`answer answer-${variant}`} role="group" aria-label={label} onKeyDown={keys}>
    {warn && <div className="answer-warn" role="alert"><i className="ph ph-warning" aria-hidden="true" /><span>{warn}</span>
      {warnAction && <button type="button" className="btn btn-secondary answer-warn-action" onClick={event => { event.stopPropagation(); warnAction.onAction(); }}>{warnAction.label}</button>}</div>}
    <div className="answer-options">
      {options.map((option, index) => {
        const on = index === selected;
        return <button type="button" key={option.id} data-answer-option={index} title={`Press ${index + 1} to select`} aria-pressed={on} disabled={locked}
          className={`btn ${option.recommended ? 'btn-primary' : 'btn-secondary'} answer-option${on ? ' answer-option-on' : ''}${option.recommended ? ' answer-option-rec' : ''}`}
          onClick={event => { event.stopPropagation(); onSelect(index); }}>
          <span className="answer-option-head">
            <span className="answer-key">{index + 1}</span>
            <span className="answer-label">{option.label}</span>
            {on && <span className="answer-picked"><i className="ph ph-check" aria-hidden="true" /></span>}
          </span>
          <span className="answer-consequence">{option.recommended && <span className="answer-recommended"><i className="ph-fill ph-star" aria-hidden="true" />Recommended</span>}{option.consequence}</span>
        </button>;
      })}
    </div>
    {picked && <div className="answer-send-row">
      <button type="button" className="btn btn-primary answer-send" disabled={!!blocked || locked} onClick={event => { event.stopPropagation(); sendOption(selected); }}>
        <i className="ph ph-paper-plane-right" aria-hidden="true" />
        <span className="answer-send-label">{full ? `Send “${picked.label}”` : 'Send answer'}</span>
        <span className="answer-enter" aria-hidden="true">↵</span>
      </button>
      <span className="answer-hint">{hint}</span>
    </div>}
    {full && !noText && <div className="answer-reply">
      <textarea className="input answer-text" aria-label="Reply in your own words" placeholder="Or reply in your own words…" rows={2}
        value={draft} disabled={locked} onClick={event => event.stopPropagation()} onChange={event => onDraft(event.target.value)} />
      <div className="answer-reply-row">
        <button type="button" className="btn btn-secondary answer-reply-send" disabled={!draft.trim() || !!blocked || locked}
          onClick={event => { event.stopPropagation(); sendText(); }}>Send reply</button>
        <span className="answer-hint">⌘↵ sends the reply instead of the option</span>
      </div>
    </div>}
    {blocked && <div className="answer-blocked" role="status"><i className="ph ph-wifi-slash" aria-hidden="true" /><span>{blocked}</span></div>}
  </div>;
}
