// The session's loading skeleton (1h), ported from Ariadne.dc.html:315-320
// (skelRows: 2152-2161). The empty state (1g) is the tree's own (ui/tree/TreeView).
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
