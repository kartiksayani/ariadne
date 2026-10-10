import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AdapterConfig, ProjectSummary, SummaryCounts } from '../../generated/domain/models';
import type { NavigationSelection, SessionPreferences, SessionRef } from '../../generated/core';
import { plainFailure } from '../../data/plain';
import { useSession, type Immutable, type SessionStore } from '../../data/session-store';
import { NavigationStore, useNavigation, type LayoutChange, type NavigationState } from '../../state/navigation/store';
import { WaitingFrame } from '../../ui/waiting/WaitingColumn';
import { SessionActionControllers } from '../bindings/actions';
import { RegisterProject, BindSession } from './Registration';
import type { DiscoveryController } from '../../data/discovery';
import { Shell } from '../../ui/shell/Shell';
import type { HeaderProps } from '../../ui/shell/Header';
import { agentName, footerSummary, headerText, tabModels, type HeaderInput, type SessionFacts } from '../../ui/shell/model';
import type { RemoveHandler } from '../../ui/dialogs/remove';
import { ProjectsPage } from '../../ui/pages/ProjectsPage';
import { SessionLists, type SessionGroup } from '../../ui/pages/SessionLists';
import { LoadingSession } from '../../ui/pages/SessionStates';
import { Notices } from '../../ui/pages/notices';
import { useSessionSnapshots } from '../../ui/pages/snapshots';
import { useHidden } from '../../ui/remove/queue';
import { isRunning } from '../../ui/pages/model';
import '../../styles/navigation.css';

export interface AdapterChoice { readonly adapter_id: string; readonly label: string; readonly configuration: AdapterConfig;
  /** Socket path prefilled in the connect dialog for this adapter, when the app knows one. */
  readonly default_socket_path?: string }
export interface OpenedSessionView {
  readonly store: SessionStore;
  readonly preferences: Immutable<SessionPreferences> | null;
  readonly temporaryExpandedItemIds: readonly string[];
  readonly missingItemBanner: string | null;
}
export interface NavigationWorkspaceProps {
  readonly store: NavigationStore;
  readonly discovery?: DiscoveryController;
  readonly waitingContent?: ReactNode;
  readonly detail?: ReactNode;
  /** The detail header's breadcrumb. */
  readonly detailPath?: ReactNode;
  readonly railContent?: ReactNode;
  /** Header controls owned by the composition: search, views, rail and theme. */
  readonly chrome?: Omit<HeaderProps, 'text' | 'disabled'>;
  /** Facts for the selected session tab's header; null while it opens. */
  readonly session?: SessionFacts | null;
  readonly onCloseDetail?: () => void;
  /** The detail column's trash button: asks to remove the item it shows. */
  readonly onRemove?: () => void;
  readonly hidden?: boolean;
  readonly hiddenNotice?: string;
  readonly onHide?: () => void;
  /** Runs after the owner confirms a project or session Remove on the pages. Required: the triggers always render. */
  readonly onRemoveTarget: RemoveHandler;
  /** Session dispatch and lifecycle actions for the project page; one per app. */
  readonly actions?: SessionActionControllers;
  /** Clock for relative times; tests pin it. */
  readonly now?: () => number;
  readonly adapterChoices: readonly AdapterChoice[];
  readonly renderSession: (view: OpenedSessionView) => ReactNode;
}
const key = (route: SessionRef) => JSON.stringify([route.project_id, route.session_id]);
const projectName = (project: Immutable<ProjectSummary>) => project.project?.display_name ?? 'Unavailable project';
const partial = (counts: Immutable<SummaryCounts>) => counts.completeness === 'partial';
const running = isRunning;
const defaultChrome: Omit<HeaderProps, 'text' | 'disabled'> ={ query: '', views: null, railOn: false, theme: 'dark' };

