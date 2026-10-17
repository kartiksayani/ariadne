// The answer cards (board screen 2, §5.2; Details' answer composer, §5.3): numbered option cards with "★ Recommended",
// a "+ Add a note" box on the picked card, a full-width "Write my own answer" card, and the bar with its phase text and
// Send. The dock, Details, the peek and the other-sessions list all render this one control.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useWorkspaceKeys } from '../keys';
import { useGrow } from './useGrow';
import './answer.css';

export interface AnswerOption {
  readonly id: string;
  readonly label: string;
  readonly consequence: string;
  readonly recommended: boolean;
}

/** The bar's left side and buttons for a phase the caller owns (sending, sent, failed). */
export interface AnswerBar {
  /** A Phosphor class, e.g. `ph ph-check`. */
  readonly icon: string;
  readonly tone?: 'accent' | 'done' | 'danger';
  readonly text: string;
  /** The narrow window's shorter text. */
  readonly narrow?: string;
  /** Replaces Send: Undo / Copy / Retry / "Sent". */
  readonly actions?: ReactNode;
  /** Options lock: the answer is on its way or sent. Unpicked options dim; no note link. */
  readonly sealed?: boolean;
}

/**
 * - `layout`: `dock` (3 columns, 2 narrow), `details` (one column; the list scrolls past 330px), `wide` (Details' bigger
 *   view: auto-fit columns), `compact` (the peek: small cards, no own-words card, consequence in the title) or `list`
 *   (other sessions: small cards in one column with their consequence, no own-words card).
 * - `selected`: index of the picked option, or -1. Recommendations never pick (`defaultSelection`).
 * - `draft`: the words: the picked option's note, or my own answer when no option is picked.
 * - `bar`: the caller's phase (sending, sent, failed); without it the bar shows the idle hint and Send.
 * - `blocked`: why sending is impossible now. Picking still works; Send is aria-disabled and the reason shows.
 * - `locked`: a send or save is in progress or must be reconciled first: the cards and the boxes are disabled.
 * - `frozen`: the view is refreshing: cards and Send are aria-disabled, the boxes stay typeable.
 *
 * Keys (editor scope): 1–9 pick and never send, Enter on a card sends that card, ⌘↵ sends the answer, Esc leaves.
 */
export interface AnswerControlProps {
  readonly options: readonly AnswerOption[];
  readonly layout?: 'dock' | 'details' | 'wide' | 'compact' | 'list';
  readonly selected: number;
  readonly draft: string;
  readonly warn?: string;
  readonly warnAction?: { readonly label: string; readonly onAction: () => void };
  readonly blocked?: string;
  readonly locked?: boolean;
  readonly frozen?: boolean;
  readonly bar?: AnswerBar | null;
  /** The idle bar text in place of the default hint (other sessions: where the answer goes). */
  readonly hint?: string;
  /** Accessible name of the control's group. */
  readonly label?: string;
  readonly onSelect: (index: number) => void;
  readonly onDraft: (text: string) => void;
  readonly onSendOption: (index: number, note?: string) => void;
  readonly onSendText: (text: string) => void;
  readonly onEscape?: () => void;
}

/** Recommendations are hints; only an explicit owner choice selects an option. */
export function defaultSelection(options: readonly Pick<AnswerOption, 'id' | 'recommended'>[], chosen: string | null | undefined): number {
  return chosen ? options.findIndex(option => option.id === chosen) : -1;
}

const range = (count: number) => count > 1 ? `1–${Math.min(count, 9)}` : '1';

