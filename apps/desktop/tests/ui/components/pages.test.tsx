import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ProjectsCards } from '../../../src/ui/pages/ProjectsCards';
import { SessionsList } from '../../../src/ui/pages/SessionsList';
import { ArchiveList } from '../../../src/ui/pages/ArchiveList';
import { FirstRun } from '../../../src/ui/pages/FirstRun';
import { WaitingHereChip } from '../../../src/ui/pages/WaitingHereChip';
import type { ArchiveRowData, PageSession, ProjectCardData, SessionGroupData, SessionsListProps } from '../../../src/ui/pages/page-types';

afterEach(cleanup);

const session = (name: string, patch: Partial<PageSession<string>> = {}): PageSession<string> => ({ route: name, name, agent: 'Claude Code', run: 'live', waiting: 0, ...patch });
const projects = (): Array<ProjectCardData<string>> => [
  { id: 'sdk', name: 'notes-sdk', path: '~/code/notes-sdk', current: true, waiting: 2, footer: '3 sessions · 2 open · last activity 21:25',
    sessions: [session('cache PR review', { waiting: 2 }), session('retry backoff', { agent: 'Codex' }), session('docs pass', { run: 'closed' })] },
  { id: 'api', name: 'notes-api', path: '~/code/notes-api', waiting: 0, footer: '1 session · 1 open · last activity 21:22', sessions: [session('schema review')] },
  { id: 'site', name: 'notes-site', path: '~/code/notes-site', waiting: 0, footer: 'Last activity 12 Sep', sessions: [], emptyText: 'No sessions. Its last one, “landing copy”, is in Archive.' },
];

function projectsPage(patch = {}) {
  const handlers = { onOpenProject: vi.fn(), onOpenSession: vi.fn(), onRegister: vi.fn(), onDiscover: vi.fn(), onRemoveProject: vi.fn() };
  render(<ProjectsCards back={{ label: 'cache PR review', onBack: vi.fn() }} sub="3 projects · 2 questions waiting on you" projects={projects()} {...handlers} {...patch} />);
  return handlers;
}

describe('Projects page', () => {
  it('names the page, counts in words, and each project with its path, tag, sessions and footer', () => {
    projectsPage();
    expect(screen.getByRole('heading', { name: 'Projects' })).toBeTruthy();
    expect(screen.getByText('3 projects · 2 questions waiting on you')).toBeTruthy();
    expect(screen.getByText('Current').textContent).toBe('Current');
    expect(screen.getByText('~/code/notes-api')).toBeTruthy();
    // The project's pill and its session's count both say it in words.
    expect(screen.getAllByRole('img', { name: '2 questions waiting on you' })).toHaveLength(2);
    expect(screen.getByText('3 sessions · 2 open · last activity 21:25')).toBeTruthy();
    expect(screen.getByText('No sessions. Its last one, “landing copy”, is in Archive.')).toBeTruthy();
    expect(screen.getByText('closed').textContent).toBe('closed');
    expect(screen.getByText('A project appears when an agent session starts in its folder. Removing a project from Ariadne never touches its files.')).toBeTruthy();
  });

  it('opens a project from its name or its card, and a session from its row', () => {
    const h = projectsPage();
    fireEvent.click(screen.getByRole('button', { name: 'notes-api' }));
    expect(h.onOpenProject).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'api' }));
    fireEvent.click(screen.getByText('Last activity 12 Sep'));
    expect(h.onOpenProject).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'site' }));
    fireEvent.click(screen.getByRole('button', { name: /retry backoff/ }));
    expect(h.onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'sdk' }), expect.objectContaining({ name: 'retry backoff' }));
    expect(h.onOpenProject).toHaveBeenCalledTimes(2);
  });

  it('goes back by name', () => {
    const onBack = vi.fn();
    projectsPage({ back: { label: 'cache PR review', onBack } });
    const button = screen.getByTitle('Back ( esc )');
    expect(button.textContent).toBe('cache PR review');
    fireEvent.click(button);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('draws no back button when there is no session to go back to', () => {
    projectsPage({ back: undefined });
    expect(screen.queryByTitle('Back ( esc )')).toBeNull();
  });

  it('the page "…" holds Register a project and Discover sessions, each doing its job and closing the menu', () => {
    const h = projectsPage();
    const more = screen.getByRole('button', { name: 'Register a project, discover sessions' });
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('menuitem', { name: /Register a project…/ }));
    expect(h.onRegister).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('menuitem', { name: /Discover sessions/ }));
    expect(h.onDiscover).toHaveBeenCalledTimes(1);
  });

  it('a card\'s "…" holds Remove project, which does not also open the project', () => {
    const h = projectsPage();
    fireEvent.click(screen.getByRole('button', { name: 'More for notes-api: remove project' }));
    const item = screen.getByRole('menuitem', { name: /Remove project…/ });
    expect(item.textContent).toContain('Ariadne forgets it; its files aren’t touched');
    fireEvent.click(item);
    expect(h.onRemoveProject).toHaveBeenCalledWith(expect.objectContaining({ id: 'api' }));
    expect(h.onOpenProject).not.toHaveBeenCalled();
  });

  it('only one "…" menu is open at a time; Esc closes it and puts focus back', () => {
    projectsPage();
    const page = screen.getByRole('button', { name: 'Register a project, discover sessions' });
    const card = screen.getByRole('button', { name: 'More for notes-sdk: remove project' });
    fireEvent.click(page);
    fireEvent.click(card);
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(card);
  });
});

