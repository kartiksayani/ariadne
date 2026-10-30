// Alpha.27 C: the Details change box starts collapsed to one head line naming the changed fields. Clicking it shows the before/after
// rows; the choice is kept per item for the running app. Unit tests read structure (jsdom has no layout); the one-line head, the
// ellipsis and the never-moves height are checked in the design suite and map-still.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { SessionSeen } from '../../../src/generated/core';
import type { Item, ItemChangeRecord } from '../../../src/generated/domain/models';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { ItemDetail } from '../../../src/ui/detail/ItemDetail';
import { ConversationView } from '../../../src/ui/detail/ConversationView';
import { clockTime } from '../../../src/ui/changes/clock';
import { resetBoxOpen } from '../../../src/ui/changes/boxOpen';
import { route } from '../app/transport';
import { setup } from '../history/fixtures';
import { boxToggle } from './open-box';

const opened: Pick<ReturnType<typeof setup>, 'sessions'>[] = [];
afterEach(() => { cleanup(); opened.splice(0).forEach(value => value.sessions.closeAll()); vi.restoreAllMocks(); resetBoxOpen(); });

const SINCE = '2026-10-01T00:00:00.000Z', CHANGED_AT = '2026-10-04T09:30:00.000Z';
const seenState = (items: SessionSeen['items'] = []): SessionSeen => ({ session: route, since: SINCE, items, topics: [] });

/** Items 1.1 and 8 each changed after the seen baseline: a note (1.1) and a status plus a note (8), each with a reason. */
async function changed(patch: (item: Item) => void = () => {}) {
  const value = setup(); opened.push(value);
  const session = value.transport.session, item = session.items['1.1']!, other = session.items['8']!;
  const record = (before: ItemChangeRecord['before']): ItemChangeRecord => ({ revision: 2, at: CHANGED_AT, cause_message_id: item.created_message_id, reason: 'The agent narrowed it.', before });
  item.revision = 2; item.created_at = '2026-09-30T00:00:00.000Z'; item.changes = [record({ note: 'Earlier note.' })];
  other.revision = 2; other.created_at = '2026-09-30T00:00:00.000Z'; other.changes = [record({ note: 'Older note.', status: 'open' })];
  patch(item);
  await value.store.refresh();
  const props = { drafts: new OwnerDraftStore(value.service), store: value.store, itemId: '1.1', later: false, onOpenItem: vi.fn() };
  return { value, item, other, props };
}
const box = () => screen.getByRole('region', { name: 'What changed' });
const at = clockTime(CHANGED_AT);

