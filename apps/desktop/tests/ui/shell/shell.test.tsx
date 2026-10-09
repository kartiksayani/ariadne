import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { Shell, type ShellProps } from '../../../src/ui/shell/Shell';
import { resolveTheme, useAppliedTheme } from '../../../src/ui/shell/theme';
import { tabModels } from '../../../src/ui/shell/model';
import { WaitingFrame } from '../../../src/ui/waiting/WaitingColumn';
import { ItemHistoryContext } from '../../../src/ui/shell/itemHistory';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete document.documentElement.dataset.theme; });

const now = new Date(2026, 9, 7, 15, 30).getTime();
function props(patch: Partial<ShellProps> = {}): ShellProps {
  const sessions = [{ id: 's1', project: 'checkout', agent: 'claude-code', createdAt: new Date(2026, 9, 7, 14, 2).getTime(), endedAt: null, running: true, on: true }];
  return {
    header: { text: { sessionText: 'checkout · started 14:02', connText: 'Connected · claude-code', connColor: 'var(--st-done)' }, query: '', views: null,
      railOn: false, theme: 'dark' },
    tabs: { tabs: tabModels({ selection: 'session', sessions, projectCount: 1 }, now), onSelect: vi.fn(), onClose: vi.fn() },
    body: { waiting: <p>Waiting column</p>, center: <p>Centre column</p> },
    summary: '10 items · 3 waiting on you · 2 in progress · 4 open',
    ...patch,
  };
}