const group = (id: string, name: string, sessions: PageSession<string>[], empty?: SessionGroupData<string>['empty']): SessionGroupData<string> => ({ id, name, path: `~/code/${name}`, sessions, empty });
function sessionsPage(patch: Partial<SessionsListProps<string>> = {}) {
  const handlers = { onOpen: vi.fn(), onRename: vi.fn(), onClose: vi.fn(), onArchive: vi.fn() };
  const onChange = vi.fn();
  render(<SessionsList narrow={false} back={{ label: 'cache PR review', onBack: vi.fn() }} title="All sessions" sub="3 sessions in 2 projects"
    tabs={{ value: 'all', counts: { open: 2, closed: 1, all: 3 }, onChange }}
    groups={[group('sdk', 'notes-sdk', [session('cache PR review', { current: true, waiting: 2, status: 'Live · iTerm window 1' }), session('docs pass', { run: 'closed', status: 'Closed yesterday 18:05' })]),
      group('api', 'notes-api', [session('schema review', { agent: 'Codex', status: 'Not running · 1 queued', run: 'off' })])]}
    {...handlers} {...patch} />);
  return { ...handlers, onChange };
}

describe('All sessions page', () => {
  it('groups by project, shows each session\'s status in words, the current tag, and the waiting count in words', () => {
    sessionsPage();
    expect(screen.getByRole('heading', { name: 'All sessions' })).toBeTruthy();
    expect(screen.getByText('3 sessions in 2 projects')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'notes-sdk' })).toBeTruthy();
    expect(screen.getByText('Live · iTerm window 1')).toBeTruthy();
    expect(screen.getByText('Current')).toBeTruthy();
    expect(screen.getByRole('img', { name: '2 questions waiting on you' })).toBeTruthy();
    expect(screen.getByText('~/code/notes-api')).toBeTruthy();
  });

  it('narrow folds the agent into the status text', () => {
    sessionsPage({ narrow: true });
    expect(screen.getByText('Claude Code · Live · iTerm window 1')).toBeTruthy();
    expect(screen.getByText('Codex · Not running · 1 queued')).toBeTruthy();
  });

  it('Open, Closed and All carry their counts, and a tab reports itself', () => {
    const h = sessionsPage();
    const tabs = screen.getByRole('group', { name: 'Show' });
    expect(within(tabs).getByRole('button', { name: 'Open2' })).toBeTruthy();
    expect(within(tabs).getByRole('button', { name: 'Closed1' })).toBeTruthy();
    expect(within(tabs).getByRole('button', { name: 'All3' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(tabs).getByRole('button', { name: 'Closed1' }));
    expect(h.onChange).toHaveBeenCalledWith('closed');
  });

  it('a project\'s own page draws no tabs', () => {
    sessionsPage({ tabs: undefined });
    expect(screen.queryByRole('group', { name: 'Show' })).toBeNull();
  });

  it('each row renames, closes and archives; a closed row keeps Close greyed, and no row copies an ID or reopens', () => {
    const h = sessionsPage();
    fireEvent.click(screen.getByRole('button', { name: 'Rename cache PR review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close cache PR review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive cache PR review' }));
    expect(h.onRename).toHaveBeenCalledWith(expect.objectContaining({ name: 'cache PR review' }));
    expect(h.onClose).toHaveBeenCalledWith(expect.objectContaining({ name: 'cache PR review' }));
    expect(h.onArchive).toHaveBeenCalledWith(expect.objectContaining({ name: 'cache PR review' }));
    // SPEC 14.2: Copy ID and Reopen are the connection card's, not the row's.
    expect(screen.queryByRole('button', { name: /^Copy the ID of/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Reopen / })).toBeNull();
    const closed = screen.getByRole('button', { name: 'Close docs pass' }) as HTMLButtonElement;
    expect(closed.disabled).toBe(true); expect(closed.title).toBe('Already closed');
    fireEvent.click(closed);
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it('opens a session from its name', () => {
    const h = sessionsPage();
    fireEvent.click(screen.getByRole('button', { name: 'schema review' }));
    expect(h.onOpen).toHaveBeenCalledWith(expect.objectContaining({ route: 'schema review' }));
  });

  it('a project with no sessions says what to do, and its action works', () => {
    const onClick = vi.fn();
    sessionsPage({ tabs: undefined, groups: [group('site', 'notes-site', [], { title: 'No sessions in notes-site', text: 'Start Claude Code or Codex in ~/code/notes-site and run /ariadne-connect.', action: { label: 'Open Archive', onClick } })] });
    expect(screen.getByText('No sessions in notes-site')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Archive' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

const row = (id: string, kind: ArchiveRowData['kind'], name: string, patch: Partial<ArchiveRowData> = {}): ArchiveRowData => ({ id, kind, name, sub: `${name} sub`, when: 'Archived 3 Oct', ...patch });
describe('Archive page', () => {
  const sessions = [row('a', 'session', 'March incident notes'), row('b', 'session', 'editor spike', { restored: true })];
  const topics = [row('t', 'topic', 'Old cache metrics', { restored: true })];

  it('lists sessions and topics under counted labels, with when each was archived, and the promise that nothing is sent', () => {
    render(<ArchiveList back={{ label: 'cache PR review', onBack: vi.fn() }} sub="2 sessions · 1 topic" sessions={sessions} topics={topics} onRestore={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Sessions · 2' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Topics · 1' })).toBeTruthy();
    expect(screen.getAllByText('Archived 3 Oct')).toHaveLength(3);
    expect(screen.getByText(/Nothing here is sent to an agent\./)).toBeTruthy();
  });

  it('Restore reports the row; a restored row says what happened instead', () => {
    const onRestore = vi.fn();
    render(<ArchiveList sub="x" sessions={sessions} topics={topics} onRestore={onRestore} />);
    fireEvent.click(screen.getByRole('button', { name: 'Restore March incident notes' }));
    expect(onRestore).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
    expect(screen.queryByRole('button', { name: 'Restore editor spike' })).toBeNull();
    expect(screen.getByText('Restored, closed')).toBeTruthy();
    expect(screen.getByText('Back in the Map')).toBeTruthy();
  });

  it('a row’s name opens it, for sessions and topics, without restoring; with no way to open, the name is plain text', () => {
    const onOpen = vi.fn(), onRestore = vi.fn();
    const { rerender } = render(<ArchiveList sub="x" sessions={sessions} topics={topics} onRestore={onRestore} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'March incident notes' }));
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'a', kind: 'session' }));
    fireEvent.click(screen.getByRole('button', { name: 'Old cache metrics' }));
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: 't', kind: 'topic' }));
    expect(onRestore).not.toHaveBeenCalled();
    rerender(<ArchiveList sub="x" sessions={sessions} topics={topics} onRestore={onRestore} />);
    expect(screen.queryByRole('button', { name: 'March incident notes' })).toBeNull();
    expect(screen.getByText('March incident notes')).toBeTruthy();
  });

  it('draws the "…" only when it can remove, and its Remove item reports the row', () => {
    const { rerender } = render(<ArchiveList sub="x" sessions={sessions} topics={[]} onRestore={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /More for/ })).toBeNull();
    const onRemove = vi.fn();
    rerender(<ArchiveList sub="x" sessions={sessions} topics={[]} onRestore={vi.fn()} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole('button', { name: 'More for March incident notes' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Remove from Ariadne…/ }));
    expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
  });

  it('leaves out a section with nothing in it', () => {
    render(<ArchiveList sub="x" sessions={sessions} topics={[]} onRestore={vi.fn()} />);
    expect(screen.queryByRole('region', { name: /Topics/ })).toBeNull();
  });
});

