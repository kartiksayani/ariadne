// The Details column beside the Map: where it sits and how wide, how it folds to its rail and unfolds, how its left edge
// resizes it, and that the open dock never covers anything in it. The width and fold themselves are tested in
// tests/ui/details/column.test.tsx; this is the column and the shell body that lay them out.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Shell } from '../../../src/ui/shell/Shell';
import { DetailsColumn } from '../../../src/ui/shell/DetailsColumn';
import { DockInsetProvider } from '../../../src/ui/shell/dockInset';
import { DetailsColumnProvider, FOLDED_KEY } from '../../../src/state/details/column';

const WIDE = 1280, NARROW = 900;
const original = window.innerWidth;

function viewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  act(() => { window.dispatchEvent(new Event('resize')); });
}

beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); viewport(WIDE); });
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); viewport(original); });

interface Setup {
  readonly saved?: number | null;
  readonly inset?: number;
  readonly onSave?: (width: number) => void;
  readonly side?: boolean;
  readonly covered?: boolean;
  readonly children?: ReactNode;
}
const tree = ({ saved = null, inset = 0, onSave, side = true, covered = false, children = <p>Details</p> }: Setup) =>
  <DockInsetProvider height={inset}><DetailsColumnProvider saved={saved} onSave={onSave}>
    <Shell topBar={null} main={<p>Map</p>} legacy={{ conversation: covered ? <p>Bigger view</p> : undefined }}
      side={side ? <DetailsColumn rail={<i data-testid="rail-status" />}>{children}</DetailsColumn> : undefined} />
  </DetailsColumnProvider></DockInsetProvider>;
const mount = (setup: Setup = {}) => render(tree(setup));

const columns = () => (document.querySelector('.shell-body') as HTMLElement).style.gridTemplateColumns.split(' ');
const sideColumn = () => columns().at(-1);
const edge = () => screen.getByRole('separator', { name: 'Resize detail panel' });
const now = () => Number(edge().getAttribute('aria-valuenow'));
const aside = () => document.querySelector('.shell-detail') as HTMLElement;
const settle = () => act(() => { vi.advanceTimersByTime(1000); });