describe('the change box starts collapsed', () => {
  it('opens as one head line: caret, title, the changed field names; no rows; Older history stays visible', async () => {
    const { props } = await changed();
    render(<ItemDetail {...props} seen={seenState([{ item_id: '1.1', revision: 2 }])} />);
    const toggle = boxToggle(box());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.firstElementChild!.className).toContain('ph-caret-right');
    expect(toggle.textContent).toBe(`Changed at ${at} · Notes`);
    expect(within(box()).queryByTestId('change-rows')).toBeNull();
    expect(within(box()).queryByText('Earlier note.')).toBeNull();
    expect(within(box()).queryByText('The agent narrowed it.')).toBeNull();
    // The summary is one text node, so the exact label "Notes" still belongs to the row alone.
    const summary = within(box()).getByTestId('change-box-summary');
    expect(summary.childNodes).toHaveLength(1);
    expect(summary.textContent).toBe(' · Notes');
    expect(summary.getAttribute('title')).toBe('Notes');
    // Only the title carries the bare title as its tooltip.
    expect(within(box()).getAllByTitle(`Changed at ${at}`)).toHaveLength(1);
  });

  it('shows Older history below the collapsed head', async () => {
    const { props } = await changed(item => {
      item.changes!.unshift({ revision: 1, at: '2026-10-02T09:30:00.000Z', cause_message_id: item.created_message_id, reason: 'Earlier.', before: { note: 'Oldest note.' } });
    });
    render(<ItemDetail {...props} seen={seenState([{ item_id: '1.1', revision: 2 }])} />);
    expect(boxToggle(box()).getAttribute('aria-expanded')).toBe('false');
    expect(within(box()).getByRole('button', { name: 'Older history (1)' })).toBeTruthy();
  });

  it('lists each changed field once, in row order, in the summary', async () => {
    const { props } = await changed();
    render(<ItemDetail {...props} itemId="8" seen={seenState([{ item_id: '8', revision: 2 }])} />);
    expect(within(box()).getByTestId('change-box-summary').textContent).toBe(' · Notes, Status');
  });

  it('names the note "Progress" for an item in progress, "Notes" otherwise', async () => {
    const progress = await changed(item => { item.status = 'in_progress'; });
    render(<ItemDetail {...progress.props} seen={seenState([{ item_id: '1.1', revision: 2 }])} />);
    expect(within(box()).getByTestId('change-box-summary').textContent).toBe(' · Progress');
    cleanup();
    const open = await changed(item => { item.status = 'open'; });
    render(<ItemDetail {...open.props} seen={seenState([{ item_id: '1.1', revision: 2 }])} />);
    expect(within(box()).getByTestId('change-box-summary').textContent).toBe(' · Notes');
  });

  it('draws no summary when only a reason changed', async () => {
    const { props } = await changed(item => { item.changes![0].before = {}; });
    render(<ItemDetail {...props} seen={seenState([{ item_id: '1.1', revision: 2 }])} />);
    expect(within(box()).queryByTestId('change-box-summary')).toBeNull();
    expect(boxToggle(box()).textContent).toBe(`Changed at ${at}`);
  });

  it('collapses an unseen box too, and Mark seen works while collapsed without toggling', async () => {
    const { props, item } = await changed(), onMarkSeen = vi.fn();
    const view = render(<ItemDetail {...props} seen={seenState()} onMarkSeen={onMarkSeen} />);
    expect(box().getAttribute('data-state')).toBe('unseen');
    expect(boxToggle(box()).getAttribute('aria-expanded')).toBe('false');
    expect(boxToggle(box()).textContent).toBe(`Changed at ${at} · Notes`);
    const mark = within(box()).getByRole('button', { name: 'Mark seen' });
    expect(boxToggle(box()).contains(mark)).toBe(false);
    fireEvent.click(mark);
    expect(onMarkSeen).toHaveBeenCalledExactlyOnceWith('1.1', item.revision);
    expect(boxToggle(box()).getAttribute('aria-expanded')).toBe('false');
    view.rerender(<ItemDetail {...props} seen={seenState([{ item_id: '1.1', revision: 2 }])} onMarkSeen={onMarkSeen} />);
    expect(boxToggle(box()).getAttribute('aria-expanded')).toBe('false');
    expect(boxToggle(box()).textContent).toBe(`Changed at ${at} · Notes`);
  });

  it('a collapsed unseen box says "Changed at", keeps the full title as its tooltip and shows the diamond', async () => {
    const { props } = await changed();
    render(<ItemDetail {...props} seen={seenState()} />);
    expect(box().getAttribute('data-state')).toBe('unseen');
    const title = within(box()).getByTitle(`Changed since you looked · ${at}`);
    expect(within(title).getByText(`Changed at ${at}`)).toBeTruthy();
    expect(title.textContent).toBe(`Changed at ${at}`);
    // The diamond is the title's first child, drawn only while unseen (decorative, so no role to query).
    expect(title.childElementCount).toBe(2);
    expect(title.firstElementChild!.getAttribute('aria-hidden')).toBe('true');
    expect(within(box()).queryByText(`Changed since you looked · ${at}`)).toBeNull();
  });

  it('names the toggle with the full title and the field names: "Changed since you looked" while unseen, "Changed at" once seen', async () => {
    const { props } = await changed();
    const view = render(<ItemDetail {...props} seen={seenState()} />);
    expect(screen.getByRole('button', { name: `Changed since you looked · ${at} · Notes` })).toBe(boxToggle(box()));
    expect(boxToggle(box()).textContent).toBe(`Changed at ${at} · Notes`);
    view.rerender(<ItemDetail {...props} seen={seenState([{ item_id: '1.1', revision: 2 }])} />);
    expect(screen.getByRole('button', { name: `Changed at ${at} · Notes` })).toBe(boxToggle(box()));
    expect(screen.getByRole('button', { name: /^Changed (at|since you looked)/ })).toBe(boxToggle(box()));
  });

  it('opening an unseen box shows "Changed since you looked", and closing it goes back to "Changed at"', async () => {
    const { props } = await changed();
    render(<ItemDetail {...props} seen={seenState()} />);
    fireEvent.click(boxToggle(box()));
    const title = within(box()).getByTitle(`Changed since you looked · ${at}`);
    expect(within(title).getByText(`Changed since you looked · ${at}`)).toBeTruthy();
    fireEvent.click(boxToggle(box()));
    expect(within(title).getByText(`Changed at ${at}`)).toBeTruthy();
    expect(within(box()).queryByText(`Changed since you looked · ${at}`)).toBeNull();
  });

  it('keeps the collapsed head text the same through Mark seen; only the diamond and the tooltip change', async () => {
    const { props } = await changed();
    const view = render(<ItemDetail {...props} seen={seenState()} />);
    expect(boxToggle(box()).textContent).toBe(`Changed at ${at} · Notes`);
    view.rerender(<ItemDetail {...props} seen={seenState([{ item_id: '1.1', revision: 2 }])} />);
    expect(boxToggle(box()).textContent).toBe(`Changed at ${at} · Notes`);
    expect(boxToggle(box()).getAttribute('aria-expanded')).toBe('false');
    const title = within(box()).getByTitle(`Changed at ${at}`);
    expect(title.childElementCount).toBe(1);
    expect(within(box()).queryByTitle(`Changed since you looked · ${at}`)).toBeNull();
  });
});

