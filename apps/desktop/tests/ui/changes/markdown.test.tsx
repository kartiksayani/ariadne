// Alpha.25 C: the change comparisons draw the agent's prose fields as Markdown. Unit tests assert structure (jsdom has no stylesheets);
// the pixels (strike reaching nested items, list numbers, no timeline border, no doubled breaks) are checked in the design suite.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ItemChanges } from '../../../src/ui/changes/ItemChanges';
import { Compare } from '../../../src/ui/changes/Compare';
import { changeRow } from '../../../src/selectors/changes/card';
import { createDesktopService } from '../../../src/data/service';
import { OpenSessions } from '../../../src/data/session-store';
import { AppTransport, route } from '../app/transport';
import { changesFixture } from './fixture';
import { setupChanges, stores } from './harness';

afterEach(() => { cleanup(); stores.splice(0).forEach(store => store.stop()); vi.useRealTimers(); localStorage.clear(); });

const BEFORE = '- **From:** the old team\n- see [old thread](https://example.com/old)';
const AFTER = '- **From:** the new team\n- see [new thread](https://example.com/new)\n\n1. first step\n2. second step';

/** An open item whose note changed from BEFORE to AFTER, with the box's session and store. */
async function mountBox(patch: (value: ReturnType<typeof changesFixture>) => void = () => {}) {
  const value = changesFixture(), item = value.session.items['updated-0']!;
  item.note = AFTER; item.changes![0].before = { note: BEFORE };
  patch(value);
  const transport = new AppTransport(); transport.sessions.set(value.session.id, value.session);
  const service = createDesktopService(transport), opened = new OpenSessions(service);
  const store = opened.open(route); await store.refresh();
  const view = render(<ItemChanges service={service} store={store} session={value.session} item={item} seen={value.seen} onOpenAnswer={vi.fn()} onMarkSeen={vi.fn()} />);
  return { value, item, opened, view, box: screen.getByRole('region', { name: 'What changed' }) };
}
const rowOf = (box: HTMLElement, label: string) => within(within(box).getByText(label).parentElement!).getByTestId('change-row-value');

