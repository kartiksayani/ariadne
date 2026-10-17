import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AdapterConfig, ProjectSummary, SummaryCounts } from '../../generated/domain/models';
import type { SessionPreferences, SessionRef } from '../../generated/core';
import { plainFailure } from '../../data/plain';
import { CoreFailure } from '../../data/service';
import { useSession, type Immutable, type SessionStore } from '../../data/session-store';
import { NavigationStore, useNavigation, type LayoutChange, type NavigationState } from '../../state/navigation/store';
import { currentSession, NavigationProvider, viewOf, type PageName } from '../../state/navigation/view';
import { useIntents } from '../../ui/intents';
import { useDock } from '../../ui/dock/api';
import { SessionActionControllers } from '../bindings/actions';
import { RegisterProject, BindSession } from './Registration';
import type { DiscoveryController } from '../../data/discovery';
import { Shell } from '../../ui/shell/Shell';
import { DetailsColumn } from '../../ui/shell/DetailsColumn';
import { DetailsColumnProvider } from '../../state/details/column';
import type { ShellTheme } from '../../ui/shell/model';
import type { TextSize } from '../../ui/shell/textScale';
import { NARROW_BELOW } from '../../ui/topbar/model';
import { SwitcherMenu } from '../../ui/topbar/SwitcherMenu';
import { HelpPanel } from '../../ui/help/HelpPanel';
import { WorkspaceTopBar } from './WorkspaceTopBar';
import { WaitingStore, useWaiting } from '../../selectors/waiting/store';
import { switcherData } from '../../state/navigation/switcher';
import { ArchivePage } from '../../ui/pages/ArchivePage';
import type { RemoveHandler } from '../../ui/dialogs/remove';
import { ProjectsPage } from '../../ui/pages/ProjectsPage';
import { SessionLists } from '../../ui/pages/SessionLists';
import { FirstRun } from '../../ui/pages/FirstRun';
import { copyText } from '../../ui/shared/clipboard';
import { LoadingSession } from '../../ui/pages/SessionStates';
import { notices } from '../../ui/pages/notices';
import { conflictNotice, isViewConflict } from '../../ui/shared/conflictNotice';
import { useSessionSnapshots } from '../../ui/pages/snapshots';
import { useHidden } from '../../ui/remove/queue';
import { SessionLifecycleOwner } from '../../ui/shared/SessionLifecycleOwner';
import type { MapSearchStatus } from '../../ui/tree/mapSearch';
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
  /** The answer dock; it floats over the Map and Details. Absent on pages. */
  readonly dockContent?: ReactNode;
  readonly conversation?: ReactNode;
  readonly waitingStore?: WaitingStore;
  readonly detail?: ReactNode;
  /** The detail header's breadcrumb. */
  readonly detailPath?: ReactNode;
  /** The selected item's status icon, shown on the rail while Details is folded. */
  readonly detailRail?: ReactNode;
  /** Counts the owner's choices of an item to show; each one unfolds a folded Details column. */
  readonly detailAsked?: number;
  /** Told whenever Details folds or unfolds: a folded column's item is not being seen. */
  readonly onDetailsFolded?: (folded: boolean) => void;
  /** Top bar controls owned by the composition: search, views, filter, Recent, text size and theme. */
  readonly chrome?: WorkspaceChrome;
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
/** What the App gives the top bar for the session on screen. Absent controls show disabled. */
export interface WorkspaceChrome {
  readonly query: string;
  readonly onQueryChange?: (query: string) => void;
  /** The search box's × and esc: an explicit clear, saved at once. Falls back to an empty query. */
  readonly onClearSearch?: () => void;
  /** The Map's search in place: "2 of 4", the arrows and the "Also matching" note (ui/tree/mapSearch). */
  readonly searchStatus?: MapSearchStatus | null;
  readonly graph?: boolean;
  readonly onView?: (view: 'tree' | 'graph') => void;
  readonly filter?: { readonly active: boolean; readonly count: number; readonly onToggle: () => void };
  readonly onRecent?: () => void;
  readonly theme: ShellTheme;
  readonly onToggleTheme?: () => void;
  readonly textSize?: TextSize;
  readonly onTextSizeChange?: (size: TextSize) => void;
  /** The bigger view covers the Map, so search waits (as `/` does). */
  readonly searchBlocked?: boolean;
}
const defaultChrome: WorkspaceChrome = { query: '', theme: 'dark' };
const noop = () => {};
/** The board's wide frame is 1280 and its narrow one 900; below NARROW_BELOW the bar keeps its five main controls. */
function useNarrow(): boolean {
  const query = useMemo(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(`(max-width: ${NARROW_BELOW - 0.02}px)`) : null, []);
  const [narrow, setNarrow] = useState(() => query?.matches ?? false);
  useEffect(() => {
    if (!query) return undefined;
    const change = () => setNarrow(query.matches);
    change(); query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, [query]);
  return narrow;
}

/** Saved binding-connect receipt: what to give the host, plus capabilities the owner cannot rely on. */
function SetupCard({ setup, adapterId, onDismiss }: { setup: NonNullable<NavigationState['setup']>; adapterId: string | null; onDismiss: () => void }) {
  const attempt = useRef(0);
  useEffect(() => () => { ++attempt.current; }, [setup]);
  if (setup.data.kind !== 'binding_connect') return null;
  const instruction = setup.data.setup_instruction;
  const unavailable = Object.entries(setup.data.capabilities)
    .filter(([, value]) => typeof value === 'object' && !value.supported).map(([name]) => name.replace(/_/g, ' '));
  const copy = () => {
    const current = ++attempt.current;
    const feedback = (copied: boolean) => {
      if (current !== attempt.current) return;
      notices.push({ icon: copied ? 'ph ph-check-circle' : 'ph ph-warning-circle',
        iconColor: copied ? undefined : 'var(--a-warn)', text: copied ? 'Instruction copied.' : 'Copy failed. Try again.' });
    };
    try {
      void navigator.clipboard.writeText(instruction).then(() => feedback(true), () => feedback(false));
    } catch {
      feedback(false);
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
      <div className="nav-setup-copy"><button type="button" className="btn btn-secondary" onClick={copy}>Copy instruction</button></div>
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
    {matchingReveal?.kind === 'missing_item' && <p className="nav-banner" role="status">{matchingReveal.banner}</p>}
    {renderSession({ store, preferences, temporaryExpandedItemIds: matchingReveal?.kind === 'item' ? matchingReveal.temporaryExpandedItemIds : [],
      missingItemBanner: matchingReveal?.kind === 'missing_item' ? matchingReveal.banner : null })}
  </>;
}

export function NavigationWorkspace({ store, discovery, dockContent, waitingStore, conversation, detail, detailPath, detailRail, detailAsked, onDetailsFolded, chrome = defaultChrome, onCloseDetail, onRemove, hidden: hiddenItem, hiddenNotice, onHide, onRemoveTarget,
  actions: injectedActions, now = Date.now, adapterChoices, renderSession }: NavigationWorkspaceProps) {
  const state = useNavigation(store);
  const dock = useDock();
  const transientError = !state.pendingOperationId && state.error === store.getMutationFailure() ? state.error : null;
  useEffect(() => () => notices.dismiss('navigation-action-failed'), [store]);
  useEffect(() => {
    const id = 'navigation-action-failed';
    let current = true;
    if (transientError) {
      if (isViewConflict(transientError)) void conflictNotice(transientError, { id, draftAtRisk: false,
        isCurrent: () => current, autoRefresh: async () => {
          if (transientError instanceof CoreFailure && transientError.error.code === 'revision_conflict') {
            // Navigation has already refreshed this rejection. Join that read rather than starting another.
            await store.getRefreshCompletion();
          } else await store.refresh();
          return store.getSnapshot().status === 'ready';
        }, refresh: async () => { await refresh(); return store.getSnapshot().status === 'ready'; } });
      else {
        notices.push({ id, icon: 'ph ph-warning-circle', iconColor: 'var(--a-warn)', text: plainFailure(transientError),
          actions: [{ label: 'Refresh', run: () => {
            const notice = notices.getSnapshot().find(entry => entry.id === id);
            void refresh().then(() => {
              if (current && store.getSnapshot().status === 'ready' && notice && notices.getSnapshot().includes(notice)) notices.dismiss(id);
            });
          } }] });
      }
    } else notices.dismiss(id);
    return () => { current = false; };
  }, [store, transientError]);
  const ownActions = useMemo(() => injectedActions ? null : new SessionActionControllers(store.service), [injectedActions, store]);
  const actions = injectedActions ?? ownActions!;
  const ownWaiting = useMemo(() => waitingStore ? null : new WaitingStore(store.service, store.opened), [waitingStore, store]);
  const waiting = waitingStore ?? ownWaiting!;
  const waitingState = useWaiting(waiting);
  useEffect(() => { void waiting.start(); return () => { ownWaiting?.stop(); }; }, [waiting, ownWaiting]);
  const [switcherOpen, setSwitcherOpen] = useState(false), [helpOpen, setHelpOpen] = useState(false);
  const closeSwitcher = useCallback(() => setSwitcherOpen(false), []);
  const closeHelp = useCallback(() => setHelpOpen(false), []);
  const narrow = useNarrow();
  // The search field shows while it holds words or since `/` or a click opened it.
  const [searchOpen, setSearchOpen] = useState(false);
  // The connection line above the Map is drawn by the top bar's session (it shares the card's actions) into this slot.
  const [lineHost, setLineHost] = useState<HTMLDivElement | null>(null);
  const searchShown = searchOpen || !!chrome.query;
  // While the switcher or Help is open, keys are theirs: Esc closes either, and ? closes Help (SPEC §5.16).
  useIntents({
    'switcher.open': () => { if (navigationDisabled || view.kind === 'first-run') return false; setHelpOpen(false); setSwitcherOpen(true); return true; },
    'help.toggle': () => { setSwitcherOpen(false); setHelpOpen(open => !open); return true; },
    'search.focus': () => {
      if (view.kind !== 'session' || !chrome.onQueryChange || chrome.searchBlocked) return false;
      setSearchOpen(true);
      document.querySelector<HTMLInputElement>('.tb-search-input')?.focus();
      return true;
    },
  });
  useEffect(() => {
    if (!helpOpen) return undefined;
    const question = (event: globalThis.KeyboardEvent) => {
      if (event.key !== '?' || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      if (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return;
      event.preventDefault(); setHelpOpen(false);
    };
    document.addEventListener('keydown', question, true);
    return () => document.removeEventListener('keydown', question, true);
  }, [helpOpen]);
  const [registering, setRegistering] = useState(false);
  const [registrationRoot, setRegistrationRoot] = useState('');
  const [binding, setBinding] = useState<Immutable<ProjectSummary> | null>(null);
  const [refreshPending, setRefreshPending] = useState(false);
  // The composition that owns this injected store disposes it. A view mount
  // must not permanently stop a shared store during React's effect replay.
  useEffect(() => { void store.start(); }, [store]);
  // A pending project or session removal hides its cards and rows until it runs or is undone.
  const hidden = useHidden();
  const view = viewOf(state, id => hidden.project(id));
  const pageProjectId = view.kind === 'page' ? view.projectId ?? null : null;
  const projects = (state.projects?.projects.items ?? []).filter(project => !hidden.project(project.project_id));
  const matchingSessions = state.sessions;
  const sessions = (matchingSessions?.sessions.items ?? []).filter(session => !hidden.session(session));
  const selectedProject = pageProjectId ? projects.find(project => project.project_id === pageProjectId) : null;
  const mutationDisabled = refreshPending || state.writing || state.pendingOperationId !== null;
  const disabled = mutationDisabled || !state.preferences;
  // Navigation stays open during an owner write: a switcher choice queues as the newest navigation and runs after it.
  const navigationDisabled = refreshPending || !state.preferences;
  const refresh = async () => {
    if (refreshPending) return;
    setRefreshPending(true);
    try { await store.refresh(); }
    finally { setRefreshPending(false); }
  };
  const showPage = (page: PageName, projectId?: string) => { store.openPage({ kind: 'page', page, ...(projectId ? { projectId } : {}) }); };
  // Layout choices apply at once; the saved preferences catch up when the write lands.
  const [layout, setLayout] = useState<LayoutChange>({});
  const shown: LayoutChange = { detail_width: state.preferences?.global.detail_width, ...layout };
  const saveLayout = (change: LayoutChange) => {
    setLayout(current => ({ ...current, ...change }));
    if (state.preferences) void store.saveLayout(change, state.preferences.revision);
  };
  const at = now();
  const last = currentSession(state);
  // A single project's page lists only its own sessions; the waiting capture lists every unarchived one.
  const lastSummary = sessions.find(value => last && key(value) === key(last))
    ?? waitingState.sessions.find(value => last && key(value.summary) === key(last))?.summary;
  const lastProject = projects.find(value => value.project_id === last?.project_id);
  const firstRun = view.kind === 'first-run';
  const screen = view.kind === 'first-run' ? 'first_run' : view.kind === 'session' ? 'map'
    : view.page === 'archive' ? 'archive' : view.page === 'sessions' ? 'all_sessions' : 'projects';
  const switcher = switcherData({ projects, sessions: waitingState.sessions, waiting: waitingState.waiting, current: last, now: at,
    hiddenSession: route => hidden.session(route) });
  // Opens a session, then the dock at one of its questions (C6: the dock opens it once that session loads).
  const openAt = (route: SessionRef, itemId?: string) => {
    void store.navigate({ kind: 'session', session: route });
    // The 1 s handoff `navigate` returns after is for the click; the dock waits for the navigation itself, as reveals do,
    // so an owner write held longer than that still ends with the dock open on the question.
    if (itemId) void store.getNavigationCompletion(store.getNavigationRequest()).then(saved => { if (saved) dock.openAt({ route, itemId }); });
  };
  const returnToWaiting = () => {
    if (!last) return;
    openAt(last, switcher.projects.flatMap(project => project.sessions).find(value => value.current)?.waiting[0]?.itemId);
  };
  const listing = view.kind === 'page';
  // Message counts, topic chips and remove counts come from each listed session's snapshot.
  const snapshots = useSessionSnapshots(listing ? store.service : null, listing ? sessions : []);
  const counts = view.kind === 'page' && view.page === 'projects' ? state.projects?.counts : matchingSessions?.counts;
  // The connect card belongs to the project page it was made on, directly under the project header,
  // and goes with its session: dismissed, removed (or pending removal), or another page shown.
  const setup = state.setup;
  const setupCard = setup?.data.kind === 'binding_connect' && selectedProject && selectedProject.project_id === state.setupProjectId
    && !sessions.some(summary => summary.session_id === setup.session_id && summary.archived_at != null)
    && !hidden.session({ project_id: selectedProject.project_id, session_id: setup.session_id })
    ? <SetupCard setup={setup} adapterId={state.setupAdapterId} onDismiss={() => store.dismissSetup()} /> : null;
  const register = (root: string) => { setRegistrationRoot(root); setRegistering(true); };
  const openSession = (route: SessionRef) => { void store.navigate({ kind: 'session', session: route }); };
  const openProject = (id: string) => showPage('sessions', id);
  // "← cache PR review" returns to the session; a project's page goes back to Projects.
  const back = pageProjectId ? { label: 'Projects', onBack: () => showPage('projects') }
    : last ? { label: lastSummary?.name?.trim() || lastSummary?.title || 'Back to session', onBack: () => openSession(last) } : undefined;
  const connectExisting = selectedProject && <div className="pw-page-notes"><button type="button" className="btn btn-ghost pw-group-link"
    disabled={disabled || selectedProject.availability !== 'available' || adapterChoices.length === 0}
    onClick={() => setBinding(selectedProject)}><i className="ph ph-plugs-connected" aria-hidden="true" />Connect existing session</button></div>;
  const notes = <>
    {state.error && !transientError && <div className="nav-banner" role="alert"><p>{plainFailure(state.error)}</p>
      {state.pendingOperationId ? <><p>Ariadne isn’t sure your last change was saved. Check before changing anything else.</p>
        <button type="button" className="btn btn-secondary" disabled={state.writing} onClick={() => { void store.retryMutation(); }}>Check again</button></>
        : <button type="button" className="btn btn-secondary" disabled={mutationDisabled} onClick={() => { void refresh(); }}>{refreshPending ? 'Refreshing…' : 'Refresh'}</button>}
    </div>}
    {state.status === 'loading' && <p className="pw-page-note" role="status">Loading registered projects and sessions…</p>}
    {state.status === 'stale' && <p className="pw-page-note" role="status">Showing the last complete catalogue. Refresh failed.</p>}
    {counts && partial(counts) && <p className="pw-page-note" role="status">Counts are incomplete. Unavailable sessions: {counts.unavailable_session_ids.join(', ') || 'not individually identified'}.</p>}
  </>;
  const sessionNote = view.kind === 'page' && view.page !== 'projects' && !matchingSessions
    && <p className="pw-page-note" role="status">{state.error ? 'Sessions are unavailable for this view.' : 'Loading sessions…'}</p>;
  // The setup instruction a Codex thread needs comes from the last connect receipt, when there is one.
  const instruction = setup?.data.kind === 'binding_connect' ? setup.data.setup_instruction : null;
  /** Copies and says so in a notice; resolves to whether the write landed, for the button's own label. */
  const copyWords = (text: string, done: string) => copyText(text).then(() => { notices.push({ icon: 'ph ph-check-circle', text: done }); return true; },
    () => { notices.push({ icon: 'ph ph-warning-circle', iconColor: 'var(--a-warn)', tone: 'problem', text: 'Copy failed. Try again.' }); return false; });
  const page = view.kind === 'page' && view.page === 'archive'
    ? <ArchivePage navigation={store} actions={actions} projects={projects} sessions={sessions} snapshots={snapshots} now={at} disabled={disabled} navigationDisabled={navigationDisabled} back={back} onOpenSession={openSession} onRemove={onRemoveTarget} />
    : firstRun ? <FirstRun command="/ariadne-connect" onCopyCommand={() => copyWords('/ariadne-connect', 'Command copied.')}
      onCopyInstruction={instruction ? () => copyWords(instruction, 'Instruction copied.') : undefined} onRegister={() => register('')} />
    : view.kind === 'session' ? null : view.page === 'projects'
    ? <ProjectsPage currentSession={last} projects={projects} sessions={sessions} snapshots={snapshots} now={at} back={back} disabled={disabled} navigationDisabled={navigationDisabled}
      discovery={discovery} onOpen={openProject} onOpenSession={openSession} onRegister={register} onRemove={onRemoveTarget}>
      {state.status === 'ready' && projects.length === 0 && <p className="pw-page-note">No registered projects. Register a project to connect an existing session.</p>}
    </ProjectsPage>
    : <SessionLists navigation={store} actions={actions} projects={selectedProject ? [selectedProject] : pageProjectId ? [] : projects} single={!!pageProjectId}
      sessions={sessions} currentSession={last} now={at} narrow={narrow} disabled={disabled} navigationDisabled={navigationDisabled} back={back} onOpenArchive={() => showPage('archive')} onOpenSession={openSession}
      notes={setupCard}>
      {connectExisting}
      {sessionNote}
      {pageProjectId && !selectedProject && state.status === 'ready' && <p className="pw-page-note">This project is no longer registered.</p>}
    </SessionLists>;
  const center = <>
    {page && <div className="pw-page-notes">{notes}</div>}
    {page ?? <div className="nav-content nav-session-content">{notes}<div className="nav-connection-line" ref={setLineHost} /><SelectedSession navigation={store} renderSession={renderSession} /></div>}
    {state.pendingNavigation && <p className="nav-opening" role="status">{state.pendingNavigation.kind === 'all_sessions'
      ? 'Opening All sessions…' : state.pendingNavigation.kind === 'projects' ? 'Opening Projects…'
        : state.pendingNavigation.kind === 'project' ? 'Opening the project…' : 'Opening the session…'}</p>}
  </>;
  const onSession = view.kind === 'session';
  const bar = {
    narrow, variant: firstRun ? 'first-run' as const : page ? 'page' as const : 'session' as const, disabled, switcherDisabled: navigationDisabled,
    sessionName: lastSummary?.name?.trim() || lastSummary?.title || (screen === 'archive' ? 'Archive' : screen === 'all_sessions' ? 'All sessions' : 'Projects'),
    project: lastProject ? projectName(lastProject) : undefined, otherWaiting: switcher.otherWaitingCount,
    switcherOpen, onSwitcherToggle: () => { setHelpOpen(false); setSwitcherOpen(value => !value); },
    waitingHere: page ? switcher.thisWaitingCount : 0, onWaitingHere: returnToWaiting,
    search: { active: onSession && searchShown, query: chrome.query, onOpen: () => { if (onSession && chrome.onQueryChange) setSearchOpen(true); },
      onQuery: (text: string) => chrome.onQueryChange?.(text), onClear: () => { if (chrome.onClearSearch) chrome.onClearSearch(); else chrome.onQueryChange?.(''); setSearchOpen(false); },
      ...onSession && chrome.searchStatus ? { count: chrome.searchStatus.count, onNext: chrome.searchStatus.onNext, onPrev: chrome.searchStatus.onPrev,
        note: chrome.searchStatus.note ?? undefined } : {} },
    view: chrome.graph ? 'graph' as const : 'tree' as const, onView: chrome.onView ?? noop,
    filter: chrome.filter ?? { active: false, count: 0, onToggle: noop },
    recent: { active: false, onToggle: chrome.onRecent ?? noop },
    archive: { active: view.kind === 'page' && view.page === 'archive', onOpen: () => showPage('archive') },
    textSize: chrome.textSize ?? 80, onTextSizeChange: chrome.onTextSizeChange ?? noop,
    theme: chrome.theme, onToggleTheme: chrome.onToggleTheme ?? noop,
    help: { open: helpOpen, onToggle: () => { setSwitcherOpen(false); setHelpOpen(value => !value); } },
  };
  // The bar carries the connection of the session on screen, or of the one a page returns to.
  const barSession = onSession ? store.selectedSession() : last ? store.opened.get(last) ?? null : null;
  // Pages take the place of the Map, Waiting and Details (SPEC §6.16).
  // The bar's session owns one lifecycle: the connection card, the Map and a page row share its review and Undo.
  const barActions = barSession ? actions.forSession(barSession) : null;
  return <NavigationProvider store={store} waiting={waiting}><SessionLifecycleOwner actions={barActions}>
    <DetailsColumnProvider saved={shown.detail_width ?? null} unfoldWhen={detailAsked} onFolded={onDetailsFolded} onSave={width => saveLayout({ detail_width: width })}>
    <Shell topBar={<WorkspaceTopBar bar={bar} store={barSession} controllers={actions} line={onSession ? lineHost : null}
      setup={setup?.data.kind === 'binding_connect' ? { sessionId: setup.session_id, instruction: setup.data.setup_instruction } : null} />}
    main={center}
    side={detail && !page ? <DetailsColumn path={detailPath} rail={detailRail} onClose={onCloseDetail} onRemove={onRemove} hidden={hiddenItem} hiddenNotice={hiddenNotice} onHide={onHide}>{detail}</DetailsColumn> : undefined}
    dock={page ? undefined : dockContent}
    legacy={page ? undefined : { conversation }}
    overlay={<>{switcherOpen && <SwitcherMenu projects={switcher.projects} onClose={closeSwitcher}
      onOpenSession={(target, _projectId, itemId) => openAt(target.route, itemId)} onOpenPage={page => showPage(page)} />}
    {helpOpen && <HelpPanel narrow={narrow} onClose={closeHelp} />}{registering
      ? <RegisterProject store={store} initialRoot={registrationRoot} disabled={mutationDisabled} close={() => setRegistering(false)} />
      : binding ? <BindSession store={store} project={binding} sessions={sessions.filter(session => session.project_id === binding.project_id)}
        adapters={adapterChoices} discovery={discovery} disabled={mutationDisabled} close={() => setBinding(null)} /> : undefined}</>} />
    </DetailsColumnProvider></SessionLifecycleOwner></NavigationProvider>;
}
