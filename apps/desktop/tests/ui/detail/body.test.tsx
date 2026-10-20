// The body of Details (alpha.21 §6 W3): the badge row's marker, the change box's Mark seen, the actions row, the Because card
// shown once, and opening scrolled to the "New since you last looked" divider. Typed-text rows live in the chat and composer suites.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { SessionSeen } from '../../../src/generated/core';
import type { ItemChangeRecord } from '../../../src/generated/domain/models';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { ActionsRow } from '../../../src/ui/detail/ActionsRow';
import { ackTargetText, ackTitle } from '../../../src/ui/shared/ack';
import { ItemDetail } from '../../../src/ui/detail/ItemDetail';
import type { ItemActionView } from '../../../src/ui/detail/itemActions';
import { clockTime } from '../../../src/ui/changes/clock';
import { route } from '../app/transport';
import { setup } from '../history/fixtures';

const opened: Pick<ReturnType<typeof setup>, 'sessions'>[] = [];
afterEach(() => { cleanup(); opened.splice(0).forEach(value => value.sessions.closeAll()); vi.restoreAllMocks(); });

const SINCE = '2026-10-01T00:00:00.000Z', CHANGED_AT = '2026-10-04T09:30:00.000Z';
const seenState = (items: SessionSeen['items'] = []): SessionSeen => ({ session: route, since: SINCE, items, topics: [] });

/** Item 1.1 (open) changed after the seen baseline: Changed, with a change box. */
async function changed() {
  const value = setup(); opened.push(value);
  const session = value.transport.session, item = session.items['1.1']!;
  item.revision = 2; item.created_at = '2026-09-30T00:00:00.000Z';
  const record: ItemChangeRecord = { revision: 2, at: CHANGED_AT, cause_message_id: item.created_message_id, reason: 'The agent narrowed it.', before: { note: 'Earlier note.' } };
  item.changes = [record];
  await value.store.refresh();
  const props = { drafts: new OwnerDraftStore(value.service), store: value.store, itemId: '1.1', later: false, onOpenItem: vi.fn() };
  return { value, item, props };
}

describe('the badge row and Mark seen', () => {
  it('shows Changed beside the status and the unseen head, then Seen and "Changed at" once it is read, with the box kept', async () => {
    const { item, props } = await changed(), onMarkSeen = vi.fn();
    const view = render(<ItemDetail {...props} seen={seenState()} onMarkSeen={onMarkSeen} />);
    const head = document.querySelector<HTMLElement>('.detail-head')!;
    expect(within(head).getByRole('img', { name: 'Changed' })).toBeTruthy();
    const box = screen.getByRole('region', { name: 'What changed' });
    expect(within(box).getByText(`Changed since you looked · ${clockTime(CHANGED_AT)}`)).toBeTruthy();
    // The title keeps one line and shortens with "…" when narrow, so its full words ride in its tooltip.
    expect(within(box).getByTitle(`Changed since you looked · ${clockTime(CHANGED_AT)}`)).toBeTruthy();
    fireEvent.click(within(box).getByRole('button', { name: 'Mark seen' }));
    expect(onMarkSeen).toHaveBeenCalledExactlyOnceWith('1.1', item.revision);
    // The dwell or Mark seen advances `seen`: only the head text and the pill change.
    const rows = box.querySelector('.change-rows')!.textContent;
    view.rerender(<ItemDetail {...props} seen={seenState([{ item_id: '1.1', revision: 2 }])} onMarkSeen={onMarkSeen} />);
    const seenPill = within(head).getByRole('img', { name: 'Seen' });
    expect(seenPill.getAttribute('title')).toBe('Marked seen after a second in Details');
    expect(within(head).queryByRole('img', { name: 'Changed' })).toBeNull();
    const kept = screen.getByRole('region', { name: 'What changed' });
    expect(within(kept).getByText(`Changed at ${clockTime(CHANGED_AT)}`)).toBeTruthy();
    expect(within(kept).queryByRole('button', { name: 'Mark seen' })).toBeNull();
    expect(kept.querySelector('.change-rows')!.textContent).toBe(rows);
  });

  it('shows New for an item made after the baseline, and no marker for an item the owner has already seen', async () => {
    const { value, props } = await changed();
    const session = value.transport.session;
    session.items['8']!.created_at = '2026-10-05T00:00:00.000Z'; session.items['8']!.changes = [];
    await value.store.refresh();
    const view = render(<ItemDetail {...props} itemId="8" seen={seenState()} />);
    expect(within(document.querySelector<HTMLElement>('.detail-head')!).getByRole('img', { name: 'New' })).toBeTruthy();
    view.unmount();
    render(<ItemDetail {...props} itemId="1.1" seen={seenState([{ item_id: '1.1', revision: 2 }])} />);
    expect(document.querySelector('.detail-head [data-testid="change-marker"]')).toBeNull();
  });
});

