import type { KeyboardEvent } from 'react';
import '../../styles/reference.css';

export type AnswerOption = { id: string; label: string; consequence: string; recommended?: boolean };
export type AnswerControlProps = {
  options: readonly AnswerOption[];
  variant?: 'compact' | 'full';
  selected: string | null;
  draft: string;
  onSelect: (id: string) => void;
  onDraft: (text: string) => void;
  onSubmit: (answer: { optionId?: string; text?: string }) => void;
  onEscape?: () => void;
  warning?: string;
  blocked?: string;
  saving?: boolean;
  error?: string;
  stateLabel?: string;
  noText?: boolean;
};

export function AnswerControl({ options, variant = 'full', selected, draft, onSelect, onDraft, onSubmit, onEscape, warning, blocked, saving = false, error, stateLabel, noText = false }: AnswerControlProps) {
  const full = variant === 'full';
  const option = options.find(option => option.id === selected);
  const text = draft.trim();
  const disabled = !!blocked || saving;
  const submit = () => {
    if (disabled || (!option && !text)) return;
    onSubmit({ ...(option ? { optionId: option.id } : {}), ...(text ? { text } : {}) });
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); onEscape?.(); }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.stopPropagation(); submit(); return; }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); submit(); }
    if (saving) return;
    const index = Number(event.key) - 1;
    if (/^[1-9]$/.test(event.key) && options[index]) { event.preventDefault(); event.stopPropagation(); onSelect(options[index].id); }
  };
  return <div className="ariadne-reference ref-answer" onKeyDown={key}>
    {warning && <div className="ref-warning"><i className="ph ph-warning" aria-hidden="true" /><span>{warning}</span></div>}
    <div className="ref-options" style={{ gridTemplateColumns: full ? 'repeat(auto-fit, minmax(220px, 1fr))' : 'minmax(0, 1fr)' }}>
      {options.map((entry, index) => {
        const picked = selected === entry.id;
        return <button key={entry.id} type="button" className={`ref-button ${entry.recommended ? 'ref-primary' : 'ref-secondary'} ref-option`} aria-pressed={picked} title={`Press ${index + 1} to select`} disabled={saving} onClick={() => onSelect(entry.id)} style={{ padding: full ? '10px 12px 11px' : '8px 10px 9px', background: picked ? 'color-mix(in srgb, var(--color-accent) 10%, transparent)' : 'transparent', boxShadow: picked ? '0 0 0 1px var(--color-accent), 0 0 18px color-mix(in srgb, var(--color-accent) 20%, transparent)' : 'none' }}>
          <span className="ref-option-title"><span className="ref-keycap">{index + 1}</span><span style={{ fontWeight: 500, lineHeight: 1.3, fontSize: full ? 14 : 13.5, color: entry.recommended ? 'var(--a-acc-text)' : 'var(--color-text)' }}>{entry.label}</span>{picked && <span className="ref-picked"><i className="ph ph-check" aria-hidden="true" style={{ fontSize: 11 }} /></span>}</span>
          <span className="ref-consequence" style={{ fontSize: full ? 13 : 12.5 }}>{entry.recommended && <span className="ref-recommended"><i className="ph-fill ph-star" aria-hidden="true" style={{ fontSize: 11 }} />Recommended</span>}{entry.consequence}</span>
        </button>;
      })}
    </div>
    {option && <div className="ref-send-row"><button type="button" className="ref-button ref-primary" onClick={submit} disabled={disabled} style={{ height: 32, maxWidth: '100%' }}><i className="ph ph-paper-plane-right" aria-hidden="true" style={{ fontSize: 14 }} /><span className="ref-send-label">{full ? `Send “${option.label}”` : 'Send answer'}</span><span className="ref-keycap ref-enter">↵</span></button><span className="ref-hint">{!blocked && (full && options.length > 1 ? `1–${options.length} to change · Enter sends · Esc closes, keeps your draft` : 'Enter sends')}</span></div>}
    {full && !noText && <div className="ref-text-reply"><textarea className="ref-input" aria-label="Reply in your own words" placeholder="Or reply in your own words…" rows={2} value={draft} onChange={event => onDraft(event.target.value)} /><div className="ref-send-row"><button type="button" className="ref-button ref-secondary" style={{ height: 30, fontSize: 13 }} disabled={disabled || !text} onClick={submit}>Send reply</button><span className="ref-hint">⌘↵ sends · Esc closes, keeps your draft</span></div></div>}
    {blocked && <div className="ref-blocked"><i className="ph ph-wifi-slash" aria-hidden="true" /><span>{blocked}</span></div>}
    {error && <div className="ref-warning" role="alert">{error}</div>}
    {(saving || stateLabel) && <div className="ref-hint" role="status">{saving ? 'Saving…' : stateLabel}</div>}
  </div>;
}
