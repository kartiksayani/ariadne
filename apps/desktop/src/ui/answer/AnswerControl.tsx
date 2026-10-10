// The answer control (handoff "Answer Control.dc.html"): numbered options, the
// Send row and, in the full variant, a reply box. Waiting cards (compact), the
// tree's inline answer and the detail panel (full) all render this one control.
import { useId, useRef, useState } from 'react';
import { useWorkspaceKeys } from '../keys';
import { useGrow } from './useGrow';
import './answer.css';

export interface AnswerOption {
  readonly id: string;
  readonly label: string;
  readonly consequence: string;
  readonly recommended: boolean;
}

/**
 * Props of the answer control. The caller owns the
 * selection and the draft (normally `useSubmit`, backed by the draft store).
 *
 * - `variant`: `compact` (Waiting card), `full` (tree row; adds the reply box
 *   and the "Send “label”" wording) or `chat` (the detail's docked composer:
 *   `full`, with the options as quick replies above a one-line reply box that
 *   grows as you type).
 * - `selected`: index of the selected option, or -1. Callers pass the draft's
 *   choice, else the recommended option (`defaultSelection`).
 * - `draft`: the reply text, shown in the full variant unless `noText`.
 * - `warn`: a warn-coloured line above the options, with an optional action.
 * - `blocked`: why sending is impossible now (closed, reconnecting, stale…).
 *   Selection still works; both Send buttons are aria-disabled (they keep focus) and the hint hides.
 * - `locked`: a send or save is in progress or must be reconciled first; the
 *   options, the reply box and both Send buttons are disabled.
 * - `frozen`: the view behind the control is refreshing; the options and both
 *   Send buttons are `aria-disabled` (their clicks and keys do nothing), but
 *   the reply box stays typeable. A truly disabled button or box drops the
 *   focus it holds to <body>, where keys become tree shortcuts.
 * - `onSendOption(index, note)` sends the option with the text box's note;
 *   compact controls and controls without a text box use the saved draft's note.
 *   `onSendText(text)` sends the reply only, without an option.
 * - `onEscape`: Esc closes the control; the draft is kept by the caller.
 *
 * Keys (through `ui/keys.ts`, editor scope): 1–9 select and never send, Enter
 * sends the selected option, ⌘↵ in the reply box sends the reply, Esc closes.
 */
export interface AnswerControlProps {
  readonly options: readonly AnswerOption[];
  readonly variant: 'compact' | 'full' | 'chat';
  readonly selected: number;
  readonly draft: string;
  readonly warn?: string;
  readonly warnAction?: { readonly label: string; readonly onAction: () => void };
  readonly blocked?: string;
  readonly locked?: boolean;
  /** The view behind the control is refreshing: options and both Send buttons are disabled, but the reply box keeps taking words. */
  readonly frozen?: boolean;
  readonly noText?: boolean;
  /** Accessible name of the control's group. */
  readonly label?: string;
  readonly onSelect: (index: number) => void;
  readonly onDraft: (text: string) => void;
  readonly onSendOption: (index: number, note?: string) => void;
  readonly onSendText: (text: string) => void;
  readonly onEscape?: () => void;
}

/** The option selected when the draft has no choice: the recommended one, else none. */
export function defaultSelection(options: readonly Pick<AnswerOption, 'id' | 'recommended'>[], chosen: string | null | undefined): number {
  const index = chosen ? options.findIndex(option => option.id === chosen) : -1;
  return index >= 0 ? index : options.findIndex(option => option.recommended);
}

