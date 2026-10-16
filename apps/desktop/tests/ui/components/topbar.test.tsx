import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { TopBar } from '../../../src/ui/topbar/TopBar';
import { connectionBadge } from '../../../src/ui/topbar/connection';
import { NARROW_BELOW, type ConnectionKind, type ConnectionView, type TopBarProps } from '../../../src/ui/topbar/model';
import { useNarrow } from '../../../src/ui/topbar/useNarrow';

afterEach(cleanup);

const live: ConnectionView = { kind: 'live', where: 'Claude Code in iTerm window 1', agent: 'Claude Code' };
function props(patch: Partial<TopBarProps> = {}): TopBarProps {
  return {
    narrow: false, project: 'notes-sdk', sessionName: 'cache PR review', otherWaiting: 3, switcherOpen: false, onSwitcherToggle: vi.fn(),
    connection: live, connectionOpen: false, onConnectionToggle: vi.fn(),
    search: { active: false, query: '', onOpen: vi.fn(), onQuery: vi.fn(), onNext: vi.fn(), onPrev: vi.fn(), onClear: vi.fn() },
    view: 'tree', onView: vi.fn(), filter: { active: false, count: 0, onToggle: vi.fn() }, recent: { active: false, onToggle: vi.fn() },
    archive: { active: false, onOpen: vi.fn() }, textSize: 80, onTextSizeChange: vi.fn(), theme: 'light', onToggleTheme: vi.fn(), help: { open: false, onToggle: vi.fn() },
    ...patch,
  };
}

