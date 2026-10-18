// The drawn states of the redesign's presentational components, with sample props (names are neutral on purpose).
// registry.ts says which board shot each is checked against.
import type { ReactNode } from 'react';
import { TopBar } from '../../../apps/desktop/src/ui/topbar/TopBar';
import { SwitcherMenu } from '../../../apps/desktop/src/ui/topbar/SwitcherMenu';
import { HelpPanel } from '../../../apps/desktop/src/ui/help/HelpPanel';
import { ConnectionCard, ConnectionLine } from '../../../apps/desktop/src/ui/topbar/ConnectionCard';
import { ProjectsCards } from '../../../apps/desktop/src/ui/pages/ProjectsCards';
import { SessionsList } from '../../../apps/desktop/src/ui/pages/SessionsList';
import { ArchiveList } from '../../../apps/desktop/src/ui/pages/ArchiveList';
import { FirstRun } from '../../../apps/desktop/src/ui/pages/FirstRun';
import { NameSessionDialog } from '../../../apps/desktop/src/ui/dialogs/NameSessionDialog';
import { RegisterProjectDialog } from '../../../apps/desktop/src/ui/dialogs/RegisterProjectDialog';
import { RemoveProjectDialog } from '../../../apps/desktop/src/ui/dialogs/RemoveProjectDialog';
import type { PageSession, ProjectCardData, SessionGroupData } from '../../../apps/desktop/src/ui/pages/page-types';
import type { ConnectionCardActions, ConnectionView, SwitcherProject, TopBarProps } from '../../../apps/desktop/src/ui/topbar/model';

export type Theme = 'light' | 'dark';
export interface FrameContext { readonly narrow: boolean; readonly theme: Theme }

const noop = () => undefined;
const copied = () => Promise.resolve(true);
const live: ConnectionView = { kind: 'live', where: 'Claude Code in iTerm window 1', agent: 'Claude Code' };

export function barProps({ narrow, theme }: FrameContext, over: Partial<TopBarProps> = {}): TopBarProps {
  return {
    narrow, project: 'notes-sdk', sessionName: 'cache PR review', otherWaiting: 3, switcherOpen: false, onSwitcherToggle: noop,
    connection: live, connectionOpen: false, onConnectionToggle: noop,
    search: { active: false, query: '', onOpen: noop, onQuery: noop, onNext: noop, onPrev: noop, onClear: noop },
    view: 'tree', onView: noop, filter: { active: false, count: 0, onToggle: noop }, recent: { active: false, onToggle: noop },
    archive: { active: false, onOpen: noop }, textSize: 80, onTextSizeChange: noop, theme, onToggleTheme: noop, help: { open: false, onToggle: noop },
    ...over,
  };
}

const question = (itemId: string, title: string, since: string) => ({ itemId, title, since });
export const switcherProjects: Array<SwitcherProject<string>> = [
  { id: 'sdk', name: 'notes-sdk', current: true, sessions: [
    { route: 'cache', name: 'cache PR review', agent: 'Claude Code', running: true, current: true, waiting: [question('a', 'Should workspace keys still get a one-line note?', '34 min'), question('b', 'Bump the key prefix?', '6 min')] },
    { route: 'retry', name: 'retry backoff', agent: 'Codex', running: true, waiting: [] },
    { route: 'docs', name: 'docs pass', agent: 'Claude Code', running: false, closed: true, closedWhen: 'yesterday', waiting: [] },
  ] },
  { id: 'api', name: 'notes-api', sessions: [
    { route: 'schema', name: 'schema review', agent: 'Claude Code', running: true, waiting: [
      question('c', 'Drop the unused legacy ID column in this migration?', '12 min'), question('d', 'Run the backfill during business hours?', '3 min')] },
    { route: 'limits', name: 'rate limits', agent: 'Codex', running: false, waiting: [] },
  ] },
  { id: 'web', name: 'notes-web', sessions: [
    { route: 'flaky', name: 'flaky tests', agent: 'Claude Code', running: true, waiting: [question('e', 'Quarantine the two flaky editor tests for a week?', '40 min')] },
  ] },
];