export function AnswerControl({ options, variant, selected, draft, warn, warnAction, blocked, locked = false, frozen = false, noText = false, label,
  onSelect, onDraft, onSendOption, onSendText, onEscape }: AnswerControlProps) {
  const root = useRef<HTMLDivElement>(null), text = useRef<HTMLTextAreaElement>(null);
  const descriptionId = useId(), [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const chat = variant === 'chat', full = variant !== 'compact', picked = options[selected];
  useGrow(text, draft, chat);
  // `off` stops choosing and sending; only `locked` stops the owner typing.
  const off = locked || frozen;
  const canSend = !!picked && !blocked && !off;
  // A button held back only because the view is refreshing or sending is blocked (`soft`) is marked aria-disabled, not disabled: a
  // disabled one drops the focus it holds to <body>, where the next digit becomes a tree shortcut. Its click and keys do nothing
  // (`off` and `blocked` are checked where they act). A `hard` one (a send in progress, no words) is disabled.
  const gate = (hard: boolean, soft: boolean) => ({ disabled: hard || undefined, 'aria-disabled': soft && !hard ? true : undefined });
  const hasText = full && !noText;
  const withNote = hasText && !!draft.trim();
  const sendOption = (index: number) => { if (options[index] && !blocked && !off) onSendOption(index, hasText ? draft : undefined); };
  const sendText = () => { if (draft.trim() && !blocked && !off) onSendText(draft); };
  const optionIndex = (target: EventTarget) => target instanceof HTMLElement && root.current?.contains(target)
    ? Number(target.closest<HTMLElement>('[data-answer-option]')?.dataset.answerOption ?? -1) : -1;
  const keys = useWorkspaceKeys<HTMLDivElement>({
    choose: (intent, event) => {
      if (intent.kind !== 'choose' || !options[intent.index]) return false;
      event.stopPropagation();
      if (!off) onSelect(intent.index);
      return true;
    },
    enter: (_intent, event) => {
      // Enter on an option sends that option; on the control itself, the
      // selected one. Other buttons (Send, Retry) keep their own Enter.
      const focused = optionIndex(event.target);
      if (focused < 0 && event.target !== event.currentTarget) return false;
      event.stopPropagation();
      const index = focused >= 0 ? focused : selected;
      if (focused >= 0 && focused !== selected && !off) onSelect(focused);
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
  const hint = blocked ? '' : full && options.length > 1 ? `1–${Math.min(options.length, 9)} to select · Enter sends${withNote ? ' with your note' : ''} · Esc closes, keeps your draft` : `Enter sends${withNote ? ' with your note' : ''}`;
  const chatHint = [!blocked && options.length > 1 ? `1–${Math.min(options.length, 9)} select` : '', !blocked && picked ? 'Enter sends' : '',
    hasText ? '⌘↵ reply only' : '', 'Esc keeps draft'].filter(Boolean).join(' · ');
  return <div ref={root} className={`answer answer-${variant}${chat ? ' answer-full' : ''}`} role="group" aria-label={label} onKeyDown={keys}>
    {warn && <div className="answer-warn" role="alert"><i className="ph ph-warning" aria-hidden="true" /><span>{warn}</span>
      {warnAction && <button type="button" className="btn btn-secondary answer-warn-action" onClick={event => { event.stopPropagation(); warnAction.onAction(); }}>{warnAction.label}</button>}</div>}
    <div className="answer-options">
      {options.map((option, index) => {
        const on = index === selected;
        const open = expanded.has(option.id), id = `${descriptionId}-${index}`;
        const shortcut = index < 9 ? `Press ${index + 1} to select, ⌥${index + 1} to send${draft.trim() ? ' with your note' : ''}` : 'Click to select, Enter to send';
        const button = <button type="button" key={option.id} data-answer-option={index} title={chat ? `${option.label}\n${option.consequence}\n${shortcut}` : shortcut} aria-pressed={on} {...gate(locked, frozen)}
          className={`btn ${option.recommended ? 'btn-primary' : 'btn-secondary'} answer-option${on ? ' answer-option-on' : ''}${option.recommended ? ' answer-option-rec' : ''}`}
          onClick={event => { event.stopPropagation(); if (!off) onSelect(index); }}>
          <span className="answer-option-head">
            <span className="answer-key">{index + 1}</span>
            <span className="answer-label">{option.label}</span>
            {on && <span className="answer-picked"><i className="ph ph-check" aria-hidden="true" /></span>}
          </span>
          <span className="answer-consequence">{option.recommended && <span className="answer-recommended"><i className="ph-fill ph-star" aria-hidden="true" />Recommended</span>}{chat
            ? <span id={id} className={`answer-description${open ? ' answer-description-open' : ''}`}>{option.consequence}</span> : option.consequence}</span>
        </button>;
        return chat ? <div className="answer-card" key={option.id}>
          {button}
          {option.consequence && <button type="button" className="answer-more" aria-expanded={open} aria-controls={id}
            aria-label={`${open ? 'Less' : 'More'} about ${option.label}`} onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
            }} onClick={event => {
              event.stopPropagation();
              setExpanded(current => { const next = new Set(current); if (next.has(option.id)) next.delete(option.id); else next.add(option.id); return next; });
            }}>{open ? 'Less' : 'More'}</button>}
        </div> : button;
      })}
    </div>
    {picked && <div className="answer-send-row">
      <button type="button" className="btn btn-primary answer-send" {...gate(locked, frozen || !!blocked)} onClick={event => { event.stopPropagation(); sendOption(selected); }}>
        <i className="ph ph-paper-plane-right" aria-hidden="true" />
        <span className="answer-send-label">{full ? `Send “${picked.label}”${withNote ? ' with your note' : ''}` : 'Send answer'}</span>
        <span className="answer-enter" aria-hidden="true">↵</span>
      </button>
      {!chat && <span className="answer-hint">{hint}</span>}
    </div>}
    {chat && !noText && <div className="answer-reply answer-composer">
      <div className="answer-composer-row">
        <textarea ref={text} className="input answer-text" aria-label="Reply in your own words" placeholder="Add a note to your choice, or reply on its own…" rows={1}
          value={draft} disabled={locked} onClick={event => event.stopPropagation()} onChange={event => onDraft(event.target.value)} />
        <button type="button" className="btn btn-secondary answer-reply-send" {...gate(!draft.trim() || locked, frozen || !!blocked)}
          onClick={event => { event.stopPropagation(); sendText(); }}>Send as a reply only</button>
      </div>
    </div>}
    {chat && <span className="answer-hint">{chatHint}</span>}
    {full && !chat && !noText && <div className="answer-reply">
      <textarea className="input answer-text" aria-label="Reply in your own words" placeholder="Add a note to your choice, or reply on its own…" rows={2}
        value={draft} disabled={locked} onClick={event => event.stopPropagation()} onChange={event => onDraft(event.target.value)} />
      <div className="answer-reply-row">
        <button type="button" className="btn btn-secondary answer-reply-send" {...gate(!draft.trim() || locked, frozen || !!blocked)}
          onClick={event => { event.stopPropagation(); sendText(); }}>Send as a reply only</button>
        <span className="answer-hint">⌘↵ sends as a reply only</span>
      </div>
    </div>}
    {blocked && <div className="answer-blocked" role="status"><i className="ph ph-wifi-slash" aria-hidden="true" /><span>{blocked}</span></div>}
  </div>;
}
