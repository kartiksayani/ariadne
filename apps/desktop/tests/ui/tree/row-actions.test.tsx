import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import demo from '../../../../../fixtures/domain/demo/session.json';
import type { Session } from '../../../src/generated/domain/models';
import { immutable } from '../../../src/data';
import type { Item, ItemStatus } from '../../../src/generated/domain/models';
import { ItemRow, placeActions, type ItemRowProps } from '../../../src/ui/tree/ItemRow';
import type { Delivery } from '../../../src/ui/tree/model';
import { DockInsetProvider } from '../../../src/ui/shell/dockInset';
import { TopicRow, type TopicAction, type TopicRowProps } from '../../../src/ui/tree/TopicRow';

afterEach(cleanup);

/** An item row as the Map draws it; the row builds its Ack and hover bar from its item and these values (F6d). */
function itemProps({ status = 'open', ack = null, stopped = null, ackDisabled = false, delivery = null, later = false }: {
  status?: ItemStatus; ack?: Item['ack_to']; stopped?: string | null; ackDisabled?: boolean; delivery?: Delivery | null; later?: boolean;
} = {}): ItemRowProps {
  const template = (demo as Session).items['1']!;
  const item = immutable({ ...template, question: 'Choose the orchard planting order', status,
    outcome: 'Plant the pear trees first.', ask: null, note: null, ack_to: ack });
  return { row: { kind: 'item', key: item.id, item, status, ack, depth: 1, hasKids: false,
    expanded: false, context: false, guides: [], boxes: [], branch: 0, later, hidden: false, segments: [{ text: item.question, hit: false }], matches: [],
    replacedBy: null, relatedCount: 2, collapsed: null, delivery, badge: 'Open' },
  selected: false, focused: true, note: null, stopped, ackDisabled, run: vi.fn(), unfolded: false,
  onUnfold: vi.fn(), remember: vi.fn(), onFocus: vi.fn(), onKeyDown: vi.fn(), onSelect: vi.fn(),
  onToggle: vi.fn() };
}
/** The hover bar of an open item, in SPEC 6.2's order. */
const OPEN_BAR = ['Reply (r)', 'Bring it up (b)', 'Later (z)', 'Drop (d)', 'Hide (x)', 'Remove (⌫)'];

function topicProps(actions: readonly TopicAction[]): TopicRowProps {
  const topic = immutable({ ...Object.values((demo as Session).topics)[0]!, name: 'Orchard plans' });
  return { row: { kind: 'topic', key: topic.id, topic, depth: 0, expanded: true, first: true, guides: [],
    counts: [{ text: '2 open', icon: 'ph ph-circle', color: 'var(--st-open)' },
      { text: '1 closed', icon: 'ph ph-check', color: 'var(--st-done)' }],
    earlier: false, chip: null, allClosed: false, delivery: null }, focused: true, actions, prompt: null,
  remember: vi.fn(), onFocus: vi.fn(), onKeyDown: vi.fn(), onToggle: vi.fn() };
}

