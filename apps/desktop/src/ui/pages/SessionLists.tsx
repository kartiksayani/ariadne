// Project page (1ac) and All sessions (1z), ported from Ariadne.dc.html:225-263.
import { useState, type ReactNode } from 'react';
import type { Immutable, SessionStore } from '../../data/session-store';
import type { SessionRef } from '../../generated/core';
import type { ProjectSummary, Session, SessionSummary } from '../../generated/domain/models';
import type { NavigationStore } from '../../state/navigation/store';
import type { SessionActionControllers } from '../../components/bindings/actions';
import { RemoveDialog } from '../dialogs/RemoveDialog';
import type { RemoveHandler, RemoveSubject, RemoveTarget } from '../dialogs/remove';
import { ownerName, sessionWhen } from '../shell/model';
import { RenameButton, SessionRename, saveSessionLabel } from '../shared/SessionRename';
import { CopySessionId } from '../shared/CopySessionId';
import type { RendererService } from '../../data/service';
import { plainFailure } from '../../data/plain';
import { useSupervisorHealth } from '../../components/bindings/health';
import '../../components/bindings/controls.css';
import { cardDispatch, continuationLinks, projectName, projectRemoval, routeOf, runOf, sessionCardText, sessionKey, sessionRemoval, topicChips, type TopicChip } from './model';
import { notices } from './notices';
import { CloseSessionDialog, DispatchDialog } from './SessionDialogs';
import './pages.css';

export interface SessionGroup {
  readonly project: Immutable<ProjectSummary>;
  /** All sessions: an "Open project" link beside the name. */
  readonly openLink: boolean;
  /** Under the group header, e.g. the connect-session setup card. */
  readonly extra?: ReactNode;
  /** Beside "Remove project", e.g. Connect existing session. */
  readonly tools?: ReactNode;
}
export interface SessionListsProps {
  readonly navigation: NavigationStore;
  readonly actions: SessionActionControllers;
  readonly groups: readonly SessionGroup[];
  readonly sessions: readonly Immutable<SessionSummary>[];
  readonly snapshots: ReadonlyMap<string, Immutable<Session>>;
  readonly openTabs: ReadonlySet<string>;
  readonly now: number;
  readonly disabled: boolean;
  /** Project page: "← Projects". */
  readonly onBack?: () => void;
  /** All sessions: the title and subtitle. */
  readonly overview?: { readonly sub: string };
  readonly onOpenProject: (projectId: string) => void;
  readonly onOpenSession: (route: SessionRef) => void;
  readonly onRemove: RemoveHandler;
  readonly children?: ReactNode;
}

type Dialog = { kind: 'dispatch' | 'close'; store: SessionStore; agent: string; when: string; name: string | null }
  | { kind: 'remove'; subject: RemoveSubject; target: RemoveTarget };

const failed = (error: unknown) => notices.push({ icon: 'ph ph-warning-circle', iconColor: 'var(--a-danger)', dismissible: true,
  text: plainFailure(error, 'The session could not be changed. Try again.') });

export function Chip({ chip }: { readonly chip: TopicChip }) {
  return <span className="pw-topic-chip" title={chip.full} style={{ color: chip.color }}><i className={chip.icon} aria-hidden="true" />{chip.name}
    {chip.counts && <span className="pw-topic-chip-counts">{chip.counts}</span>}</span>;
}

/** The card's sending state as a button that opens the sending and connection dialog. */
function CardRun({ summary, service, onClick }: { readonly summary: Immutable<SessionSummary>; readonly service: RendererService; readonly onClick: () => void }) {
  const binding = summary.active_binding;
  const run = runOf(cardDispatch(summary, useSupervisorHealth(service, binding?.id, binding?.generation)));
  return <button type="button" className="pw-run dispatch-card" data-dispatch={run.dispatch.kind} style={{ color: run.runColor }}
    title="Sending and connection" onClick={onClick}>
    <span className="pw-dot" style={{ background: run.runDot, boxShadow: run.runRing }} />{run.run}</button>;
}