describe('placement', () => {
  it.each([
    ['wide, nothing saved', WIDE, null, false, '400px'],
    ['narrow, nothing saved', NARROW, null, false, '340px'],
    ['just under the breakpoint', 1099, null, false, '340px'],
    ['at the breakpoint', 1100, null, false, '400px'],
    ['wide, saved wider', WIDE, 520, false, '520px'],
    ['wide, saved at the least', WIDE, 320, false, '320px'],
    ['narrow, saved', NARROW, 450, false, '450px'],
    ['wide, folded', WIDE, null, true, '36px'],
    ['narrow, folded', NARROW, null, true, '36px'],
    ['folded keeps its saved width for later', WIDE, 520, true, '36px'],
  ])('%s: the side column is %s', (_name, window, saved, folded, expected) => {
    viewport(window);
    if (folded) localStorage.setItem(FOLDED_KEY, 'true');
    mount({ saved });
    expect(sideColumn()).toBe(expected);
  });

  it('has no column, and the Map runs the full width, while no item is selected', () => {
    mount({ side: false });
    expect(document.querySelector('.shell-detail')).toBeNull();
    // The Map's column is the last one: nothing is reserved for Details.
    expect(columns().at(-1)).toMatch(/^minmax\(/);
    expect(screen.getByRole('main').textContent).toBe('Map');
  });

  it('keeps the Map in the first of the grid cells and Details after it, in one row', () => {
    mount();
    const grid = document.querySelector('.shell-body')!;
    expect([...grid.children].slice(-2).map(child => child.tagName)).toEqual(['MAIN', 'ASIDE']);
  });

  it.each([['open', null, 400], ['folded', true, 36]])('lets notices float over the Map only, %s: they stop at Details', (_name, folded, right) => {
    if (folded) localStorage.setItem(FOLDED_KEY, 'true');
    mount();
    expect(parseFloat((document.querySelector('.shell-notices') as HTMLElement).style.right)).toBe(right);
  });

  it('puts notices to the edge of the window when there is no column', () => {
    mount({ side: false });
    expect(parseFloat((document.querySelector('.shell-notices') as HTMLElement).style.right)).toBe(0);
  });

  it('follows a window that crosses the breakpoint', () => {
    mount();
    expect(sideColumn()).toBe('400px');
    viewport(NARROW);
    expect(sideColumn()).toBe('340px');
    viewport(WIDE);
    expect(sideColumn()).toBe('400px');
  });

  it('is covered, unreachable and hidden from assistive tech, while the bigger view is open', () => {
    mount({ covered: true });
    expect(aside().hasAttribute('inert')).toBe(true);
    expect(aside().getAttribute('aria-hidden')).toBe('true');
  });
});

describe('resize', () => {
  // [what the owner does, window, saved, steps, shown, saved]. A drag step is [start x, end x]; a key step is its key.
  type Step = readonly [number, number] | string;
  it.each<[string, number, number | null, readonly Step[], number, number | null]>([
    ['drags the edge left to widen', WIDE, null, [[1000, 880]], 520, 520],
    ['drags the edge right to narrow', WIDE, null, [[1000, 1060]], 340, 340],
    ['stops a drag at the least', WIDE, null, [[1000, 1900]], 320, 320],
    ['stops a drag at the most (window - 480)', WIDE, null, [[1000, -3000]], 800, 800],
    ['drags in a narrow window', NARROW, null, [[800, 700]], 440, 440],
    ['uses a width under 320 in a narrow window and saves 320', NARROW, null, [[800, 840]], 300, 320],
    ['stops a narrow drag at 280 and saves 320', NARROW, null, [[800, 1800]], 280, 320],
    ['stops a narrow drag at the most (window - 380)', NARROW, null, [[800, -3000]], 520, 520],
    ['steps 16 wider with ArrowLeft', WIDE, null, ['ArrowLeft', 'ArrowLeft'], 432, 432],
    ['steps 16 narrower with ArrowRight', WIDE, 500, ['ArrowRight'], 484, 484],
    ['goes to the least with Home', WIDE, null, ['Home'], 320, 320],
    ['goes to the most with End', WIDE, null, ['End'], 800, 800],
    ['goes to the narrow least with Home, saved as 320', NARROW, null, ['Home'], 280, 320],
    ['goes to the narrow most with End', NARROW, null, ['End'], 520, 520],
    ['keeps stepping from where a drag ended', WIDE, null, [[1000, 900], 'ArrowRight'], 484, 484],
    ['ignores other keys', WIDE, null, ['ArrowUp', 'Tab', 'a'], 400, null],
  ])('%s (%ipx window, saved %s)', (_name, window, saved, steps, shown, written) => {
    viewport(window);
    const onSave = vi.fn();
    mount({ saved, onSave });
    for (const step of steps) {
      if (typeof step === 'string') fireEvent.keyDown(edge(), { key: step });
      else {
        fireEvent.pointerDown(edge(), { button: 0, clientX: step[0], pointerId: 1 });
        fireEvent.pointerMove(edge(), { clientX: step[1], pointerId: 1 });
        fireEvent.pointerUp(edge(), { clientX: step[1], pointerId: 1 });
      }
    }
    expect(now()).toBe(shown);
    expect(sideColumn()).toBe(`${shown}px`);
    settle();
    if (written === null) expect(onSave).not.toHaveBeenCalled();
    else expect(onSave).toHaveBeenCalledExactlyOnceWith(written);
  });

  it('resizes live while the pointer is down, and writes only once the drag settles', () => {
    const onSave = vi.fn();
    mount({ onSave });
    fireEvent.pointerDown(edge(), { button: 0, clientX: 1000, pointerId: 1 });
    for (const x of [980, 940, 900, 860]) { fireEvent.pointerMove(edge(), { clientX: x, pointerId: 1 }); expect(sideColumn()).toBe(`${400 + 1000 - x}px`); }
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.pointerUp(edge(), { pointerId: 1 });
    settle();
    expect(onSave).toHaveBeenCalledExactlyOnceWith(540);
  });

  it('ignores a drag that did not start on the edge, and a right-button press', () => {
    const onSave = vi.fn();
    mount({ onSave });
    fireEvent.pointerMove(edge(), { clientX: 500, pointerId: 1 });
    fireEvent.pointerDown(edge(), { button: 2, clientX: 1000, pointerId: 1 });
    fireEvent.pointerMove(edge(), { clientX: 800, pointerId: 1 });
    expect(sideColumn()).toBe('400px');
    settle();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('goes back to the window default on a double-click', () => {
    const onSave = vi.fn();
    viewport(NARROW);
    mount({ saved: 500, onSave });
    expect(sideColumn()).toBe('500px');
    fireEvent.doubleClick(edge());
    expect(sideColumn()).toBe('340px');
    settle();
    expect(onSave).toHaveBeenCalledExactlyOnceWith(340);
  });

  it('describes the edge for assistive tech with this window range, and names it on hover', () => {
    mount();
    expect(edge().getAttribute('aria-valuemin')).toBe('320');
    expect(edge().getAttribute('aria-valuemax')).toBe('800');
    expect(edge().getAttribute('aria-valuenow')).toBe('400');
    expect(edge().getAttribute('title')).toBe('Drag to change the width of Details. Ariadne remembers it.');
    viewport(NARROW);
    expect(edge().getAttribute('aria-valuemin')).toBe('280');
    expect(edge().getAttribute('aria-valuemax')).toBe('520');
  });

  it('writes a width stepped by keys even when the column closes before the pause ends', () => {
    const onSave = vi.fn();
    const { rerender } = mount({ onSave });
    fireEvent.keyDown(edge(), { key: 'ArrowLeft' });
    rerender(tree({ onSave, side: false }));
    expect(onSave).not.toHaveBeenCalled();
    settle();
    expect(onSave).toHaveBeenCalledExactlyOnceWith(416);
  });

  it('remembers the width across a restart', () => {
    const first = vi.fn();
    const { unmount } = mount({ onSave: first });
    fireEvent.keyDown(edge(), { key: 'End' });
    settle();
    unmount();
    expect(first).toHaveBeenCalledExactlyOnceWith(800);
    mount({ saved: 800 });
    expect(sideColumn()).toBe('800px');
  });
});

describe('fold', () => {
  const fold = () => screen.getByRole('button', { name: 'Fold Details' });
  const rail = () => screen.queryByRole('button', { name: 'Show Details' });

  it('folds with the » button to a 36px rail, and a click on the rail unfolds it', () => {
    mount();
    expect(rail()).toBeNull();
    expect(fold().title).toBe('Fold Details');
    fireEvent.click(fold());
    expect(sideColumn()).toBe('36px');
    expect(rail()).not.toBeNull();
    expect(rail()!.textContent).toContain('Details');
    expect(localStorage.getItem(FOLDED_KEY)).toBe('true');
    fireEvent.click(rail()!);
    expect(sideColumn()).toBe('400px');
    expect(rail()).toBeNull();
    expect(localStorage.getItem(FOLDED_KEY)).toBe('false');
  });

  it('shows the item status in the rail', () => {
    localStorage.setItem(FOLDED_KEY, 'true');
    mount();
    expect(rail()!.contains(screen.getByTestId('rail-status'))).toBe(true);
  });

  it('keeps the content mounted but out of reach while folded, so typed text and scroll position survive', () => {
    mount({ children: <textarea aria-label="Reply" /> });
    const box = screen.getByLabelText('Reply') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'half a sentence' } });
    fireEvent.click(fold());
    expect(document.contains(box)).toBe(true);
    expect(box.closest('[inert]')).not.toBeNull();
    fireEvent.click(rail()!);
    expect(box.closest('[inert]')).toBeNull();
    expect((screen.getByLabelText('Reply') as HTMLTextAreaElement).value).toBe('half a sentence');
  });

  it('moves focus to the rail when it folds, and back to the » button when it unfolds', () => {
    mount();
    fold().focus();
    fireEvent.click(fold());
    expect(document.activeElement).toBe(rail());
    fireEvent.click(rail()!);
    expect(document.activeElement).toBe(fold());
  });

  it('keeps its width through a fold and an unfold', () => {
    mount({ saved: 520 });
    fireEvent.click(fold());
    fireEvent.click(rail()!);
    expect(sideColumn()).toBe('520px');
  });

  it('opens folded after a restart, and unfolded when the stored value is not a boolean', () => {
    localStorage.setItem(FOLDED_KEY, 'true');
    const { unmount } = mount();
    expect(rail()).not.toBeNull();
    unmount();
    localStorage.setItem(FOLDED_KEY, 'maybe');
    mount();
    expect(rail()).toBeNull();
    expect(sideColumn()).toBe('400px');
  });

  it('has no resize edge or header while folded, only the rail to click', () => {
    localStorage.setItem(FOLDED_KEY, 'true');
    mount();
    expect(screen.queryByRole('separator', { name: 'Resize detail panel' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close detail' })).toBeNull();
  });

  // The design gives Details no key: the rail and the » button are the only ways.
  it.each(['d', 'D', 'f', 'F', 'w', '\\', '[', ']', '.', 'Escape', 'ArrowRight', 'Enter', ' '])('does not fold or unfold on the %j key', key => {
    mount();
    fireEvent.keyDown(document.body, { key });
    fireEvent.keyDown(aside(), { key });
    fireEvent.keyDown(document.body, { key, metaKey: true });
    expect(rail()).toBeNull();
    expect(localStorage.getItem(FOLDED_KEY)).toBeNull();
  });

  it('does not unfold on a key either', () => {
    localStorage.setItem(FOLDED_KEY, 'true');
    mount();
    for (const key of ['d', 'f', '[', ']', 'Escape']) fireEvent.keyDown(document.body, { key });
    expect(rail()).not.toBeNull();
    expect(sideColumn()).toBe('36px');
  });
});

describe('dock', () => {
  // The column leaves the dock's height free at its bottom, so its composer (the last thing in the column) sits above the dock.
  it.each([0, 40, 200, 400, 520])('keeps %ipx free below the column for the dock, open or folded', inset => {
    const { unmount } = mount({ inset });
    expect(parseFloat(aside().style.paddingBottom || '0')).toBe(inset);
    unmount();
    localStorage.setItem(FOLDED_KEY, 'true');
    mount({ inset });
    expect(parseFloat(aside().style.paddingBottom || '0')).toBe(inset);
  });

  it('follows the dock as it opens, grows and folds', () => {
    const { rerender } = mount({ inset: 40 });
    for (const inset of [400, 200, 40, 0]) {
      rerender(tree({ inset }));
      expect(parseFloat(aside().style.paddingBottom || '0')).toBe(inset);
    }
  });

  it('stops the bigger view where the dock starts, so its composer is never under the dock either', () => {
    const css = readFileSync(resolve(__dirname, '../../../src/ui/shell/shell.css'), 'utf8');
    expect(css.match(/\.shell-conversation \{([^}]*)\}/)?.[1]).toContain('bottom: var(--dock-inset, 0);');
  });

  it('keeps the composer in the free space: it is the last child of the scroll host, and the host is not padded further', () => {
    mount({ inset: 200, children: <div className="item-detail"><div className="detail-body" /><div className="detail-dock">Composer</div></div> });
    const host = document.querySelector('.shell-detail-scroll')!;
    expect(host.lastElementChild!.lastElementChild!.textContent).toBe('Composer');
    expect((host as HTMLElement).style.paddingBottom).toBe('');
  });
});