describe('Paperwhite shell', () => {
  it('hides and unhides from the detail header next to Remove, and explains the key in the footer', () => {
    const hide = vi.fn();
    const value = props({ body: { waiting: null, center: null, detail: <p>Detail</p>, onHide: hide } });
    const { rerender } = render(<Shell {...value} />);
    const button = screen.getByRole('button', { name: 'Hide item' });
    expect(button.title).toBe('Hide (x)');
    expect(button.querySelector('svg path[d="m3 3 18 18"]')).not.toBeNull();
    expect(button.nextElementSibling?.getAttribute('aria-label')).toBe('Remove item');
    fireEvent.click(button); expect(hide).toHaveBeenCalledOnce();
    expect(document.querySelector('.shell-footer')?.textContent).toContain('xhide / unhide');
    rerender(<Shell {...value} body={{ ...value.body, hidden: true }} />);
    const unhide = screen.getByRole('button', { name: 'Unhide item' });
    expect(unhide.title).toBe('Unhide (x)');
    expect(unhide.querySelector('svg path[d="m3 3 18 18"]')).toBeNull();
    fireEvent.click(unhide); expect(hide).toHaveBeenCalledTimes(2);
  });

  it('puts accessible Back/Forward icons before the detail breadcrumb, with shortcut tooltips and disabled endpoints', () => {
    const back = vi.fn(() => true), forward = vi.fn(() => true);
    const value = props({ body: { waiting: null, center: null, detail: <p>Detail</p>, detailPath: <span>Topic / #2</span> } });
    const { rerender } = render(<ItemHistoryContext.Provider value={{ canBack: true, canForward: false, back, forward }}><Shell {...value} /></ItemHistoryContext.Provider>);
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Back' });
    expect(button.title).toBe('Back (⌘[)'); expect(button.querySelector('.ph-arrow-left')).not.toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Forward' }).disabled).toBe(true);
    expect(button.closest('.shell-detail-history')?.nextElementSibling?.className).toBe('shell-detail-path');
    fireEvent.click(button); expect(back).toHaveBeenCalledOnce();
    rerender(<ItemHistoryContext.Provider value={{ canBack: false, canForward: true, back, forward }}><Shell {...value} /></ItemHistoryContext.Provider>);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Back' }).disabled).toBe(true);
    const next = screen.getByRole<HTMLButtonElement>('button', { name: 'Forward' });
    expect(next.title).toBe('Forward (⌘])'); expect(next.querySelector('.ph-arrow-right')).not.toBeNull();
    fireEvent.click(next); expect(forward).toHaveBeenCalledOnce();
  });

  it('renders header, tabs, body and footer from props', () => {
    const value = props(); render(<Shell {...value} />);
    expect(document.querySelector('.shell-session-text')?.textContent).toBe('checkout · started 14:02');
    expect(document.querySelector('.shell-connection-text')?.textContent).toBe('Connected · claude-code');
    const search = screen.getByRole<HTMLInputElement>('textbox', { name: 'Search questions and outcomes' });
    expect(search.readOnly).toBe(true); expect(search.dataset.shellSearch).toBe('');
    expect(screen.queryByRole('group', { name: 'View' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Switch to light' }).querySelector('.ph-sun')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Messages (m)' }).getAttribute('aria-pressed')).toBe('false');
    const tabs = screen.getByRole('navigation', { name: 'Projects and sessions' });
    expect(within(tabs).getByRole('button', { name: 'Projects' }).dataset.shellTab).toBe('projects');
    const session = within(tabs).getByRole('button', { name: 'claude-code Today 14:02' });
    expect(session.getAttribute('aria-current')).toBe('page'); expect(session.dataset.sessionTab).toBe('s1');
    fireEvent.click(session); expect(value.tabs.onSelect).toHaveBeenCalledWith('s1');
    fireEvent.click(within(tabs).getByRole('button', { name: 'Close claude-code Today 14:02 tab' })); expect(value.tabs.onClose).toHaveBeenCalledWith('s1');
    expect(screen.getByText('Waiting column')).toBeTruthy();
    expect(screen.getByRole('main').textContent).toBe('Centre column');
    expect((document.querySelector('.shell-body') as HTMLElement).style.gridTemplateColumns).toBe('300px minmax(560px,1fr)');
    expect(screen.queryByRole('complementary', { name: 'Item detail' })).toBeNull();
    expect(document.querySelector('.shell-summary')?.textContent).toBe('10 items · 3 waiting on you · 2 in progress · 4 open');
    expect([...document.querySelectorAll('.shell-footer .pw-keycap')].map(key => key.textContent)).toContain('esc');
    const footer = document.querySelector('.shell-footer')!;
    expect(footer.textContent).toContain('⌥1–9send choice + note');
    expect(footer.textContent).toContain('⌥0focus own words');
    expect(footer.textContent).toContain('⌘↵reply only');
  });

  it('wires views, search, rail, theme and the detail column', () => {
    const select = vi.fn(), query = vi.fn(), rail = vi.fn(), theme = vi.fn(), close = vi.fn(), remove = vi.fn();
    render(<Shell {...props({
      header: { text: { sessionText: 's', connText: 'c', connColor: 'var(--st-open)' }, demo: true, query: 'needle', onQueryChange: query,
        views: [{ label: 'Tree', icon: 'ph ph-tree-view', title: 'Tree (g)', on: true, onSelect: select }, { label: 'Graph', icon: 'ph ph-graph', title: 'Graph (g)', on: false }],
        railOn: true, onToggleRail: rail, theme: 'light', onToggleTheme: theme },
      body: { waiting: null, center: null, detail: <section><p>Detail body</p></section>, rail: <aside aria-label="Messages">Rail</aside>, onCloseDetail: close, onRemove: remove },
    })} />);
    expect(screen.getByText('Demo')).toBeTruthy();
    const views = screen.getByRole('group', { name: 'View' });
    expect(within(views).getByRole('button', { name: 'Tree' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(views).getByRole('button', { name: 'Tree' })); expect(select).toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search questions and outcomes' }), { target: { value: 'next' } }); expect(query).toHaveBeenCalledWith('next');
    fireEvent.click(screen.getByRole('button', { name: 'Messages (m)' })); expect(rail).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark' })); expect(theme).toHaveBeenCalled();
    const detail = screen.getByRole('complementary', { name: 'Item detail' });
    expect(detail.querySelector('.shell-detail-scroll')?.textContent).toBe('Detail body');
    fireEvent.click(within(detail).getByRole('button', { name: 'Remove item' })); expect(remove).toHaveBeenCalled();
    fireEvent.click(within(detail).getByRole('button', { name: 'Close detail' })); expect(close).toHaveBeenCalled();
    expect((document.querySelector('.shell-body') as HTMLElement).style.gridTemplateColumns).toBe('300px minmax(560px,1fr) 400px 240px');
  });

  it('folds the Waiting column to a strip with its count and saves the owner choice', () => {
    const fold = vi.fn();
    const { rerender } = render(<Shell {...props({ body: { waiting: <WaitingFrame count="3"><p>Card</p></WaitingFrame>, center: null, onFoldWaiting: fold } })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide Waiting on me' }));
    expect(fold).toHaveBeenCalledWith(true);
    rerender(<Shell {...props({ body: { waiting: <WaitingFrame count="3"><p>Card</p></WaitingFrame>, center: null, onFoldWaiting: fold, waitingFolded: true } })} />);
    expect((document.querySelector('.shell-body') as HTMLElement).style.gridTemplateColumns).toBe('44px minmax(560px,1fr)');
    // The list stays mounted but hidden; the strip keeps the count in view.
    expect((screen.getByText('Card').closest('.waiting-scroll') as HTMLElement).hidden).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Show Waiting on me (3)' }));
    expect(fold).toHaveBeenLastCalledWith(false);
  });

  it('draws an icon on both the Hide and the Show button of the Waiting column', () => {
    // Phosphor ships as a bundled subset; a class outside it renders an empty square.
    const icons = readFileSync(resolve(__dirname, '../../../public/icons/phosphor.css'), 'utf8');
    const glyph = (button: HTMLElement) => button.querySelector('i')!.className.split(' ').find(name => name !== 'ph')!;
    const { rerender } = render(<Shell {...props({ body: { waiting: <WaitingFrame count="3" />, center: null, onFoldWaiting: vi.fn() } })} />);
    const hide = screen.getByRole('button', { name: 'Hide Waiting on me' });
    expect(hide.className).toContain('btn-icon');
    expect(icons).toContain(`.ph.${glyph(hide)}::before`);
    rerender(<Shell {...props({ body: { waiting: <WaitingFrame count="3" />, center: null, onFoldWaiting: vi.fn(), waitingFolded: true } })} />);
    expect(icons).toContain(`.ph.${glyph(screen.getByRole('button', { name: 'Show Waiting on me (3)' }))}::before`);
  });

  it('folds the Waiting column by itself in a window too narrow for every column, and the owner can still open it', () => {
    vi.stubGlobal('ResizeObserver', class {
      constructor(private readonly receive: ResizeObserverCallback) {}
      observe() { this.receive([{ contentRect: { width: 1300 } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
      disconnect() {}
    });
    const fold = vi.fn();
    render(<Shell {...props({ body: { waiting: <WaitingFrame count="2" />, center: null, detail: <p>Detail</p>, rail: <aside>Rail</aside>, onFoldWaiting: fold } })} />);
    const grid = () => (document.querySelector('.shell-body') as HTMLElement).style.gridTemplateColumns;
    expect(grid()).toBe('44px minmax(560px,1fr) 400px 240px');
    fireEvent.click(screen.getByRole('button', { name: 'Show Waiting on me (2)' }));
    // Opening it in a narrow window is not saved as the owner's fold; the centre squeezes instead.
    expect(fold).not.toHaveBeenCalled();
    expect(grid()).toBe('300px minmax(0,1fr) 400px 240px');
    fireEvent.click(screen.getByRole('button', { name: 'Hide Waiting on me' }));
    expect(fold).toHaveBeenCalledWith(true);
  });

  it('resizes the detail panel from its left edge by pointer and keys, inside the bounds, and saves the width', () => {
    vi.useFakeTimers();
    try {
      const resize = vi.fn();
      const { rerender } = render(<Shell {...props({ body: { waiting: null, center: null, detail: <p>Detail</p>, onResizeDetail: resize } })} />);
      const edge = screen.getByRole('separator', { name: 'Resize detail panel' });
      expect(edge.getAttribute('aria-valuenow')).toBe('400');
      fireEvent.pointerDown(edge, { button: 0, clientX: 1000, pointerId: 1 });
      fireEvent.pointerMove(edge, { clientX: 880, pointerId: 1 });
      expect((document.querySelector('.shell-body') as HTMLElement).style.gridTemplateColumns).toBe('300px minmax(560px,1fr) 520px');
      fireEvent.pointerUp(edge, { clientX: 880, pointerId: 1 });
      expect(resize).toHaveBeenCalledWith(520);
      rerender(<Shell {...props({ body: { waiting: null, center: null, detail: <p>Detail</p>, onResizeDetail: resize, detailWidth: 520 } })} />);
      // Dragging past the bounds stops at them.
      fireEvent.pointerDown(edge, { button: 0, clientX: 1000, pointerId: 1 });
      fireEvent.pointerMove(edge, { clientX: 1900, pointerId: 1 });
      fireEvent.pointerUp(edge, { pointerId: 1 });
      expect(resize).toHaveBeenLastCalledWith(320);
      // Keys step it and save once they settle.
      resize.mockClear();
      fireEvent.keyDown(edge, { key: 'ArrowLeft' }); fireEvent.keyDown(edge, { key: 'ArrowLeft' });
      expect(edge.getAttribute('aria-valuenow')).toBe('552');
      expect(resize).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(600); });
      expect(resize).toHaveBeenCalledOnce(); expect(resize).toHaveBeenCalledWith(552);
      fireEvent.doubleClick(edge);
      expect(resize).toHaveBeenLastCalledWith(400);
    } finally { vi.useRealTimers(); }
  });

  it('disables chrome controls while navigation writes', () => {
    render(<Shell {...props({ header: { ...props().header, onQueryChange: vi.fn(), onToggleRail: vi.fn(), onToggleTheme: vi.fn(), disabled: true },
      tabs: { ...props().tabs, disabled: true } })} />);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Search questions and outcomes' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Messages (m)' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Projects' }).disabled).toBe(true);
  });
});

describe('theme', () => {
  it('resolves system against the OS preference', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('applies the resolved theme to the document and follows OS changes for system', () => {
    let listener: (() => void) | undefined; const media = { matches: false, addEventListener: (_: string, value: () => void) => { listener = value; }, removeEventListener: vi.fn() };
    vi.stubGlobal('matchMedia', () => media);
    const { result, rerender, unmount } = renderHook(({ theme }) => useAppliedTheme(theme), { initialProps: { theme: 'system' as 'system' | 'dark' | 'light' } });
    expect(result.current).toBe('light'); expect(document.documentElement.dataset.theme).toBe('light');
    media.matches = true; act(() => listener?.());
    expect(result.current).toBe('dark'); expect(document.documentElement.dataset.theme).toBe('dark');
    rerender({ theme: 'light' }); expect(document.documentElement.dataset.theme).toBe('light');
    expect(media.removeEventListener).toHaveBeenCalled();
    unmount();
  });
});
