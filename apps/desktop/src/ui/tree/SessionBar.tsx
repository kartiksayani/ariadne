// The session bar over the tree (Ariadne.dc.html:94-101) and the notice banners
// under the filters (Ariadne.dc.html:107-130).
import { useState, type ReactNode } from 'react';
import { SessionRename } from '../shared/SessionRename';
import { CopySessionId } from '../shared/CopySessionId';
import { ActionMenu } from '../shared/ActionMenu';
import type { SessionBar as Bar } from './model';

/**
 * `dispatch` is the session's dispatch chip (components/bindings/DispatchChip); without it the bar shows the run state only.
 * `onRename` saves the owner's name and description (the error in plain words, or null once saved); without it the bar offers no Rename.
 */
export function SessionBar({ bar, busy, onClose, dispatch, onRename }: {
  bar: Bar; busy: boolean; onClose: () => void; dispatch?: ReactNode; onRename?: (name: string, description: string) => Promise<string | null>;
}) {
  const [renaming, setRenaming] = useState(false);
  const editor = renaming && onRename;
  return <div className="tree-session-bar" aria-label="Session" aria-busy={busy}>
    <i className="ph ph-terminal-window" />
    {editor
      ? <SessionRename layout="bar" naming={{ name: bar.named ? bar.title : null, description: bar.description }}
        onSave={async (name, description) => { const failure = await onRename(name, description); if (failure === null) setRenaming(false); return failure; }}
        onCancel={() => setRenaming(false)} />
      : <span className="tree-session-name" title={[bar.title, bar.secondary, bar.description].filter(Boolean).join(' · ')}>
        <span className="tree-session-title" title={bar.title}>{bar.title}</span>
        {bar.secondary && <span className="tree-session-secondary">{bar.secondary}</span>}
        {bar.description && <span className="tree-session-description" title={bar.description}>{bar.description}</span>}
      </span>}
    {bar.meta && <span className="tree-session-meta" title={bar.meta}>{bar.meta}</span>}
    {dispatch ?? <span className="tree-run" data-running={bar.running || undefined} data-connection={bar.connection}><span className="tree-run-dot" /><span className="tree-run-label" title={bar.running ? 'Agent running' : 'Agent not running'}>{bar.running ? 'Agent running' : 'Agent not running'}</span></span>}
    <div className="tree-session-actions">
      {bar.archived
        ? <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}
          title="Restore this session as Closed. Reopen it when you want to resume sending."><i className="ph ph-arrow-counter-clockwise" /><span className="tree-session-action-label">Restore session</span></button>
        : bar.closed
        ? <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}
          title="Mark this session Active in Ariadne again. Sending to the agent resumes."><i className="ph ph-arrow-counter-clockwise" /><span className="tree-session-action-label">Reopen session</span></button>
        : null}
      <ActionMenu label="Session actions" dismissKey={bar.sessionId} icon={<i className="ph ph-dots-three" aria-hidden="true" />}>
        {close => <>
          <CopySessionId sessionId={bar.sessionId} role="menuitem" />
          {onRename && <button type="button" role="menuitem" className="btn btn-ghost" disabled={busy || !!editor}
            title="Give this session a name you will recognise" onClick={() => { close(true); setRenaming(true); }}>
            <i className="ph ph-pencil-simple" aria-hidden="true" />Rename</button>}
          {!bar.archived && !bar.closed && <button type="button" role="menuitem" className="btn btn-ghost" disabled={busy}
            title="Mark this session Closed in Ariadne. The agent process isn’t touched." onClick={() => { close(true); onClose(); }}>
            <i className="ph ph-x-circle" aria-hidden="true" />Close session</button>}
        </>}
      </ActionMenu>
    </div>
  </div>;
}

export function Banner({ icon, children, actions, alert = false }: { icon: string; children: ReactNode; actions?: ReactNode; alert?: boolean }) {
  return <div className="tree-banner" role={alert ? 'alert' : 'status'}>
    <i className={icon} />
    <span className="tree-banner-text">{children}</span>
    {actions}
  </div>;
}
