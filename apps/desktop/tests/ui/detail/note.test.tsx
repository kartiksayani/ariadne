// Alpha.25 A: the item's `note` is its body. Details shows it for every status ("Notes" section; the blue progress row while In
// progress) and the answer dock draws it as Markdown. jsdom has no stylesheets: these tests assert structure.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import demo from '../../../../../fixtures/domain/demo/session.json';
import type { Item, ItemStatus, Session } from '../../../src/generated/domain/models';
import { immutable } from '../../../src/data';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { ItemDetail } from '../../../src/ui/detail/ItemDetail';
import { detailModel } from '../../../src/ui/detail/model';
import { notices } from '../../../src/ui/pages/notices';
import { AppTransport, route } from '../app/transport';
import { setup } from '../history/fixtures';

const opened: Pick<ReturnType<typeof setup>, 'sessions'>[] = [];
afterEach(() => { cleanup(); opened.splice(0).forEach(value => value.sessions.closeAll()); notices.clear(); localStorage.clear(); vi.restoreAllMocks(); });

const NOTE = '- **From:** the support queue\n- details in [the ticket](https://example.com/ticket/7)\n\nSecond paragraph.';
const modelOf = (patch: Partial<Item>, itemId = '1.1') => {
  const session = structuredClone(demo) as Session;
  Object.assign(session.items[itemId]!, patch);
  return detailModel({ session: immutable(session), itemId, now: Date.parse(session.updated_at), mode: null, later: false, saving: null })!;
};

describe('the Details model: where the note is drawn', () => {
  it('draws the progress row for an item in progress', () => {
    expect(modelOf({ status: 'in_progress', note: 'Reading the log.' }).note).toEqual({ text: 'Reading the log.', progress: true });
  });
  it.each(['open', 'waiting_on_me', 'decided', 'done', 'dropped', 'replaced'] as ItemStatus[])('draws the Notes section for %s', status => {
    expect(modelOf({ status, note: NOTE }).note).toEqual({ text: NOTE, progress: false });
  });
  it.each([null, '', '   \n  '])('draws nothing for an empty or whitespace note (%j)', note => {
    expect(modelOf({ status: 'open', note }).note).toBeNull();
    expect(modelOf({ status: 'in_progress', note }).note).toBeNull();
  });
});

async function detail(patch: Partial<Item>) {
  const value = setup(); opened.push(value);
  Object.assign(value.transport.session.items['1.1']!, patch);
  await value.store.refresh();
  return render(<ItemDetail drafts={new OwnerDraftStore(value.service)} store={value.store} itemId="1.1" later={false} onOpenItem={vi.fn()} />);
}

describe('Details', () => {
  it('renders an open item’s note as a Notes section: a list, bold and a link, directly above Why', async () => {
    await detail({ status: 'open', note: NOTE, why: 'The ticket is the evidence.' });
    const notes = screen.getByRole('region', { name: 'Notes' });
    expect(within(notes).getByText('Notes').tagName).toBe('DIV');
    expect(within(notes).getAllByRole('listitem')).toHaveLength(2);
    expect(within(notes).getByText('From:').tagName).toBe('STRONG');
    expect(within(notes).getByRole('link', { name: 'the ticket' })).toBeTruthy();
    expect(notes.textContent).not.toMatch(/\*\*|\]\(/u);
    // The text is a block under a block label, never Why's inline label or Why's selectors.
    const text = within(notes).getByText('Second paragraph.').parentElement!;
    expect(text.tagName).toBe('DIV');
    expect(text.classList.contains('detail-why-text')).toBe(false);
    expect(notes.classList.contains('detail-why')).toBe(false);
    const why = screen.getByText('Why').parentElement!;
    expect(notes.nextElementSibling).toBe(why);
    expect(screen.queryByTestId('detail-note')).toBeNull();
  });

  it('keeps the blue robot line for an item in progress, with no Notes section', async () => {
    await detail({ status: 'in_progress', note: 'Reading the log.' });
    const line = screen.getByTestId('detail-note');
    expect(line.querySelector('i')).not.toBeNull();
    expect(line.textContent).toBe('Reading the log.');
    expect(screen.queryByRole('region', { name: 'Notes' })).toBeNull();
  });

  it('draws no note section for an empty note', async () => {
    await detail({ status: 'open', note: '  ' });
    expect(screen.queryByRole('region', { name: 'Notes' })).toBeNull();
    expect(screen.queryByTestId('detail-note')).toBeNull();
  });

  it('puts Notes between a shown outcome and Why', async () => {
    await detail({ status: 'open', note: 'Some body.', outcome: 'Pending the decision.', why: 'Because.' });
    const notes = screen.getByRole('region', { name: 'Notes' });
    expect(screen.getByRole('region', { name: 'Current outcome' }).nextElementSibling).toBe(notes);
    expect(notes.nextElementSibling).toBe(screen.getByText('Why').parentElement);
  });
});

describe('the answer dock', () => {
  it('renders a waiting item’s note as Markdown: a list, bold and a link', async () => {
    const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
    Object.assign(session.items['2']!, { note: NOTE });
    transport.preferences.global.selected_navigation = { kind: 'session', session: route };
    Object.assign(transport.preferences.sessions[0]!, { tab_open: true });
    render(<DesktopApp service={createDesktopService(transport)} />);
    const tree = await screen.findByRole('tree', { name: 'Session items' });
    await waitFor(() => expect(tree.getAttribute('aria-busy')).toBe('false'));
    const dock = await screen.findByRole('region', { name: 'Answer dock' });
    if (!within(dock).queryByRole('button', { name: 'Fold the dock' })) fireEvent.click(await within(dock).findByRole('button', { name: /waiting$/ }));
    const link = await within(dock).findByRole('link', { name: 'the ticket' });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    const body = within(dock).getByText('Second paragraph.').parentElement!;
    expect(body.classList.contains('dock-question-body')).toBe(true);
    expect(within(body).getAllByRole('listitem')).toHaveLength(2);
    expect(within(body).getByText('From:').tagName).toBe('STRONG');
    expect(body.contains(link)).toBe(true);
    expect(body.textContent).not.toMatch(/\*\*|\]\(/u);
  });
});
