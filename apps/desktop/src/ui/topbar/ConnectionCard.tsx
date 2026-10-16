// Where the agent stands for a session (SPEC 5.12): the card that opens from the connection dot, and the line above the
// Map for a state that changes what I can do. Pure props in, callbacks out (contract C8).
import { useEffect, useRef, useState } from 'react';
import { OutlineButton, useCopied, usePopover, useRestoreFocus } from '../parts/parts';
import { connectionBadge, connectionCopy, connectionLine, cardActions, lineActions } from './connection';
import type { ConnectionCardProps, ConnectionLineProps } from './model';
import './connection.css';

/** The mark of a state: the dot and/or icon the top bar shows, at the card's size. */
function Mark({ view }: { readonly view: ConnectionCardProps['view'] }) {
  const badge = connectionBadge(view, false);
  return <>
    {badge.dot && <span className={badge.dot.ring ? 'cc-dot cc-dot-ring' : 'cc-dot'} style={badge.dot.color ? { background: badge.dot.color } : undefined} aria-hidden="true" />}
    {badge.icon && <i className={`${badge.icon.name}${badge.icon.spin ? ' p-spin' : ''}`} style={{ color: badge.icon.color }} aria-hidden="true" />}
  </>;
}

/** A popover under the connection button. Esc or a press outside dismisses it; focus returns to the button. */
export function ConnectionCard({ view, actions, onDismiss }: ConnectionCardProps) {
  const panel = useRef<HTMLDivElement>(null);
  const copy = connectionCopy(view);
  const [copied, markCopied] = useCopied();
  usePopover(true, () => onDismiss(), panel, '[data-popover-trigger="connection"]');
  useRestoreFocus(panel);
  useEffect(() => { panel.current?.focus(); }, []);
  return <div ref={panel} className="cc" role="dialog" aria-label={copy.title} tabIndex={-1}>
    <div className="cc-title"><Mark view={view} />{copy.title}</div>
    {copy.lines.map(line => <div className="cc-line" key={line}>{line}</div>)}
    <div className="cc-actions">
      {cardActions(view, actions).map(action => action.key === 'copy-id'
        ? <OutlineButton key={action.key} icon={copied ? 'ph ph-check' : action.icon} onClick={() => { action.run(); markCopied(); }}>{copied ? 'Copied' : action.label}</OutlineButton>
        : <OutlineButton key={action.key} icon={action.icon} onClick={() => { onDismiss(); action.run(); }}>{action.label}</OutlineButton>)}
    </div>
  </div>;
}

/** The in-flow line above the Map. Live and Connecting draw none. "No agent connected" carries its steps, folded until asked for. */
export function ConnectionLine({ view, actions, steps: control, command = '/ariadne-connect' }: ConnectionLineProps) {
  const copy = connectionLine(view);
  const [own, setOwn] = useState(false);
  const steps = control?.open ?? own, toggleSteps = control?.onToggle ?? (() => setOwn(open => !open));
  const [command1, markCommand] = useCopied(), [instruction, markInstruction] = useCopied();
  if (!copy) return null;
  const connect = view.kind === 'none';
  return <section className="cl" aria-label="Connection" role="status">
    <div className="cl-row">
      <i className={`${copy.icon}${view.kind === 'reconnect' ? ' p-spin' : ''} cl-icon`} style={{ color: copy.color }} aria-hidden="true" />
      <span className="cl-text"><span className="cl-title">{copy.title}</span> <span className="cl-body">{copy.text}</span></span>
      <span className="cl-actions">
        {connect && <OutlineButton className="cl-btn" aria-expanded={steps} onClick={toggleSteps}>{steps ? 'Hide steps' : 'How to connect'}</OutlineButton>}
        {lineActions(view, actions).map(action => <OutlineButton key={action.key} className="cl-btn" onClick={action.run}>{action.label}</OutlineButton>)}
      </span>
    </div>
    {connect && steps && <div className="cl-steps">
      <div className="cl-step">
        <span className="cl-num">1</span><span>In the Claude Code conversation for this project, run</span>
        <span className="cl-code">{command}</span>
        <OutlineButton icon={command1 ? 'ph ph-check' : 'ph ph-copy'} className="cl-btn cl-copy" onClick={() => { actions.onCopyCommand?.(); markCommand(); }}>{command1 ? 'Copied' : 'Copy'}</OutlineButton>
      </div>
      <div className="cl-step">
        <span className="cl-num">2</span><span>Using Codex? Paste the setup instruction into its thread once.</span>
        <OutlineButton icon={instruction ? 'ph ph-check' : 'ph ph-copy'} className="cl-btn cl-copy" onClick={() => { actions.onCopyInstruction?.(); markInstruction(); }}>{instruction ? 'Copied' : 'Copy instruction'}</OutlineButton>
      </div>
      <div className="cl-foot">Connecting sends nothing to the model. The dot by the session name turns green when it’s done.</div>
    </div>}
  </section>;
}
