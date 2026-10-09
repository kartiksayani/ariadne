// Project page (1ac) and All sessions (1z), ported from Ariadne.dc.html:225-263.
import { useRef, useState, type ReactNode } from 'react';
import type { Immutable, SessionStore } from '../../data/session-store';
import type { SessionRef } from '../../generated/core';
import type { ProjectSummary, Session, SessionSummary } from '../../generated/domain/models';
import { useNavigation, type NavigationStore } from '../../state/navigation/store';
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
import { ArchiveSessionDialog, CloseSessionDialog, DispatchDialog } from './SessionDialogs';
import { closeImpact } from '../../components/history-actions/selectors';
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

type Dialog = { kind: 'dispatch' | 'close' | 'archive'; store: SessionStore; agent: string; when: string; name: string | null; summary?: Immutable<SessionSummary>; onSaved?: () => void }
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
  const lifecycleBusy = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  /** The key of the card whose name is being edited. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const state = useNavigation(navigation);
  const expanded = state.preferences?.global.session_archive_expanded_project_ids ?? [];
  const fold = (projectId: string) => {
    if (!state.preferences || disabled) return;
    const ids = expanded.includes(projectId) ? expanded.filter(id => id !== projectId) : [...expanded, projectId];
    void navigation.saveLayout({ session_archive_expanded_project_ids: ids }, state.preferences.revision);
  };
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
  const announceRestored = (summary: Immutable<SessionSummary>, reopen: boolean) => {
    const name = ownerName(summary), subject = name ? `“${name}”` : 'the session';
    notices.push({ icon: 'ph ph-arrow-counter-clockwise', dismissible: true,
      text: reopen ? `Restored and reopened ${subject}.` : `Restored ${subject}; it stays closed.` });
  };
  const announceArchive = (summary: Immutable<SessionSummary>, wasActive: boolean, controller: ReturnType<SessionActionControllers['forSession']>) => {
    setDialog(null);
    const receipt = controller.getSnapshot().receipt;
    const data = receipt && 'data' in receipt ? receipt.data : undefined;
    const cancelled = data?.kind === 'session_lifecycle' ? data.cancelled_input_ids?.length ?? 0 : 0;
    const name = ownerName(summary), subject = name ? `“${name}”` : 'the session';
    let used = false;
    const id = notices.push({ icon: 'ph ph-archive', text: `Archived${wasActive ? ' and closed' : ''} ${subject}.${cancelled ? ` ${cancelled} unsent message${cancelled === 1 ? ' was' : 's were'} cancelled.` : ''}`, dismissible: true,
      actions: [{ label: 'Undo', run: () => {
        if (used) return;
        used = true;
        notices.dismiss(id);
        void lifecycle(summary, 'session_restore', wasActive, receipt && 'revision' in receipt ? receipt.revision : undefined);
      } }] }, 8000);
    void navigation.refresh();
  };
  const lifecycle = async (summary: Immutable<SessionSummary>, kind: 'session_close' | 'session_reopen' | 'session_archive' | 'session_restore', reopen = false, expectedRevision?: number): Promise<boolean> => {
    const route = routeOf(summary), key = sessionKey(summary);
    if (lifecycleBusy.current || disabled) return false;
    lifecycleBusy.current = true;
    setBusy(key);
    try {
      const { store, session, controller } = await ready(route);
      const agent = sessionCardText(summary, null, now).agent, when = sessionWhen(Date.parse(summary.created_at), now);
      // Reconcile the controller's existing action before offering a different one.
      if (controller.getSnapshot().pending) {
        setDialog({ kind: 'dispatch', store, agent, when, name: ownerName(session) });
        return false;
      }
      // Close is one confirmation in plain words; Reopen runs at once.
      if (kind === 'session_close') { setDialog({ kind: 'close', store, agent, when, name: ownerName(session) }); return false; }
      if (kind === 'session_archive') {
        const impact = closeImpact(session);
        if (session.state === 'active' || impact.questions + impact.unsent + impact.delivering) { setDialog({ kind: 'archive', store, agent, when, name: ownerName(session), summary }); return false; }
      }
      const done = await controller.execute({ command: kind, api_version: 1, op_id: '', params: { expected_revision: expectedRevision ?? session.revision, ...(kind === 'session_restore' && reopen ? { reopen: true } : {}) } }, expectedRevision ?? session.revision);
      if (!done) {
        if (controller.getSnapshot().pending) setDialog({ kind: kind === 'session_archive' ? 'archive' : 'dispatch', store, agent, when, name: ownerName(session), summary,
          onSaved: kind === 'session_restore' ? () => { setDialog(null); announceRestored(summary, reopen); void navigation.refresh(); } : undefined });
        else failed(controller.getSnapshot().error ?? new Error('The session could not be changed.'));
      }
      if (done && kind === 'session_archive') announceArchive(summary, session.state === 'active', controller);
      if (done && kind === 'session_restore') announceRestored(summary, reopen);
      await navigation.refresh();
      return done;
    } catch (error: unknown) { failed(error); return false; }
    finally { lifecycleBusy.current = false; setBusy(null); }
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
    const off = disabled || busy !== null, editing = renaming === key, archived = summary.archived_at != null;
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
          {archived
            ? <><button type="button" className="btn btn-secondary pw-card-button" disabled={disabled} onClick={() => onOpenSession(route)}>
              <i className="ph ph-arrow-right" aria-hidden="true" />{open ? 'Go to tab' : 'Open in a tab'}</button>
              <button type="button" className="btn btn-secondary pw-card-button" disabled={off} title="Restore this session; it stays closed." onClick={() => { void lifecycle(summary, 'session_restore'); }}>
                <i className="ph ph-arrow-counter-clockwise" aria-hidden="true" />Restore</button></>
            : text.closed
            ? <button type="button" className="btn btn-secondary pw-card-button" disabled={off} onClick={() => { void lifecycle(summary, 'session_reopen'); }}>
              <i className="ph ph-arrow-counter-clockwise" aria-hidden="true" />Reopen</button>
            : <>
              <button type="button" className={`btn ${open ? 'btn-secondary' : 'btn-primary'} pw-card-button`} disabled={disabled} data-session-id={summary.session_id}
                onClick={() => onOpenSession(route)}>
                <i className={open ? 'ph ph-arrow-right' : 'ph ph-plus'} aria-hidden="true" />{open ? 'Go to tab' : 'Open in a tab'}</button>
              <button type="button" className="btn btn-ghost pw-card-button" disabled={off} title="Mark this session Closed in Ariadne. The agent process isn’t touched."
                onClick={() => { void lifecycle(summary, 'session_close'); }}><i className="ph ph-x-circle" aria-hidden="true" />Close session</button>
            </>}
          {!archived && <button type="button" className="btn btn-ghost pw-card-button" disabled={off} onClick={() => { void lifecycle(summary, 'session_archive'); }}>
            <i className="ph ph-archive" aria-hidden="true" />Archive</button>}
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
      const active = own.filter(session => session.archived_at == null && session.state !== 'closed'), closed = own.filter(session => session.archived_at == null && session.state === 'closed');
      const archived = own.filter(session => session.archived_at != null), unfolded = expanded.includes(project.project_id);
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
        {archived.length > 0 && <><h3 className="pw-group-label pw-group-label-closed"><button type="button" className="btn btn-ghost pw-archive-fold"
          aria-expanded={unfolded} disabled={disabled} onClick={() => fold(project.project_id)}>
          <i className={`ph ${unfolded ? 'ph-caret-down' : 'ph-caret-right'}`} aria-hidden="true" />{`Archived · ${archived.length}`}</button></h3>
          {unfolded && archived.map(card)}</>}
      </section>;
    })}
    {children}
    {dialog?.kind === 'dispatch' && <DispatchDialog store={dialog.store} actions={actions.forSession(dialog.store)} agent={dialog.agent} onSaved={dialog.onSaved}
      onClose={() => { setDialog(null); void navigation.refresh(); }} />}
    {dialog?.kind === 'close' && <CloseSessionDialog store={dialog.store} actions={actions.forSession(dialog.store)} agent={dialog.agent} when={dialog.when} name={dialog.name}
      onClose={() => { setDialog(null); void navigation.refresh(); }} />}
    {dialog?.kind === 'archive' && <ArchiveSessionDialog store={dialog.store} actions={actions.forSession(dialog.store)}
      agent={dialog.agent} onClose={() => setDialog(null)} onSaved={wasActive => announceArchive(dialog.summary!, wasActive, actions.forSession(dialog.store))} />}
    {dialog?.kind === 'remove' && <RemoveDialog subject={dialog.subject} onCancel={() => setDialog(null)} onConfirm={() => onRemove(dialog.target, dialog.subject)} />}
  </div>;
}