describe('the Details change box', () => {
  it('draws a changed note as Markdown: a list and a link before (struck) and after, stacked', async () => {
    const { box, opened } = await mountBox();
    const value = rowOf(box, 'Notes');
    expect(value.getAttribute('data-stacked')).toBe('true');
    const before = value.querySelector('del')!, after = value.lastElementChild!;
    expect(before.querySelectorAll('ul > li')).toHaveLength(2);
    expect(before.querySelector('strong')?.textContent).toBe('From:');
    expect(before.querySelector('a')?.textContent).toBe('old thread');
    expect(after.querySelectorAll('ul > li')).toHaveLength(2);
    expect(after.querySelectorAll('ol > li')).toHaveLength(2);
    expect(after.querySelector('a')?.textContent).toBe('new thread');
    // The raw markers never show.
    expect(value.textContent).not.toMatch(/\*\*|\]\(/u);
    // The after sits outside the struck before, and the order is before, arrow, after.
    expect(after.closest('del')).toBeNull();
    expect([...value.children].map(child => child.tagName + (child.getAttribute('aria-hidden') ? ':arrow' : ''))).toEqual(['DEL', 'SPAN:arrow', 'SPAN']);
    opened.closeAll();
  });

  it('labels the note "Notes" for an open item and "Progress" for one in progress', async () => {
    const open = await mountBox();
    expect(within(open.box).getByText('Notes')).toBeTruthy();
    expect(within(open.box).queryByText('Progress')).toBeNull();
    open.opened.closeAll(); cleanup();
    const progress = await mountBox(({ session }) => { session.items['updated-0']!.status = 'in_progress'; });
    expect(within(progress.box).getByText('Progress')).toBeTruthy();
    expect(within(progress.box).queryByText('Notes')).toBeNull();
    progress.opened.closeAll();
  });

  it('keeps a one-line value on its line: a plain span, no stacking, same text', async () => {
    const { box, opened } = await mountBox(({ session, record }) => { session.items['updated-0']!.note = 'Current note.'; session.items['updated-0']!.changes![0] = record({ before: { note: 'Earlier note.' } }); });
    const value = rowOf(box, 'Notes');
    expect(value.hasAttribute('data-stacked')).toBe(false);
    expect(value.querySelector('del')!.firstElementChild!.tagName).toBe('SPAN');
    expect(value.querySelector('del')!.textContent).toBe('Earlier note.');
    expect(value.lastElementChild!.textContent).toBe('Current note.');
    expect(value.querySelector('br, ul, ol, p')).toBeNull();
    opened.closeAll();
  });

  it('keeps a status change exactly as before: plain label text, no Markdown root', async () => {
    const { box, opened } = await mountBox(({ session, record }) => { session.items['updated-0']!.changes![0] = record({ before: { status: 'open' } }); session.items['updated-0']!.status = 'decided'; });
    const value = rowOf(box, 'Status');
    expect(value.querySelector('del')!.children).toHaveLength(0);
    expect(value.hasAttribute('data-stacked')).toBe(false);
    expect(value.querySelector('del')!.textContent).toBe('Open');
    expect(value.lastElementChild!.textContent).toBe('Decided');
    opened.closeAll();
  });

  it('draws a two-line value with one break, not two', async () => {
    const { box, opened } = await mountBox(({ session, record }) => { session.items['updated-0']!.note = 'Line one\nLine two'; session.items['updated-0']!.changes![0] = record({ before: { note: 'Old one\nOld two' } }); });
    const value = rowOf(box, 'Notes');
    expect(value.getAttribute('data-stacked')).toBe('true');
    expect(value.querySelector('del')!.querySelectorAll('br')).toHaveLength(1);
    expect(value.lastElementChild!.querySelectorAll('br')).toHaveLength(1);
    opened.closeAll();
  });

  it('draws "None" plainly when the before value was empty', async () => {
    const { box, opened } = await mountBox(({ session, record }) => { session.items['updated-0']!.changes![0] = record({ before: { note: null } }); });
    const value = rowOf(box, 'Notes');
    expect(value.querySelector('del')!.textContent).toBe('None');
    expect(value.querySelector('del')!.children).toHaveLength(0);
    opened.closeAll();
  });

  it('draws the agent’s reason as Markdown, each reason its own paragraph', async () => {
    const { box, opened } = await mountBox(({ session, record }) => {
      const item = session.items['updated-0']!; item.revision = 3;
      item.changes = [record({ reason: 'Narrowed to **one** team.' }), record({ revision: 3, reason: 'Linked [the thread](https://example.com/t).', before: { note: AFTER } })];
    });
    const reason = rowOf(box, 'Why');
    expect(reason.querySelectorAll('p')).toHaveLength(2);
    expect(reason.querySelector('strong')?.textContent).toBe('one');
    expect(reason.querySelector('a')?.textContent).toBe('the thread');
    opened.closeAll();
  });

  it('keeps the timeline’s own list its only direct <ol>, with the Markdown lists nested below the event text', async () => {
    const { box, opened } = await mountBox(({ session, record, seen }) => {
      const open = session.items['updated-0']!; open.revision = 3; seen.items.push({ item_id: open.id, revision: 1 });
      open.changes = [record({ revision: 1, before: { note: BEFORE }, reason: 'First pass.' }), record({ revision: 3, before: { note: AFTER } })];
      open.note = 'Final note.';
    });
    fireEvent.click(within(box).getByRole('button', { name: 'Older history (1)' }));
    const timeline = await screen.findByTestId('change-timeline');
    fireEvent.click(within(timeline).getByRole('button', { name: 'Before → after' }));
    expect([...timeline.children].filter(child => child.tagName === 'OL')).toHaveLength(1);
    const inner = [...timeline.querySelectorAll('ol ol, ol ul')];
    expect(inner.length).toBeGreaterThan(0);
    for (const list of inner) expect(list.parentElement).not.toBe(timeline);
    opened.closeAll();
  });
});