/** Saved binding-connect receipt: what to give the host, plus capabilities the owner cannot rely on. */
function SetupCard({ setup, adapterId, onDismiss }: { setup: NonNullable<NavigationState['setup']>; adapterId: string | null; onDismiss: () => void }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (copied === 'idle') return undefined;
    const timer = setTimeout(() => setCopied('idle'), 3000);
    return () => clearTimeout(timer);
  }, [copied]);
  if (setup.data.kind !== 'binding_connect') return null;
  const instruction = setup.data.setup_instruction;
  const unavailable = Object.entries(setup.data.capabilities)
    .filter(([, value]) => typeof value === 'object' && !value.supported).map(([name]) => name.replace(/_/g, ' '));
  const copy = () => {
    try {
      void navigator.clipboard.writeText(instruction).then(() => setCopied('copied'), () => setCopied('failed'));
    } catch {
      setCopied('failed');
    }
  };
  return <section className="nav-banner nav-setup" aria-label="Session setup">
    <div className="nav-setup-head"><h2>Session connected</h2>
      <button type="button" className="btn btn-ghost btn-icon" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}><i className="ph ph-x" aria-hidden="true" /></button></div>
    <p>Connecting sent nothing to the model. {adapterId === 'codex'
      ? 'Paste this setup instruction into the selected Codex thread once per binding so the agent connects and uses the Ariadne skill. Installation also adds an Ariadne skill for Codex unless its link was skipped.'
      : adapterId === 'claude_code_mod'
        ? 'Run /ariadne-connect in the selected Claude conversation. Nothing to paste: the Mod reports the binding and the installed Ariadne skill holds the rules.'
        : 'Paste this setup instruction into the selected host conversation once per binding so the agent connects and uses the Ariadne skill.'}</p>
    {adapterId !== 'claude_code_mod' && <div className="nav-setup-code">
      <details><summary>Show instruction</summary><pre>{instruction}</pre></details>
      <div className="nav-setup-copy"><button type="button" className="btn btn-secondary" onClick={copy}>Copy instruction</button>
        <span role="status" className="nav-copied">{copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Copy failed' : ''}</span></div>
    </div>}
    {unavailable.length > 0 && <p>Unavailable capabilities: {unavailable.join(', ')}.</p>}
  </section>;
}

function SelectedSession({ navigation, renderSession }: { navigation: NavigationStore; renderSession: NavigationWorkspaceProps['renderSession'] }) {
  const state = useNavigation(navigation);
  const selected = state.preferences?.global.selected_navigation;
  const store = navigation.selectedSession();
  if (!store || selected?.kind !== 'session') return null;
  return <SessionView key={key(selected.session)} navigation={state} store={store} renderSession={renderSession} />;
}
function SessionView({ navigation, store, renderSession }: { navigation: NavigationState; store: SessionStore; renderSession: NavigationWorkspaceProps['renderSession'] }) {
  const session = useSession(store);
  const preferences = navigation.preferences?.sessions.find(view => key(view.session) === key(session.route)) ?? null;
  const reveal = navigation.reveal;
  const matchingReveal = reveal?.store === store ? reveal : null;
  // 1h: the skeleton stands in for the session until its first snapshot.
  if (session.status === 'loading' && !session.snapshot) return <LoadingSession />;
  return <>
    {session.error && <p role="alert">{plainFailure(session.error)}</p>}
    {session.snapshot?.session.state === 'closed' && <p className="nav-banner">{session.snapshot.session.archived_at != null ? 'Archived session · restore it, then reopen it to resume sending.' : 'Closed session · opening this tab does not resume dispatch.'}</p>}
    {matchingReveal?.kind === 'missing_item' && <p className="nav-banner" role="status">{matchingReveal.banner}</p>}
    {renderSession({ store, preferences, temporaryExpandedItemIds: matchingReveal?.kind === 'item' ? matchingReveal.temporaryExpandedItemIds : [],
      missingItemBanner: matchingReveal?.kind === 'missing_item' ? matchingReveal.banner : null })}
  </>;
}

