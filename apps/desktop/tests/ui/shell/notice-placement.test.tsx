import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { notices } from '../../../src/ui/pages/notices';
import { Body } from '../../../src/ui/shell/Body';
import { DockInsetProvider } from '../../../src/ui/shell/dockInset';

const rect = (top: number) => ({ top, bottom: top + 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: top, toJSON: () => ({}) });
afterEach(() => { notices.clear(); cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const frames = () => { vi.stubGlobal('requestAnimationFrame', (run: () => void) => { run(); return 0; }); };

describe('notice placement (E20)', () => {
  it('hangs the stack under the Tree’s topic band: scroll shell top + band height + 8', () => {
    frames();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('shell-body-viewport') ? rect(40) as DOMRect : this.classList.contains('tree-scroll-shell') ? rect(40 + 52) as DOMRect : rect(0) as DOMRect;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('tree-topic') ? 58 : 0; });
    const { container } = render(<DockInsetProvider height={0}><Body main={<div className="tree-scroll-shell"><div className="tree-scroll"><div className="tree-topic" /></div></div>} /></DockInsetProvider>);
    const layer = container.querySelector<HTMLElement>('.shell-notices')!;
    expect(layer.dataset.placement).toBe('map');
    expect(layer.style.getPropertyValue('--notice-top')).toBe(`${52 + 58 + 8}px`);
  });

  it('hangs the stack 8px under the Graph’s top edge (no band)', () => {
    frames();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('graph-view') ? rect(30) as DOMRect : rect(0) as DOMRect;
    });
    const { container } = render(<DockInsetProvider height={0}><Body main={<div className="graph-view" />} /></DockInsetProvider>);
    expect(container.querySelector<HTMLElement>('.shell-notices')!.style.getPropertyValue('--notice-top')).toBe('38px');
  });

  it('follows the Map when a line opens above it, and lets go on a page', async () => {
    frames();
    let shellTop = 20;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('graph-view') ? rect(shellTop) as DOMRect : rect(0) as DOMRect;
    });
    const { container, rerender } = render(<DockInsetProvider height={0}><Body main={<div className="graph-view" />} /></DockInsetProvider>);
    const layer = container.querySelector<HTMLElement>('.shell-notices')!;
    expect(layer.style.getPropertyValue('--notice-top')).toBe('28px');
    shellTop = 60;
    // A line opening above the Map changes the DOM before any size reaches the observers.
    await act(async () => { container.querySelector('.shell-center-content')!.append(document.createElement('div')); await Promise.resolve(); });
    expect(layer.style.getPropertyValue('--notice-top')).toBe('68px');
    rerender(<DockInsetProvider height={0}><Body main={<p>Projects</p>} /></DockInsetProvider>);
    await act(async () => { await Promise.resolve(); });
    expect(layer.dataset.placement).toBeUndefined();
    expect(layer.style.getPropertyValue('--notice-top')).toBe('');
  });

  it('uses the bigger view’s band over the covered Map', () => {
    frames();
    const { container } = render(<DockInsetProvider height={0}><Body main={<div className="graph-view" />} conversation={<div className="conversation-header" />} /></DockInsetProvider>);
    expect(container.querySelector<HTMLElement>('.shell-notices')!.dataset.placement).toBe('conversation');
  });

  it('lifts the toast above the bigger view’s composer by the measured --notice-bottom, and lets go when the view closes', async () => {
    frames();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('shell-conversation') ? { ...rect(0), bottom: 600 } as DOMRect
        : this.classList.contains('detail-dock') ? { ...rect(520), bottom: 600 } as DOMRect : rect(0) as DOMRect;
    });
    const view = <div><div className="conversation-header" /><div className="detail-dock" /></div>;
    const { container, rerender } = render(<DockInsetProvider height={0}><Body main={<div className="graph-view" />} conversation={view} /></DockInsetProvider>);
    const toast = container.querySelector<HTMLElement>('.shell-toast')!;
    expect(toast.dataset.placement).toBe('conversation');
    // Composer top at 520 in a 600px view: 80px of composer plus the 8px gap, the same as for the notices.
    expect(toast.style.getPropertyValue('--notice-bottom')).toBe('88px');
    expect(container.querySelector<HTMLElement>('.shell-notices')!.style.getPropertyValue('--notice-bottom')).toBe('88px');
    rerender(<DockInsetProvider height={0}><Body main={<div className="graph-view" />} /></DockInsetProvider>);
    await act(async () => { await Promise.resolve(); });
    expect(toast.dataset.placement).toBeUndefined();
    expect(toast.style.getPropertyValue('--notice-bottom')).toBe('');
  });

  it('publishes where the stack ends, from the Map’s shell, so the Back-to pill hangs below it; unset when no card shows or on a page', async () => {
    frames();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('pw-notice-stack') ? { ...rect(100), bottom: 200 } as DOMRect
        : this.classList.contains('tree-scroll-shell') ? rect(92) as DOMRect : rect(0) as DOMRect;
    });
    const { container, rerender } = render(<DockInsetProvider height={0}><Body main={<div className="tree-scroll-shell"><div className="tree-topic" /></div>} /></DockInsetProvider>);
    const body = container.querySelector<HTMLElement>('.shell-body-viewport')!;
    expect(body.style.getPropertyValue('--notice-stack-bottom')).toBe('');
    act(() => { notices.push({ id: 'n', icon: 'ph ph-warning', tone: 'warn', text: 'A notice.' }); });
    // The store shows a notice 300 ms after it is raised.
    await waitFor(() => expect(body.style.getPropertyValue('--notice-stack-bottom')).toBe('108px'));
    act(() => { notices.dismiss('n'); });
    await waitFor(() => expect(body.style.getPropertyValue('--notice-stack-bottom')).toBe(''));
    // On a page no Map is drawn, so there is no pill to keep clear.
    act(() => { notices.push({ id: 'm', icon: 'ph ph-warning', tone: 'warn', text: 'Another.' }); });
    rerender(<DockInsetProvider height={0}><Body main={<p>Projects</p>} /></DockInsetProvider>);
    await waitFor(() => expect(container.querySelector('.pw-note')).not.toBeNull());
    expect(body.style.getPropertyValue('--notice-stack-bottom')).toBe('');
  });

  it('keeps the toast at the dock on the Map and on a page', () => {
    frames();
    const { container } = render(<DockInsetProvider height={0}><Body main={<div className="graph-view" />} /></DockInsetProvider>);
    const toast = container.querySelector<HTMLElement>('.shell-toast')!;
    expect(toast.dataset.placement).toBeUndefined();
    expect(toast.style.getPropertyValue('--notice-bottom')).toBe('');
  });
});
