// The Archive page (SPEC 5.14): archived sessions and topics, each with Restore and a "…" to remove it from Ariadne.
// Pure props in, callbacks out (contract C8).
import { useRef, useState } from 'react';
import { PopMenu, usePopover } from '../parts/parts';
import { PageColumn, PageHead } from './PageHead';
import type { ArchiveListProps, ArchiveRowData } from './page-types';
import './archive.css';

function Section({ label, rows, props }: { readonly label: string; readonly rows: readonly ArchiveRowData[]; readonly props: ArchiveListProps }) {
  const [open, setOpen] = useState<string | null>(null), [keyboard, setKeyboard] = useState(false);
  const menu = useRef<HTMLDivElement>(null), buttons = useRef(new Map<string, HTMLButtonElement>());
  const close = (restore: boolean) => {
    const was = open;
    setOpen(null);
    if (restore && was) buttons.current.get(was)?.focus();
  };
  usePopover(open !== null, close, menu, '[data-popover-trigger="archive-menu"]');
  if (!rows.length) return null;
  return <section className="ar-sec" aria-label={label}>
    <h2 className="p-label ar-label">{label}</h2>
    <div className="ar-box">
      {rows.map(row => <div className="ar-row" key={`${row.kind}:${row.id}`}>
        <i className={row.kind === 'topic' ? 'ph ph-tree-structure ar-icon' : 'ph ph-terminal-window ar-icon'} aria-hidden="true" />
        <div className="ar-id"><span className="ar-name">{row.name}</span><span className="ar-sub">{row.sub}</span></div>
        <span className="ar-when">{row.when}</span>
        {row.restored
          ? <span className="ar-done"><i className="ph ph-check" aria-hidden="true" />{row.kind === 'topic' ? 'Back in the Map' : 'Restored, closed'}</span>
          : <button type="button" className="p-btn ar-restore" title={row.kind === 'topic' ? 'Put it back in the Map' : 'Restore it, closed'} aria-label={`Restore ${row.name}`} onClick={() => props.onRestore(row)}>
            <i className="ph ph-arrow-u-up-left" aria-hidden="true" />Restore</button>}
        {props.onRemove && <span className="ar-more-anchor">
          <button type="button" className="p-iconbtn ar-more" data-popover-trigger="archive-menu" title="More: remove from Ariadne" aria-label={`More for ${row.name}`} aria-haspopup="menu" aria-expanded={open === row.id}
            ref={element => { if (element) buttons.current.set(row.id, element); else buttons.current.delete(row.id); }}
            onClick={event => { setKeyboard(event.detail === 0); setOpen(current => current === row.id ? null : row.id); }}><i className="ph ph-dots-three" aria-hidden="true" /></button>
          {open === row.id && <PopMenu menuRef={menu} className="ar-menu" label={`${row.name} menu`} focusFirst={keyboard} onClose={close}
            items={[{ key: 'remove', icon: 'ph ph-trash', label: 'Remove from Ariadne…', sub: 'Ariadne forgets it; nothing is sent to an agent', danger: true, onSelect: () => props.onRemove!(row) }]} />}
        </span>}
      </div>)}
    </div>
  </section>;
}

export function ArchiveList(props: ArchiveListProps) {
  const { back, sub, sessions, topics } = props;
  return <PageColumn label="Archive">
    <PageHead back={back} title="Archive" sub={sub} />
    <Section label={`Sessions · ${sessions.length}`} rows={sessions} props={props} />
    <Section label={`Topics · ${topics.length}`} rows={topics} props={props} />
    <p className="pp-foot">Nothing here is sent to an agent. A restored session comes back closed; reopen it to answer in it.</p>
  </PageColumn>;
}
