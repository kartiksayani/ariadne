import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { immutable } from '../../../src/data';
import { relatedItems } from '../../../src/selectors/related';
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

  it('omits the section for older items without any connections', async () => {
    const value = setup(); opened.push(value); await value.store.refresh();
    render(<ItemDetail drafts={new OwnerDraftStore(value.service)} store={value.store} itemId="1" later={false} onOpenItem={vi.fn()} />);
    expect(screen.queryByRole('region', { name: 'Related items' })).toBeNull();
  });
});