describe('Compare', () => {
  const row = (note = AFTER, before = BEFORE) => {
    const value = changesFixture(), item = value.session.items['updated-0']!;
    item.note = note; item.changes![0].before = { note: before };
    return { value, row: changeRow(value.session, item, item.changes!) };
  };

  it('opens a labelled Before / After of Markdown: list and link, "Notes" as the field name, before in a <del>', () => {
    const { value, row: changed } = row();
    render(<Compare row={changed} session={value.session} variant="link" />);
    fireEvent.click(screen.getByRole('button', { name: 'Before → after' }));
    const field = within(screen.getByTestId('change-comparison')).getByText('Notes', { selector: 'strong' }).parentElement!;
    const del = field.querySelector('del')!, mark = field.querySelector('mark')!;
    expect(del.querySelectorAll('ul > li')).toHaveLength(2);
    expect(del.querySelector('a')?.textContent).toBe('old thread');
    expect(mark.querySelectorAll('ol > li')).toHaveLength(2);
    expect(mark.querySelector('a')?.textContent).toBe('new thread');
    expect(field.textContent).not.toMatch(/\*\*|\]\(/u);
  });

  it('keeps a one-line value a span inside its <del>, and a two-line value one break', () => {
    const one = row('Now.', 'Was.');
    const view = render(<Compare row={one.row} session={one.value.session} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show before and after' }));
    expect(screen.getByTestId('change-comparison').querySelector('del')!.firstElementChild!.tagName).toBe('SPAN');
    expect(screen.getByTestId('change-comparison').querySelector('del')!.textContent).toBe('Was.');
    view.unmount();
    const two = row('One\nTwo', 'Old one\nOld two');
    render(<Compare row={two.row} session={two.value.session} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show before and after' }));
    expect(screen.getByTestId('change-comparison').querySelector('del')!.querySelectorAll('br')).toHaveLength(1);
    expect(screen.getByTestId('change-comparison').querySelector('mark')!.querySelectorAll('br')).toHaveLength(1);
  });

  it('draws the item’s why as Markdown when no why change is shown', () => {
    const { value, row: changed } = row();
    render(<Compare row={changed} session={value.session} why={'Because **evidence** in [the log](https://example.com/log).'} variant="link" />);
    fireEvent.click(screen.getByRole('button', { name: 'Before → after' }));
    const why = within(screen.getByTestId('change-comparison')).getByText('Why', { selector: 'strong' }).parentElement!;
    expect(within(why).getByText('evidence').tagName).toBe('STRONG');
    expect(why.querySelector('a')?.textContent).toBe('the log');
  });

  it('keeps links, refs and status as plain text', () => {
    const value = changesFixture(), item = value.session.items['updated-0']!;
    item.changes![0].before = { status: 'open' };
    render(<Compare row={changeRow(value.session, item, item.changes!)} session={value.session} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show before and after' }));
    expect(screen.getByTestId('change-comparison').querySelector('del')!.children).toHaveLength(0);
    expect(screen.getByTestId('change-comparison').querySelector('del')!.textContent).toBe('Open');
  });
});

describe('the changes popover', () => {
  it('draws a changed note’s before and after as Markdown inside its row, the before in a <del> (the stylesheet leaves it unstruck there)', async () => {
    const value = await setupChanges(1, 0, 0);
    const item = value.session.items['updated-0']!;
    item.note = AFTER; item.changes![0].before = { note: BEFORE };
    value.rerender(value.element());
    fireEvent.click(screen.getByRole('button', { name: /changed/ }));
    const row = within(screen.getByRole('dialog', { name: 'What changed' })).getAllByTestId('changes-row')[0]!;
    fireEvent.click(within(row).getByRole('button', { name: 'Before → after' }));
    const del = row.querySelector('del')!, mark = row.querySelector('mark')!;
    expect(row.contains(del)).toBe(true);
    expect(del.querySelectorAll('ul > li')).toHaveLength(2);
    expect(del.querySelector('a')?.textContent).toBe('old thread');
    expect(mark.querySelectorAll('ol > li')).toHaveLength(2);
    expect(mark.querySelector('a')?.textContent).toBe('new thread');
    expect(within(row).getByText('Notes', { selector: 'strong' })).toBeTruthy();
  });
});
