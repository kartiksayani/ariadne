// All sessions and a project's page (SPEC 5.14, 15.2): the rows' Rename, Close and Reopen go through the session's
// lifecycle (C3, SessionRowAction); Archive and Restore keep their receipts and Undo here (useSessionArchive).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Immutable, SessionStore } from '../../data/session-store';
import type { SessionRef } from '../../generated/core';
import type { ProjectSummary, SessionSummary } from '../../generated/domain/models';
import type { NavigationStore } from '../../state/navigation/store';
import type { SessionActionControllers } from '../../components/bindings/actions';
import { ownerDescription, ownerName, sessionPhrase, sessionWhen } from '../shell/model';
import { plainFailure } from '../../data/plain';
import '../../components/bindings/controls.css';
import { agentOf, sessionKey } from './model';
import { notices } from './notices';
import { ArchiveSessionDialog, DispatchDialog } from './SessionDialogs';
import { closeImpact } from '../../components/history-actions/selectors';
import { waitForLifecycleReady } from '../shared/lifecycleReady';
import { isViewConflict } from '../shared/conflictNotice';
import { SessionsList } from './SessionsList';
import { SessionRowAction, type RowAct } from './SessionRowAction';
import type { PageBack, PageSession } from './page-types';
import { inTab, sessionGroups, type SessionsTabValue } from '../../components/navigation/pageData';
import './pages.css';

type Dialog = { kind: 'dispatch' | 'archive'; store: SessionStore; agent: string; summary?: Immutable<SessionSummary>; onSaved?: () => void };

const sessionFailure = (summary: Immutable<SessionSummary>, now: number, error: unknown, fallback?: string) =>
  `For ${sessionPhrase(summary, agentOf(summary), sessionWhen(Date.parse(summary.created_at), now))}: ${plainFailure(error, fallback)}`;
const failed = (summary: Immutable<SessionSummary>, now: number, error: unknown, fallback = 'The session could not be changed. Try again.') => notices.push({ id: `session-lifecycle-failed:${sessionKey(summary)}`, icon: 'ph ph-warning-circle', iconColor: 'var(--a-danger)', dismissible: true,
  text: sessionFailure(summary, now, error, fallback) });

/** The receipt outlives this page; dismiss it only after an authoritative restore. */
function watchArchiveNotice(store: SessionStore, navigation: NavigationStore, id: string, restored: () => void) {
  const { route, snapshot } = store.getSnapshot(), revision = snapshot?.session.revision ?? 0;
  const stop = () => { stopSession(); stopNavigation(); stopNotices(); };
  const dismiss = () => { restored(); notices.dismiss(id); stop(); };
  const stopSession = store.subscribe(() => {
    const state = store.getSnapshot();
    if (state.status === 'ready' && !state.error && state.snapshot && state.snapshot.session.revision >= revision
        && state.snapshot.session.archived_at == null) dismiss();
  });
  const stopNavigation = navigation.subscribe(() => {
    const state = navigation.getSnapshot();
    const summary = state.sessions?.sessions.items.find(session => session.project_id === route.project_id && session.session_id === route.session_id);
    if (state.status === 'ready' && !state.error && summary && summary.revision >= revision && summary.archived_at == null) dismiss();
  });
  const stopNotices = notices.subscribe(() => { if (!notices.getSnapshot().some(notice => notice.id === id)) stop(); });
}

export interface SessionArchiveOptions {
  readonly navigation: NavigationStore;
  readonly actions: SessionActionControllers;
  readonly now: number;
  readonly disabled: boolean;
}
export interface SessionArchive {
  /** The key of the session whose change is running. */
  readonly busy: string | null;
  readonly archive: (summary: Immutable<SessionSummary>) => Promise<boolean>;
  /** Restores an archived session (closed, or reopened with `reopen`); says so in a notice. */
  readonly restore: (summary: Immutable<SessionSummary>, reopen?: boolean) => Promise<boolean>;
  readonly dialogs: ReactNode;
}

