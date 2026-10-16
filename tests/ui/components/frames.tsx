// The drawn states of the redesign's presentational components, with sample props (names are neutral on purpose).
// registry.ts says which board shot each is checked against.
import type { ReactNode } from 'react';
import { TopBar } from '../../../apps/desktop/src/ui/topbar/TopBar';
import { SwitcherMenu } from '../../../apps/desktop/src/ui/topbar/SwitcherMenu';
import { HelpPanel } from '../../../apps/desktop/src/ui/help/HelpPanel';
import { ConnectionCard, ConnectionLine } from '../../../apps/desktop/src/ui/topbar/ConnectionCard';
import type { ConnectionCardActions, ConnectionView, SwitcherProject, TopBarProps } from '../../../apps/desktop/src/ui/topbar/model';

export type Theme = 'light' | 'dark';
export interface FrameContext { readonly narrow: boolean; readonly theme: Theme }

const noop = () => undefined;
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
  onSending: noop, onHowToConnect: noop, onTryAgain: noop, onShowFile: noop, onShowFolder: noop, onClose: noop, onReopen: noop, onCopyId: noop, onCopyCommand: noop, onCopyInstruction: noop,
};
const states: Record<string, ConnectionView> = {
  none: { kind: 'none', agent: 'Claude Code' },
  off: { kind: 'off', agent: 'Claude Code', where: 'iTerm window 1', lastSeenAt: '20:58' },
  closed: { kind: 'closed', closedAt: '21:33' },
  loading: { kind: 'loading', where: 'Claude Code in iTerm window 1' },
  reconnect: { kind: 'reconnect', agent: 'Claude Code', where: 'Claude Code in iTerm window 1', droppedAt: '21:30' },
  unreadable: { kind: 'unreadable', unreadableLine: 1204 },
  stale: { kind: 'stale', lastGoodAt: '21:24' },
  unsaved: { kind: 'unsaved', where: 'Claude Code in iTerm window 1', unsavedAt: '21:31', unsavedChange: 'Later on “separate hit metrics”' },
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
