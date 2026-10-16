import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Shell as SlotShell } from '../../../src/ui/shell/Shell';
import { Header, type HeaderProps } from '../../../src/ui/shell/Header';
import { TabBar, type TabBarProps } from '../../../src/ui/shell/TabBar';
import { Footer } from '../../../src/ui/shell/Footer';
import { DetailsColumn } from '../../../src/ui/shell/DetailsColumn';
import { DetailsColumnProvider } from '../../../src/state/details/column';
import { resolveTheme, useAppliedTheme } from '../../../src/ui/shell/theme';
import { tabModels, type ConversationFooterState } from '../../../src/ui/shell/model';
import { WaitingFrame } from '../../../src/ui/waiting/WaitingColumn';
import { ItemHistoryContext } from '../../../src/ui/shell/itemHistory';
import { notices } from '../../../src/ui/pages/notices';

const jsdomWidth = window.innerWidth;
// Details is 400 wide in a window of 1100 or more (state/details/column.ts); a body without a measured width is a wide one.
beforeEach(() => { setWindow(1280); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete document.documentElement.dataset.theme; setWindow(jsdomWidth); });

/** Today's chrome (header, tabs, Waiting, detail, footer) through the shell's slots, as NavigationWorkspace builds it. */
interface ShellProps {
  readonly header: HeaderProps;
  readonly tabs: TabBarProps;
  readonly body: {
    readonly waiting: ReactNode; readonly center: ReactNode; readonly conversation?: ReactNode; readonly detail?: ReactNode; readonly detailPath?: ReactNode;
    readonly onCloseDetail?: () => void; readonly onRemove?: () => void; readonly hidden?: boolean; readonly hiddenNotice?: string; readonly onHide?: () => void;
    readonly detailWidth?: number | null; readonly onResizeDetail?: (width: number) => void; readonly waitingFolded?: boolean; readonly onFoldWaiting?: (folded: boolean) => void;
  };
  readonly summary: string;
  readonly conversationFooter?: ConversationFooterState;
  readonly overlay?: ReactNode;
}
function Shell({ header, tabs, body, summary, conversationFooter, overlay }: ShellProps) {
  return <DetailsColumnProvider saved={body.detailWidth} onSave={body.onResizeDetail}><SlotShell topBar={<><Header {...header} /><TabBar {...tabs} /></>} main={body.center}
    side={body.detail ? <DetailsColumn path={body.detailPath} onClose={body.onCloseDetail} onRemove={body.onRemove} hidden={body.hidden} hiddenNotice={body.hiddenNotice}
      onHide={body.onHide}>{body.detail}</DetailsColumn> : undefined}
    footer={<Footer summary={summary} conversation={body.conversation ? conversationFooter ?? { question: false } : undefined} />}
    legacy={{ waiting: body.waiting, conversation: body.conversation, waitingFolded: body.waitingFolded, onFoldWaiting: body.onFoldWaiting }}
    overlay={overlay} /></DetailsColumnProvider>;
}

const now = new Date(2026, 9, 7, 15, 30).getTime();
function props(patch: Partial<ShellProps> = {}): ShellProps {
  const sessions = [{ id: 's1', project: 'search', agent: 'claude-code', createdAt: new Date(2026, 9, 7, 14, 2).getTime(), endedAt: null, running: true, on: true }];
  return {
    header: { text: { sessionText: 'search · started 14:02', connText: 'Connected · claude-code', connColor: 'var(--st-done)' }, query: '', views: null,
      theme: 'dark' },
    tabs: { tabs: tabModels({ selection: 'session', sessions, projectCount: 1 }, now), onSelect: vi.fn(), onClose: vi.fn() },
    body: { waiting: <p>Waiting column</p>, center: <p>Centre column</p> },
    summary: '10 items · 3 waiting on you · 2 in progress · 4 open',
    ...patch,
  };
}

