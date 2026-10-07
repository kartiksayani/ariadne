// The session bar over the tree (Ariadne.dc.html:94-101) and the notice banners
// under the filters (Ariadne.dc.html:107-130).
import type { ReactNode } from 'react';
import type { SessionBar as Bar } from './model';

export function SessionBar({ bar, busy, onClose }: { bar: Bar; busy: boolean; onClose: () => void }) {
  return <div className="tree-session-bar" aria-label="Session">
    <i className="ph ph-terminal-window" />
    <span className="tree-session-title">{bar.title}</span>
    <span className="tree-session-meta">{bar.meta}</span>
    <span className="tree-run" data-running={bar.running || undefined} title={bar.host ?? undefined}><span className="tree-run-dot" />{bar.running ? 'Agent running' : 'Agent not running'}</span>
    {bar.closed
      ? <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}
        title="Mark this session Active in Ariadne again. Dispatch stays paused."><i className="ph ph-arrow-counter-clockwise" />Reopen session</button>
      : <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}
        title="Mark this session Closed in Ariadne. The agent process isn’t touched."><i className="ph ph-x-circle" />Close session</button>}
  </div>;
}

export function Banner({ icon, children, actions, alert = false }: { icon: string; children: ReactNode; actions?: ReactNode; alert?: boolean }) {
  return <div className="tree-banner" role={alert ? 'alert' : 'status'}>
    <i className={icon} />
    <span className="tree-banner-text">{children}</span>
    {actions}
  </div>;
}
