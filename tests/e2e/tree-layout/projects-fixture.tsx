// The Projects page over its real styles with cards of every size: none, one, five, seven and twelve sessions, a long name.
// Base styles first, as in main.tsx.
import '../../../apps/desktop/src/style.css';
import { createRoot } from 'react-dom/client';
import { ProjectsCards } from '../../../apps/desktop/src/ui/pages/ProjectsCards';
import type { PageSession, ProjectCardData } from '../../../apps/desktop/src/ui/pages/page-types';

const noop = () => undefined;
const sessions = (count: number, prefix: string): PageSession<string>[] => Array.from({ length: count }, (_, index) => ({
  route: `${prefix}-${index + 1}`, name: `${prefix} session ${index + 1}`, agent: index % 2 ? 'Codex' : 'Claude Code',
  run: index === 0 ? 'live' : index % 3 === 0 ? 'closed' : 'off', waiting: index === 1 ? 2 : 0,
}));
const card = (id: string, name: string, count: number, patch: Partial<ProjectCardData<string>> = {}): ProjectCardData<string> => ({
  id, name, path: `~/code/${id}`, waiting: 0, sessions: sessions(count, id), footer: count ? `${count} session${count === 1 ? '' : 's'} · ${count} open · last activity 21:25` : 'Last activity 12 Sep',
  emptyText: count ? undefined : 'No sessions. Its last one, “landing copy”, is in Archive.', ...patch,
});
const projects = [
  card('empty', 'notes-empty', 0),
  card('one', 'notes-one', 1, { current: true, waiting: 2 }),
  card('five', 'notes-five', 5),
  card('seven', 'notes-seven', 7),
  card('twelve', 'notes-twelve', 12),
  card('long', 'a-project-with-a-name-that-is-far-too-long-to-fit-on-one-line-of-a-card', 3, { path: '~/code/a/very/deep/folder/structure/that/also/does/not/fit/in/a/card' }),
];

createRoot(document.getElementById('root')!).render(<ProjectsCards back={{ label: 'cache PR review', onBack: noop }} sub="6 projects · 4 questions waiting on you" projects={projects}
  onOpenProject={noop} onOpenSession={noop} onRegister={noop} onDiscover={noop} onRemoveProject={noop} />);
