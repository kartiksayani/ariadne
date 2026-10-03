import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { WorkspaceCase, workspaceFixtures } from './workspace-cases';
import { frameRegions, assembledRegions } from './assembled-regions';
import { BackAndForthRound } from '../../../apps/desktop/src/components/reference/BackAndForthRound';
import { TopicGraph } from '../../../apps/desktop/src/components/reference/TopicGraph';
import { GlobalWaitingPanel } from '../../../apps/desktop/src/components/reference/GlobalWaitingPanel';
import { GuardDialog, ContinueTopic } from '../../../apps/desktop/src/components/reference/ReferenceDialog';
import { ProjectCard, SessionCard } from '../../../apps/desktop/src/components/reference/ProjectSessionCard';
import source from '../../../docs/planning/evidence/design-assets/source.json';
import gallery from '../../../docs/planning/evidence/design-assets/gallery.json';
import { cases } from './cases';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

afterEach(cleanup);
describe('assembled reference presentation', () => {
  it('closes all 30 frame/family mappings against real mounts and immutable fixture provenance', () => {
    expect(gallery.frames.map(frame => frame.id)).toEqual(source.frames.map(frame => frame.id));
    expect(gallery.source_archive).toEqual(source.archive); expect(gallery.source_prompt).toEqual(source.prompt);
    expect(createHash('sha256').update(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'workspace-fixtures.json'))).digest('hex')).toBe(gallery.fixture.sha256);
    const actualCases = new Set([...cases.map(fixture => fixture.id), ...Object.keys(workspaceFixtures).map(id => `frame:${id}`), ...gallery.target_only_states]);
    for (const frame of gallery.frames) {
      expect(frame.member).toBe(source.frames.find(sourceFrame => sourceFrame.id === frame.id)!.member);
      for (const id of frame.render_cases) expect(actualCases.has(id), id).toBe(true);
    }
    expect(gallery.components.map(component => component.family)).toEqual(source.components.map(component => component.family));
    for (const component of gallery.components) for (const id of component.render_cases) expect(actualCases.has(id), id).toBe(true);
    for (const id of ['1j', '1k', '1s']) expect(workspaceFixtures[id]).toBeUndefined();
  });
  it('maps all application scenarios to source regions while keeping diagram/sheets separate', () => {
    const frames = source.frames.filter(frame => frame.member.endsWith('/Ariadne.dc.html'));
    expect(Object.keys(frameRegions)).toEqual(frames.map(frame => frame.id));
    expect(Object.keys(workspaceFixtures)).toEqual([...frames.map(frame => frame.id), 'graph-expanded-replacement', 'graph-filtered']);
    expect(() => render(<WorkspaceCase frameId="unknown" />)).toThrow('Unknown assembled fixture');
  });
  it.each(Object.keys(workspaceFixtures))('mounts source-derived scenario %s through reusable components', frameId => {
    const { container } = render(<WorkspaceCase frameId={frameId} />);
    const fixture = workspaceFixtures[frameId];
    expect(screen.getByRole('complementary', { name: 'Waiting on me' })).toBeVisible();
    expect(container.querySelector('.ref-workspace')).toBeVisible();
    for (const region of frameRegions[frameId] ?? ['graph']) expect(container.querySelector(assembledRegions[region].app)).not.toBeNull();
    if (fixture.detail) expect(screen.getByRole('heading', { name: fixture.detail.question })).toBeVisible();
    if (fixture.projects.length) expect(container.querySelectorAll('.ref-project-card')).toHaveLength(fixture.projects.length);
    if (fixture.graphs.length) expect(container.querySelectorAll('.ref-graph-node').length).toBe(fixture.graphs.reduce((n, graph) => n + graph.graph.nodes.length, 0));
    expect(screen.queryAllByRole('button', { pressed: true })).toHaveLength(0);
  });
  it('preserves three ordered rounds, both child forks, ask/result/reply text and message ranges', () => {
    const rounds = workspaceFixtures['1u'].detail!.rounds;
    const reveal = vi.fn();
    const { container } = render(<>{rounds.map(round => <BackAndForthRound {...round} onReveal={reveal} key={round.label} />)}</>);
    expect([...container.querySelectorAll('.ref-round-label > span:first-child')].map(node => node.textContent)).toEqual(['Round 1', 'Round 2', 'Round 3']);
    expect(screen.getByText('#20–#22')).toBeVisible();
    expect(screen.getByText('You chose “Fix it as suggested”')).toBeVisible();
    expect(screen.getByText('Waiting on you')).toBeVisible();
    const forks = container.querySelectorAll<HTMLButtonElement>('.ref-fork');
    expect(forks).toHaveLength(2); fireEvent.click(forks[0]);
    expect(reveal).toHaveBeenCalledWith('4.1.1');
    expect(rounds[2].reply).toBeUndefined(); expect(rounds[2].result).toBeUndefined();
  });
  it('renders explicit node coordinates, labelled dashed replacement links and keyboard reveal without implementing layout', () => {
    const graph = workspaceFixtures['graph-expanded-replacement'].graphs[0].graph;
    const reveal = vi.fn();
    const { container } = render(<TopicGraph {...graph} onReveal={reveal} />);
    const nodes = screen.getAllByRole('button');
    expect(nodes[0]).toHaveStyle({ left: `${graph.nodes[0].x}px`, top: `${graph.nodes[0].y}px` });
    fireEvent.keyDown(nodes[0], { key: 'Enter' }); fireEvent.keyDown(nodes[1], { key: ' ' }); fireEvent.click(nodes[2]);
    expect(reveal.mock.calls.map(call => call[0])).toEqual(graph.nodes.slice(0, 3).map(node => node.id));
    expect(screen.getByText('replaced by')).toBeVisible();
    expect(container.querySelector('path[marker-end]')).toHaveStyle({ strokeDasharray: '4 4' });
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    const filtered = workspaceFixtures['graph-filtered'].graphs.flatMap(graph => graph.graph.nodes);
    expect(filtered.some(node => node.opacity === 0.4)).toBe(true);
  });
  it('keeps older Sent inputs alongside a new ask and does not select a recommendation', () => {
    const fixture = workspaceFixtures['1l'].waiting;
    const received = fixture.sent[0];
    const card = workspaceFixtures['1a'].waiting.waiting[0];
    const open = vi.fn(), action = vi.fn();
    render(<GlobalWaitingPanel {...fixture} count="1" waiting={[{ ...card, answer: { ...card.answer, selected: null, onSelect: vi.fn(), onDraft: vi.fn(), onSubmit: vi.fn() }, earlier: 'Earlier session', previousRound: 'Round 2', delivery: { text: 'Delivery uncertain', icon: 'ph ph-warning', color: 'var(--a-warn)', action: 'Review', onAction: action } }]} sent={[{ ...received, id: 'input-old', onOpen: open }, { ...received, id: 'input-generic', question: 'Generic note', onOpen: open }]} />);
    expect(screen.getByText(card.question)).toBeVisible(); expect(screen.getByText('Generic note')).toBeVisible();
    expect(screen.getAllByText(received.delivery.text)).toHaveLength(2);
    expect(screen.queryByRole('button', { pressed: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review' })); expect(action).toHaveBeenCalledOnce();
    const sent = screen.getAllByRole('button').filter(node => node.classList.contains('ref-sent-card'));
    fireEvent.keyDown(sent[0], { key: 'Enter' }); fireEvent.keyDown(sent[1], { key: ' ' });
    expect(open).toHaveBeenCalledTimes(2);
  });
  it('shows archive blockers and requires confirmed pause before a separate close confirmation', () => {
    const confirm = vi.fn(), pause = vi.fn(), reveal = vi.fn(), cancel = vi.fn();
    const props = { kind: 'close' as const, title: 'Close session', blockers: [{ id: 'input-2', label: 'Delivery uncertain' }], dispatch: 'enabled' as const, onConfirm: confirm, onPause: pause, onReveal: reveal, onCancel: cancel };
    const { rerender } = render(<GuardDialog {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'input-2 · Delivery uncertain' })); expect(reveal).toHaveBeenCalledWith('input-2');
    fireEvent.click(screen.getByRole('button', { name: 'Pause dispatch' })); expect(pause).toHaveBeenCalledOnce(); expect(confirm).not.toHaveBeenCalled();
    rerender(<GuardDialog {...props} dispatch="pausing" />); expect(screen.getByRole('button', { name: 'Pausing dispatch…' })).toBeDisabled();
    rerender(<GuardDialog {...props} dispatch="paused" />); expect(screen.getByRole('button', { name: 'Confirm close session' })).toBeDisabled();
    rerender(<GuardDialog {...props} blockers={[]} dispatch="paused" />); fireEvent.click(screen.getByRole('button', { name: 'Confirm close session' })); expect(confirm).toHaveBeenCalledOnce();
    expect(screen.getByText(/terminal session keeps running/)).toBeVisible();
    rerender(<GuardDialog {...props} kind="archive" title="Archive topic" dispatch="paused" />); expect(screen.getByRole('button', { name: 'Confirm archive topic' })).toBeDisabled();
  });
  it('names source and target copy semantics, retains source on target failure, traps and restores dialog focus', () => {
    const send = vi.fn(), cancel = vi.fn();
    const opener = document.createElement('button'); opener.textContent = 'Continue'; document.body.append(opener); opener.focus();
    const { unmount } = render(<ContinueTopic title="Continue topic" source="codex · yesterday" target="claude-code · today" groups={workspaceFixtures['1y'].continuation!.groups} error="Target write failed" onSend={send} onCancel={cancel} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('new local IDs with immutable source references for topics, items, messages, rounds and answers');
    expect(screen.getByRole('alert')).toHaveTextContent('Source unchanged');
    expect(send).not.toHaveBeenCalled();
    const buttons = within(dialog).getAllByRole('button'); expect(buttons[0]).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true }); expect(buttons[1]).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Tab' }); expect(buttons[0]).toHaveFocus();
    fireEvent.click(buttons[1]); expect(send).toHaveBeenCalledOnce();
    fireEvent.keyDown(dialog, { key: 'Escape' }); expect(cancel).toHaveBeenCalledOnce();
    unmount(); expect(opener).toHaveFocus(); opener.remove();
  });
  it('qualifies unbound candidates/incomplete counts and preserves card action ownership', () => {
    const open = vi.fn(); const project = workspaceFixtures['1ab'].projects[0];
    const { rerender } = render(<ProjectCard {...project} candidate incomplete onOpen={open} />);
    expect(screen.getByText('Candidate · not bound')).toBeVisible(); expect(screen.getByText(/incomplete/)).toBeVisible();
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' }); fireEvent.keyDown(screen.getByRole('button'), { key: ' ' }); fireEvent.click(screen.getByRole('button')); expect(open).toHaveBeenCalledTimes(3);
    const session = workspaceFixtures['1ac'].sessionGroups[0].closed[0], reopen = vi.fn();
    rerender(<SessionCard {...session} actions={[{ label: 'Reopen', icon: 'ph ph-arrow-counter-clockwise', kind: 'secondary', onClick: reopen }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' })); expect(reopen).toHaveBeenCalledOnce();
  });
  it('closes detail and rail explicitly to recover width and uses the release shortcut copy', () => {
    const { container } = render(<WorkspaceCase frameId="1b" />);
    expect(screen.getByRole('complementary', { name: 'Item detail' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Close detail' })); expect(screen.queryByRole('complementary', { name: 'Item detail' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Hide messages (m)')); expect(screen.queryByRole('complementary', { name: 'Messages' })).not.toBeInTheDocument();
    expect(container.querySelector('.ref-footer')).toHaveTextContent('⌘↵send');
  });
  it('keeps the disconnected existing session and exposes no cross-agent reroute prompt', () => {
    render(<WorkspaceCase frameId="1ad" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: workspaceFixtures['1ad'].detail!.question })).toBeVisible();
    expect(screen.getByText('Agent not running')).toBeVisible();
    expect(screen.queryByText(/Send to another agent|Start the agent|Route to/)).not.toBeInTheDocument();
  });
  it('mounts ask-only history and paused-follow affordances as component states', () => {
    const { container, rerender } = render(<WorkspaceCase frameId="1u" variant="ask-only" />);
    expect(container.querySelectorAll('.ref-round-card')).toHaveLength(1);
    expect(screen.queryByText('Waiting on you')).not.toBeInTheDocument();
    rerender(<WorkspaceCase frameId="1a" variant="paused-follow" />);
    expect(screen.getByRole('button', { name: '3 new messages · Jump to latest' })).toBeVisible();
  });
});
