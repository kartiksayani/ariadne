import '../../styles/reference.css';

export type MessageExcerptProps = {
  message: { number: number; author: 'me' | 'agent'; when: string; excerpt: string; tag?: string };
  variant?: 'rail' | 'timeline';
  mark?: 'created' | 'updated' | 'origin' | 'answer';
  active?: boolean;
  highlight?: boolean;
  last?: boolean;
  label?: string;
  note?: string;
  onEnter?: () => void;
  onLeave?: () => void;
  onClick?: () => void;
};

export function MessageExcerpt({ message, variant = 'rail', mark = 'created', active = false, highlight = false, last = false, label, note, onEnter, onLeave, onClick }: MessageExcerptProps) {
  const me = message.author === 'me';
  const who = me ? 'You' : 'Agent';
  const icon = me ? 'ph ph-user' : 'ph ph-robot';
  const origin = mark === 'origin';
  const textColor = `color-mix(in srgb, var(--color-text) ${origin ? 64 : 84}%, transparent)`;
  const number = message.tag || `#${message.number}`;
  const author = <><i className={icon} aria-hidden="true" style={{ fontSize: 12 }} />{who}</>;
  if (variant === 'rail') return <div className="ariadne-reference ref-message-rail" onMouseEnter={onEnter} onMouseLeave={onLeave} onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined} onKeyDown={event => { if (onClick && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onClick(); } }} style={{ background: active ? 'color-mix(in srgb, var(--color-accent) 15%, transparent)' : highlight ? 'color-mix(in srgb, var(--color-accent) 8%, transparent)' : 'transparent' }}>
    <div className="ref-message-bar" style={{ background: active ? 'var(--color-accent)' : highlight ? 'color-mix(in srgb, var(--color-accent) 65%, transparent)' : 'transparent' }} />
    <div className="ref-message-meta"><span className="ref-message-number">{number}</span><i className={icon} aria-hidden="true" style={{ fontSize: 12 }} /><span style={{ fontWeight: 500, color: 'color-mix(in srgb, var(--color-text) 85%, transparent)' }}>{who}</span><span style={{ marginLeft: 'auto' }}>{message.when}</span></div>
    <div className="ref-message-preview" style={{ color: textColor }}>{message.excerpt}</div>
  </div>;
  const roleLabel = label || (mark === 'origin' ? 'Parent raised here' : mark === 'created' ? (me ? 'You asked here' : 'Agent raised this') : mark === 'updated' ? (me ? 'You replied' : 'Agent updated') : 'Message');
  return <div className="ariadne-reference ref-message-timeline"><div className="ref-message-track"><div className="ref-message-dot" style={{ background: mark === 'created' ? 'var(--color-accent)' : 'var(--a-bg)', boxShadow: origin ? 'inset 0 0 0 1.5px color-mix(in srgb, var(--color-text) 40%, transparent)' : 'inset 0 0 0 1.5px var(--color-accent)' }} />{!last && <div className="ref-message-connector" />}</div><div className="ref-timeline-content"><div className="ref-timeline-meta"><span style={{ fontWeight: 500, color: origin ? 'color-mix(in srgb, var(--color-text) 62%, transparent)' : 'var(--a-acc-text)' }}>{roleLabel}</span><span className="ref-message-number">{number}</span><span className="ref-message-author">{author}</span><span>{message.when}</span></div><div style={{ fontSize: 13.5, lineHeight: 1.55, color: textColor, textWrap: 'pretty' }}>{message.excerpt}</div>{note && <div className="ref-timeline-note">{note}</div>}</div></div>;
}