describe('TopBar, wide', () => {
  it('names the project and session, and says in words how many questions wait in other sessions', () => {
    render(<TopBar {...props()} />);
    const button = screen.getByRole('button', { name: /Switch session or project/ });
    expect(button.textContent).toContain('notes-sdk');
    expect(button.textContent).toContain('cache PR review');
    expect(button.getAttribute('aria-label')).toBe('Switch session or project. notes-sdk / cache PR review, 3 questions waiting in other sessions');
    expect(within(button).getByRole('img').getAttribute('aria-label')).toBe('3 questions waiting on you in other sessions');
  });

  it('draws no waiting chip when nothing waits elsewhere, and says "1 question" for one', () => {
    const { rerender } = render(<TopBar {...props({ otherWaiting: 0 })} />);
    expect(within(screen.getByRole('button', { name: /Switch session or project/ })).queryByRole('img')).toBeNull();
    rerender(<TopBar {...props({ otherWaiting: 1 })} />);
    expect(screen.getByRole('button', { name: /Switch session or project/ }).getAttribute('aria-label')).toContain('1 question waiting in other sessions');
  });

  it('shows the connection word and the labels of Tree and Graph', () => {
    render(<TopBar {...props()} />);
    expect(screen.getByRole('button', { name: /Live/ }).textContent).toBe('Live');
    expect(screen.getByRole('button', { name: 'Tree' }).textContent).toBe('Tree');
    expect(screen.getByRole('button', { name: 'Graph' }).textContent).toBe('Graph');
    expect(screen.getByRole('button', { name: 'Search the Map' }).textContent).toContain('Search the Map');
  });

  it('fires each control once, with the arguments the owner asked for', () => {
    const p = props();
    render(<TopBar {...p} />);
    fireEvent.click(screen.getByRole('button', { name: /Switch session or project/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Search the Map' }));
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }));
    fireEvent.click(screen.getByRole('button', { name: 'Filter by status' }));
    fireEvent.click(screen.getByRole('button', { name: 'Recent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark' }));
    fireEvent.click(screen.getByRole('button', { name: 'Help: keys and markers' }));
    fireEvent.click(screen.getByRole('button', { name: /Live/ }));
    expect(p.onSwitcherToggle).toHaveBeenCalledTimes(1);
    expect(p.search.onOpen).toHaveBeenCalledTimes(1);
    expect(p.onView).toHaveBeenCalledWith('graph');
    expect(p.filter.onToggle).toHaveBeenCalledTimes(1);
    expect(p.recent.onToggle).toHaveBeenCalledTimes(1);
    expect(p.archive.onOpen).toHaveBeenCalledTimes(1);
    expect(p.onToggleTheme).toHaveBeenCalledTimes(1);
    expect(p.help.onToggle).toHaveBeenCalledTimes(1);
    expect(p.onConnectionToggle).toHaveBeenCalledTimes(1);
  });

  it('shows how many statuses the filter holds, in words for a screen reader', () => {
    render(<TopBar {...props({ filter: { active: true, count: 2, onToggle: vi.fn() } })} />);
    const button = screen.getByRole('button', { name: 'Filter by status, 2 statuses picked' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.textContent).toBe('2');
  });

  it('marks the open popovers: the switcher, the connection and Help', () => {
    render(<TopBar {...props({ switcherOpen: true, connectionOpen: true, help: { open: true, onToggle: vi.fn() } })} />);
    expect(screen.getByRole('button', { name: /Switch session or project/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: /Live/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'Help: keys and markers' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('draws the connection card under its button only while it is open', () => {
    const card = <div role="dialog" aria-label="card">card</div>;
    const { rerender } = render(<TopBar {...props({ connectionCard: card })} />);
    expect(screen.queryByRole('dialog', { name: 'card' })).toBeNull();
    rerender(<TopBar {...props({ connectionCard: card, connectionOpen: true })} />);
    expect(screen.getByRole('dialog', { name: 'card' })).toBeTruthy();
  });
});

describe('TopBar, narrow', () => {
  it('drops the project name and every word beside an icon, and keeps one "…" for the rest', () => {
    render(<TopBar {...props({ narrow: true })} />);
    expect(screen.getByRole('button', { name: /Switch session or project/ }).textContent).not.toContain('notes-sdk');
    expect(screen.getByRole('button', { name: /Live/ }).textContent).toBe('');
    expect(screen.getByRole('button', { name: 'Tree' }).textContent).toBe('');
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Help: keys and markers' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Search the Map' }).textContent).toBe('');
    expect(screen.getByRole('button', { name: /More: archive, text size, theme, help/ })).toBeTruthy();
  });

  it('keeps the words of a state that needs them, shortened', () => {
    const { rerender } = render(<TopBar {...props({ narrow: true, connection: { kind: 'off', agent: 'Claude Code' } })} />);
    expect(screen.getByRole('button', { name: /Not running/ }).textContent).toBe('Not running');
    rerender(<TopBar {...props({ narrow: false, connection: { kind: 'off', agent: 'Claude Code' } })} />);
    expect(screen.getByRole('button', { name: /Claude Code not running/ }).textContent).toBe('Claude Code not running');
  });

  it('opens the "…" menu with the four wide-only controls, and each does its job', () => {
    const p = props({ narrow: true });
    render(<TopBar {...p} />);
    const more = screen.getByRole('button', { name: /More: archive, text size, theme, help/ });
    fireEvent.click(more);
    const menu = screen.getByRole('menu');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Archive' }));
    expect(p.archive.onOpen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Switch to dark' }));
    expect(p.onToggleTheme).toHaveBeenCalledTimes(1);
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('menuitem', { name: /Help: keys and markers/ }));
    expect(p.help.onToggle).toHaveBeenCalledTimes(1);
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('menuitemradio', { name: '110%' }));
    expect(p.onTextSizeChange).toHaveBeenCalledWith(110);
  });

  it('closes the "…" menu with Esc and puts focus back on its button', () => {
    render(<TopBar {...props({ narrow: true })} />);
    const more = screen.getByRole('button', { name: /More: archive, text size, theme, help/ });
    fireEvent.click(more);
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it('walks the menu with the arrow keys', () => {
    render(<TopBar {...props({ narrow: true })} />);
    fireEvent.click(screen.getByRole('button', { name: /More: archive, text size, theme, help/ }), { detail: 0 });
    const items = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1]!, { key: 'ArrowUp' });
    fireEvent.keyDown(items[0]!, { key: 'ArrowUp' });
    // From the top, ArrowUp wraps to the last control: the 120% text size.
    expect(document.activeElement?.textContent).toBe('120%');
  });
});

describe('TopBar, search', () => {
  const search = (patch = {}) => ({ active: true, query: 'per-workspace', count: '2 of 4', onOpen: vi.fn(), onQuery: vi.fn(), onNext: vi.fn(), onPrev: vi.fn(), onClear: vi.fn(), ...patch });

  it('shows the query, the count in words, and focuses the box when it opens', () => {
    const { rerender } = render(<TopBar {...props()} />);
    rerender(<TopBar {...props({ search: search() })} />);
    const box = screen.getByRole('textbox', { name: 'Search the Map' }) as HTMLInputElement;
    expect(box.value).toBe('per-workspace');
    expect(screen.getByRole('status').textContent).toBe('2 of 4');
    expect(document.activeElement).toBe(box);
  });

  it('types, steps with Enter and Shift+Enter, and clears with Esc without the workspace seeing it', () => {
    const s = search();
    render(<TopBar {...props({ search: s })} />);
    const box = screen.getByRole('textbox', { name: 'Search the Map' });
    fireEvent.change(box, { target: { value: 'cache' } });
    expect(s.onQuery).toHaveBeenCalledWith('cache');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(s.onNext).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(s.onPrev).toHaveBeenCalledTimes(1);
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    fireEvent.keyDown(box, { key: 'Escape' });
    document.removeEventListener('keydown', outer);
    expect(s.onClear).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it('draws no match arrows when the search only filters, and leaves Enter alone', () => {
    const s = search({ onNext: undefined, onPrev: undefined, count: undefined });
    render(<TopBar {...props({ search: s })} />);
    expect(screen.queryByRole('button', { name: 'Next match' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Previous match' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Clear the search' })).toBeTruthy();
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search the Map' }), { key: 'Enter' });
    document.removeEventListener('keydown', outer);
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it('says what else matches and offers to show it', () => {
    const onAction = vi.fn();
    render(<TopBar {...props({ search: search({ note: { text: 'Also matching: 1 in a hidden item.', action: 'Show them', onAction } }) })} />);
    expect(screen.getByText('Also matching: 1 in a hidden item.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show them' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});

describe('TopBar, first run and pages', () => {
  it('first run draws the mark, "No projects yet", and only text size, theme and help', () => {
    render(<TopBar {...props({ variant: 'first-run', connection: undefined })} />);
    expect(screen.getByText('No projects yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Switch session or project/ })).toBeNull();
    for (const name of ['Search the Map', 'Tree', 'Graph', 'Recent', 'Archive']) expect(screen.queryByRole('button', { name })).toBeNull();
    for (const name of ['Text size', 'Switch to dark', 'Help: keys and markers']) expect(screen.getByRole('button', { name })).toBeTruthy();
  });

  it('a page shows "N waiting in this session" and goes back to it; narrow says "N waiting here"', () => {
    const onWaitingHere = vi.fn();
    const { rerender } = render(<TopBar {...props({ variant: 'page', waitingHere: 2, onWaitingHere })} />);
    fireEvent.click(screen.getByRole('button', { name: '2 waiting in this session' }));
    expect(onWaitingHere).toHaveBeenCalledTimes(1);
    rerender(<TopBar {...props({ variant: 'page', narrow: true, waitingHere: 2, onWaitingHere })} />);
    expect(screen.getByRole('button', { name: '2 waiting here' })).toBeTruthy();
  });

  it('draws no waiting chip on a page when nothing waits, or on a session', () => {
    const { rerender } = render(<TopBar {...props({ variant: 'page', waitingHere: 0 })} />);
    expect(screen.queryByText(/waiting in this session/)).toBeNull();
    rerender(<TopBar {...props({ variant: 'session', waitingHere: 2 })} />);
    expect(screen.queryByText(/waiting in this session/)).toBeNull();
  });
});

describe('connectionBadge', () => {
  const kinds: ConnectionKind[] = ['live', 'loading', 'none', 'off', 'closed', 'reconnect', 'unreadable', 'stale', 'unsaved'];
  it.each(kinds)('%s has a word or a mark, and a title, wide and narrow', kind => {
    for (const narrow of [false, true]) {
      const badge = connectionBadge({ kind, agent: 'Claude Code', where: 'Claude Code in iTerm window 1', lastGoodAt: '21:24' }, narrow);
      expect(badge.title.length).toBeGreaterThan(5);
      expect(badge.dot || badge.icon).toBeTruthy();
      expect(badge.label.length).toBeGreaterThan(0);
    }
  });

  it('keeps the exact words the board draws', () => {
    const view = (kind: ConnectionKind): ConnectionView => ({ kind, agent: 'Claude Code', lastGoodAt: '21:24' });
    expect(connectionBadge(view('off'), false).label).toBe('Claude Code not running');
    expect(connectionBadge(view('off'), true).label).toBe('Not running');
    expect(connectionBadge(view('unreadable'), false).label).toBe('Can’t read the session');
    expect(connectionBadge(view('unreadable'), true).label).toBe('Can’t read');
    expect(connectionBadge(view('stale'), false).label).toBe('Last good copy, 21:24');
    expect(connectionBadge(view('stale'), true).label).toBe('Last good copy');
    expect(connectionBadge(view('unsaved'), false).label).toBe('Live · not saving');
    expect(connectionBadge(view('unsaved'), true).label).toBe('Not saving');
    expect(connectionBadge(view('live'), true).showLabel).toBe(false);
  });
});

describe('useNarrow', () => {
  it('is narrow below 1100 px and follows a resize', () => {
    let width = 900;
    const Probe = () => <p>{useNarrow(() => width) ? 'narrow' : 'wide'}</p>;
    render(<Probe />);
    expect(screen.getByText('narrow')).toBeTruthy();
    width = 1280;
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(screen.getByText('wide')).toBeTruthy();
    width = NARROW_BELOW - 1;
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(screen.getByText('narrow')).toBeTruthy();
  });
});
