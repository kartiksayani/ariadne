import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionTopicGraph } from '../../../src/components/graph/SessionTopicGraph';
import * as geometry from '../../../src/graph/layout/geometry';
import { fitBounds } from '../../../src/graph/layout/viewport';
import { sentenceRows } from '../../../src/selectors/tree/rows';
import { graphFixture } from './fixture';

const opened: Awaited<ReturnType<typeof graphFixture>>[] = [];
afterEach(() => { cleanup(); opened.splice(0).forEach(fixture => fixture.opened.closeAll()); vi.restoreAllMocks(); });
const nodes = () => Array.from(document.querySelectorAll<SVGGElement>('[data-graph-node]'));
const node = (id: string) => nodes().find(node => node.dataset.graphNode === id)!;
const world = () => document.querySelector('[data-graph-world]')!.getAttribute('transform');
function frames() {
  let next = 0;
  const pending = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { pending.set(++next, callback); return next; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { pending.delete(id); });
  return () => act(() => { const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(callback => callback(0)); });
}
const pointer = (target: Element, type: string, x: number, y: number) => {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, 'pointerId', { value: 1 }); fireEvent(target, event);
};
async function setup() {
  const fixture = await graphFixture(); opened.push(fixture);
  return { ...fixture, later: new Set<string>(), onReveal: vi.fn(), saveSelection: vi.fn(async () => true), onSwitchToTree: vi.fn() };
}
describe('2,000-node rendered viewport', () => {
  it('culls nodes, retains crossing edges and commits burst input together without relayout', async () => {
    const flush = frames(), layout = vi.spyOn(geometry, 'layoutGraph'), fixture = await setup();
    render(<SessionTopicGraph {...fixture} />); flush();
    expect(nodes().length).toBeLessThan(200);
    expect(document.querySelector('[data-edge="replacement:1.1:20.99"]')).not.toBeNull();
    expect(screen.getByText(/2000 matching · 2000 in this topic/)).toBeTruthy();
    const canvas = screen.getByLabelText('Topic sentences'), before = world(), ids = nodes().map(node => node.dataset.graphNode);
    const calls = layout.mock.calls.length;
    pointer(canvas, 'pointerdown', 0, 0); pointer(canvas, 'pointermove', 50, 1000); pointer(canvas, 'pointermove', 80, 2000);
    expect(world()).toBe(before); expect(nodes().map(node => node.dataset.graphNode)).toEqual(ids);
    flush(); expect(world()).not.toBe(before); expect(nodes().map(node => node.dataset.graphNode)).not.toEqual(ids);
    fireEvent.wheel(canvas, { clientX: 100, clientY: 120, deltaY: -600 });
    fireEvent.wheel(canvas, { clientX: 100, clientY: 120, deltaY: -600 }); flush();
    expect(layout).toHaveBeenCalledTimes(calls);
    expect(screen.getByText(/2000 matching · 2000 in this topic/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Fit' })); flush(); expect(world()).toBe(before);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to tree' })); expect(fixture.onSwitchToTree).toHaveBeenCalledOnce();
  });
  it('centers an off-screen shared selection before focus and retains selected and separately focused nodes while panning', async () => {
    const flush = frames(), fixture = await setup(), rendered = render(<SessionTopicGraph {...fixture} />); flush();
    expect(node('20.99')).toBeUndefined();
    const view = { ...fixture.view, selected_item_id: '20.99' }, before = world();
    rendered.rerender(<SessionTopicGraph {...fixture} view={view} />);
    expect(world()).toBe(before); expect(document.activeElement).not.toBe(node('20.99'));
    flush(); expect(world()).not.toBe(before); expect(document.activeElement).toBe(node('20.99'));
    expect(node('20.99').getAttribute('aria-pressed')).toBe('true');
    const other = nodes().find(node => node.dataset.graphNode !== '20.99')!;
    act(() => other.focus());
    const canvas = screen.getByLabelText('Topic sentences'); pointer(canvas, 'pointerdown', 0, 0); pointer(canvas, 'pointermove', 2000, 30000); flush();
    expect(document.activeElement).toBe(other); expect(node('20.99')).toBeTruthy(); expect(nodes()).toContain(other);
    const panned = world(); fixture.session.revision++;
    await act(async () => { await fixture.store.refresh(); }); flush();
    expect(world()).toBe(panned); expect(document.activeElement).toBe(other);
    fireEvent.click(screen.getByRole('button', { name: 'Fit' })); flush();
    const full = geometry.layoutGraph(Object.values(fixture.session.items).flatMap(item => item ? [item] : [])), fit = fitBounds(full.bounds, 800, 420);
    expect(world()).toBe(`translate(${fit.x} ${fit.y}) scale(${fit.scale})`);
    expect(document.activeElement).toBe(other); expect(fixture.saveSelection).not.toHaveBeenCalled();
  });
  it('preserves full tree search counts and ancestry even with off-screen retained selection', async () => {
    const flush = frames(), fixture = await setup();
    const view = { ...fixture.view, selected_item_id: '1.1', filters: { ...fixture.view.filters, search: 'Graph question 20.' } };
    render(<SessionTopicGraph {...fixture} view={view} />); flush();
    const tree = sentenceRows(fixture.session, { ...view, expanded_item_ids: Object.keys(fixture.session.items) }, fixture.later);
    expect(tree.matchingTotal).toBe(99); expect(tree.scopeTotal).toBe(2000);
    expect(screen.getByText(/99 matching · 2000 in this topic/)).toBeTruthy();
    expect(nodes().map(node => node.dataset.graphNode)).toEqual(tree.rows.map(row => row.item.id));
    expect(node('20').classList.contains('topic-graph-context')).toBe(true);
    expect(screen.getByText(/selected item is outside this filtered topic/)).toBeTruthy();
  });
});