describe('opening and closing the change box', () => {
  it('shows the rows on a click, hides them on the next, and a keyboard-activated native button works the same', async () => {
    const { props } = await changed();
    render(<ItemDetail {...props} seen={seenState([{ item_id: '1.1', revision: 2 }])} />);
    const toggle = boxToggle(box());
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.getAttribute('type')).toBe('button');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.firstElementChild!.className).toContain('ph-caret-down');
    expect(within(box()).queryByTestId('change-rows')).toBeTruthy();
    const row = within(box()).getByText('Notes').parentElement!;
    expect(row.querySelector('del')?.textContent).toBe('Earlier note.');
    expect(within(box()).getByText('The agent narrowed it.')).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(box()).queryByTestId('change-rows')).toBeNull();
  });

  it('is remembered for the item after Details is mounted again, and another item still opens collapsed', async () => {
    const { props } = await changed(), seen = seenState([{ item_id: '1.1', revision: 2 }, { item_id: '8', revision: 2 }]);
    const first = render(<ItemDetail {...props} seen={seen} />);
    fireEvent.click(boxToggle(box()));
    first.unmount();
    const second = render(<ItemDetail {...props} seen={seen} />);
    expect(boxToggle(box()).getAttribute('aria-expanded')).toBe('true');
    expect(within(box()).queryByTestId('change-rows')).toBeTruthy();
    second.unmount();
    const other = render(<ItemDetail {...props} itemId="8" seen={seen} />);
    expect(boxToggle(box()).getAttribute('aria-expanded')).toBe('false');
    other.unmount();
    render(<ItemDetail {...props} seen={seen} />);
    expect(boxToggle(box()).getAttribute('aria-expanded')).toBe('true');
  });

  it('remembers closing too', async () => {
    const { props } = await changed(), seen = seenState([{ item_id: '1.1', revision: 2 }]);
    const first = render(<ItemDetail {...props} seen={seen} />);
    fireEvent.click(boxToggle(box()));
    fireEvent.click(boxToggle(box()));
    first.unmount();
    render(<ItemDetail {...props} seen={seen} />);
    expect(boxToggle(box()).getAttribute('aria-expanded')).toBe('false');
    expect(within(box()).queryByTestId('change-rows')).toBeNull();
  });

  it('is shared with the larger Conversation view for the same item, both ways', async () => {
    const { props } = await changed(), seen = seenState([{ item_id: '1.1', revision: 2 }]);
    const details = render(<ItemDetail {...props} seen={seen} />);
    fireEvent.click(boxToggle(box()));
    details.unmount();
    const bigger = render(<ConversationView {...props} seen={seen} onClose={vi.fn()} />);
    expect(boxToggle(box()).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(boxToggle(box()));
    bigger.unmount();
    render(<ItemDetail {...props} seen={seen} />);
    expect(boxToggle(box()).getAttribute('aria-expanded')).toBe('false');
  });
});