/** Archive and restore a listed session: confirm when needed, then a receipt with Undo that outlives the page. */
export function useSessionArchive({ navigation, actions, now, disabled }: SessionArchiveOptions): SessionArchive {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const lifecycleBusy = useRef(false);
  const waiting = useRef<{ cancel: () => void } | null>(null);
  useEffect(() => () => { waiting.current?.cancel(); }, []);
  const [busy, setBusy] = useState<string | null>(null);
  const announceRestored = (summary: Immutable<SessionSummary>, reopen: boolean) => {
    const name = ownerName(summary), subject = name ? `“${name}”` : sessionPhrase(summary, agentOf(summary), sessionWhen(Date.parse(summary.created_at), now));
    notices.dismiss(`session-archive:${summary.project_id}:${summary.session_id}`);
    notices.dismiss(`session-lifecycle-failed:${sessionKey(summary)}`);
    notices.push({ id: `session-restored:${sessionKey(summary)}`, icon: 'ph ph-arrow-counter-clockwise', dismissible: true,
      text: reopen ? `Restored and reopened ${subject}.` : `Restored ${subject}; it stays closed.` });
  };
  const announceArchive = (summary: Immutable<SessionSummary>, wasActive: boolean, controller: ReturnType<SessionActionControllers['forSession']>) => {
    setDialog(null);
    const receipt = controller.getSnapshot().receipt;
    const data = receipt && 'data' in receipt ? receipt.data : undefined;
    const cancelled = data?.kind === 'session_lifecycle' ? data.cancelled_input_ids?.length ?? 0 : 0;
    const name = ownerName(summary), subject = name ? `“${name}”` : sessionPhrase(summary, agentOf(summary), sessionWhen(Date.parse(summary.created_at), now));
    let used = false, restoring = false;
    const id = `session-archive:${summary.project_id}:${summary.session_id}`;
    const text = `Archived${wasActive ? ' and closed' : ''} ${subject}.${cancelled ? ` ${cancelled} unsent message${cancelled === 1 ? ' was' : 's were'} cancelled.${wasActive ? ' Undo resumes sending, even if you paused it.' : ''} Cancelled messages stay cancelled.` : ''}`;
    const show = (error?: string) => { if (used) return; notices.push({ id, icon: error ? 'ph ph-warning-circle' : 'ph ph-archive',
      ...(error ? { iconColor: 'var(--a-danger)' } : {}), text: error ?? text, dismissible: true,
      actions: [{ label: controller.getSnapshot().pending?.command.command === 'session_restore' ? 'Check again' : 'Undo', run: undo }] }); };
    const undo = async () => {
      if (used || restoring) return;
      restoring = true;
      const report = (error: unknown, fallback?: string) => show(sessionFailure(summary, now, error, fallback));
      try {
        if (controller.getSnapshot().pending?.command.command === 'session_restore') {
          if (await controller.retry()) { setDialog(null); announceRestored(summary, wasActive); used = true; await navigation.refresh(); }
          else report(controller.getSnapshot().error);
        } else if (await lifecycle(summary, 'session_restore', wasActive, report)) { used = true; notices.dismiss(id); }
      } catch (error: unknown) { report(error); }
      finally { restoring = false; }
    };
    show();
    watchArchiveNotice(controller.session, navigation, id, () => { used = true; });
    void navigation.refresh();
  };
  const lifecycle = async (summary: Immutable<SessionSummary>, kind: 'session_archive' | 'session_restore', reopen = false,
    onFailure?: (error: unknown, fallback?: string) => void): Promise<boolean> => {
    const route: SessionRef = { project_id: summary.project_id, session_id: summary.session_id }, key = sessionKey(summary);
    const report = onFailure ?? ((error: unknown, fallback?: string) => failed(summary, now, error, fallback));
    if (lifecycleBusy.current || disabled) {
      report(null, kind === 'session_restore'
        ? 'The session could not be restored while another change is finishing. Try again.'
        : 'Ariadne is finishing another change. Try again.');
      return false;
    }
    lifecycleBusy.current = true;
    setBusy(key);
    let cancel!: () => void;
    const cancellation = new Promise<boolean>(resolve => { cancel = () => { attempt.cancelled = true; resolve(false); }; });
    const attempt = { cancelled: false, cancellation, cancel };
    waiting.current = attempt;
    try {
      const store = navigation.opened.open(route), controller = actions.forSession(store);
      const readiness = await waitForLifecycleReady(controller, attempt, true);
      if (!readiness.ok) { if (readiness.error) report(null, readiness.error); return false; }
      const session = readiness.session;
      if (kind === 'session_restore' && session.archived_at == null) { notices.dismiss(`session-archive:${summary.project_id}:${summary.session_id}`); return true; }
      const agent = agentOf(summary);
      if (kind === 'session_archive') {
        const impact = closeImpact(session);
        if (session.state === 'active' || impact.questions + impact.unsent + impact.delivering) { setDialog({ kind: 'archive', store, agent, summary }); return false; }
      }
      const done = await controller.execute({ command: kind, api_version: 1, op_id: '', params: { expected_revision: session.revision, ...(kind === 'session_restore' && reopen ? { reopen: true } : {}) } }, session.revision);
      if (!done) {
        if (controller.getSnapshot().pending) setDialog({ kind: kind === 'session_archive' ? 'archive' : 'dispatch', store, agent, summary,
          onSaved: kind === 'session_restore' ? () => { setDialog(null); announceRestored(summary, reopen); void navigation.refresh(); } : undefined });
        if (onFailure || !controller.getSnapshot().pending && !isViewConflict(controller.getSnapshot().error)) report(controller.getSnapshot().error ?? new Error('The session could not be changed.'));
      }
      if (done && kind === 'session_archive') announceArchive(summary, session.state === 'active', controller);
      if (done && kind === 'session_restore') announceRestored(summary, reopen);
      await navigation.refresh();
      return done;
    } catch (error: unknown) { report(error); return false; }
    finally { waiting.current = null; lifecycleBusy.current = false; if (!attempt.cancelled) setBusy(null); }
  };
  const dialogs = <>
    {dialog?.kind === 'dispatch' && <DispatchDialog store={dialog.store} actions={actions.forSession(dialog.store)} agent={dialog.agent} onSaved={dialog.onSaved}
      onClose={() => { setDialog(null); void navigation.refresh(); }} />}
    {dialog?.kind === 'archive' && <ArchiveSessionDialog store={dialog.store} actions={actions.forSession(dialog.store)}
      agent={dialog.agent} onClose={() => setDialog(null)} onSaved={wasActive => announceArchive(dialog.summary!, wasActive, actions.forSession(dialog.store))} />}
  </>;
  return { busy, archive: summary => lifecycle(summary, 'session_archive'), restore: (summary, reopen = false) => lifecycle(summary, 'session_restore', reopen), dialogs };
}