export function SessionLists(props: SessionListsProps) {
  const { navigation, actions, groups, sessions, snapshots, openTabs, now, disabled, onBack, overview, onOpenProject, onOpenSession, onRemove, children } = props;
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** The key of the card whose name is being edited. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const links = continuationLinks([...snapshots.values()]);
  /** Opens the session's reader and waits for its snapshot. */
  const ready = async (route: SessionRef) => {
    const store = navigation.opened.open(route);
    await store.refresh();
    const state = store.getSnapshot();
    if (state.error) throw state.error;
    if (!state.snapshot) throw new Error('The session could not be read.');
    return { store, session: state.snapshot.session, controller: actions.forSession(store) };
  };
  const lifecycle = async (summary: Immutable<SessionSummary>, kind: 'session_close' | 'session_reopen') => {
    const route = routeOf(summary), key = sessionKey(summary);
    if (busy) return;
    setBusy(key);
    try {
      const { store, session, controller } = await ready(route);
      const agent = sessionCardText(summary, null, now).agent, when = sessionWhen(Date.parse(summary.created_at), now);
      // Close is one confirmation in plain words; Reopen runs at once.
      if (kind === 'session_close') { setDialog({ kind: 'close', store, agent, when, name: ownerName(session) }); return; }
      const done = await controller.execute({ command: kind, api_version: 1, op_id: '', params: { expected_revision: session.revision } }, session.revision);
      if (!done) failed(controller.getSnapshot().error ?? new Error('The session could not be reopened.'));
      await navigation.refresh();
    } catch (error: unknown) { failed(error); }
    finally { setBusy(null); }
  };
  const dispatch = (summary: Immutable<SessionSummary>) => {
    const route = routeOf(summary), store = navigation.opened.open(route);
    setDialog({ kind: 'dispatch', store, agent: sessionCardText(summary, null, now).agent, when: sessionWhen(Date.parse(summary.created_at), now), name: ownerName(summary) });
  };
  /** Saves the owner's name and description through the session's write barrier; the error in plain words, or null once saved. */
  const rename = async (summary: Immutable<SessionSummary>, name: string, description: string) => {
    try {
      const { session, controller } = await ready(routeOf(summary));
      const failure = await saveSessionLabel(controller, session.revision, name, description);
      await navigation.refresh();
      if (failure === null) setRenaming(null);
      return failure;
    } catch (error: unknown) { return plainFailure(error, 'The name could not be saved. Try again.'); }
  };
  const removeSession = (summary: Immutable<SessionSummary>) => {
    const counts = sessionRemoval(snapshots.get(sessionKey(summary)) ?? null, links.shared);
    setDialog({ kind: 'remove', target: { kind: 'session', session: routeOf(summary) },
      subject: { kind: 'session', agent: sessionCardText(summary, null, now).agent, when: sessionWhen(Date.parse(summary.created_at), now),
        name: ownerName(summary), ...counts } });
  };
  const removeProject = (project: Immutable<ProjectSummary>) => {
    const own = sessions.filter(session => session.project_id === project.project_id);
    const counts = projectRemoval(own.flatMap(session => snapshots.get(sessionKey(session)) ?? []));
    setDialog({ kind: 'remove', target: { kind: 'project', project_id: project.project_id },
      subject: { kind: 'project', name: projectName(project), path: project.canonical_root, sessions: own.length, ...counts } });
  };
  const card = (summary: Immutable<SessionSummary>) => {
    const key = sessionKey(summary), snapshot = snapshots.get(key) ?? null, text = sessionCardText(summary, snapshot, now, summary.active_binding?.host_location ?? null);
    const chips = snapshot ? topicChips(snapshot, links.movedOn) : [], open = openTabs.has(key), route = routeOf(summary);
    const off = disabled || busy === key, editing = renaming === key;
    return <div key={key} className="pw-session-card" style={{ background: text.background }} data-session-card={summary.session_id}>
      <div className="pw-session-row">
        <i className="ph ph-terminal-window pw-session-icon" aria-hidden="true" />
        {editing
          ? <div className="pw-session-text"><SessionRename layout="card" naming={summary} onSave={(name, description) => rename(summary, name, description)}
            onCancel={() => setRenaming(null)} /></div>
          : <div className="pw-session-text"><span className="pw-session-title" style={{ color: text.titleColor }}>{text.title}</span>
            {text.description && <span className="pw-session-description" style={{ color: text.titleColor }}>{text.description}</span>}
            {text.secondary && <span className="pw-session-secondary">{text.secondary}</span>}
            <span className="pw-session-meta">{text.meta}</span></div>}
        <CardRun summary={summary} service={actions.service} onClick={() => dispatch(summary)} />
        <span className="pw-session-actions">
          <CopySessionId sessionId={summary.session_id} className="btn btn-ghost pw-card-button" />
          {text.closed
            ? <button type="button" className="btn btn-secondary pw-card-button" disabled={off} onClick={() => { void lifecycle(summary, 'session_reopen'); }}>
              <i className="ph ph-arrow-counter-clockwise" aria-hidden="true" />Reopen</button>
            : <>
              <button type="button" className={`btn ${open ? 'btn-secondary' : 'btn-primary'} pw-card-button`} disabled={disabled} data-session-id={summary.session_id}
                onClick={() => onOpenSession(route)}>
                <i className={open ? 'ph ph-arrow-right' : 'ph ph-plus'} aria-hidden="true" />{open ? 'Go to tab' : 'Open in a tab'}</button>
              <button type="button" className="btn btn-ghost pw-card-button" disabled={off} title="Mark this session Closed in Ariadne. The agent process isn’t touched."
                onClick={() => { void lifecycle(summary, 'session_close'); }}><i className="ph ph-x-circle" aria-hidden="true" />Close session</button>
            </>}
          <RenameButton className="btn btn-ghost pw-card-button" disabled={editing || disabled} onClick={() => setRenaming(key)} />
          <button type="button" className="btn btn-ghost pw-card-button" onClick={() => removeSession(summary)}><i className="ph ph-trash" aria-hidden="true" />Remove</button>
        </span>
      </div>
      {chips.length > 0 && <div className="pw-topic-chips">{chips.map(chip => <Chip key={chip.id} chip={chip} />)}</div>}
    </div>;
  };
  return <div className="pw-page pw-session-lists">
    {onBack && <div><button type="button" className="btn btn-ghost pw-back" onClick={onBack}><i className="ph ph-arrow-left" aria-hidden="true" />Projects</button></div>}
    {overview && <div className="pw-page-title"><h1 className="pw-page-name">All sessions</h1><span className="pw-page-sub">{overview.sub}</span></div>}
    {groups.map(({ project, openLink, extra, tools }) => {
      const own = sessions.filter(session => session.project_id === project.project_id);
      const active = own.filter(session => session.state !== 'closed'), closed = own.filter(session => session.state === 'closed');
      return <section key={project.project_id} className="pw-session-group" aria-label={projectName(project)}>
        <div className="pw-group-head">
          <i className="ph ph-folder-simple pw-group-icon" aria-hidden="true" />
          {overview ? <h2 className="pw-group-name">{projectName(project)}</h2> : <h1 className="pw-group-name">{projectName(project)}</h1>}
          <span className="pw-group-path">{project.canonical_root}</span>
          {openLink && <button type="button" className="btn btn-ghost pw-group-link" onClick={() => onOpenProject(project.project_id)}>Open project</button>}
          <span className="pw-group-tools">{tools}
            <button type="button" className="btn btn-ghost pw-group-remove" onClick={() => removeProject(project)}><i className="ph ph-trash" aria-hidden="true" />Remove project</button></span>
        </div>
        {extra}
        {project.availability === 'unavailable' && <div className="pw-page-note">This project’s folder is unavailable. Check local access, then refresh.</div>}
        {active.length > 0 && <><h3 className="pw-group-label">{`Active sessions · ${active.length}`}</h3>{active.map(card)}</>}
        {closed.length > 0 && <><h3 className="pw-group-label pw-group-label-closed">{`Closed · ${closed.length}`}</h3>{closed.map(card)}</>}
      </section>;
    })}
    {children}
    {dialog?.kind === 'dispatch' && <DispatchDialog store={dialog.store} actions={actions.forSession(dialog.store)} agent={dialog.agent}
      onClose={() => { setDialog(null); void navigation.refresh(); }} />}
    {dialog?.kind === 'close' && <CloseSessionDialog store={dialog.store} actions={actions.forSession(dialog.store)} agent={dialog.agent} when={dialog.when} name={dialog.name}
      onClose={() => { setDialog(null); void navigation.refresh(); }} />}
    {dialog?.kind === 'remove' && <RemoveDialog subject={dialog.subject} onCancel={() => setDialog(null)} onConfirm={() => onRemove(dialog.target, dialog.subject)} />}
  </div>;
}
