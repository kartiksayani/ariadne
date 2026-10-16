// The shell's slot API (contract C1) and the dock inset (C2): what each slot renders where, and what the dock's
// height reaches. Nothing here changes what the owner sees while no dock is open.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Shell } from '../../../src/ui/shell/Shell';
import { DetailsColumn } from '../../../src/ui/shell/DetailsColumn';
import { DockInsetProvider, useDockInset } from '../../../src/ui/shell/dockInset';

afterEach(() => { cleanup(); vi.useRealTimers(); });

const css = (file: string) => readFileSync(resolve(__dirname, '../../../src', file), 'utf8');
const rules = (source: string, selector: string) => source.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? '';
const viewport = () => document.querySelector<HTMLElement>('.shell-body-viewport')!;

describe('shell slots', () => {
  it('puts each slot in its place: top bar, main, side, footer and overlay', () => {
    render(<Shell topBar={<p>Top bar</p>} main={<p>Map</p>} side={<DetailsColumn><p>Details</p></DetailsColumn>}
      footer={<footer className="shell-footer">Footer</footer>} overlay={<div role="dialog">Dialog</div>} />);
    expect(screen.getByText('Top bar').parentElement?.className).toBe('shell-top');
    expect(screen.getByText('Map').parentElement?.className).toBe('shell-center-content');
    expect(screen.getByText('Details').closest('aside')?.parentElement?.className).toBe('shell-body');
    const shell = document.querySelector('.shell')!;
    expect([...shell.children].map(child => child.className || child.getAttribute('role'))).toEqual(['shell-top', 'shell-body-viewport', 'shell-footer', 'dialog']);
  });
  it('renders no side column and no dock layer when they are absent', () => {
    render(<Shell topBar={null} main={<p>Map</p>} />);
    expect(document.querySelector('.shell-detail')).toBeNull();
    expect(document.querySelector('.shell-dock')).toBeNull();
  });
  it('floats the dock inside the body, over the main and side areas', () => {
    render(<Shell topBar={null} main={<p>Map</p>} side={<DetailsColumn><p>Details</p></DetailsColumn>} dock={<p>Dock</p>} />);
    const layer = screen.getByText('Dock').parentElement!;
    expect(layer.className).toBe('shell-dock');
    expect(layer.parentElement).toBe(viewport());
    const shell = css('ui/shell/shell.css');
    for (const declaration of ['position: absolute;', 'right: 0;', 'bottom: 0;', 'left: 0;']) expect(rules(shell, '.shell-dock')).toContain(declaration);
    expect(rules(shell, '.shell-body-viewport')).toContain('position: relative;');
  });
  it('keeps one 40px top bar in the slot grid, with no header, tab row or footer rows left (SPEC 2)', () => {
    const shell = css('ui/shell/shell.css');
    expect(rules(shell, '.shell')).toContain('grid-template-rows: auto minmax(0, 1fr) auto;');
    expect(rules(css('ui/topbar/topbar.css'), '.tb')).toContain('height: 40px;');
    for (const selector of ['.shell-header', '.shell-tabs', '.shell-footer']) expect(rules(shell, selector)).toBe('');
  });
});

describe('dock inset', () => {
  it('is 0 without a dock and the dock height inside a provider', () => {
    expect(renderHook(() => useDockInset()).result.current).toBe(0);
    const wrapper = ({ children }: { children: ReactNode }) => <DockInsetProvider height={120}>{children}</DockInsetProvider>;
    expect(renderHook(() => useDockInset(), { wrapper }).result.current).toBe(120);
  });
  it('sets --dock-inset on the body: 0px with no dock, the dock height with one', () => {
    const { rerender } = render(<Shell topBar={null} main={<p>Map</p>} />);
    expect(viewport().style.getPropertyValue('--dock-inset')).toBe('0px');
    rerender(<DockInsetProvider height={164}><Shell topBar={null} main={<p>Map</p>} dock={<p>Dock</p>} /></DockInsetProvider>);
    expect(viewport().style.getPropertyValue('--dock-inset')).toBe('164px');
  });
  it('keeps the Tree and Graph scrollers 40px of room below the last row, plus the dock', () => {
    expect(rules(css('ui/tree/tree.css'), '.tree-scroll')).toContain('padding-bottom: calc(40px + var(--dock-inset, 0px));');
    expect(rules(css('ui/graph/graph.css'), '.graph-scroll')).toContain('padding-bottom: calc(40px + var(--dock-inset, 0px));');
  });
});

describe('Details column in the side slot', () => {
  it('saves a width stepped by keys even when the column closes before the pause ends', () => {
    vi.useFakeTimers();
    const resize = vi.fn();
    const side = <DetailsColumn onResize={resize}><p>Details</p></DetailsColumn>;
    const { rerender } = render(<Shell topBar={null} main={null} side={side} />);
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize detail panel' }), { key: 'ArrowLeft' });
    rerender(<Shell topBar={null} main={null} />);
    expect(resize).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(500); });
    expect(resize).toHaveBeenCalledExactlyOnceWith(416);
  });
  it('outside a shell body shows at the default width with its head and content', () => {
    render(<DetailsColumn path={<span>Topic / #2</span>} onResize={vi.fn()}><p>Details</p></DetailsColumn>);
    expect(screen.getByRole('separator', { name: 'Resize detail panel' }).getAttribute('aria-valuenow')).toBe('400');
    expect(screen.getByText('Topic / #2')).toBeTruthy();
    expect(screen.getByText('Details').parentElement?.className).toBe('shell-detail-scroll');
  });
});