/** The window is as wide as the body here: the Details column sizes itself from the window, the body lays out from its own width. */
function setWindow(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
}
function measureBody(initialWidth: number): (width: number) => void {
  let resize: ((width: number) => void) | undefined;
  setWindow(initialWidth);
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly receive: ResizeObserverCallback) {}
    observe() {
      resize = width => this.receive([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      resize(initialWidth);
    }
    disconnect() {}
  });
  return width => act(() => { setWindow(width); window.dispatchEvent(new Event('resize')); resize?.(width); });
}

describe('Paperwhite shell', () => {
  it('bounds Conversation to the viewport while the covered Map and detail retain their grid and mounted state', () => {
    measureBody(900);
    const value = props({ body: { waiting: <WaitingFrame count="2" />, center: <input aria-label="Map draft" defaultValue="Preserved" />,
      detail: <p>Dock content</p>, onFoldWaiting: vi.fn() } });
    const { rerender } = render(<Shell {...value} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show Waiting on me (2)' }));
    const grid = document.querySelector<HTMLElement>('.shell-body')!, center = screen.getByRole('main');
    const draft = screen.getByRole<HTMLInputElement>('textbox', { name: 'Map draft' });
    const detail = screen.getByRole('complementary', { name: 'Item detail' });
    const columns = grid.style.gridTemplateColumns;
    // The retained Map's minimum columns extend to 960px in this 900px viewport.
    expect(columns).toBe('300px minmax(380px,1fr) 280px');
    fireEvent.change(draft, { target: { value: 'Still here' } });
    rerender(<Shell {...value} body={{ ...value.body, conversation: <p>Conversation content</p> }} />);
    const overlay = screen.getByText('Conversation content').parentElement!;
    expect(overlay.className).toBe('shell-conversation');
    expect(overlay.parentElement?.className).toBe('shell-body-viewport');
    expect(overlay.previousElementSibling).toBe(grid);
    expect(overlay.style.left).toBe('300px');
    expect(grid.style.gridTemplateColumns).toBe(columns);
    expect(grid.querySelector('.shell-center')).toBe(center);
    expect(grid.querySelector('.shell-detail')).toBe(detail);
    expect(center.getAttribute('inert')).toBe('');
    expect(detail.getAttribute('aria-hidden')).toBe('true');
    expect(draft.value).toBe('Still here');
    // CSS owns the actual geometry; browser design assertions complement this jsdom ownership check.
    const css = readFileSync(resolve(__dirname, '../../../src/ui/shell/shell.css'), 'utf8');
    const rules = (selector: string) => css.split(`${selector} {`)[1]!.split('}')[0];
    expect(rules('.shell-body-viewport')).toContain('position: relative;');
    expect(rules('.shell-body-viewport')).toContain('minmax(0, 1fr) / minmax(0, 1fr)');
    expect(rules('.shell-body-viewport')).toContain('overflow: hidden;');
    expect(rules('.shell-conversation')).toContain('position: absolute;');
    expect(rules('.shell-conversation')).toContain('right: 0;');
    expect(rules('.shell-conversation')).not.toContain('grid-column');
    rerender(<Shell {...value} />);
    expect(screen.getByRole('main')).toBe(center);
    expect(screen.getByRole('complementary', { name: 'Item detail' })).toBe(detail);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Map draft' })).toBe(draft);
    expect(draft.value).toBe('Still here');
    expect(grid.style.gridTemplateColumns).toBe(columns);
    expect(center.hasAttribute('inert')).toBe(false);
  });

  it('moves the Conversation edge with the actual Waiting fold and peek as the viewport resizes', () => {
    const resizeWindow = measureBody(900), fold = vi.fn();
    const value = props({ body: { waiting: <WaitingFrame count="2" />, center: <p>Map</p>, detail: <p>Dock</p>,
      conversation: <p>Conversation content</p>, onFoldWaiting: fold } });
    const { rerender } = render(<Shell {...value} />);
    const overlay = document.querySelector<HTMLElement>('.shell-conversation')!;
    expect(overlay.style.left).toBe('44px');
    fireEvent.click(screen.getByRole('button', { name: 'Show Waiting on me (2)' }));
    expect(overlay.style.left).toBe('300px');
    expect(fold).not.toHaveBeenCalled();
    resizeWindow(1400);
    expect(overlay.style.left).toBe('300px');
    rerender(<Shell {...value} body={{ ...value.body, waitingFolded: true }} />);
    expect(overlay.style.left).toBe('44px');
    resizeWindow(900);
    expect(overlay.style.left).toBe('44px');
  });

  it('shows only Conversation shortcuts and hides pinned question keys when no question is pinned', () => {
    const value = props({ body: { waiting: null, center: <p>Map</p>, conversation: <p>Conversation</p> },
      conversationFooter: { question: true } });
    const { rerender } = render(<Shell {...value} />);
    const footer = document.querySelector('.shell-footer')!;
    const keys = () => [...footer.querySelectorAll('.pw-keycap')].map(key => key.textContent);
    expect(keys()).toEqual(['esc', '↑↓', 'a', 'r', '1–9', '⌥1–9', '⌥0', '⌘↵', 'b d o', 'Space']);
    expect(footer.textContent).toContain('escBack to Map');
    expect(footer.textContent).toContain('↑↓messages');
    expect(footer.textContent).toContain('⌘↵send');
    expect(footer.textContent).toContain('aack / answer');
    expect(footer.textContent).toContain('rreply');
    expect(footer.textContent).toContain('b d oitem actions');
    rerender(<Shell {...value} conversationFooter={{ question: false }} />);
    expect(keys()).toEqual(['esc', '↑↓', 'a', 'r', '⌘↵', 'b d o', 'Space']);
    rerender(<Shell {...value} conversationFooter={undefined} />);
    expect(keys()).toEqual(['esc', '↑↓', 'a', 'r', '⌘↵', 'b d o', 'Space']);
    rerender(<Shell {...value} body={{ ...value.body, conversation: undefined }} />);
    expect(keys()).toContain('g');
    expect(keys()).toContain('←→');
    expect(keys()).toContain('b r d z o');
    expect(keys()).not.toContain('r');
    expect(footer.textContent).toContain('⌘↵reply only');
  });

  it('bounds the overlay in a named centre container while its content owns scrolling', () => {
    // jsdom does not lay out CSS; these ownership rules complement the design geometry assertions.
    const shell = readFileSync(resolve(__dirname, '../../../src/ui/shell/shell.css'), 'utf8');
    const notes = readFileSync(resolve(__dirname, '../../../src/ui/pages/notices.css'), 'utf8');
    const rules = (css: string, selector: string) => css.split(`${selector} {`)[1]!.split('}')[0];
    expect(rules(shell, '.shell-center')).toContain('position: relative;');
    expect(rules(shell, '.shell-center')).toContain('container: shell-center / inline-size;');
    expect(rules(shell, '.shell-center')).toContain('overflow: hidden;');
    expect(rules(shell, '.shell-center-content')).toContain('overflow: auto;');
    expect(rules(shell, '.shell-notices')).toContain('container: shell-center / inline-size;');
    expect(rules(shell, '.shell-notices')).toContain('pointer-events: none;');
    expect(Number(rules(shell, '.shell-notices').match(/z-index: (\d+)/)![1])).toBeGreaterThan(Number(rules(shell, '.shell-conversation').match(/z-index: (\d+)/)![1]));
    expect(rules(notes, '.pw-notices')).toContain('position: absolute;');
    expect(rules(notes, '.pw-notices')).toContain('width: min(480px, calc(100% - 32px));');
    expect(notes).toContain('@container shell-center (max-width: 400px)');
  });

  it('keeps notification actions opaque throughout their entrance, including a suspended first frame', () => {
    // A hidden native WebView may suspend at any keyframe; Undo must already be visible.
    const css = readFileSync(resolve(__dirname, '../../../src/ui/pages/notices.css'), 'utf8');
    const animation = css.split('@keyframes pw-notice-arrive {')[1]!.split('@media')[0]!;
    expect(animation).not.toMatch(/opacity:\s*(?:0(?:\.\d+)?|\.\d+)\s*;/);
    expect(animation).toContain('transform: translateY(4px);');
    expect(animation).toContain('transform: translateY(0);');
  });

  it('keeps one notification region above the centre while adjacent panes change, and preserves input focus', () => {
    vi.useFakeTimers();
    try {
      const value = props({ body: { waiting: <p>Waiting column</p>, center: <input aria-label="Centre draft" defaultValue="Draft" />,
        detail: <p>Detail</p> } });
      const { rerender } = render(<Shell {...value} />);
      const center = screen.getByRole('main'), region = screen.getByRole('region', { name: 'Notifications' });
      const anchor = document.querySelector<HTMLElement>('.shell-notices')!;
      const draft = screen.getByRole<HTMLInputElement>('textbox', { name: 'Centre draft' });
      expect(region.parentElement).toBe(anchor);
      expect(anchor.parentElement?.className).toBe('shell-body-viewport');
      expect(anchor.style.left).toBe('300px');
      expect(anchor.style.right).toBe('400px');
      const scroll = center.querySelector('.shell-center-content')!;
      expect(scroll.contains(draft)).toBe(true);
      expect(scroll.contains(region)).toBe(false);
      act(() => { draft.focus(); notices.push({ id: 'shell-anchor', icon: 'ph ph-check', text: 'Reference copied.' }); vi.advanceTimersByTime(300); });
      expect(within(region).getByText('Reference copied.')).toBeTruthy();
      expect(document.activeElement).toBe(draft);
      rerender(<Shell {...value} body={{ ...value.body, waitingFolded: true, detailWidth: 700 }} />);
      expect(screen.getAllByRole('region', { name: 'Notifications' })).toEqual([region]);
      expect(region.parentElement).toBe(anchor);
      expect(anchor.style.left).toBe('44px');
      expect(anchor.style.right).toBe('700px');
      expect(center.querySelector('.shell-center-content')).toBe(scroll);
      expect(document.activeElement).toBe(draft);
      act(() => { notices.dismiss('shell-anchor'); });
      expect(within(region).queryByText('Reference copied.')).toBeNull();
      expect(document.activeElement).toBe(draft);
      expect(draft.value).toBe('Draft');
    } finally { notices.clear(); vi.useRealTimers(); }
  });

  it('keeps notification actions visible, keyboard reachable and clickable above Conversation', () => {
    vi.useFakeTimers();
    try {
      const undo = vi.fn(), value = props({ body: { waiting: null, center: <p>Map</p>, detail: <p>Dock</p> } });
      const { rerender } = render(<Shell {...value} />);
      const region = screen.getByRole('region', { name: 'Notifications' });
      act(() => { notices.push({ id: 'conversation-undo', icon: 'ph ph-check', text: 'Item removed.', actions: [{ label: 'Undo', run: undo }] }); vi.advanceTimersByTime(300); });
      rerender(<Shell {...value} body={{ ...value.body, conversation: <input aria-label="Conversation reply" /> }} />);
      expect(screen.getByRole('region', { name: 'Notifications' })).toBe(region);
      expect(region.closest('[inert],[aria-hidden="true"]')).toBeNull();
      expect(region.parentElement?.style.right).toBe('0px');
      const reply = screen.getByRole('textbox', { name: 'Conversation reply' });
      reply.focus();
      fireEvent.keyDown(reply, { key: 'F6' });
      expect(document.activeElement).toBe(within(region).getByText('Item removed.').closest('.pw-note'));
      fireEvent.click(within(region).getByRole('button', { name: 'Undo' }));
      expect(undo).toHaveBeenCalledOnce();
      fireEvent.click(within(region).getByRole('button', { name: 'Dismiss' }));
      expect(within(region).queryByText('Item removed.')).toBeNull();
      expect(document.activeElement).toBe(reply);
    } finally { notices.clear(); vi.useRealTimers(); }
  });

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
    expect(unhide.title).toBe('Unhide');
    expect(unhide.getAttribute('aria-pressed')).toBe('true');
    expect(unhide.querySelector('svg path[d="m3 3 18 18"]')).not.toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Hidden — this item is hidden from the list.');
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
    expect(document.querySelector('.shell-session-text')?.textContent).toBe('search · started 14:02');
    expect(document.querySelector('.shell-connection-text')?.textContent).toBe('Connected · claude-code');
    const search = screen.getByRole<HTMLInputElement>('textbox', { name: 'Search questions and outcomes' });
    expect(search.readOnly).toBe(true); expect(search.dataset.shellSearch).toBe('');
    expect(screen.queryByRole('group', { name: 'View' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Switch to light' }).querySelector('.ph-sun')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Messages (m)' })).toBeNull();
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
    expect([...document.querySelectorAll('.shell-footer .pw-keycap')].map(key => key.textContent)).not.toContain('m');
  });

  it('wires views, search, theme and the detail column', () => {
    const select = vi.fn(), query = vi.fn(), theme = vi.fn(), close = vi.fn(), remove = vi.fn();
    render(<Shell {...props({
      header: { text: { sessionText: 's', connText: 'c', connColor: 'var(--st-open)' }, demo: true, query: 'needle', onQueryChange: query,
        views: [{ label: 'Tree', icon: 'ph ph-tree-view', title: 'Tree (g)', on: true, onSelect: select }, { label: 'Graph', icon: 'ph ph-graph', title: 'Graph (g)', on: false }],
        theme: 'light', onToggleTheme: theme },
      body: { waiting: null, center: null, detail: <section><p>Detail body</p></section>, onCloseDetail: close, onRemove: remove },
    })} />);
    expect(screen.getByText('Demo')).toBeTruthy();
    const views = screen.getByRole('group', { name: 'View' });
    expect(within(views).getByRole('button', { name: 'Tree' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(views).getByRole('button', { name: 'Tree' })); expect(select).toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search questions and outcomes' }), { target: { value: 'next' } }); expect(query).toHaveBeenCalledWith('next');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark' })); expect(theme).toHaveBeenCalled();
    const detail = screen.getByRole('complementary', { name: 'Item detail' });
    expect(detail.querySelector('.shell-detail-scroll')?.textContent).toBe('Detail body');
    fireEvent.click(within(detail).getByRole('button', { name: 'Remove item' })); expect(remove).toHaveBeenCalled();
    fireEvent.click(within(detail).getByRole('button', { name: 'Close detail' })); expect(close).toHaveBeenCalled();
    expect((document.querySelector('.shell-body') as HTMLElement).style.gridTemplateColumns).toBe('300px minmax(560px,1fr) 400px');
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
      observe() { this.receive([{ contentRect: { width: 1200 } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
      disconnect() {}
    });
    const fold = vi.fn();
    render(<Shell {...props({ body: { waiting: <WaitingFrame count="2" />, center: null, detail: <p>Detail</p>, onFoldWaiting: fold } })} />);
    const grid = () => (document.querySelector('.shell-body') as HTMLElement).style.gridTemplateColumns;
    expect(grid()).toBe('44px minmax(560px,1fr) 400px');
    fireEvent.click(screen.getByRole('button', { name: 'Show Waiting on me (2)' }));
    // Opening it in a narrow window is not saved as the owner's fold; the panel narrows first.
    expect(fold).not.toHaveBeenCalled();
    expect(grid()).toBe('300px minmax(380px,1fr) 400px');
    fireEvent.click(screen.getByRole('button', { name: 'Hide Waiting on me' }));
    expect(fold).toHaveBeenCalledWith(true);
  });

  it('disables chrome controls while navigation writes', () => {
    render(<Shell {...props({ header: { ...props().header, onQueryChange: vi.fn(), onToggleTheme: vi.fn(), disabled: true },
      tabs: { ...props().tabs, disabled: true } })} />);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Search questions and outcomes' }).disabled).toBe(true);
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