describe('compact row actions', () => {
  it('has no Focus button and no double-click Focus: the topic band and ⇧F own Focus (D9)', () => {
    const props = itemProps(), mounted = render(<ItemRow {...props} row={{ ...props.row, item: { ...props.row.item, parent: null } }} />);
    expect(within(mounted.container).queryByRole('button', { name: /^(Focus on|Unfocus)/ })).toBeNull();
    fireEvent.doubleClick(mounted.container.querySelector('.tree-icon')!);
    expect(within(mounted.container).queryByRole('button', { name: /^(Focus on|Unfocus)/ })).toBeNull();
  });

  // owner 2026-10-20: visible Ack target. Only the Ack names where it leads; the hover bar's buttons stay icons.
  it.each([['→ Done', 'done'], ['→ Decided', 'decided'], ['→ Dropped', 'dropped'], ['→ Open', 'open'], ['→ In progress', 'in_progress']] as const)('shows "%s" after the Ack check and keeps the hover bar icon-only', (label, target) => {
    const props = itemProps({ status: target === 'in_progress' ? 'open' : 'in_progress', ack: target });
    const { container } = render(<ItemRow {...props} />);
    const ack = within(container.querySelector('.tree-ack-slot') as HTMLElement).getByRole('button', { name: /^Ack → / });
    expect(ack.textContent).toBe(label);
    expect(ack.firstElementChild?.className).toContain('ph-check');
    expect(ack.querySelector('.tree-action-label')?.textContent).toBe(label);
    const bar = within(container.querySelector('.tree-actions') as HTMLElement).getAllByRole('button');
    expect(bar).toHaveLength(6);
    expect(bar.every(button => button.textContent === '')).toBe(true);
    expect(container.querySelector('.tree-end')?.classList.contains('tree-end-labelled')).toBe(true);
  });

  it('keeps the 22px Ack slot on a row with no Ack, and the wide one through the 6 s hold', () => {
    const bare = render(<ItemRow {...itemProps()} />);
    expect(bare.container.querySelector('.tree-end')?.classList.contains('tree-end-labelled')).toBe(false);
    bare.unmount();
    const props = itemProps({ ack: 'done' });
    const { container, rerender } = render(<ItemRow {...props} />);
    expect(container.querySelector('.tree-end')?.classList.contains('tree-end-labelled')).toBe(true);
    // Held: the button is replaced by "Acked · Undo", and the cluster stays as wide so the row does not rewrap until the Ack is saved.
    rerender(<ItemRow {...props} acked onUndoAck={vi.fn()} />);
    expect(container.querySelector('.tree-end')?.classList.contains('tree-end-labelled')).toBe(true);
    expect(container.querySelector('.tree-acked')).not.toBeNull();
  });

  it('draws a held Ack over the area left of the Ack slot, hides the Ack button, and Undo cancels it', () => {
    const undo = vi.fn(), props = itemProps({ ack: 'done' }), ack = props.run;
    const { container, rerender } = render(<ItemRow {...props} />);
    const before = container.querySelector('.tree-ack-slot')!;
    expect(within(before as HTMLElement).getByRole('button', { name: 'Ack → Done' })).toBeTruthy();
    expect(container.querySelector('.tree-acked')).toBeNull();
    rerender(<ItemRow {...props} acked onUndoAck={undo} />);
    const held = within(container).getByRole('status');
    expect(held.textContent).toBe('Acked·Undo');
    // The Ack slot keeps its place (empty), so the row never rewraps; the notice is inside the end cluster, drawn over it.
    expect(container.querySelector('.tree-ack-slot')?.childElementCount).toBe(0);
    expect(held.closest('.tree-end')).not.toBeNull();
    fireEvent.click(within(held).getByRole('button', { name: /^Undo Ack of/ }));
    expect(undo).toHaveBeenCalledWith(props.row.item.id);
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
  });

  it('keeps every item action in its existing order with the same names, tab behavior and callbacks', () => {
    const props = itemProps({ ack: 'done' }), { container } = render(<ItemRow {...props} />);
    // The row holds both: the floating hover bar in order, then Ack in its own reserved slot at the end of the cluster.
    const cluster = container.querySelector('.tree-item')!, buttons = within(cluster as HTMLElement).getAllByRole('button');
    const shown = [...OPEN_BAR, 'Ack → Done'];
    expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual(shown);
    expect(buttons.map(button => button.title)).toEqual(shown);
    expect(within(container.querySelector('.tree-actions') as HTMLElement).getAllByRole('button').map(button => button.title)).toEqual(OPEN_BAR);
    expect(buttons.slice(0, -1).every(button => button.textContent === '')).toBe(true);
    expect(buttons.map(button => button.tabIndex)).toEqual([-1, -1, -1, -1, -1, -1, 0]);
    expect(container.querySelectorAll('.tree-ack-slot')).toHaveLength(1);
    expect(container.querySelectorAll('.tree-actions')).toHaveLength(1);
    expect(buttons.at(-1)!.closest('.tree-actions')).toBeNull();
    expect(buttons.at(-1)!.closest('.tree-ack-slot')).not.toBeNull();
    expect(buttons[4]!.querySelector('svg')).not.toBeNull();
    // Each button runs its command for this row's item through the Map's one dispatcher.
    const commands = ['reply', 'bring', 'later', 'drop', 'hide', 'remove', 'ack'];
    buttons.forEach((button, index) => {
      expect(button.getAttribute('type')).toBe('button');
      expect(button.classList.contains('tree-action')).toBe(true);
      fireEvent.click(button);
      expect(props.run).toHaveBeenLastCalledWith(commands[index], props.row.item.id);
    });
    expect(props.run).toHaveBeenCalledTimes(commands.length);
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(container.querySelector('.tree-end-badge')?.textContent).toBe('Open');
    expect(container.querySelector('.tree-related')?.getAttribute('aria-label')).toBe('2 related items');
    // The Round tag is gone (SPEC §7): it widened the cluster when the owner replied.
    expect(container.querySelector('.tree-round')).toBeNull();
  });

  it('preserves disabled Ack and keeps action markup stable when hovering and selecting a row', () => {
    const props = itemProps({ ack: 'done', ackDisabled: true }), run = vi.mocked(props.run);
    const { container, rerender } = render(<ItemRow {...props} />);
    const row = container.querySelector('.tree-item')!, grid = row;
    const markup = () => `${container.querySelector('.tree-actions')!.innerHTML}|${container.querySelector('.tree-end')!.innerHTML}`, before = markup();
    const button = within(grid as HTMLElement).getByRole('button', { name: 'Ack → Done' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button); expect(run).not.toHaveBeenCalled();
    fireEvent.mouseEnter(row);
    rerender(<ItemRow {...props} selected />);
    expect(markup()).toBe(before);
    expect(within(grid as HTMLElement).getByRole('button', { name: 'Reply (r)' }).tabIndex).toBe(-1);
    const selections = vi.mocked(props.onSelect).mock.calls.length;
    fireEvent.click(within(grid as HTMLElement).getByRole('button', { name: 'Reply (r)' }));
    expect(run).toHaveBeenCalledExactlyOnceWith('reply', props.row.item.id); expect(props.onSelect).toHaveBeenCalledTimes(selections);
  });

  // The six-slot hover bar can float over the middle of a narrow row. A click there must still select the row, so a greyed
  // slot sits in a titled wrapper that takes the pointer (the button ignores it) and the click bubbles to the row.
  it('lets a click on a greyed hover-bar slot select the row, keeps its tooltip, and never runs it', () => {
    const props = itemProps({ status: 'done' });
    const { container } = render(<ItemRow {...props} />);
    const bar = container.querySelector('.tree-actions')!;
    const slot = bar.querySelector<HTMLElement>('.tree-action-off')!;
    expect(slot.title).toBe('Later: not for Done items');
    const button = within(slot).getByRole('button', { name: 'Later: not for Done items' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect([...bar.querySelectorAll<HTMLElement>('.tree-action-off')].map(off => off.title)).toEqual(['Later: not for Done items', 'Drop: not for Done items']);
    fireEvent.click(slot);
    expect(props.onSelect).toHaveBeenCalledWith(props.row.item.id);
    expect(props.run).not.toHaveBeenCalled();
  });

  // A stopped agent or archived session greys slots 1-4 with the reason (D4); a message on its way greys them too. Hide and
  // Remove stay. The Map passes the reason; the row builds the bar.
  it.each([
    ['the agent is not running', { stopped: 'the agent is not running' }, ': the agent is not running'],
    ['an archived session', { stopped: 'archived' }, ': archived'],
    ['a message on its way', { delivery: { icon: 'ph ph-paper-plane-tilt', text: 'Sending', color: 'red', failed: false } }, ': a message is on its way'],
  ] as const)('greys the agent slots for %s', (_name, options, reason) => {
    const props = itemProps(options), { container } = render(<ItemRow {...props} />);
    const titles = within(container.querySelector('.tree-actions') as HTMLElement).getAllByRole('button').map(button => button.title);
    expect(titles).toEqual([`Reply${reason}`, `Bring it up${reason}`, `Later${reason}`, `Drop${reason}`, 'Hide (x)', 'Remove (⌫)']);
    fireEvent.click(within(container).getByRole('button', { name: 'Hide (x)' }));
    expect(props.run).toHaveBeenCalledExactlyOnceWith('hide', props.row.item.id);
  });

  it('offers Unpark for a parked item, Follow up and Back to Open for a closed one, and Unhide for a hidden one', () => {
    const parked = itemProps({ later: true });
    const { container, rerender } = render(<ItemRow {...parked} />);
    const titles = () => within(container.querySelector('.tree-actions') as HTMLElement).getAllByRole('button').map(button => button.title);
    expect(titles()).toEqual(['Reply (r)', 'Bring it up (b)', 'Unpark (z)', 'Drop (d)', 'Hide (x)', 'Remove (⌫)']);
    const done = itemProps({ status: 'done' });
    rerender(<ItemRow {...done} row={{ ...done.row, hidden: true }} />);
    expect(titles()).toEqual(['Follow up (r)', 'Back to Open (o)', 'Later: not for Done items', 'Drop: not for Done items', 'Unhide (x)', 'Remove (⌫)']);
  });

  // The bar floats above the row unless the sticky band or the top of the Map/window is closer than its reach (24px).
  it.each([
    ['plenty of room under a band', { row: 200, band: 80, scroll: 40 }, 'above'],
    ['exactly the bar\'s reach under the band', { row: 104, band: 80, scroll: 40 }, 'above'],
    ['a pixel short of the reach under the band', { row: 103, band: 80, scroll: 40 }, 'below'],
    ['the first row right under the band', { row: 80, band: 80, scroll: 40 }, 'below'],
    ['partly under the sticky band', { row: 60, band: 80, scroll: 40 }, 'below'],
    ['no band: room above the Map\'s top', { row: 90, band: null, scroll: 40 }, 'above'],
    ['no band: the first row at the Map\'s top', { row: 40, band: null, scroll: 40 }, 'below'],
    ['no band and no Map: the window\'s top', { row: 10, band: null, scroll: null }, 'below'],
    ['a row taller than the window, its top under the band', { row: 60, band: 80, scroll: 40, height: 900 }, 'inside'],
    ['a row whose bottom is exactly the bar\'s reach from the Map\'s bottom', { row: 60, band: 80, scroll: 40, height: 516 }, 'below'],
    ['a row whose bottom is a pixel short of the bar\'s reach', { row: 60, band: 80, scroll: 40, height: 517 }, 'inside'],
  ] as const)('puts the hover bar %s: %s', (_name, at, side) => {
    const props = itemProps();
    const group = document.createElement('div'), scroller = document.createElement('div');
    group.className = 'tree-topic-group'; scroller.className = 'tree-scroll';
    const height = 'height' in at ? at.height : 30, rect = (top: number) => ({ top, bottom: top + height }) as DOMRect;
    // The Map runs from `scroll` to 600; the band is 30px high and ends at `band`.
    if (at.scroll !== null) { scroller.append(group); scroller.getBoundingClientRect = () => ({ top: at.scroll, bottom: 600 }) as DOMRect; }
    document.body.append(at.scroll !== null ? scroller : group);
    if (at.band !== null) {
      const band = document.createElement('div'); band.className = 'tree-topic';
      band.getBoundingClientRect = () => ({ top: at.band - 30, bottom: at.band }) as DOMRect; group.append(band);
    }
    const { container } = render(<ItemRow {...props} />, { container: group.appendChild(document.createElement('div')) });
    const row = container.querySelector<HTMLElement>('.tree-item')!, bar = container.querySelector<HTMLElement>('.tree-actions')!;
    expect(bar.dataset.side).toBe('above');
    row.getBoundingClientRect = () => rect(at.row);
    fireEvent.mouseEnter(row);
    expect(bar.dataset.side).toBe(side);
    // Inside a tall row it sits in the first visible spot below the cluster (here: the band's bottom plus a little); elsewhere it sets no top.
    expect(bar.style.top).toBe(side === 'inside' ? `${at.band! - at.row + 4}px` : '');
    // It follows the row as the Map scrolls under a resting pointer, and never changes the rendered tree otherwise.
    row.getBoundingClientRect = () => rect(at.row + 500);
    fireEvent.mouseMove(row);
    expect(bar.dataset.side).toBe('above');
    row.getBoundingClientRect = () => rect(at.row);
    fireEvent.focus(row);
    expect(bar.dataset.side).toBe(side);
    expect(placeActions(row, null)).toBeUndefined();
    scroller.remove(); group.remove();
  });

  // The answer dock covers the bottom of the Map (TreeView `visibleBottom` subtracts its inset): a bar that would land under it goes
  // above, or inside, instead.
  it.each([
    ['no dock: room below the row', 0, 'below'],
    ['a dock that leaves the bar\'s reach below the row', 100, 'below'],
    ['a dock that covers the space right under the row', 740, 'inside'],
  ] as const)('counts the dock when it picks the side of the hover bar: %s', (_name, inset, side) => {
    const props = itemProps();
    // The window is 768px high in jsdom; the row is at its top (no room above), 30px high, so its bottom edge is at 40.
    const { container } = render(<DockInsetProvider height={inset}><ItemRow {...props} /></DockInsetProvider>);
    const row = container.querySelector<HTMLElement>('.tree-item')!, bar = container.querySelector<HTMLElement>('.tree-actions')!;
    row.getBoundingClientRect = () => ({ top: 10, bottom: 40, right: 500 }) as DOMRect;
    fireEvent.mouseEnter(row);
    expect(bar.dataset.side).toBe(side);
    // With room above (a dock under a row near the bottom): the bar stays above.
    row.getBoundingClientRect = () => ({ top: 700, bottom: 730, right: 500 }) as DOMRect;
    fireEvent.mouseMove(row);
    expect(bar.dataset.side).toBe('above');
    row.getBoundingClientRect = () => ({ top: 10, bottom: 40, right: 500 }) as DOMRect;
    expect(placeActions(row, bar, inset)).toBeUndefined();
    expect(bar.dataset.side).toBe(side);
    expect(placeActions(row, bar, 0)).toBeUndefined();
    expect(bar.dataset.side).toBe('below');
  });

  // Above or below, the bar ends where the end cluster begins, so it never covers the Ack, status pill or related count of the row it
  // floats over (a deeper neighbour's cluster starts further left, and counts too). Inside a tall row it stays under the cluster.
  it.each([
    ['above: the row alone', 'above', 340, null, '160px'],
    ['above: a deeper row above, whose cluster starts further left', 'above', 340, 328, '172px'],
    ['above: a shallower row above does not push the bar left', 'above', 340, 346, '160px'],
    ['below: a deeper row below', 'below', 340, 322, '178px'],
  ] as const)('ends the hover bar at the end cluster %s', (_name, side, own, neighbour, right) => {
    const props = itemProps();
    const { container } = render(<ItemRow {...props} />);
    const row = container.querySelector<HTMLElement>('.tree-item')!, bar = container.querySelector<HTMLElement>('.tree-actions')!;
    const at = (left: number) => () => ({ left, bottom: 0 }) as DOMRect;
    row.querySelector('.tree-end')!.getBoundingClientRect = at(own);
    if (neighbour !== null) {
      const other = document.createElement('div'), end = document.createElement('div');
      other.className = 'tree-item'; end.className = 'tree-end'; end.getBoundingClientRect = at(neighbour); other.append(end);
      if (side === 'above') row.before(other); else row.after(other);
    }
    // 'above' needs room over the row; 'below' needs none (it is at the top of the window).
    const top = side === 'above' ? 200 : 10;
    row.getBoundingClientRect = () => ({ top, bottom: top + 30, right: 500 }) as DOMRect;
    fireEvent.mouseEnter(row);
    expect(bar.dataset.side).toBe(side);
    expect(bar.style.right).toBe(right);
    // Inside a row taller than the window it sits under the cluster, at the stylesheet's own right edge.
    row.getBoundingClientRect = () => ({ top: -500, bottom: 5000, right: 500 }) as DOMRect;
    fireEvent.mouseMove(row);
    expect(bar.dataset.side).toBe('inside');
    expect(bar.style.right).toBe('');
  });

  it('keeps the hover bar a direct child of the row, not of the end cluster', () => {
    const { container } = render(<ItemRow {...itemProps()} />);
    const row = container.querySelector('.tree-item')!;
    expect(row.querySelector(':scope > .tree-actions')).not.toBeNull();
    expect(row.querySelector('.tree-end .tree-actions')).toBeNull();
  });

  it('retains item metadata, and keeps the empty Ack slot on a row with no Ack so an Ack never rewraps the row', () => {
    const { container } = render(<ItemRow {...itemProps()} />);
    expect(container.querySelector('.tree-ack-slot')?.childElementCount).toBe(0);
    expect(container.querySelector('.tree-end-marker')?.childElementCount).toBe(0);
    expect(container.querySelector('.tree-end-badge')?.textContent).toBe('Open');
    expect(container.querySelector('.tree-question')?.textContent).toBe('Choose the orchard planting order');
    expect(container.querySelector('.tree-outcome')?.textContent).toBe('Plant the pear trees first.');
  });

  it('preserves topic action order, accessible names, shortcut marker and callbacks beside grouped counts', () => {
    const names = ['Reply to topic', 'Continue here', 'Archive', 'Remove'];
    const actions: TopicAction[] = names.map(label => ({ label, title: `${label} in this topic`, icon: 'ph ph-check',
      run: vi.fn(), archive: label === 'Archive' }));
    const props = topicProps(actions), { container } = render(<TopicRow {...props} />);
    const grid = container.querySelector('.tree-topic-actions')!, buttons = within(grid as HTMLElement).getAllByRole('button');
    expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual(names);
    expect(buttons.map(button => button.title)).toEqual(names.map(name => `${name} in this topic`));
    for (const [index, button] of buttons.entries()) {
      expect(button.tabIndex).toBe(-1); expect(button.getAttribute('type')).toBe('button');
      expect(button.classList.contains('tree-topic-action')).toBe(true);
      expect(button.getAttribute('data-shortcut-archive-topic')).toBe(index === 2 ? props.row.topic.id : null);
      fireEvent.click(button); expect(actions[index]!.run).toHaveBeenCalledOnce();
    }
    expect(props.onToggle).not.toHaveBeenCalled();
    expect([...container.querySelectorAll('.tree-topic-counts .tree-count')].map(count => count.textContent)).toEqual(['2 open', '1 closed']);
  });

  it('omits empty topic actions and counts while retaining the topic name and toggle', () => {
    const props = topicProps([]), { container } = render(<TopicRow {...props} row={{ ...props.row, counts: [] }} />);
    expect(container.querySelector('.tree-topic-actions')).toBeNull();
    expect(container.querySelector('.tree-topic-counts')).toBeNull();
    expect(container.querySelector('.tree-topic-name')?.textContent).toBe('Orchard plans');
    fireEvent.click(within(container).getByRole('button', { name: 'Expand or collapse topic' }));
    expect(props.onToggle).toHaveBeenCalledWith(props.row.topic.id);
  });
});