export function NavigationWorkspace({ store, discovery, waitingContent, detail, detailPath, railContent, chrome, session, onCloseDetail, onRemove, hidden: hiddenItem, hiddenNotice, onHide, onRemoveTarget,
  actions: injectedActions, now = Date.now, adapterChoices, renderSession }: NavigationWorkspaceProps) {
  const state = useNavigation(store);
  const ownActions = useMemo(() => injectedActions ? null : new SessionActionControllers(store.service), [injectedActions, store]);
  const actions = injectedActions ?? ownActions!;
  const [registering, setRegistering] = useState(false);
  const [registrationRoot, setRegistrationRoot] = useState('');
  const [binding, setBinding] = useState<Immutable<ProjectSummary> | null>(null);
  const [refreshPending, setRefreshPending] = useState(false);
  // The composition that owns this injected store disposes it. A view mount
  // must not permanently stop a shared store during React's effect replay.
  useEffect(() => { void store.start(); }, [store]);
  const selection: Immutable<NavigationSelection> = state.preferences?.global.selected_navigation ?? { kind: 'projects' };
  // A pending project or session removal hides its cards and tabs until it runs or is undone.
  const hidden = useHidden();
  const projects = (state.projects?.projects.items ?? []).filter(project => !hidden.project(project.project_id));
  const projectId = selection.kind === 'project' ? selection.project_id : null;
  const matchingSessions = state.sessionProjectId === projectId ? state.sessions : null;
  const sessions = (matchingSessions?.sessions.items ?? []).filter(session => !hidden.session(session));
  const selectedProject = selection.kind === 'project' ? projects.find(project => project.project_id === selection.project_id) : null;
  const selectedSession = selection.kind === 'session' ? sessions.find(session => key(session) === key(selection.session)) : null;
  const mutationDisabled = refreshPending || state.writing || state.pendingOperationId !== null;
  const disabled = mutationDisabled || !state.preferences;
  const refresh = async () => {
    if (refreshPending) return;
    setRefreshPending(true);
    try { await store.refresh(); }
    finally { setRefreshPending(false); }
  };
  const select = (next: NavigationSelection) => { void store.navigate(next); };
  // Layout choices apply at once; the saved preferences catch up when the write lands.
  const [layout, setLayout] = useState<LayoutChange>({});
  const shown: LayoutChange = { detail_width: state.preferences?.global.detail_width, waiting_collapsed: state.preferences?.global.waiting_collapsed, ...layout };
  const saveLayout = (change: LayoutChange) => {
    setLayout(current => ({ ...current, ...change }));
    if (state.preferences) void store.saveLayout(change, state.preferences.revision);
  };
  const openViews: readonly Immutable<SessionPreferences>[] = state.preferences?.sessions.filter(view => view.tab_open && !hidden.session(view.session))
    .sort((a, b) => a.tab_order - b.tab_order || key(a.session).localeCompare(key(b.session))) ?? [];
  const archivedTab = (view: Immutable<SessionPreferences>) => {
    const summary = sessions.find(value => key(value) === key(view.session));
    return summary ? summary.archived_at != null : store.opened.get(view.session)?.getSnapshot().snapshot?.session.archived_at != null;
  };
  const unarchivedViews = openViews.filter(view => !archivedTab(view));
  const projectNameOf = (projectId: string) => { const project = projects.find(value => value.project_id === projectId); return project ? projectName(project) : 'Unavailable project'; };
  const at = now();
  const tabs = tabModels({ selection: selection.kind === 'project' ? 'projects' : selection.kind, projectCount: projects.length,
    sessions: openViews.map(view => {
      const summary = sessions.find(value => key(value) === key(view.session));
      return { id: key(view.session), archived: archivedTab(view), project: projectNameOf(view.session.project_id), agent: summary?.active_binding ? agentName(summary.active_binding.adapter_id) : null,
        where: summary?.active_binding?.host_location ?? null, naming: summary,
        createdAt: summary ? Date.parse(summary.created_at) : null, endedAt: summary ? Date.parse(summary.closed_at ?? summary.updated_at) : null, running: summary ? running(summary) : false,
        on: selection.kind === 'session' && key(selection.session) === key(view.session) };
    }) }, at);
  const selectTab = (id: string) => {
    if (id === 'projects' || id === 'all_sessions') { select({ kind: id }); return; }
    const view = openViews.find(value => key(value.session) === id);
    if (view) select({ kind: 'session', session: view.session });
  };
  const closeTab = (id: string) => { const view = openViews.find(value => key(value.session) === id); if (view) void store.closeTab(view.session); };
  const headerInput: HeaderInput = selection.kind === 'all_sessions'
    ? { kind: 'all_sessions', openTabs: unarchivedViews.length, openProjects: new Set(unarchivedViews.map(view => view.session.project_id)).size }
    : selection.kind === 'session' ? { kind: 'session', facts: session ?? null, fallbackAgent: selectedSession?.active_binding ? agentName(selectedSession.active_binding.adapter_id) : null }
      : { kind: 'projects', projectCount: projects.length, runningAgents: sessions.filter(running).length, projectPath: selectedProject?.canonical_root ?? null };
  const global = state.projects?.counts;
  const listing = selection.kind !== 'session';
  // Message counts, topic chips and remove counts come from each listed session's snapshot.
  const snapshots = useSessionSnapshots(listing ? store.service : null, listing ? sessions : []);
  const counts = selection.kind === 'projects' ? state.projects?.counts : matchingSessions?.counts;
  // The connect card belongs to the project page it was made on, directly under the project header,
  // and goes with its session: dismissed, removed (or pending removal), or another page shown.
  const setup = state.setup;
  const setupCard = setup?.data.kind === 'binding_connect' && selectedProject && selectedProject.project_id === state.setupProjectId
    && !sessions.some(summary => summary.session_id === setup.session_id && summary.archived_at != null)
    && !hidden.session({ project_id: selectedProject.project_id, session_id: setup.session_id })
    ? <SetupCard setup={setup} adapterId={state.setupAdapterId} onDismiss={() => store.dismissSetup()} /> : null;
  const openTabs = new Set(openViews.map(view => key(view.session)));
  const register = (root: string) => { setRegistrationRoot(root); setRegistering(true); };
  const openSession = (route: SessionRef) => select({ kind: 'session', session: route });
  const openProject = (id: string) => select({ kind: 'project', project_id: id });
  // All sessions (1z) lists the projects that have open tabs, in tab order.
  const openProjectIds = [...new Set(openViews.map(view => view.session.project_id))];
  const groups: readonly SessionGroup[] = selection.kind === 'project'
    ? selectedProject ? [{ project: selectedProject, openLink: false, extra: setupCard,
      tools: <button type="button" className="btn btn-ghost pw-group-link" disabled={disabled || selectedProject.availability !== 'available' || adapterChoices.length === 0}
        onClick={() => setBinding(selectedProject)}><i className="ph ph-plugs-connected" aria-hidden="true" />Connect existing session</button> }] : []
    : openProjectIds.flatMap(id => { const project = projects.find(value => value.project_id === id); return project ? [{ project, openLink: true }] : []; });
  const notes = <>
    {state.error && <div className="nav-banner" role="alert"><p>{plainFailure(state.error)}</p>
      {state.pendingOperationId ? <><p>Ariadne isn’t sure your last change was saved. Check before changing anything else.</p>
        <button type="button" className="btn btn-secondary" disabled={state.writing} onClick={() => { void store.retryMutation(); }}>Check again</button></>
        : <button type="button" className="btn btn-secondary" disabled={mutationDisabled} onClick={() => { void refresh(); }}>{refreshPending ? 'Refreshing…' : 'Refresh'}</button>}
    </div>}
    {state.status === 'loading' && <p className="pw-page-note" role="status">Loading registered projects and sessions…</p>}
    {state.status === 'stale' && <p className="pw-page-note" role="status">Showing the last complete catalogue. Refresh failed.</p>}
    {counts && partial(counts) && <p className="pw-page-note" role="status">Counts are incomplete. Unavailable sessions: {counts.unavailable_session_ids.join(', ') || 'not individually identified'}.</p>}
  </>;
  const sessionNote = selection.kind !== 'projects' && !matchingSessions
    && <p className="pw-page-note" role="status">{state.error ? 'Sessions are unavailable for this view.' : 'Loading sessions…'}</p>;
  const page = selection.kind === 'session' ? null : selection.kind === 'projects'
    ? <ProjectsPage projects={projects} sessions={sessions} snapshots={snapshots} now={at} discovered={state.status === 'ready' && state.preferences?.sessions.length === 0 && projects.length > 0}
      disabled={mutationDisabled} discovery={discovery} onOpen={openProject} onRegister={register} onRemove={onRemoveTarget}>
      {state.status === 'ready' && projects.length === 0 && <p className="pw-page-note">No registered projects. Register a project to connect an existing session.</p>}
    </ProjectsPage>
    : <SessionLists navigation={store} actions={actions} groups={groups} sessions={sessions} snapshots={snapshots} openTabs={openTabs} now={at} disabled={disabled}
      onBack={selection.kind === 'project' ? () => select({ kind: 'projects' }) : undefined}
      overview={selection.kind === 'all_sessions' ? { sub: openProjectIds.length
        ? `Every session in ${openProjectIds.map(projectNameOf).join(' and ')}` : 'Open a session from Projects to see it here.' } : undefined}
      onOpenProject={openProject} onOpenSession={openSession} onRemove={onRemoveTarget}>
      {sessionNote}
      {selection.kind === 'project' && !selectedProject && state.status === 'ready' && <p className="pw-page-note">This project is no longer registered.</p>}
    </SessionLists>;
  const center = <>
    <Notices />
    {page && <div className="pw-page-notes">{notes}</div>}
    {page ?? <div className="nav-content nav-session-content">{notes}<SelectedSession navigation={store} renderSession={renderSession} /></div>}
  </>;
  return <Shell header={{ ...defaultChrome,...chrome, text: headerText(headerInput, at), disabled }}
    tabs={{ tabs, disabled, onSelect: selectTab, onClose: closeTab }}
    body={{ waiting: waitingContent ?? <WaitingFrame count="–" loading />,
      center, detail, detailPath, rail: railContent, onCloseDetail, onRemove, hidden: hiddenItem, hiddenNotice, onHide,
      detailWidth: shown.detail_width ?? null, waitingFolded: shown.waiting_collapsed ?? false,
      onResizeDetail: width => saveLayout({ detail_width: width }), onFoldWaiting: folded => saveLayout({ waiting_collapsed: folded }) }}
    summary={footerSummary(global ? { items: Object.values(global.items_by_status).reduce((sum, count) => sum + count, 0), waiting: global.waiting_unanswered,
      inProgress: global.items_by_status.in_progress, open: global.items_by_status.open, archivedTopics: global.archived_topics } : null)} overlay={registering
      ? <RegisterProject store={store} initialRoot={registrationRoot} disabled={mutationDisabled} close={() => setRegistering(false)} />
      : binding ? <BindSession store={store} project={binding} sessions={sessions.filter(session => session.project_id === binding.project_id)}
        adapters={adapterChoices} discovery={discovery} disabled={mutationDisabled} close={() => setBinding(null)} /> : undefined} />;
}