export const renderers: Record<string, (context: FrameContext) => ReactNode> = {
  topbar: context => <TopBar {...barProps(context)} />,
  'topbar-search': context => <TopBar {...barProps(context, {
    search: { active: true, query: 'per-workspace', count: '2 of 4', onOpen: noop, onQuery: noop, onNext: noop, onPrev: noop, onClear: noop,
      note: { text: 'Also matching: 1 in a hidden item.', action: 'Show them', onAction: noop } },
  })} />,
  switcher: context => <>
    <TopBar {...barProps(context, { switcherOpen: true })} />
    <SwitcherMenu projects={switcherProjects} onOpenSession={noop} onOpenPage={noop} onClose={noop} />
  </>,
  'switcher-typing': context => <>
    <TopBar {...barProps(context, { switcherOpen: true })} />
    <SwitcherMenu projects={switcherProjects} initialQuery="sch" onOpenSession={noop} onOpenPage={noop} onClose={noop} />
  </>,
};

const actions: ConnectionCardActions = {
  onSending: noop, onHowToConnect: noop, onTryAgain: noop, onShowFile: noop, onShowFolder: noop, onClose: noop, onReopen: noop, onCopyId: copied, onCopyCommand: copied, onCopyInstruction: copied,
};
const states: Record<string, ConnectionView> = {
  none: { kind: 'none', agent: 'Claude Code' },
  off: { kind: 'off', agent: 'Claude Code', where: 'iTerm window 1', lastSeenAt: '20:58' },
  closed: { kind: 'closed', closedAt: '21:33' },
  loading: { kind: 'loading', where: 'Claude Code in iTerm window 1' },
  reconnect: { kind: 'reconnect', agent: 'Claude Code', where: 'Claude Code in iTerm window 1', droppedAt: '21:30' },
  unreadable: { kind: 'unreadable', unreadableLine: 1204 },
  stale: { kind: 'stale', lastGoodAt: '21:24' },
  unsaved: { kind: 'unsaved', where: 'Claude Code in iTerm window 1', unsavedAt: '21:31' },
};
for (const [id, view] of Object.entries(states)) {
  renderers[`connection-${id}`] = context => <>
    <TopBar {...barProps(context, { connection: view })} />
    <ConnectionLine view={view} actions={actions} steps={id === 'none' ? { open: true, onToggle: noop } : undefined} />
  </>;
}
renderers['connection-live'] = context => {
  const view: ConnectionView = { ...live, lastMessageAt: '21:25', sending: { onItsWay: 1, queued: 1 } };
  return <TopBar {...barProps(context, { connection: view, connectionOpen: true, connectionCard: <ConnectionCard view={view} actions={actions} onDismiss={noop} /> })} />;
};

for (const tab of ['keys', 'markers'] as const) {
  renderers[`help-${tab}`] = context => <>
    <TopBar {...barProps(context, { help: { open: true, onToggle: noop } })} />
    <HelpPanel narrow={context.narrow} initialTab={tab} onClose={noop} />
  </>;
}

// Pages and dialogs, with the sample data of the board's Projects, All sessions and Archive screens.
const live2 = (name: string, agent: string, waiting = 0): PageSession<string> => ({ route: name, name, agent, run: 'live', waiting });
const projectCards = (): Array<ProjectCardData<string>> => [
  { id: 'sdk', name: 'notes-sdk', path: '~/code/notes-sdk', current: true, waiting: 2, footer: '3 sessions · 2 open · last activity 21:25', sessions: [
    live2('cache PR review', 'Claude Code', 2), live2('retry backoff', 'Codex'), { route: 'docs pass', name: 'docs pass', agent: 'Claude Code', run: 'closed', waiting: 0 }] },
  { id: 'api', name: 'notes-api', path: '~/code/notes-api', waiting: 2, footer: '2 sessions · 2 open · last activity 21:22', sessions: [
    live2('schema review', 'Claude Code', 2), { route: 'rate limits', name: 'rate limits', agent: 'Codex', run: 'off', waiting: 0 }] },
  { id: 'web', name: 'notes-web', path: '~/code/notes-web', waiting: 1, footer: '1 session · 1 open · last activity 21:10', sessions: [live2('flaky tests', 'Claude Code', 1)] },
  { id: 'site', name: 'notes-site', path: '~/code/notes-site', waiting: 0, footer: 'Last activity 12 Sep', sessions: [], emptyText: 'No sessions. Its last one, “landing copy”, is in Archive.' },
];
const sessionGroups = (): Array<SessionGroupData<string>> => [
  { id: 'sdk', name: 'notes-sdk', path: '~/code/notes-sdk', sessions: [
    { ...live2('cache PR review', 'Claude Code', 2), current: true, status: 'Live · iTerm window 1' }, { ...live2('retry backoff', 'Codex'), status: 'Live · Codex app' },
    { route: 'docs pass', name: 'docs pass', agent: 'Claude Code', run: 'closed', waiting: 0, status: 'Closed yesterday 18:05' }] },
  { id: 'api', name: 'notes-api', path: '~/code/notes-api', sessions: [
    { ...live2('schema review', 'Claude Code', 2), status: 'Live · iTerm window 2' }, { route: 'rate limits', name: 'rate limits', agent: 'Codex', run: 'off', waiting: 0, status: 'Not running · 1 queued' }] },
  { id: 'web', name: 'notes-web', path: '~/code/notes-web', sessions: [{ ...live2('flaky tests', 'Claude Code', 1), status: 'Live · Terminal tab 3' }] },
];
const back = { label: 'cache PR review', onBack: noop };
const pageBar = (context: FrameContext, over: Partial<TopBarProps> = {}) => <TopBar {...barProps(context, { variant: 'page', waitingHere: 2, ...over })} />;
const projectsPage = <ProjectsCards back={back} sub="4 projects · 5 questions waiting on you" projects={projectCards()} onOpenProject={noop} onOpenSession={noop} onRegister={noop} onDiscover={noop} onRemoveProject={noop} />;

