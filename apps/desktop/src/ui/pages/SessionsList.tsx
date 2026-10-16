// All sessions (SPEC 5.14): grouped by project, Open / Closed / All, and a row of actions on each session: Rename, Copy
// session ID, Close or Reopen, Archive. Pure props in, callbacks out (contract C8).
import { RunDot, WaitPill } from '../parts/parts';
import { PageColumn, PageHead } from './PageHead';
import { SESSION_TABS } from './sessionTabs';
import type { PageSession, SessionGroupData, SessionsListProps } from './page-types';
import './sessions.css';

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

function Row<R>({ session, narrow, props }: { readonly session: PageSession<R>; readonly narrow: boolean; readonly props: SessionsListProps<R> }) {
  const closed = session.run === 'closed';
  const status = session.status ? (narrow ? `${session.agent} · ${session.status}` : session.status) : '';
  return <div className={session.current ? 'sl-row sl-current' : 'sl-row'}>
    <span className="sl-who">
      <RunDot run={session.run} />
      <button type="button" className={closed ? 'sl-name sl-name-closed' : 'sl-name'} data-session-id={session.id} onClick={() => props.onOpen(session)}>{session.name}</button>
      {session.current && <span className="pp-tag">Current</span>}
    </span>
    {!narrow && <span className="sl-agent">{session.agent}</span>}
    <span className="sl-status">{status}</span>
    <span className="sl-wait">{session.waiting > 0 && <WaitPill count={session.waiting} label={`${plural(session.waiting, 'question')} waiting on you`} />}</span>
    <span className="sl-acts">
      <button type="button" className="p-iconbtn sl-act" title="Rename" aria-label={`Rename ${session.name}`} onClick={() => props.onRename(session)}><i className="ph ph-pencil-simple" aria-hidden="true" /></button>
      {/* SPEC 14.2: a closed row keeps Close, greyed; Reopen and Copy ID live on the connection card of the opened session. */}
      <button type="button" className="p-iconbtn sl-act" title={closed ? 'Already closed' : 'Close session'} aria-label={`Close ${session.name}`}
        disabled={closed} onClick={() => props.onClose(session)}><i className="ph ph-x-circle" aria-hidden="true" /></button>
      <button type="button" className="p-iconbtn sl-act" title="Archive session" aria-label={`Archive ${session.name}`} onClick={() => props.onArchive(session)}><i className="ph ph-archive" aria-hidden="true" /></button>
    </span>
  </div>;
}

function Group<R>({ group, narrow, props }: { readonly group: SessionGroupData<R>; readonly narrow: boolean; readonly props: SessionsListProps<R> }) {
  return <section className="sl-group" aria-label={group.name}>
    <div className="sl-ghead"><i className="ph ph-folder-simple" aria-hidden="true" /><h2 className="sl-gname">{group.name}</h2><span className="sl-gpath">{group.path}</span></div>
    <div className={narrow ? 'sl-box sl-narrow' : 'sl-box'}>
      {group.sessions.map((session, index) => <Row key={`${index}:${session.name}`} session={session} narrow={narrow} props={props} />)}
      {group.sessions.length === 0 && group.empty && <div className="sl-empty">
        <span className="sl-empty-title"><i className="ph ph-terminal-window" aria-hidden="true" />{group.empty.title}</span>
        <span className="sl-empty-text">{group.empty.text}</span>
        {group.empty.action && <button type="button" className="p-btn sl-empty-act" onClick={group.empty.action.onClick}><i className="ph ph-archive" aria-hidden="true" />{group.empty.action.label}</button>}
      </div>}
    </div>
  </section>;
}

export function SessionsList<R>(props: SessionsListProps<R>) {
  const { narrow, back, title, sub, tabs, groups, notes, children } = props;
  return <PageColumn label={title}>
    <PageHead back={back} title={title} sub={sub}>
      {tabs && <span className="pp-segs" role="group" aria-label="Show">
        {SESSION_TABS.map(tab => <button type="button" className="pp-seg" key={tab.id} aria-pressed={tabs.value === tab.id} onClick={() => tabs.onChange(tab.id)}>
          {tab.label}<span className="pp-seg-n">{tabs.counts[tab.id]}</span>
        </button>)}
      </span>}
    </PageHead>
    {notes}
    {groups.map(group => <Group key={group.id} group={group} narrow={narrow} props={props} />)}
    {children}
  </PageColumn>;
}
