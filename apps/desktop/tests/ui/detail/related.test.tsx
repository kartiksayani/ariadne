import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { immutable } from '../../../src/data';
import { connectedItems, relatedItems } from '../../../src/selectors/related';
import { ItemDetail } from '../../../src/ui/detail/ItemDetail';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { setup } from '../history/fixtures';

const opened: ReturnType<typeof setup>[] = [];
afterEach(() => { cleanup(); opened.splice(0).forEach(value => value.sessions.closeAll()); vi.restoreAllMocks(); });

describe('related item navigation', () => {
  it('combines declarations and backlinks once, skips stale and self targets, and refreshes with a new snapshot', () => {
    const value = setup(); opened.push(value);
    const session = value.transport.session;
    session.items['1']!.related = ['2', '2', 'missing', '1'];
    session.items['2']!.related = ['1'];
    session.items['8']!.related = ['1'];
    const first = immutable(session);
    expect(relatedItems(first, '1').map(item => item.id)).toEqual(['2', '8']);
    expect(relatedItems(first, '1')).toBe(relatedItems(first, '1'));
    expect(relatedItems(first, '8').map(item => item.id)).toEqual(['1']);
    expect(relatedItems(first, 'missing')).toEqual([]);
    expect(first.items['1']!.related).toEqual(['2', '2', 'missing', '1']);
    session.items['1']!.related = [];
    session.items['2']!.related = [];
    expect(relatedItems(immutable(session), '1').map(item => item.id)).toEqual(['8']);
    expect(relatedItems(first, '1').map(item => item.id)).toEqual(['2', '8']);
  });

  it.each([
    { field: 'affects', reverse: 'affected_by' },
    { field: 'depends_on', reverse: 'needed_by' },
  ] as const)('keeps $field and $reverse distinct, omits invalid or removed targets, and refreshes the cache', ({ field, reverse }) => {
    const value = setup(); opened.push(value);
    const session = value.transport.session;
    session.items['1']![field] = ['2', '2', 'missing', '1', '1.1'];
    session.items['8']![field] = ['1'];
    session.items['1.1']!.removed_at = session.updated_at;
    const first = immutable(session);
    expect(relatedItems(first, '1', field).map(item => item.id)).toEqual(['2']);
    expect(relatedItems(first, '1', reverse).map(item => item.id)).toEqual(['8']);
    expect(relatedItems(first, '2', reverse).map(item => item.id)).toEqual(['1']);
    expect(relatedItems(first, '8', field).map(item => item.id)).toEqual(['1']);
    expect(relatedItems(first, '1')).toEqual([]);
    expect(relatedItems(first, '1.1', reverse)).toEqual([]);
    expect(relatedItems(first, 'missing', field)).toEqual([]);
    expect(relatedItems(first, '1', field)).toBe(relatedItems(first, '1', field));
    expect(connectedItems(first, '1').map(item => item.id)).toEqual(['2', '8']);
    expect(connectedItems(first, '1')).toBe(connectedItems(first, '1'));
    session.items['1']![field] = [];
    session.items['8']!.removed_at = session.updated_at;
    const next = immutable(session);
    expect(relatedItems(next, '1', field)).toEqual([]);
    expect(relatedItems(next, '1', reverse)).toEqual([]);
    expect(connectedItems(next, '1')).toEqual([]);
    expect(relatedItems(first, '1', field).map(item => item.id)).toEqual(['2']);
    expect(first.items['1']![field]).toEqual(['2', '2', 'missing', '1', '1.1']);
  });

  it('shows item numbers, short labels, display status and inherited hiding, and opens every target', async () => {
    const value = setup(); opened.push(value);
    const session = value.transport.session;
    session.items['1']!.related = ['2', '2', 'missing'];
    session.items['2']!.short = 'Delivery window';
    const pending = Object.values(session.inputs).find(input => input?.target.item_id === '2')!;
    pending.state = 'queued'; pending.payload.target_snapshot.question_revision = session.items['2']!.question_revision;
    session.items['1.1']!.related = ['1'];
    session.items['8']!.related = ['1'];
    await value.store.refresh();
    const open = vi.fn();
    render(<ItemDetail drafts={new OwnerDraftStore(value.service)} store={value.store} itemId="1" later={false} onOpenItem={open} hiddenItemIds={['1']} />);
    const related = screen.getByRole('region', { name: 'Related items' });
    expect(within(related).getAllByRole('button')).toHaveLength(3);
    const window = within(related).getByRole('button', { name: /#2 Delivery window/ });
    expect(window.textContent).toContain('Waiting on agent');
    const child = within(related).getByRole('button', { name: /#1\.1.*\(hidden\)/ });
    expect(child.textContent).toContain('Hidden');
    expect(child.classList.contains('is-hidden')).toBe(true);
    expect(window.classList.contains('is-hidden')).toBe(false);
    fireEvent.click(child); fireEvent.click(window);
    fireEvent.click(within(related).getByRole('button', { name: /#8/ }));
    expect(open.mock.calls).toEqual([['1.1'], ['2'], ['8']]);
    expect(related.compareDocumentPosition(screen.getByRole('region', { name: 'Conversation' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([
    { field: 'affects', heading: 'Affects', incoming: false },
    { field: 'affects', heading: 'Affected by', incoming: true },
    { field: 'depends_on', heading: 'Depends on', incoming: false },
    { field: 'depends_on', heading: 'Needed by', incoming: true },
  ] as const)('shows $heading beside related with the same hidden row and opening behavior', async ({ field, heading, incoming }) => {
    const value = setup(); opened.push(value);
    const session = value.transport.session;
    session.items[incoming ? '1.1' : '1']![field] = [incoming ? '1' : '1.1'];
    session.items['1']!.related = ['2'];
    session.items['1.1']!.short = 'Receipt test';
    await value.store.refresh();
    const open = vi.fn();
    render(<ItemDetail drafts={new OwnerDraftStore(value.service)} store={value.store} itemId="1" later={false} onOpenItem={open} hiddenItemIds={['1']} />);
    const section = screen.getByRole('region', { name: heading });
    expect(within(section).getByText(heading)).toBeTruthy();
    const target = within(section).getByRole('button', { name: /#1\.1 Receipt test \(hidden\)/ });
    expect(target.title).toBe(session.items['1.1']!.question);
    expect(target.classList.contains('detail-related-item')).toBe(true);
    expect(target.classList.contains('is-hidden')).toBe(true);
    expect(within(target).getByText('Hidden')).toBeTruthy();
    const related = screen.getByRole('region', { name: 'Related items' });
    expect(within(related).getAllByRole('button')).toHaveLength(1);
    expect(within(related).getByRole('button', { name: /#2/ }).classList.contains('is-hidden')).toBe(false);
    for (const label of ['Affects', 'Affected by', 'Depends on', 'Needed by']) {
      if (label !== heading) expect(screen.queryByRole('region', { name: label })).toBeNull();
    }
    fireEvent.click(target);
    expect(open.mock.calls).toEqual([['1.1']]);
    expect(section.compareDocumentPosition(screen.getByRole('region', { name: 'Conversation' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('omits the section for older items without any connections', async () => {
    const value = setup(); opened.push(value); await value.store.refresh();
    render(<ItemDetail drafts={new OwnerDraftStore(value.service)} store={value.store} itemId="1" later={false} onOpenItem={vi.fn()} />);
    for (const label of ['Related items', 'Affects', 'Affected by', 'Depends on', 'Needed by']) {
      expect(screen.queryByRole('region', { name: label })).toBeNull();
    }
  });
});
