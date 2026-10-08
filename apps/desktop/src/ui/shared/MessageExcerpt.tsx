// Message Excerpt (handoff README Components; Message Excerpt.dc.html) in its
// two variants: the rail card the owner hovers and pins, and the timeline
// entry of the detail panel. The rail card is a preview and stays plain text;
// the timeline shows the whole message as Markdown.
import { useContext, type ReactNode } from 'react';
import type { ExcerptView, Mark } from './excerpt';
import { ItemRefs, Markdown } from './MarkdownText';
import { CopyMessage } from '../detail/CopyMessage';
import './shared.css';

export function RailExcerpt({ id, view, active, highlight, onHover, onPin }: {
  readonly id: string; readonly view: ExcerptView; readonly active: boolean; readonly highlight: boolean;
  readonly onHover: (on: boolean) => void; readonly onPin: () => void;
}) {
  return <button type="button" className={`pw-excerpt${active ? ' pw-excerpt-active' : highlight ? ' pw-excerpt-highlight' : ''}`} aria-pressed={active}
    data-message-id={id} onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)} onClick={onPin}>
    <span className="pw-excerpt-bar" aria-hidden="true" />
    <span className="pw-excerpt-meta"><span className="pw-excerpt-number">{view.number}</span><i className={view.icon} aria-hidden="true" />
      <span className="pw-excerpt-who">{view.who}</span><span className="pw-excerpt-when">{view.when}</span></span>
    <span className="pw-excerpt-text">{view.body}</span>
  </button>;
}

export function TimelineExcerpt({ id, message, mark, label, note, last, highlighted = false, after = null }: {
  readonly id?: string; readonly message: ExcerptView; readonly mark: Mark; readonly label: string; readonly note: string; readonly last: boolean; readonly highlighted?: boolean;
  /** Under the message: a quiet line about it (not sent) with its action. */
  readonly after?: ReactNode;
}) {
  const itemRefs = useContext(ItemRefs);
  return <div className={`excerpt-timeline excerpt-${mark}${highlighted ? ' excerpt-highlighted' : ''}`} data-message-id={id}>
    <div className="excerpt-rail"><div className="excerpt-dot" />{!last && <div className="excerpt-line" />}</div>
    <div className="excerpt-content">
      <div className="excerpt-meta">
        <span className="excerpt-mark">{label}</span>
        <span className="excerpt-number">{message.number}</span>
        <span className="excerpt-who"><i className={message.author === 'me' ? 'ph ph-user' : 'ph ph-robot'} aria-hidden="true" />{message.author === 'me' ? 'You' : 'Agent'}</span>
        <span>{message.when}</span>
      </div>
      <ItemRefs.Provider value={message.author === 'agent' ? itemRefs : null}><Markdown className="excerpt-body" text={message.body} /></ItemRefs.Provider>
      {note && <div className="excerpt-note">{note}</div>}
      {after}
    </div>
    <CopyMessage text={message.body} />
  </div>;
}