renderers.projects = context => <>{pageBar(context)}{projectsPage}</>;
renderers['projects-menu'] = context => <>{pageBar(context)}{projectsPage}</>;
renderers.register = context => <>{pageBar(context)}{projectsPage}<RegisterProjectDialog initialPath="~/code/notes-mobile" onRegister={noop} onCancel={noop} /></>;
renderers['remove-project'] = context => <>{pageBar(context)}{projectsPage}<RemoveProjectDialog name="notes-api" path="~/code/notes-api" sessionCount={2} waitingCount={2} onRemove={noop} onCancel={noop} /></>;
renderers.sessions = context => <>{pageBar(context)}
  <SessionsList narrow={context.narrow} back={back} title="All sessions" sub="6 sessions in 3 projects" tabs={{ value: 'all', counts: { open: 5, closed: 1, all: 6 }, onChange: noop }}
    groups={sessionGroups()} onOpen={noop} onRename={noop} onClose={noop} onArchive={noop} /></>;
renderers['no-sessions'] = context => <>{pageBar(context)}
  <SessionsList narrow={context.narrow} back={{ label: 'Projects', onBack: noop }} title="notes-site" sub="No sessions"
    groups={[{ id: 'site', name: 'notes-site', path: '~/code/notes-site', sessions: [], empty: { title: 'No sessions in notes-site',
      text: 'Start Claude Code or Codex in ~/code/notes-site and run /ariadne-connect; the session shows up here. Its last one, “landing copy”, is in Archive.', action: { label: 'Open Archive', onClick: noop } } }]}
    onOpen={noop} onRename={noop} onClose={noop} onArchive={noop} /></>;
renderers.archive = context => <>{pageBar(context, { archive: { active: true, onOpen: noop } })}
  <ArchiveList back={back} sub="3 sessions · 1 topic" onRestore={noop} onRemove={noop}
    sessions={[
      { id: 'a', kind: 'session', name: 'March incident notes', sub: 'notes-api · Claude Code · 4 topics · 31 items', when: 'Archived 3 Oct' },
      { id: 'b', kind: 'session', name: 'editor spike', sub: 'notes-web · Codex · 2 topics · 9 items', when: 'Archived 28 Sep' },
      { id: 'c', kind: 'session', name: 'landing copy', sub: 'notes-site · Claude Code · 1 topic · 6 items', when: 'Archived 12 Sep' }]}
    topics={[{ id: 't', kind: 'topic', name: 'Old cache metrics', sub: 'From “cache PR review” · 6 items', when: 'Archived today 19:40' }]} /></>;
renderers['first-run'] = context => <>
  <TopBar {...barProps(context, { variant: 'first-run', connection: undefined })} />
  <FirstRun command="/ariadne-connect" onCopyCommand={copied} onCopyInstruction={copied} onRegister={noop} /></>;
renderers['name-session'] = context => <>
  <TopBar {...barProps(context, { sessionName: 'Claude Code · 14:02' })} />
  <NameSessionDialog unnamedAs="the Claude Code session from today 14:02" initialName="cache PR review" initialDescription="Reviewer’s comments on the SDK cache PR" onSave={noop} onCancel={noop} />
</>;