describe('First run', () => {
  it('says what Ariadne is, gives three steps, and says it is waiting and sends nothing', () => {
    render(<FirstRun command="/ariadne-connect" onCopyCommand={vi.fn()} onCopyInstruction={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'No projects yet' })).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('/ariadne-connect')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Waiting for a session to connect. Connecting sends nothing to the model.');
  });

  it('each Copy button reports, then says Copied for a moment', () => {
    vi.useFakeTimers();
    try {
      const onCopyCommand = vi.fn(), onCopyInstruction = vi.fn();
      render(<FirstRun command="/ariadne-connect" onCopyCommand={onCopyCommand} onCopyInstruction={onCopyInstruction} />);
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
      expect(onCopyCommand).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Copy instruction' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Copy instruction' }));
      expect(onCopyInstruction).toHaveBeenCalledTimes(1);
      act(() => { vi.advanceTimersByTime(2100); });
      expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });
});

describe('WaitingHereChip', () => {
  it('says how many wait, wide and narrow, and goes back to them', () => {
    const onGo = vi.fn();
    const { rerender } = render(<WaitingHereChip count={2} narrow={false} onGo={onGo} />);
    fireEvent.click(screen.getByRole('button', { name: '2 waiting in this session' }));
    expect(onGo).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button').getAttribute('title')).toBe('Go back to the session and answer them');
    rerender(<WaitingHereChip count={1} narrow onGo={onGo} />);
    expect(screen.getByRole('button', { name: '1 waiting here' })).toBeTruthy();
  });
});