export function AnswerControl({ options, layout = 'details', selected, draft, warn, warnAction, blocked, locked = false, frozen = false, bar, hint, label,
  onSelect, onDraft, onSendOption, onSendText, onEscape }: AnswerControlProps) {
  const root = useRef<HTMLDivElement>(null), box = useRef<HTMLTextAreaElement>(null);
  const compact = layout === 'compact' || layout === 'list', peek = layout === 'compact';
  const picked = options[selected];
  const words = !compact;
  // "Write my own answer" is picked: no option, and the owner opened it or has words in it.
  const [ownOpen, setOwnOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState<string | null>(null);
  const own = words && !picked && (ownOpen || !!draft.trim() || options.length === 0);
  const sealed = !!bar?.sealed;
  // `off` stops choosing and sending; only `locked` stops the owner typing.
  const off = locked || frozen || sealed;
  // Held back only because the view refreshes or sending is blocked: aria-disabled, so focus stays (a disabled
  // button drops it to <body>, where the next digit becomes a Map key). Hard stops are disabled.
  const gate = (hard: boolean, soft: boolean) => ({ disabled: hard || undefined, 'aria-disabled': soft && !hard ? true : undefined });
  const ready = !!picked || own && !!draft.trim();
  const canSend = ready && !blocked && !off;
  const sendOption = (index: number) => { if (options[index] && !blocked && !off) onSendOption(index, words ? draft : undefined); };
  const sendAnswer = () => { if (blocked || off) return; if (picked) sendOption(selected); else if (own && draft.trim()) onSendText(draft); };
  const choose = (index: number) => {
    if (off) return;
    if (index === -1) { setOwnOpen(true); setNoteOpen(null); } else setOwnOpen(false);
    onSelect(index);
  };
  const noteShown = (option: AnswerOption) => words && !sealed && (noteOpen === option.id || !!draft.trim());
  // In Details the words box grows with its text, up to a third of the pane.
  const boxShown = !sealed && (own || options.length === 0 && words || !!picked && noteShown(picked));
  useGrow(box, draft, (layout === 'details' || layout === 'wide') && boxShown);
  // A newly opened box takes the focus, so the owner types straight away.
  const focusNext = useRef(false);
  useLayoutEffect(() => { if (focusNext.current && box.current) { focusNext.current = false; box.current.focus(); } });
  const optionIndex = (target: EventTarget) => target instanceof HTMLElement && root.current?.contains(target)
    ? Number(target.closest<HTMLElement>('[data-answer-option]')?.dataset.answerOption ?? -1) : -1;
  const keys = useWorkspaceKeys<HTMLDivElement>({
    choose: (intent, event) => {
      if (intent.kind !== 'choose' || !options[intent.index]) return false;
      event.stopPropagation();
      choose(intent.index);
      return true;
    },
    enter: (_intent, event) => {
      // Enter on a card sends that card; on the control itself, the picked one. Other buttons keep their own Enter.
      const focused = optionIndex(event.target);
      if (focused < 0 && event.target !== event.currentTarget) return false;
      event.stopPropagation();
      // A held Enter that repeats onto the control sends nothing: only a real press does.
      if (event.repeat) return true;
      if (focused >= 0 && focused !== selected) choose(focused);
      if (focused >= 0) sendOption(focused); else sendAnswer();
      return true;
    },
    send: (_intent, event) => {
      event.stopPropagation();
      if (canSend) sendAnswer();
      return true;
    },
    escape: (_intent, event) => {
      event.stopPropagation();
      if (document.activeElement instanceof HTMLElement && root.current?.contains(document.activeElement)) document.activeElement.blur();
      onEscape?.();
      return true;
    },
  }, { scope: 'editor' });
  const textBox = (placeholder: string, name: string) => <textarea ref={box} className="answer-text" aria-label={name} placeholder={placeholder} rows={2}
    value={draft} disabled={locked || sealed} onClick={event => event.stopPropagation()} onChange={event => onDraft(event.target.value)} />;
  const cards = options.map((option, index) => {
    const on = index === selected;
    const tip = peek ? [option.label, option.consequence].filter(Boolean).join('\n') : index < 9 ? `Press ${index + 1} to pick` : undefined;
    return <div key={option.id} className={`answer-card${on ? ' answer-card-on' : ''}${sealed && !on ? ' answer-card-dim' : ''}`}>
      <button type="button" data-answer-option={index} aria-pressed={on} title={tip} {...gate(locked, frozen || sealed)}
        className="answer-option" onClick={event => { event.stopPropagation(); choose(index); }}>
        <span className="answer-key" aria-hidden="true">{index + 1}</span>
        <span className="answer-body">
          <span className="answer-label">{option.label}{peek && option.recommended && <span className="answer-star" aria-label="Recommended"> · <i className="ph-fill ph-star" aria-hidden="true" /></span>}</span>
          {!peek && (option.recommended || option.consequence) && <span className="answer-consequence">
            {option.recommended && <span className="answer-recommended"><i className="ph-fill ph-star" aria-hidden="true" />Recommended</span>}
            {option.recommended && option.consequence && <span className="answer-recommended-dot"> · </span>}{option.consequence}</span>}
        </span>
        {(on || !peek) && <i className={on ? 'ph-fill ph-check-circle answer-check' : 'ph-fill ph-check-circle answer-check answer-check-off'} aria-hidden="true" />}
      </button>
      {on && words && !sealed && !noteShown(option) && <button type="button" className="answer-note-link" disabled={locked}
        onClick={event => { event.stopPropagation(); focusNext.current = true; setNoteOpen(option.id); }}>+ Add a note</button>}
      {on && noteShown(option) && textBox('Add a note for the agent…', 'Add a note for the agent')}
      {on && sealed && draft.trim() && <p className="answer-sent-note">{draft}</p>}
    </div>;
  });
  const ownCard = words && options.length > 0 && <div className={`answer-card answer-own${own ? ' answer-card-on' : ''}${sealed && !own ? ' answer-card-dim' : ''}`}>
    <button type="button" data-answer-own aria-pressed={own} {...gate(locked, frozen || sealed)} className="answer-option"
      onClick={event => { event.stopPropagation(); focusNext.current = true; choose(-1); }}>
      <span className="answer-key" aria-hidden="true"><i className="ph ph-pencil-simple" /></span>
      <span className="answer-body"><span className="answer-label">Write my own answer</span></span>
      {!peek && <i className={own ? 'ph-fill ph-check-circle answer-check' : 'ph-fill ph-check-circle answer-check answer-check-off'} aria-hidden="true" />}
    </button>
    {own && !sealed && textBox('Answer in your own words…', 'Reply in your own words')}
    {own && sealed && draft.trim() && <p className="answer-sent-note">{draft}</p>}
  </div>;
  const idle = hint ? { icon: 'ph ph-info', text: hint, narrow: hint }
    : compact ? { icon: 'ph ph-info', text: 'Sends from here; nothing else opens.', narrow: 'Sends from here.' }
      : draft.trim() ? { icon: 'ph ph-pencil-simple', text: 'Draft kept. It stays here until you send it.', narrow: 'Draft kept until you send it.' }
        : { icon: 'ph ph-info', text: `Pick an option with ${range(options.length)} or write your own, then send with ↵.`, narrow: `Pick with ${range(options.length)}, send with ↵.` };
  const shown = bar ?? idle;
  return <div ref={root} className={`answer answer-${layout}`} role="group" aria-label={label} onKeyDown={keys}>
    {warn && <div className="answer-warn" role="alert"><i className="ph ph-warning" aria-hidden="true" /><span>{warn}</span>
      {warnAction && <button type="button" className="btn btn-secondary answer-warn-action" onClick={event => { event.stopPropagation(); warnAction.onAction(); }}>{warnAction.label}</button>}</div>}
    <div className="answer-options">{cards}{ownCard}</div>
    {options.length === 0 && words && !sealed && <div className="answer-card answer-own answer-card-on">{textBox('Answer in your own words…', 'Reply in your own words')}</div>}
    {blocked && <div className="answer-blocked" role="status"><i className="ph ph-wifi-slash" aria-hidden="true" /><span>{blocked}</span></div>}
    <div className="answer-bar" data-tone={shown && 'tone' in shown ? shown.tone : undefined}>
      <i className={`${shown.icon} answer-bar-icon`} aria-hidden="true" />
      <span className="answer-bar-text" role={bar ? 'status' : undefined}>
        {shown.narrow && shown.narrow !== shown.text
          ? <><span className="answer-bar-wide">{shown.text}</span><span className="answer-bar-narrow" aria-hidden="true">{shown.narrow}</span></>
          : shown.text}
      </span>
      {bar ? bar.actions : <button type="button" data-answer-send className="answer-send" {...gate(locked || !ready, frozen || !!blocked)}
        title={ready ? 'Send ( ↵ )' : 'Pick an option or write an answer first'} onClick={event => { event.stopPropagation(); sendAnswer(); }}>
        <i className="ph ph-paper-plane-right" aria-hidden="true" /><span>Send</span>{ready && !compact && <kbd aria-hidden="true">↵</kbd>}
      </button>}
    </div>
  </div>;
}
