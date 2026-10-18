import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { Body } from '../../../src/ui/shell/Body';
import { DockInsetProvider } from '../../../src/ui/shell/dockInset';

const rect = (top: number) => ({ top, bottom: top + 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: top, toJSON: () => ({}) });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
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
});
