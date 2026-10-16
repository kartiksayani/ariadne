import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { immutable } from '../../../src/data';
import { connectedItems, relatedItems } from '../../../src/selectors/related';
import { DetailPath, ItemDetail } from '../../../src/ui/detail/ItemDetail';
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

  it('shows short labels without item numbers, display status and inherited hiding, and opens every target', async () => {
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
    const window = within(related).getByRole('button', { name: `${session.items['2']!.question} · Queued` });
    expect(window.textContent).toContain('Queued');
    const child = within(related).getByRole('button', { name: `${session.items['1.1']!.question} (hidden) · Open` });
    expect(child.textContent).toContain('Hidden');
    expect(child.classList.contains('is-hidden')).toBe(true);
    expect(window.classList.contains('is-hidden')).toBe(false);
    fireEvent.click(child); fireEvent.click(window);
    fireEvent.click(within(related).getByRole('button', { name: `${session.items['8']!.question} · Open` }));
    expect(related.textContent).not.toMatch(/#(?:1\.1|2|8)\b/);
    expect(screen.getByRole('article').getAttribute('aria-label')).toBe(`Detail of ${session.items['1']!.question}`);
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
    const target = within(section).getByRole('button', { name: `${session.items['1.1']!.question} (hidden) · Open` });
    expect(target.title).toBe(session.items['1.1']!.question);
    expect(target.classList.contains('detail-related-item')).toBe(true);
    expect(target.classList.contains('is-hidden')).toBe(true);
    expect(within(target).getByText('Hidden')).toBeTruthy();
    const related = screen.getByRole('region', { name: 'Related items' });
    expect(within(related).getAllByRole('button')).toHaveLength(1);
    expect(within(related).getByRole('button', { name: `${session.items['2']!.question} · Waiting on me` }).classList.contains('is-hidden')).toBe(false);
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

  it('puts distinguishing words first across connection sections and keeps full question accessible names', async () => {
    const value = setup(); opened.push(value);
    const session = value.transport.session;
    session.items['1']!.short = 'Source item';
    session.items['1']!.related = ['8'];
    session.items['1']!.affects = ['1.1'];
    const first = session.items['8']!, second = session.items['1.1']!;
    first.topic_id = second.topic_id;
    first.short = second.short = 'Receipt lookup';
    first.question = 'Keep the receipt lookup in the delivery handler?';
    second.question = 'Keep the receipt lookup in the retry handler?';
    await value.store.refresh();
    const open = vi.fn();
    render(<ItemDetail drafts={new OwnerDraftStore(value.service)} store={value.store} itemId="1" later={false} onOpenItem={open} />);
    expect(screen.getByRole('article', { name: `Detail of ${session.items['1']!.question}` })).toBeTruthy();
    for (const [target, visible] of [[first, 'delivery · Receipt lookup'], [second, 'retry · Receipt lookup']] as const) {
      const button = screen.getByRole('button', { name: `${target.question} · Open` });
      expect(button.querySelector('.detail-related-label')!.textContent).toBe(visible);
      expect(button.title).toBe(target.question);
      fireEvent.click(button);
    }
    expect(open.mock.calls).toEqual([['8'], ['1.1']]);
  });

  it('shows the replacement name chip and keeps the full question as its accessible name and tooltip', async () => {
    const value = setup(); opened.push(value);
    const session = value.transport.session;
    session.items['1']!.status = 'replaced'; session.items['1']!.replaced_by = '8';
    session.items['8']!.short = 'New delivery';
    await value.store.refresh();
    const open = vi.fn();
    render(<ItemDetail drafts={new OwnerDraftStore(value.service)} store={value.store} itemId="1" later={false} onOpenItem={open} />);
    const button = screen.getByRole('button', { name: session.items['8']!.question });
    expect(button.classList.contains('detail-replaced')).toBe(true);
    expect(button.textContent).toContain('New delivery');
    expect(button.classList.contains('name-chip')).toBe(true);
    expect(button.title).toBe(session.items['8']!.question);
    fireEvent.click(button); expect(open).toHaveBeenCalledWith('8');
  });

  it('distinguishes ancestor breadcrumb labels while naming their full questions', async () => {
    const value = setup(); opened.push(value);
    const session = value.transport.session, first = session.items['1']!, second = session.items['1.1']!, child = session.items['2']!;
    child.parent = second.id; child.topic_id = first.topic_id;
    first.short = second.short = 'Cache lookup';
    first.question = 'Use Redis for cache lookup?'; second.question = 'Use Postgres for cache lookup?';
    await value.store.refresh();
    const open = vi.fn();
    render(<DetailPath store={value.store} itemId={child.id} onOpenItem={open} />);
    for (const [target, visible] of [[first, 'Redis · Cache lookup'], [second, 'Postgres · Cache lookup']] as const) {
      const button = screen.getByRole('button', { name: target.question });
      expect(button.textContent).toBe(visible); expect(button.title).toBe(target.question);
      fireEvent.click(button);
    }
    expect(open.mock.calls).toEqual([[first.id], [second.id]]);
  });

  it('keeps authored item-reference text and exposes the full target question in its tooltip', async () => {
    const value = setup(); opened.push(value);
    const session = value.transport.session;
    session.items['1']!.question = 'Read [receipt follow-up](item:1.1).';
    session.items['1.1']!.short = 'Receipt test';
    await value.store.refresh();
    render(<ItemDetail drafts={new OwnerDraftStore(value.service)} store={value.store} itemId="1" later={false} onOpenItem={vi.fn()} />);
    const link = screen.getByRole('link', { name: 'receipt follow-up' });
    expect(link.title).toBe(`${session.items['1.1']!.question} · Open`);
    expect(link.textContent).toBe('receipt follow-up');
  });

  it('disambiguates breadcrumb names against items outside the ancestor path', async () => {
    const value = setup(); opened.push(value);
    const session = value.transport.session, ancestor = session.items['1']!, elsewhere = session.items['8']!;
    ancestor.short = elsewhere.short = 'Cache lookup'; elsewhere.topic_id = ancestor.topic_id;
    ancestor.question = 'Use Redis for cache lookup?'; elsewhere.question = 'Use Postgres for cache lookup?';
    await value.store.refresh();
    render(<DetailPath store={value.store} itemId="1.1" onOpenItem={vi.fn()} />);
    expect(screen.getByRole('button', { name: ancestor.question }).textContent).toBe('Redis · Cache lookup');
    expect(screen.queryByRole('button', { name: elsewhere.question })).toBeNull();
  });
});
