// Message Excerpt, timeline variant (handoff README Components; Message
// Excerpt.dc.html). The rail variant belongs to the message rail.
import type { ExcerptMessage, Mark } from './model';

export function TimelineExcerpt({ message, mark, label, note, last, highlighted = false }: {
  readonly message: ExcerptMessage; readonly mark: Mark; readonly label: string; readonly note: string; readonly last: boolean; readonly highlighted?: boolean;
}) {
  const me = message.author === 'me';
  return <div className={`excerpt-timeline excerpt-${mark}${highlighted ? ' excerpt-highlighted' : ''}`}>
    <div className="excerpt-rail"><div className="excerpt-dot" />{!last && <div className="excerpt-line" />}</div>
    <div className="excerpt-content">
      <div className="excerpt-meta">
        <span className="excerpt-mark">{label}</span>
        <span className="excerpt-number">{message.tag}</span>
        <span className="excerpt-who"><i className={me ? 'ph ph-user' : 'ph ph-robot'} aria-hidden="true" />{me ? 'You' : 'Agent'}</span>
        <span>{message.when}</span>
      </div>
      <div className="excerpt-body">{message.excerpt}</div>
      {note && <div className="excerpt-note">{note}</div>}
    </div>
  </div>;
}
