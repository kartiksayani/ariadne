import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { SwitcherMenu, findIn } from '../../../src/ui/topbar/SwitcherMenu';
import type { SwitcherProject } from '../../../src/ui/topbar/model';

afterEach(cleanup);

const q = (itemId: string, title: string, since: string) => ({ itemId, title, since });
const projects: Array<SwitcherProject<string>> = [
  { id: 'api', name: 'notes-api', sessions: [
    { route: 'schema', name: 'schema review', agent: 'Claude Code', running: true, waiting: [q('c', 'Drop the unused legacy ID column in this migration?', '12 min'), q('d', 'Run the backfill during business hours?', '3 min')] },
    { route: 'limits', name: 'rate limits', agent: 'Codex', running: false, waiting: [] },
  ] },
  { id: 'sdk', name: 'notes-sdk', current: true, sessions: [
    { route: 'cache', name: 'cache PR review', agent: 'Claude Code', running: true, current: true, waiting: [q('a', 'Should workspace keys still get a note?', '34 min')] },
    { route: 'docs', name: 'docs pass', agent: 'Claude Code', running: false, closed: true, closedWhen: 'yesterday', waiting: [] },
  ] },
  { id: 'web', name: 'notes-web', sessions: [{ route: 'flaky', name: 'flaky tests', agent: 'Claude Code', running: true, waiting: [q('e', 'Quarantine the two flaky tests?', '40 min')] }] },
];

function mount(patch: Partial<Parameters<typeof SwitcherMenu<string>>[0]> = {}) {
  const handlers = { onOpenSession: vi.fn(), onOpenPage: vi.fn(), onClose: vi.fn() };
  render(<SwitcherMenu projects={projects} {...handlers} {...patch} />);
  return handlers;
}

describe('SwitcherMenu', () => {
  it('lists this project first, then the others in the order given, with the words of each session', () => {
    mount();
    const groups = screen.getAllByRole('group').map(group => group.getAttribute('aria-label'));
    expect(groups).toEqual(['notes-sdk', 'notes-api', 'notes-web']);
    expect(screen.getByText('notes-sdk · this project')).toBeTruthy();
    expect(screen.getByRole('option', { name: /cache PR review/ }).textContent).toContain('Claude Code · running');
    expect(screen.getByRole('option', { name: /rate limits/ }).textContent).toContain('Codex · not running');
    expect(screen.getByRole('option', { name: /docs pass/ }).textContent).toContain('Claude Code · closed yesterday');
  });

  it('marks the current session, and names the waiting questions of the other sessions only', () => {
    mount();
    expect(within(screen.getByRole('option', { name: /cache PR review/ })).getByRole('img', { name: 'This session' })).toBeTruthy();
    expect(screen.queryByText('Should workspace keys still get a note?')).toBeNull();
    expect(screen.getByText('Drop the unused legacy ID column in this migration?')).toBeTruthy();
    expect(screen.getByText('12 min')).toBeTruthy();
    expect(within(screen.getByRole('option', { name: /schema review/ })).getByRole('img', { name: '2 questions waiting on you' })).toBeTruthy();
    expect(within(screen.getByRole('option', { name: /^flaky tests/ })).getByRole('img', { name: '1 question waiting on you' })).toBeTruthy();
  });

  it('opens a session, or the very question under it, and closes itself first', () => {
    const { onOpenSession, onClose } = mount();
    fireEvent.click(screen.getByRole('option', { name: /schema review/ }));
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ route: 'schema' }), 'api', undefined);
    fireEvent.click(screen.getByRole('option', { name: /Run the backfill/ }));
    expect(onOpenSession).toHaveBeenLastCalledWith(expect.objectContaining({ route: 'schema' }), 'api', 'd');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('finds sessions by name as you type, and a project by its name with all of its sessions', () => {
    mount();
    const box = screen.getByRole('combobox', { name: 'Find a session or project' });
    fireEvent.change(box, { target: { value: 'sch' } });
    expect(screen.getByRole('option', { name: /schema review/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /rate limits/ })).toBeNull();
    expect(screen.queryByRole('option', { name: /cache PR review/ })).toBeNull();
    fireEvent.change(box, { target: { value: 'notes-api' } });
    expect(screen.getByRole('option', { name: /schema review/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /rate limits/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /flaky tests/ })).toBeNull();
  });

  it('says so when nothing matches, quoting what was typed', () => {
    mount();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: ' zzz ' } });
    expect(screen.getByRole('status').textContent).toBe('No session or project matches “zzz”.');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('highlights the first match while typing and Enter opens it', () => {
    const { onOpenSession } = mount();
    const box = screen.getByRole('combobox');
    fireEvent.change(box, { target: { value: 'sch' } });
    expect(box.getAttribute('aria-activedescendant')).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ route: 'schema' }), 'api', undefined);
  });

  it('does nothing on Enter until an arrow key has picked a row, then moves through rows and questions', () => {
    const { onOpenSession } = mount();
    const box = screen.getByRole('combobox');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onOpenSession).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    // notes-sdk: cache PR review, docs pass. Next: notes-api, schema review.
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ route: 'schema' }), 'api', undefined);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onOpenSession).toHaveBeenLastCalledWith(expect.objectContaining({ route: 'schema' }), 'api', 'c');
  });

  it('wraps from the top to the last row with ArrowUp', () => {
    const { onOpenSession } = mount();
    const box = screen.getByRole('combobox');
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ route: 'flaky' }), 'web', 'e');
  });

  it('leads to Projects, All sessions and Archive, and says drafts stay where they are', () => {
    const { onOpenPage, onClose } = mount();
    expect(screen.getByText('Switching keeps your drafts where they are.')).toBeTruthy();
    for (const [name, page] of [['Projects', 'projects'], ['All sessions', 'sessions'], ['Archive', 'archive']] as const) {
      fireEvent.click(screen.getByRole('button', { name }));
      expect(onOpenPage).toHaveBeenLastCalledWith(page);
    }
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('closes on Esc and on a press outside, but not on a press on its own trigger', () => {
    const { onClose } = mount();
    const trigger = document.createElement('button');
    trigger.dataset.popoverTrigger = 'switcher';
    document.body.append(trigger);
    fireEvent.pointerDown(trigger);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    trigger.remove();
  });

  it('takes focus into the search box when it opens, and gives it back when it goes', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const view = render(<SwitcherMenu projects={projects} onOpenSession={vi.fn()} onOpenPage={vi.fn()} onClose={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByRole('combobox'));
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

describe('findIn', () => {
  it('keeps the current project first whatever the order given, and drops projects with no match', () => {
    expect(findIn(projects, '').map(group => group.project.id)).toEqual(['sdk', 'api', 'web']);
    expect(findIn(projects, 'flaky').map(group => group.project.id)).toEqual(['web']);
    expect(findIn(projects, 'nothing here')).toEqual([]);
  });
});
