// MINIMAL STAND-IN for the handoff's "Answer Control" (Answer Control.dc.html),
// built by WP1 so the tree can answer inline. WP2 owns the final component and
// replaces this file; keep its props when it does.
import type { KeyboardEvent, MouseEvent } from 'react';
import './answer.css';

export interface AnswerOption { readonly id: string; readonly label: string; readonly consequence: string; readonly recommended: boolean }
export interface AnswerControlProps {
  readonly options: readonly AnswerOption[];
  readonly variant?: 'full' | 'compact';
  /** The highlighted option, or -1. */
  readonly selected: number;
  readonly draft: string;
  readonly warn?: string | null;
  /** Why sending is not possible right now; disables both sends. */
  readonly blocked?: string | null;
  readonly busy?: boolean;
  readonly onSelect: (index: number) => void;
  readonly onDraft: (text: string) => void;
  readonly onSendOption: (index: number) => void;
  readonly onSendText: (text: string) => void;
  readonly onEscape: () => void;
}

const stop = (event: MouseEvent) => event.stopPropagation();

export function AnswerControl({ options, variant = 'full', selected, draft, warn, blocked, busy = false, onSelect, onDraft, onSendOption, onSendText, onEscape }: AnswerControlProps) {
  const full = variant === 'full', chosen = options[selected];
  const hint = blocked ? '' : full && options.length > 1 ? `1–${options.length} to change · Enter sends · Esc closes, keeps your draft` : 'Enter sends';
  const areaKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (draft.trim() && !blocked && !busy) onSendText(draft.trim());
    }
    if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.blur(); onEscape(); }
  };
  return <div className={`answer-control answer-${variant}`} onClick={stop}>
    {warn && <div className="answer-warn" role="alert"><i className="ph ph-warning" /><span>{warn}</span></div>}
    <div className="answer-options">
      {options.map((option, index) => <button key={option.id} type="button" className={`btn ${option.recommended ? 'btn-primary' : 'btn-secondary'} answer-option`}
        aria-pressed={selected === index} title={`Press ${index + 1} to select`} data-picked={selected === index || undefined}
        onClick={event => { event.stopPropagation(); onSelect(index); }}>
        <span className="answer-option-head">
          <span className="answer-key">{index + 1}</span>
          <span className="answer-label" data-recommended={option.recommended || undefined}>{option.label}</span>
          {selected === index && <span className="answer-picked"><i className="ph ph-check" /></span>}
        </span>
        <span className="answer-consequence">{option.recommended && <span className="answer-recommended"><i className="ph-fill ph-star" />Recommended</span>}{option.consequence}</span>
      </button>)}
    </div>
    {chosen && <div className="answer-send">
      <button type="button" className="btn btn-primary answer-send-option" disabled={!!blocked || busy}
        onClick={event => { event.stopPropagation(); onSendOption(selected); }}>
        <i className="ph ph-paper-plane-right" /><span className="answer-send-label">{full ? `Send “${chosen.label}”` : 'Send answer'}</span><span className="answer-enter">↵</span>
      </button>
      <span className="answer-hint">{hint}</span>
    </div>}
    {full && <div className="answer-text">
      <textarea className="input" value={draft} rows={2} placeholder="Or reply in your own words…" aria-label="Reply in your own words"
        onChange={event => onDraft(event.target.value)} onKeyDown={areaKey} onClick={stop} />
      <div className="answer-text-send">
        <button type="button" className="btn btn-secondary" disabled={!draft.trim() || !!blocked || busy}
          onClick={event => { event.stopPropagation(); if (draft.trim()) onSendText(draft.trim()); }}>Send reply</button>
        <span className="answer-hint">⌘↵ sends the reply instead of the option</span>
      </div>
    </div>}
    {blocked && <div className="answer-blocked"><i className="ph ph-wifi-slash" /><span>{blocked}</span></div>}
  </div>;
}