export interface SessionListsProps {
  readonly navigation: NavigationStore;
  readonly actions: SessionActionControllers;
  /** All sessions: every project; a project's page: that one. */
  readonly projects: readonly Immutable<ProjectSummary>[];
  readonly sessions: readonly Immutable<SessionSummary>[];
  /** A project's page: its name is the title, and there are no tabs. */
  readonly single?: boolean;
  readonly currentSession?: SessionRef | null;
  readonly now: number;
  readonly narrow: boolean;
  readonly disabled: boolean;
  readonly back?: PageBack;
  readonly onOpenArchive?: () => void;
  readonly onOpenSession: (route: SessionRef) => void;
  /** Under the page head, above the sessions: the connect-session setup card. */
  readonly notes?: ReactNode;
  /** Under the list, inside the page column: catalogue notes, the connect-existing link. */
  readonly children?: ReactNode;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

export function SessionLists({ navigation, actions, projects, sessions, single = false, currentSession, now, narrow, disabled, back, onOpenArchive, onOpenSession, notes, children }: SessionListsProps) {
  const [tab, setTab] = useState<SessionsTabValue>('all');
  const [acting, setActing] = useState<{ summary: Immutable<SessionSummary>; act: RowAct } | null>(null);
  const archive = useSessionArchive({ navigation, actions, now, disabled });
  const listed = sessions.filter(summary => projects.some(project => project.project_id === summary.project_id));
  const summaryOf = (row: PageSession<SessionRef>) => listed.find(summary => sessionKey(summary) === sessionKey(row.route));
  const act = (kind: RowAct) => (row: PageSession<SessionRef>) => {
    const summary = summaryOf(row);
    if (!summary || disabled || acting || archive.busy) return;
    setActing({ summary, act: kind });
  };
  const open = listed.filter(summary => summary.archived_at == null);
  const shownTab = single ? 'all' : tab;
  const project = single ? projects[0] : undefined;
  const title = project ? project.project?.display_name ?? 'Unavailable project' : 'All sessions';
  // "6 sessions in 3 projects": the projects the listed sessions are in, not every registered one (SPEC 14.2).
  const sub = single ? (open.length ? plural(open.length, 'session') : 'No sessions')
    : `${plural(open.length, 'session')} in ${plural(new Set(open.map(summary => summary.project_id)).size, 'project')}`;
  const counts = { open: listed.filter(summary => inTab(summary, 'open')).length, closed: listed.filter(summary => inTab(summary, 'closed')).length, all: open.length };
  const store = acting ? navigation.opened.open({ project_id: acting.summary.project_id, session_id: acting.summary.session_id }) : null;
  return <>
    <SessionsList<SessionRef> narrow={narrow} back={back} title={title} sub={sub}
      tabs={single ? undefined : { value: tab, counts, onChange: setTab }}
      groups={sessionGroups(projects, listed, shownTab, now, currentSession, single, onOpenArchive)}
      // While navigation is held (a Refresh, a save) a row opens nothing, as Rename, Close and Archive wait too.
      onOpen={row => { if (!disabled) onOpenSession(row.route); }} onRename={act('rename')} onClose={act('close')}
      onArchive={row => { const summary = summaryOf(row); if (summary && !acting) void archive.archive(summary); }}
      notes={notes}>{children}</SessionsList>
    {acting && store && <SessionRowAction key={`${sessionKey(acting.summary)}:${acting.act}`} actions={actions.forSession(store)} act={acting.act}
      naming={{ name: ownerName(acting.summary) ?? '', description: ownerDescription(acting.summary) ?? '',
        unnamedAs: acting.summary.title }}
      onDone={() => { setActing(null); void navigation.refresh(); }} />}
    {archive.dialogs}
  </>;
}
