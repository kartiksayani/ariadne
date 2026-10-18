import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Shell as SlotShell } from '../../../src/ui/shell/Shell';
import { TopBar } from '../../../src/ui/topbar/TopBar';
import type { TopBarProps } from '../../../src/ui/topbar/model';
import { DetailsColumn } from '../../../src/ui/shell/DetailsColumn';
import { DetailsColumnProvider } from '../../../src/state/details/column';
import { resolveTheme, useAppliedTheme } from '../../../src/ui/shell/theme';
import { DockInsetProvider } from '../../../src/ui/shell/dockInset';
import { ItemHistoryContext } from '../../../src/ui/shell/itemHistory';
import type { DetailHeadControls } from '../../../src/ui/shell/DetailHead';
import type { ItemActionView } from '../../../src/ui/detail/itemActions';
import { notices } from '../../../src/ui/pages/notices';

const jsdomWidth = window.innerWidth;
// Details is 400 wide in a window of 1100 or more (state/details/column.ts); a body without a measured width is a wide one.
beforeEach(() => { setWindow(1280); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete document.documentElement.dataset.theme; setWindow(jsdomWidth); });

/** The chrome (top bar, detail) and the floating dock through the shell's slots, as NavigationWorkspace builds it. */
interface ShellProps {
  readonly header: TopBarProps;
  readonly body: {
    readonly dock?: ReactNode; readonly dockHeight?: number; readonly center: ReactNode; readonly conversation?: ReactNode; readonly detail?: ReactNode; readonly detailPath?: ReactNode;
    readonly head?: DetailHeadControls; readonly hidden?: boolean;
    readonly detailWidth?: number | null; readonly onResizeDetail?: (width: number) => void;
  };
  readonly overlay?: ReactNode;
}
function Shell({ header, body, overlay }: ShellProps) {
  return <DetailsColumnProvider saved={body.detailWidth} onSave={body.onResizeDetail}><DockInsetProvider height={body.dockHeight ?? 0}><SlotShell topBar={<TopBar {...header} />} main={body.center}
    side={body.detail ? <DetailsColumn path={body.detailPath} head={body.head} hidden={body.hidden}>{body.detail}</DetailsColumn> : undefined}
    dock={body.dock} legacy={{ conversation: body.conversation }}
    overlay={overlay} /></DockInsetProvider></DetailsColumnProvider>;
}
function props(patch: Partial<ShellProps> = {}): ShellProps {
  return {
    header: { narrow: false, project: 'search', sessionName: 'Cache review', otherWaiting: 0, switcherOpen: false, onSwitcherToggle: vi.fn(),
      connection: { kind: 'live', agent: 'Claude Code' }, connectionOpen: false, onConnectionToggle: vi.fn(), connectionCard: <p>Agent connected</p>,
      search: { active: false, query: '', onOpen: vi.fn(), onQuery: vi.fn(), onClear: vi.fn() }, view: 'tree', onView: vi.fn(),
      filter: { active: false, count: 0, onToggle: vi.fn() }, recent: { active: false, onToggle: vi.fn() }, archive: { active: false, onOpen: vi.fn() },
      textSize: 100, onTextSizeChange: vi.fn(), theme: 'dark', onToggleTheme: vi.fn(), help: { open: false, onToggle: vi.fn() } },
    body: { dock: <p>Answer dock</p>, center: <p>Centre column</p> },
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
    const value = props({ body: { dock: <p>Answer dock</p>, center: <input aria-label="Map draft" defaultValue="Preserved" />,
      detail: <p>Dock content</p> } });
    const { rerender } = render(<Shell {...value} />);
    const grid = document.querySelector<HTMLElement>('.shell-body')!, center = screen.getByRole('main');
    const draft = screen.getByRole<HTMLInputElement>('textbox', { name: 'Map draft' });
    const detail = screen.getByRole('complementary', { name: 'Item detail' });
    const columns = grid.style.gridTemplateColumns;
    expect(columns).toBe('minmax(560px,1fr) 340px');
    fireEvent.change(draft, { target: { value: 'Still here' } });
    rerender(<Shell {...value} body={{ ...value.body, conversation: <p>Conversation content</p> }} />);
    const overlay = screen.getByText('Conversation content').parentElement!;
    expect(overlay.className).toBe('shell-conversation');
    expect(overlay.parentElement?.className).toBe('shell-body-viewport');
    expect(overlay.previousElementSibling).toBe(grid);
    expect(overlay.style.left).toBe('0px');
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

  it('keeps Conversation at the Map edge as the viewport and floating dock change', () => {
    const resizeWindow = measureBody(900);
    const value = props({ body: { dock: <p>Answer dock</p>, dockHeight: 40, center: <p>Map</p>, detail: <p>Details</p>,
      conversation: <p>Conversation content</p> } });
    const { rerender } = render(<Shell {...value} />);
    const overlay = document.querySelector<HTMLElement>('.shell-conversation')!;
    expect(overlay.style.left).toBe('0px');
    resizeWindow(1400);
    expect(overlay.style.left).toBe('0px');
    rerender(<Shell {...value} body={{ ...value.body, dockHeight: 280 }} />);
    expect(overlay.style.left).toBe('0px');
    resizeWindow(900);
    expect(overlay.style.left).toBe('0px');
  });

  it('keeps the switcher and Help available while a conversation is open', () => {
    const switcher = vi.fn(), help = vi.fn(), value = props();
    render(<Shell {...value} header={{ ...value.header, onSwitcherToggle: switcher, help: { open: false, onToggle: help } }} body={{ ...value.body, conversation: <p>Conversation</p> }} />);
    fireEvent.click(screen.getByRole('button', { name: /^Switch session or project/ })); expect(switcher).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Help: keys and markers' })); expect(help).toHaveBeenCalledOnce();
    expect(screen.getByText('Conversation')).toBeTruthy();
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
      const value = props({ body: { center: <input aria-label="Centre draft" defaultValue="Draft" />,
        detail: <p>Detail</p> } });
      const { rerender } = render(<Shell {...value} />);
      const center = screen.getByRole('main'), region = screen.getByRole('region', { name: 'Notifications' });
      const anchor = document.querySelector<HTMLElement>('.shell-notices')!;
      const draft = screen.getByRole<HTMLInputElement>('textbox', { name: 'Centre draft' });
      expect(region.parentElement).toBe(anchor);
      expect(anchor.parentElement?.className).toBe('shell-body-viewport');
      expect(anchor.style.left).toBe('0px');
      expect(anchor.style.right).toBe('400px');
      const scroll = center.querySelector('.shell-center-content')!;
      expect(scroll.contains(draft)).toBe(true);
      expect(scroll.contains(region)).toBe(false);
      act(() => { draft.focus(); notices.push({ id: 'shell-anchor', icon: 'ph ph-check', text: 'Reference copied.' }); vi.advanceTimersByTime(300); });
      expect(within(region).getByText('Reference copied.')).toBeTruthy();
      expect(document.activeElement).toBe(draft);
      rerender(<Shell {...value} body={{ ...value.body, detailWidth: 700 }} />);
      expect(screen.getAllByRole('region', { name: 'Notifications' })).toEqual([region]);
      expect(region.parentElement).toBe(anchor);
      expect(anchor.style.left).toBe('0px');
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
      const undo = vi.fn(), value = props({ body: { center: <p>Map</p>, detail: <p>Dock</p> } });
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

  it('hides, unhides and removes from the "…" menu of the detail head, which has no Close ×', () => {
    const hide = vi.fn(), remove = vi.fn(), unhide = vi.fn();
    const rows = (hidden: boolean): readonly ItemActionView[] => [
      { id: 'copyRef', label: 'Copy reference', icon: 'ph ph-copy', run: vi.fn(), applies: true },
      hidden ? { id: 'unhide', label: 'Unhide', icon: '', run: unhide, applies: true } : { id: 'hide', label: 'Hide', icon: '', run: hide, applies: true },
      { id: 'remove', label: 'Remove', icon: 'ph ph-trash', run: remove, applies: true },
      { id: 'drop', label: 'Drop', icon: 'ph ph-x-circle', run: vi.fn(), applies: false },
    ];
    const value = props({ body: { center: null, detail: <p>Detail</p>, head: { actions: rows(false) } } });
    const { rerender } = render(<Shell {...value} />);
    expect(screen.queryByRole('button', { name: 'Close detail' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Hide item|Remove item/ })).toBeNull();
    const menu = () => fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    menu();
    expect(screen.getAllByRole('menuitem').map(row => row.textContent)).toEqual(['Copy reference', 'Hide', 'Remove', 'Close Details ( esc )']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' })); expect(hide).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
    rerender(<Shell {...value} body={{ ...value.body, hidden: true, head: { actions: rows(true) } }} />);
    expect(screen.queryByRole('status')).toBeNull();
    menu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unhide' })); expect(unhide).toHaveBeenCalledOnce();
    menu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' })); expect(remove).toHaveBeenCalledOnce();
  });

  it('puts accessible Back/Forward icons after the detail breadcrumb, with shortcut tooltips and disabled endpoints', () => {
    const back = vi.fn(() => true), forward = vi.fn(() => true);
    const value = props({ body: { center: null, detail: <p>Detail</p>, detailPath: <span>Topic / #2</span> } });
    const { rerender } = render(<ItemHistoryContext.Provider value={{ canBack: true, canForward: false, back, forward }}><Shell {...value} /></ItemHistoryContext.Provider>);
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Back' });
    expect(button.title).toBe('Back (⌘[)'); expect(button.querySelector('.ph-arrow-left')).not.toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Forward' }).disabled).toBe(true);
    expect(button.closest('.shell-detail-history')?.previousElementSibling?.className).toBe('shell-detail-path');
    fireEvent.click(button); expect(back).toHaveBeenCalledOnce();
    rerender(<ItemHistoryContext.Provider value={{ canBack: false, canForward: true, back, forward }}><Shell {...value} /></ItemHistoryContext.Provider>);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Back' }).disabled).toBe(true);
    const next = screen.getByRole<HTMLButtonElement>('button', { name: 'Forward' });
    expect(next.title).toBe('Forward (⌘])'); expect(next.querySelector('.ph-arrow-right')).not.toBeNull();
    fireEvent.click(next); expect(forward).toHaveBeenCalledOnce();
  });

  it('renders the current session, connection card and body from props', () => {
    const toggle = vi.fn(), value = props();
    const { rerender } = render(<Shell {...value} header={{ ...value.header, onConnectionToggle: toggle }} />);
    expect(screen.getByRole('button', { name: /^Switch session or project/ }).textContent).toContain('Cache review');
    expect(screen.queryByText('Agent connected')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Live\. Connected/ })); expect(toggle).toHaveBeenCalledOnce();
    rerender(<Shell {...value} header={{ ...value.header, connectionOpen: true }} />);
    expect(screen.getByText('Agent connected')).toBeTruthy();
    expect(screen.getByText('Answer dock')).toBeTruthy();
    expect(screen.getByRole('main').textContent).toBe('Centre column');
    expect(document.querySelector<HTMLElement>('.shell-body')!.style.gridTemplateColumns).toBe('minmax(0px,1fr)');
    expect(screen.queryByRole('complementary', { name: 'Item detail' })).toBeNull();
  });

  it('wires filter, Recent, Archive and waiting-page controls', () => {
    const filter = vi.fn(), recent = vi.fn(), archive = vi.fn(), waiting = vi.fn(), value = props();
    render(<Shell {...value} header={{ ...value.header, variant: 'page', filter: { active: true, count: 1, onToggle: filter }, recent: { active: false, onToggle: recent },
      archive: { active: false, onOpen: archive }, waitingHere: 3, onWaitingHere: waiting, otherWaiting: 2 }} />);
    const filterButton = screen.getByRole('button', { name: 'Filter by status, 1 status picked' });
    expect(filterButton.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(filterButton); expect(filter).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Recent' })); expect(recent).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' })); expect(archive).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '3 waiting in this session' })); expect(waiting).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: /^Switch session or project/ }).getAttribute('aria-label')).toContain('2 questions waiting in other sessions');
  });

  it('wires views, search, theme and the detail column', () => {
    const select = vi.fn(), query = vi.fn(), theme = vi.fn(), close = vi.fn(), remove = vi.fn();
    render(<Shell {...props({
      header: { ...props().header, sessionName: 's', search: { active: true, query: 'needle', onOpen: vi.fn(), onQuery: query, onClear: vi.fn() },
        onView: select, theme: 'light', onToggleTheme: theme },
      body: { center: null, detail: <section><p>Detail body</p></section>, head: { close, actions: [{ id: 'remove', label: 'Remove', icon: 'ph ph-trash', run: remove, applies: true }] } },
    })} />);
    const views = screen.getByRole('group', { name: 'View' });
    expect(within(views).getByRole('button', { name: 'Tree' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(views).getByRole('button', { name: 'Graph' })); expect(select).toHaveBeenCalledWith('graph');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search the Map' }), { target: { value: 'next' } }); expect(query).toHaveBeenCalledWith('next');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark' })); expect(theme).toHaveBeenCalled();
    const detail = screen.getByRole('complementary', { name: 'Item detail' });
    expect(detail.querySelector('.shell-detail-scroll')?.textContent).toBe('Detail body');
    fireEvent.click(within(detail).getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' })); expect(remove).toHaveBeenCalled();
    fireEvent.click(within(detail).getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^Close Details/ })); expect(close).toHaveBeenCalled();
    expect((document.querySelector('.shell-body') as HTMLElement).style.gridTemplateColumns).toBe('minmax(560px,1fr) 400px');
  });

  it('floats the dock outside both columns, reserves its height and preserves the mounted Map draft', () => {
    measureBody(1200);
    const value = props({ body: { dock: <section aria-label="Answer dock">Folded question</section>, dockHeight: 40,
      center: <input aria-label="Map draft" defaultValue="Keep these words" />, detail: <p>Details</p> } });
    const { rerender } = render(<Shell {...value} />);
    const grid = document.querySelector<HTMLElement>('.shell-body')!;
    const viewport = grid.parentElement!, draft = screen.getByRole('textbox', { name: 'Map draft' });
    const columns = grid.style.gridTemplateColumns;
    expect(columns).toBe('minmax(560px,1fr) 400px');
    expect(screen.getByRole('region', { name: 'Answer dock' }).parentElement?.parentElement).toBe(viewport);
    expect(grid.contains(screen.getByRole('region', { name: 'Answer dock' }))).toBe(false);
    expect(viewport.style.getPropertyValue('--dock-inset')).toBe('40px');
    draft.focus();
    rerender(<Shell {...value} body={{ ...value.body, dock: <section aria-label="Answer dock">Open question and choices</section>, dockHeight: 280 }} />);
    expect(viewport.style.getPropertyValue('--dock-inset')).toBe('280px');
    expect(grid.style.gridTemplateColumns).toBe(columns);
    expect(screen.getByRole('textbox', { name: 'Map draft' })).toBe(draft);
    expect(document.activeElement).toBe(draft);
    expect((draft as HTMLInputElement).value).toBe('Keep these words');
    // A page has no dock: no room is kept for one.
    rerender(<Shell {...value} body={{ ...value.body, dock: undefined, dockHeight: 280 }} />);
    expect(viewport.style.getPropertyValue('--dock-inset')).toBe('0px');
    expect(grid.style.gridTemplateColumns).toBe(columns);
  });

  // The resize edge through the slot shell (C9: the range follows the window; tests/ui/shell/details-column.test.tsx
  // tables every step). These keep the dock's protections: one write per settled change, the Map's minimum, the dock
  // out of the grid.
  it('resizes the detail panel from its left edge by pointer and keys, inside the bounds, and saves the width', () => {
    vi.useFakeTimers();
    try {
      const resize = vi.fn();
      const { rerender } = render(<Shell {...props({ body: { center: null, detail: <p>Detail</p>, onResizeDetail: resize } })} />);
      const edge = screen.getByRole('separator', { name: 'Resize detail panel' });
      expect(edge.getAttribute('aria-valuenow')).toBe('400');
      fireEvent.pointerDown(edge, { button: 0, clientX: 1000, pointerId: 1 });
      fireEvent.pointerMove(edge, { clientX: 880, pointerId: 1 });
      expect((document.querySelector('.shell-body') as HTMLElement).style.gridTemplateColumns).toBe('minmax(560px,1fr) 520px');
      fireEvent.pointerUp(edge, { clientX: 880, pointerId: 1 });
      act(() => { vi.advanceTimersByTime(600); });
      expect(resize).toHaveBeenCalledExactlyOnceWith(520);
      rerender(<Shell {...props({ body: { center: null, detail: <p>Detail</p>, onResizeDetail: resize, detailWidth: 520 } })} />);
      // Dragging past the bounds stops at them.
      fireEvent.pointerDown(edge, { button: 0, clientX: 1000, pointerId: 1 });
      fireEvent.pointerMove(edge, { clientX: 1900, pointerId: 1 });
      fireEvent.pointerUp(edge, { pointerId: 1 });
      act(() => { vi.advanceTimersByTime(600); });
      expect(resize).toHaveBeenLastCalledWith(320);
      rerender(<Shell {...props({ body: { center: null, detail: <p>Detail</p>, onResizeDetail: resize, detailWidth: 320 } })} />);
      // Keys step it and save once they settle.
      resize.mockClear();
      fireEvent.keyDown(edge, { key: 'ArrowLeft' }); fireEvent.keyDown(edge, { key: 'ArrowLeft' });
      expect(edge.getAttribute('aria-valuenow')).toBe('352');
      expect(resize).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(600); });
      expect(resize).toHaveBeenCalledExactlyOnceWith(352);
      fireEvent.doubleClick(edge);
      act(() => { vi.advanceTimersByTime(600); });
      expect(resize).toHaveBeenLastCalledWith(400);
    } finally { vi.useRealTimers(); }
  });

  it('clamps a saved wide pane on window resize without writing a new preference or moving the dock into the grid', () => {
    vi.useFakeTimers();
    try {
      const resizeWindow = measureBody(3400), resize = vi.fn();
      render(<Shell {...props({ body: { dock: <section aria-label="Answer dock">Question</section>, dockHeight: 180,
        center: <p>Map</p>, detail: <p>Details</p>, detailWidth: 2000, onResizeDetail: resize } })} />);
      const grid = document.querySelector<HTMLElement>('.shell-body')!;
      const edge = screen.getByRole('separator', { name: 'Resize detail panel' });
      expect(grid.style.gridTemplateColumns).toBe('minmax(560px,1fr) 2000px');
      resizeWindow(2000);
      // At its widest (the window less 480), Details still leaves the Map 480px.
      expect(grid.style.gridTemplateColumns).toBe('minmax(480px,1fr) 1520px');
      expect(edge.getAttribute('aria-valuemax')).toBe('1520');
      resizeWindow(1200);
      expect(grid.style.gridTemplateColumns).toBe('minmax(480px,1fr) 720px');
      expect(edge.getAttribute('aria-valuenow')).toBe('720');
      resizeWindow(3400);
      expect(grid.style.gridTemplateColumns).toBe('minmax(560px,1fr) 2000px');
      act(() => { vi.advanceTimersByTime(600); });
      expect(resize).not.toHaveBeenCalled();
      expect(grid.contains(screen.getByRole('region', { name: 'Answer dock' }))).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('uses the available width with End, preserves the Map minimum and resets the saved width', () => {
    vi.useFakeTimers();
    try {
      measureBody(1400);
      const resize = vi.fn();
      const value = props({ body: { dock: <p>Question</p>, dockHeight: 40, center: <p>Map</p>, detail: <p>Details</p>, onResizeDetail: resize } });
      const { rerender } = render(<Shell {...value} />);
      const grid = document.querySelector<HTMLElement>('.shell-body')!;
      const edge = screen.getByRole('separator', { name: 'Resize detail panel' });
      expect(edge.getAttribute('aria-valuemax')).toBe('920');
      fireEvent.keyDown(edge, { key: 'End' });
      expect(grid.style.gridTemplateColumns).toBe('minmax(480px,1fr) 920px');
      act(() => { vi.advanceTimersByTime(600); });
      expect(resize).toHaveBeenCalledExactlyOnceWith(920);
      rerender(<Shell {...value} body={{ ...value.body, detailWidth: 920 }} />);
      fireEvent.keyDown(edge, { key: 'ArrowRight' });
      expect(edge.getAttribute('aria-valuenow')).toBe('904');
      act(() => { vi.advanceTimersByTime(600); });
      expect(resize).toHaveBeenLastCalledWith(904);
      fireEvent.keyDown(edge, { key: 'Home' });
      expect(grid.style.gridTemplateColumns).toBe('minmax(560px,1fr) 320px');
      act(() => { vi.advanceTimersByTime(600); });
      expect(resize).toHaveBeenLastCalledWith(320);
      fireEvent.doubleClick(edge);
      act(() => { vi.advanceTimersByTime(600); });
      expect(resize).toHaveBeenLastCalledWith(400);
      rerender(<Shell {...value} body={{ ...value.body, detailWidth: 400 }} />);
      expect(grid.style.gridTemplateColumns).toBe('minmax(560px,1fr) 400px');
    } finally { vi.useRealTimers(); }
  });

  it('disables chrome controls while navigation writes', () => {
    render(<Shell {...props({ header: { ...props().header, disabled: true } })} />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Search the Map' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /^Switch session or project/ }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Switch to light' }).disabled).toBe(true);
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
