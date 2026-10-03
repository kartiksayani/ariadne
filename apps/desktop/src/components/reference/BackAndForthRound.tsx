import { StatusBadge, type Status } from './StatusBadge';
import '../../styles/reference.css';

export type BackAndForthRoundProps = {
  label: string; range: string; ask: string; isNow?: boolean;
  reply?: { chosen: boolean; text: string }; result?: string;
  forks: readonly { id: string; question: string; status: Status }[];
  onReveal?: (id: string) => void;
};

export function BackAndForthRound({ label, range, ask, isNow = false, reply, result, forks, onReveal }: BackAndForthRoundProps) {
  return <div className="ariadne-reference ref-round-card" style={{ background: isNow ? 'color-mix(in srgb, var(--color-accent) 7%, transparent)' : 'var(--a-card)', boxShadow: isNow ? '0 0 0 1px color-mix(in srgb, var(--color-accent) 45%, transparent)' : '0 0 0 1px var(--color-divider)' }}>
    <div className="ref-round-label" style={{ color: isNow ? 'var(--a-acc-text)' : 'color-mix(in srgb, var(--color-text) 64%, transparent)' }}><span>{label}</span><span className="ref-round-range">{range}</span>{isNow && <span className="ref-tag ref-tag-accent" style={{ marginLeft: 'auto', padding: '1px 7px', fontSize: 10.5 }}>Waiting on you</span>}</div>
    <div className="ref-round-line"><i className="ph ph-robot" aria-hidden="true" /><span>{ask}</span></div>
    {reply && <div className="ref-round-line" style={{ color: 'var(--a-acc-text)' }}><i className={reply.chosen ? 'ph ph-check-circle' : 'ph ph-user'} aria-hidden="true" style={{ color: 'inherit' }} /><span>{reply.text}</span></div>}
    {result && <div className="ref-round-line" style={{ color: 'color-mix(in srgb, var(--color-text) 80%, transparent)' }}><i className="ph ph-arrow-elbow-down-right" aria-hidden="true" style={{ color: 'color-mix(in srgb, var(--color-text) 55%, transparent)' }} /><span>{result}</span></div>}
    {forks.map(fork => <button key={fork.id} type="button" className="ref-fork" onClick={() => onReveal?.(fork.id)}><i className="ph ph-git-fork" aria-hidden="true" /><span>{fork.question}</span><StatusBadge status={fork.status} variant="text" /></button>)}
  </div>;
}
