// The message rail card the owner hovers and pins: a plain text preview.
import type { ExcerptView } from './excerpt';
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
