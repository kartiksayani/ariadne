// The session's loading skeleton (1h) and its empty state (1g), ported from
// Ariadne.dc.html:285-292 and 315-320 (skelRows: 2152-2161).
import './pages.css';

const rows = [
  { pad: '12px', w: '38%', bw: '0px', pt: '16px' }, { pad: '36px', w: '64%', bw: '64px', pt: '12px' },
  { pad: '36px', w: '52%', bw: '64px', pt: '12px' }, { pad: '60px', w: '58%', bw: '84px', pt: '12px' },
  { pad: '36px', w: '70%', bw: '64px', pt: '12px' }, { pad: '12px', w: '30%', bw: '0px', pt: '24px' },
  { pad: '36px', w: '60%', bw: '64px', pt: '12px' }, { pad: '60px', w: '48%', bw: '96px', pt: '12px' },
] as const;

export function LoadingSession() {
  return <div className="pw-loading" aria-busy="true">
    {rows.map((row, index) => <div key={index} className="pw-skel-row" style={{ paddingTop: row.pt, paddingLeft: row.pad }} aria-hidden="true">
      <span className="pw-skel-dot" /><span className="pw-skel-bar" style={{ width: row.w }} /><span className="pw-skel-badge" style={{ width: row.bw }} /></div>)}
    <div className="pw-loading-text" role="status"><i className="ph ph-circle-notch" aria-hidden="true" />Reading the session…</div>
  </div>;
}

/** `agent` is null when no agent is connected; `where` only when the host reports it. */
export function EmptySession({ agent, connected, where = null }: { readonly agent: string | null; readonly connected: boolean; readonly where?: string | null }) {
  const status = agent && connected ? `Connected to ${agent}${where ? ` in ${where}` : ''} · waiting for the agent’s first message`
    : agent ? `${agent} isn’t running · its messages appear here when it runs again` : 'No agent is connected to this session';
  return <div className="pw-empty">
    <i className="ph ph-spiral pw-empty-icon" aria-hidden="true" />
    <div className="pw-empty-title">No items yet</div>
    <p className="pw-empty-text">Ariadne is following this session. Questions, decisions and findings appear here as the agent writes them, grouped by topic.</p>
    <div className="pw-empty-status"><span className="pw-dot" style={{ background: agent && connected ? 'var(--st-done)' : 'transparent',
      boxShadow: agent && connected ? 'none' : 'inset 0 0 0 1.5px color-mix(in srgb, var(--color-text) 50%, transparent)' }} />{status}</div>
  </div>;
}