describe('the actions row', () => {
  it('puts Bring it up first on an open item with Reply, Later, Drop, Hide and Remove beside it, and runs Hide and Remove', async () => {
    const { props } = await changed(), onHide = vi.fn(), onRemove = vi.fn();
    render(<ItemDetail {...props} onHide={onHide} onRemove={onRemove} />);
    const row = screen.getByRole('group', { name: 'Item actions' });
    expect(row.closest('.detail-dock')).toBeNull();
    expect(within(row).getAllByRole('button').map(button => button.getAttribute('aria-label') ?? button.textContent)).toEqual(['Bring it up', 'Reply', 'Later', 'Drop', 'Hide', 'Remove']);
    expect(within(row).getByRole('button', { name: 'Bring it up' }).className).toContain('btn-primary');
    fireEvent.click(within(row).getByRole('button', { name: 'Hide' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Remove' }));
    expect(onHide).toHaveBeenCalledOnce(); expect(onRemove).toHaveBeenCalledOnce();
  });

  it('reads Unhide for a hidden item and leaves Hide and Remove out when the host gives no handler', async () => {
    const { props } = await changed();
    const view = render(<ItemDetail {...props} hiddenItemIds={['1.1']} onHide={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Unhide' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    view.rerender(<ItemDetail {...props} />);
    expect(screen.queryByRole('button', { name: /Hide|Unhide/ })).toBeNull();
  });

  it('hands the list upward once while nothing changes, with Copy reference in it, and null when Details closes', async () => {
    const { props } = await changed(), onActions = vi.fn<(list: readonly ItemActionView[] | null) => void>();
    const view = render(<ItemDetail {...props} onActions={onActions} onHide={vi.fn()} onRemove={vi.fn()} />);
    const lists = () => onActions.mock.calls.map(call => call[0]).filter((list): list is readonly ItemActionView[] => list !== null);
    expect(lists().length).toBeGreaterThan(0);
    expect(lists().at(-1)!.map(action => action.id)).toEqual(['followUp', 'bring', 'reopen', 'later', 'drop', 'hide', 'remove', 'copyRef']);
    const before = lists().length;
    view.rerender(<ItemDetail {...props} onActions={onActions} onHide={vi.fn()} onRemove={vi.fn()} />);
    expect(lists().length).toBe(before);
    view.unmount();
    expect(onActions).toHaveBeenLastCalledWith(null);
  });
});

describe('the Ack button in the actions row', () => {
  const ack = (disabled: boolean) => ({ title: 'Ack → Done', held: false, disabled, onAck: vi.fn(), onUndo: vi.fn() });
  it.each([
    ['ready', false, 'Ack → Done'],
    ['greyed while a change is being saved', true, 'A change is being saved'],
  ] as const)('%s: its tooltip is %s, and its name stays "Ack → Done"', (_name, disabled, title) => {
    render(<ActionsRow actions={[]} ack={ack(disabled)} statusLabel="Open" />);
    const button = screen.getByRole('button', { name: 'Ack → Done' });
    expect(button.getAttribute('title')).toBe(title);
    expect((button as HTMLButtonElement).disabled).toBe(disabled);
  });
});

// owner 2026-10-20: visible Ack target. Details names where an Ack takes the item on the button itself.
describe('the Ack button names its target', () => {
  it.each([
    ['open', 'done', 'Done'], ['open', 'decided', 'Decided'], ['open', 'dropped', 'Dropped'], ['open', 'in_progress', 'In progress'],
    ['in_progress', 'open', 'Open'], ['open', 'open', 'keeps it open'], ['in_progress', 'in_progress', 'keeps it in progress'],
  ] as const)('a %s item acked to %s reads "✓ Ack → %s"', (status, target, text) => {
    expect(ackTargetText(target, status)).toBe(text);
    expect(ackTitle(target, status)).toBe(`Ack → ${text}`);
    render(<ActionsRow actions={[]} ack={{ title: ackTitle(target, status), held: false, disabled: false, onAck: vi.fn(), onUndo: vi.fn() }} statusLabel="Open" />);
    const button = screen.getByRole('button', { name: `Ack → ${text}` });
    expect(button.textContent).toBe(`Ack → ${text}`);
    expect(button.querySelector('i.ph-check')).not.toBeNull();
  });
  it('keeps the held state and a greyed reason as before', () => {
    const props = { title: 'Ack → Done', disabled: false, onAck: vi.fn(), onUndo: vi.fn() };
    const view = render(<ActionsRow actions={[]} ack={{ ...props, held: true }} statusLabel="Open" />);
    expect(screen.getByRole('button', { name: 'Undo Ack' }).textContent).toBe('Acked · Undo');
    view.rerender(<ActionsRow actions={[]} ack={{ ...props, held: false, disabled: true }} statusLabel="Open" />);
    const grey = screen.getByRole('button', { name: 'Ack → Done' }) as HTMLButtonElement;
    expect(grey.title).toBe('A change is being saved');
    expect(grey.disabled).toBe(true);
  });
});

describe('the Because card', () => {
  it('shows under the newest answer that changed something, once', async () => {
    const value = setup(); opened.push(value);
    const session = value.transport.session, answers = session.answers;
    const messages = session.messages;
    // Two answers on item 1, each behind a batch of changes (an activity message tied to the answer's input).
    messages.find(message => message.id.endsWith('0101'))!.input_id = answers[0]!.input_id;
    messages.find(message => message.id.endsWith('0114'))!.input_id = answers[1]!.input_id;
    const stamp = (cause: string): ItemChangeRecord => ({ revision: 2, at: CHANGED_AT, cause_message_id: messages.find(message => message.id.endsWith(cause))!.id, reason: `Changed by ${cause}.`, before: { note: 'Earlier.' } });
    session.items['1.1']!.revision = 2; session.items['1.1']!.changes = [stamp('0101')];
    session.items['4']!.revision = 2; session.items['4']!.changes = [stamp('0114')];
    await value.store.refresh();
    render(<ItemDetail drafts={new OwnerDraftStore(value.service)} store={value.store} itemId="1" later={false} onOpenItem={vi.fn()} />);
    const cards = await screen.findAllByTestId('because-card');
    expect(cards).toHaveLength(1);
    const newest = answers[1]!.message_id;
    expect(cards[0]!.closest('[data-message-id]')?.getAttribute('data-message-id')).toBe(newest);
  });
});

describe('opening at the divider', () => {
  it('scrolls the body once to 140px above "New since you last looked", and leaves a reader in place after that', async () => {
    const value = setup(); opened.push(value);
    await value.store.refresh();
    const session = value.transport.session, dividerId = session.messages.find(message => message.item_id === '1' && message.kind === 'reply')!.id;
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(3000);
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(500);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return { top: this.classList.contains('conversation-unseen') ? 1000 : 100, bottom: 0, height: 0, width: 400 } as DOMRect;
    });
    const props = { drafts: new OwnerDraftStore(value.service), store: value.store, itemId: '1', later: false, onOpenItem: vi.fn(), dividerId };
    const view = render(<ItemDetail {...props} />);
    const pane = await act(async () => document.querySelector<HTMLElement>('.detail-body')!);
    expect(await screen.findByText('New since you last looked')).toBeTruthy();
    // divider.top (1000) - pane.top (100) - 140
    await vi.waitFor(() => expect(pane.scrollTop).toBe(760));
    pane.scrollTop = 40; fireEvent.scroll(pane);
    view.rerender(<ItemDetail {...props} seen={seenState([{ item_id: '1', revision: 9 }])} />);
    expect(pane.scrollTop).toBe(40);
  });
});
