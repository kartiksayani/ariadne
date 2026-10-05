import { useEffect, useRef, type ReactNode } from 'react';
import { StatusBadge, type Status } from './StatusBadge';
import { dialogControls } from '../accessibility/dialog-focus';
import '../../styles/reference.css';

type DialogProps = { title: string; children: ReactNode; actions: ReactNode; onCancel: () => void; width?: number };
export function ReferenceDialog({ title, children, actions, onCancel, width = 580 }: DialogProps) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = element.current;
    if (!dialog) return;
    const focusInside = () => { (dialogControls(dialog)[0] ?? dialog).focus(); };
    focusInside();
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) focusInside();
    };
    document.addEventListener('focusin', containFocus);
    return () => {
      document.removeEventListener('focusin', containFocus);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return <div className="ariadne-reference ref-overlay" onClick={onCancel}><div ref={element} className="ref-dialog" role="dialog" tabIndex={-1} aria-modal="true" aria-label={title} style={{ width: `min(${width}px, 100%)` }} onClick={event => event.stopPropagation()} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); }
    if (event.key === 'Tab') {
      const controls = dialogControls(event.currentTarget);
      const first = controls[0], last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); event.currentTarget.focus(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}><div className="ref-dialog-title">{title}</div>{children}<div className="ref-dialog-actions">{actions}</div></div></div>;
}
export type ContinueTopicProps = { title: string; source: string; target: string; groups: readonly { title: string; icon: string; color: string; lines: readonly { id: string; text: string }[] }[]; error?: string; onCancel: () => void; onSend: () => void };
export function ContinueTopic({ title, source, target, groups, error, onCancel, onSend }: ContinueTopicProps) {
  return <ReferenceDialog title={title} onCancel={onCancel} actions={<><button type="button" className="ref-button ref-ghost" onClick={onCancel}>Cancel</button><button type="button" className="ref-button ref-primary" onClick={onSend}><i className="ph ph-paper-plane-right" aria-hidden="true" style={{ fontSize: 14 }} />Send to {target}</button></>}><div className="ref-continue-lead">Copy this snapshot from {source} into {target}. The target receives new local IDs with immutable source references for topics, items, messages, rounds and answers. The source stays unchanged.</div><div className="ref-continue-summary">{groups.map(group => <div className="ref-continue-group" key={group.title}><div style={{ color: group.color }}><i className={group.icon} aria-hidden="true" />{group.title}</div>{group.lines.map(line => <div key={line.id}><code>{line.id}</code><span>{line.text}</span></div>)}</div>)}</div>{error && <div role="alert" className="ref-warning">{error} · Source unchanged. Review and send again explicitly.</div>}</ReferenceDialog>;
}
export type GuardDialogProps = { kind: 'archive' | 'close'; title: string; blockers: readonly { id: string; label: string }[]; dispatch: 'enabled' | 'pausing' | 'paused'; onReveal: (id: string) => void; onPause: () => void; onConfirm: () => void; onCancel: () => void };
export function GuardDialog({ kind, title, blockers, dispatch, onReveal, onPause, onConfirm, onCancel }: GuardDialogProps) {
  const pauseRequired = kind === 'close' && dispatch !== 'paused';
  return <ReferenceDialog title={title} onCancel={onCancel} width={520} actions={<><button type="button" className="ref-button ref-ghost" onClick={onCancel}>Cancel</button>{pauseRequired ? <button type="button" className="ref-button ref-primary" disabled={dispatch === 'pausing'} onClick={onPause}>{dispatch === 'pausing' ? 'Pausing dispatch…' : 'Pause dispatch'}</button> : <button type="button" className="ref-button ref-primary" disabled={blockers.length > 0} onClick={onConfirm}>{kind === 'close' ? 'Confirm close session' : 'Confirm archive topic'}</button>}</>}><p className="ref-continue-lead">{blockers.length ? 'Resolve these active items or unresolved inputs first.' : 'All items are terminal and no unresolved inputs remain.'} {kind === 'close' && 'Closing changes Ariadne metadata. The terminal session keeps running.'}</p>{blockers.map(blocker => <button type="button" className="ref-button ref-secondary" key={blocker.id} onClick={() => onReveal(blocker.id)}>{blocker.id} · {blocker.label}</button>)}{pauseRequired && <p className="ref-continue-lead">Pause dispatch, wait for confirmation, then confirm Close separately.</p>}</ReferenceDialog>;
}
export type ArchiveCardProps = { name: string; meta: string; lines: readonly { status: Status; text: string }[]; more?: string; onRestore?: () => void; onContinue?: () => void };
export function ArchiveCard({ name, meta, lines, more, onRestore, onContinue }: ArchiveCardProps) {
  return <div className="ariadne-reference ref-archive-card"><div className="ref-archive-heading"><i className="ph ph-archive" aria-hidden="true" style={{ flex: 'none', marginTop: 3, fontSize: 16, color: 'color-mix(in srgb, var(--color-text) 60%, transparent)' }} /><div className="ref-archive-identity"><span style={{ fontSize: 15, fontWeight: 500 }}>{name}</span><span style={{ fontSize: 12.5, color: 'color-mix(in srgb, var(--color-text) 62%, transparent)' }}>{meta}</span></div><div style={{ flex: 'none', display: 'flex', gap: 6 }}><button type="button" className="ref-button ref-secondary" style={{ height: 30, fontSize: 13 }} onClick={onRestore}><i className="ph ph-arrow-u-up-left" aria-hidden="true" style={{ fontSize: 13 }} />Restore</button><button type="button" className="ref-button ref-primary" style={{ height: 30, fontSize: 13 }} onClick={onContinue}><i className="ph ph-arrow-bend-down-right" aria-hidden="true" style={{ fontSize: 13 }} />Continue in this session</button></div></div><div className="ref-archive-outcomes">{lines.map((line, index) => <div key={index}><span className="ref-archive-icon"><StatusBadge status={line.status} variant="icon" size={14} /></span><span>{line.text}</span></div>)}{more && <span>{more}</span>}</div></div>;
}
