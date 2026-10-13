import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { AppTransport, route, secondId } from '../app/transport';
import { sessionButton } from '../app/open';

afterEach(cleanup);
async function openFirst() {
  fireEvent.click(await sessionButton(route));
  await waitFor(() => expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready'));
}

describe('peek desktop composition', { timeout: 10_000 }, () => {
  it('previews a historical fork with its full title while its chip keeps the disambiguated name before Go to selects it', async () => {
    const transport = new AppTransport(), source = transport.sessions.get(route.session_id)!;
    const fork = source.items['1.1']!, elsewhere = source.items['8']!;
    fork.short = elsewhere.short = 'Cache lookup'; elsewhere.topic_id = fork.topic_id;
    fork.question = 'Use Redis for cache lookup?'; elsewhere.question = 'Use Postgres for cache lookup?';
    expect(source.rounds[fork.source_round_id!]!.closed_at).not.toBeNull();
    render(<DesktopApp service={createDesktopService(transport)} />); await openFirst();
    fireEvent.click(document.querySelector('[role="treeitem"][data-item-id="1"]')!);
    const detail = await screen.findByRole('article', { name: `Detail of ${source.items['1']!.question}` });
    const chat = within(detail).getByRole('region', { name: 'Conversation' });
    const chip = await within(chat).findByRole('button', { name: 'Branched into Redis · Cache lookup · Open' });
    expect(chip.textContent).toContain('Branched into Redis · Cache lookup');
    expect(chip.textContent).not.toContain(fork.question);
    expect(chip.title).toBe(fork.question); expect(chip.classList.contains('name-chip')).toBe(true);
    fireEvent.click(chip);
    const peek = await screen.findByRole('dialog', { name: `Peek: ${fork.question}` });
    expect(within(peek).getByRole('heading', { level: 2 }).textContent).toBe(fork.question);
    expect(within(peek).queryByText('Redis · Cache lookup')).toBeNull();
    expect(screen.getByRole('article').getAttribute('data-detail-item-id')).toBe('1');
    expect(transport.preferences.sessions[0]!.selected_item_id).toBe('1');
    fireEvent.click(within(peek).getByRole('button', { name: 'Go to' }));
    await screen.findByRole('article', { name: `Detail of ${fork.question}` });
    await waitFor(() => expect(transport.preferences.sessions[0]!.selected_item_id).toBe(fork.id));
  });

  it.each(['Waiting', 'detail'] as const)('records a successful ordinary %s answer in Recent', async surface => {
    const transport = new AppTransport();
    transport.sessions.get(route.session_id)!.items['2']!.options = [{ id: 'yes', label: 'Approve delivery', recommended: true, consequence: 'Keep the delivery window.' }];
    render(<DesktopApp service={createDesktopService(transport)} />); await openFirst();
    let control: HTMLElement;
    if (surface === 'Waiting') {
      await waitFor(() => expect(document.querySelector('[data-waiting-item="2"]')).not.toBeNull());
      control = document.querySelector<HTMLElement>('[data-waiting-item="2"]')!;
    } else {
      fireEvent.click(document.querySelector('[role="treeitem"][data-item-id="2"]')!);
      control = await screen.findByRole('article', { name: `Detail of ${transport.sessions.get(route.session_id)!.items['2']!.question}` });
    }
    if (surface === 'Waiting') fireEvent.click(await within(control).findByRole('button', { name: 'Send answer' }));
    else {
      const textbox = await within(control).findByRole('textbox', { name: 'Reply in your own words' });
      fireEvent.change(textbox, { target: { value: `Answer from ${surface}.` } });
      fireEvent.click(within(control).getByRole('button', { name: 'Send as a reply only' }));
    }
    await waitFor(() => expect(transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(1));
    await waitFor(() => expect(transport.preferences.sessions.find(view => view.session.session_id === route.session_id)?.recent_items).toEqual(expect.arrayContaining([expect.objectContaining({ item_id: '2', action: 'answered' })])));
  });

  it('previews a reference without selecting it, then Go to reveals, selects and opens its detail', async () => {
    const transport = new AppTransport(), source = transport.sessions.get(route.session_id)!;
    source.items['1']!.why = 'Review [#2](item:2) before the next delivery.';
    source.items['2']!.short = 'Delivery choice';
    render(<DesktopApp service={createDesktopService(transport)} />); await openFirst();
    fireEvent.click(document.querySelector('[role="treeitem"][data-item-id="1"]')!);
    const detail = await screen.findByRole('article', { name: `Detail of ${source.items['1']!.question}` });
    const chip = within(detail).getByRole('button', { name: `${source.items['2']!.question} · Waiting on me` });
    expect(chip.textContent).toBe('Delivery choice'); fireEvent.click(chip);
    const peek = await screen.findByRole('dialog', { name: `Peek: ${source.items['2']!.question}` });
    expect(screen.getByRole('article').getAttribute('data-detail-item-id')).toBe('1');
    fireEvent.click(within(peek).getByRole('button', { name: 'Go to' }));
    await screen.findByRole('article', { name: `Detail of ${source.items['2']!.question}` });
    await waitFor(() => expect(transport.preferences.sessions.find(view => view.session.session_id === route.session_id)?.selected_item_id).toBe('2'));
    await waitFor(() => expect(transport.preferences.sessions.find(view => view.session.session_id === route.session_id)?.recent_items).toEqual(expect.arrayContaining([expect.objectContaining({ item_id: '2', action: 'viewed' })])));
    expect(transport.queries.some(request => request.request.command === 'reveal_item' && request.request.params.item_id === '2')).toBe(true);
    expect(screen.queryByRole('dialog', { name: `Peek: ${source.items['2']!.question}` })).toBeNull();
  });

  it('opens a Waiting path chip in another session and answers its referenced question without switching the workspace', async () => {
    const transport = new AppTransport(), first = transport.sessions.get(route.session_id)!;
    const other = structuredClone(first); other.id = secondId; other.title = 'Separate session';
    other.items['2']!.parent = '8'; other.items['2']!.topic_id = other.items['8']!.topic_id;
    other.items['2']!.question = 'Approve the other session delivery?'; other.items['2']!.short = 'Other delivery';
    other.items['8']!.short = 'Other branch'; other.items['8']!.why = 'Review [#2](item:2).';
    transport.sessions.set(secondId, other);
    render(<DesktopApp service={createDesktopService(transport)} />); await openFirst();
    fireEvent.click(document.querySelector('[role="treeitem"][data-item-id="1"]')!);
    await screen.findByRole('article', { name: `Detail of ${first.items['1']!.question}` });
    await waitFor(() => expect(document.querySelector(`[data-waiting-item="2"][data-session-id="${secondId}"]`)).not.toBeNull());
    const card = document.querySelector<HTMLElement>(`[data-waiting-item="2"][data-session-id="${secondId}"]`)!;
    fireEvent.click(within(card).getByRole('button', { name: `${other.items['8']!.question} · Open` }));
    const branchPeek = await screen.findByRole('dialog', { name: `Peek: ${other.items['8']!.question}` });
    fireEvent.click(within(branchPeek).getByRole('button', { name: `${other.items['2']!.question} · Waiting on me` }));
    const questionPeek = await screen.findByRole('dialog', { name: `Peek: ${other.items['2']!.question}` });
    fireEvent.change(within(questionPeek).getByRole('textbox', { name: 'One-line answer' }), { target: { value: 'Yes, keep this delivery.' } });
    fireEvent.click(within(questionPeek).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(1));
    const saved = transport.mutations.find(request => request.command.command === 'input_submit')!;
    expect(saved.session).toEqual({ ...route, session_id: secondId });
    expect(saved.command).toMatchObject({ params: { target: { item_id: '2' }, text: 'Yes, keep this delivery.', kind: 'answer' } });
    expect(transport.preferences.global.selected_navigation).toEqual({ kind: 'session', session: route });
    expect(screen.getByRole('article').getAttribute('data-detail-item-id')).toBe('1');
    await waitFor(() => expect(transport.preferences.sessions.find(view => view.session.session_id === secondId)?.recent_items).toEqual(expect.arrayContaining([expect.objectContaining({ item_id: '2', action: 'answered' })])));
  });

  it('keeps the stopped-agent modal in control of Escape while preserving the peek and its draft', async () => {
    const transport = new AppTransport(), source = transport.sessions.get(route.session_id)!;
    source.items['1']!.why = 'Review [#2](item:2).'; source.items['2']!.short = 'Delivery choice';
    const binding = source.bindings[source.active_binding_id!]!;
    binding.connection_state = 'disconnected'; binding.dispatch_state = 'disconnected';
    render(<DesktopApp service={createDesktopService(transport)} />); await openFirst();
    fireEvent.click(document.querySelector('[role="treeitem"][data-item-id="1"]')!);
    const detail = await screen.findByRole('article', { name: `Detail of ${source.items['1']!.question}` });
    fireEvent.click(within(detail).getByRole('button', { name: `${source.items['2']!.question} · Waiting on me` }));
    const peek = await screen.findByRole('dialog', { name: `Peek: ${source.items['2']!.question}` });
    fireEvent.change(within(peek).getByRole('textbox', { name: 'One-line answer' }), { target: { value: 'Keep this draft after cancel.' } });
    fireEvent.click(within(peek).getByRole('button', { name: 'Send' }));
    const modal = await screen.findByRole('dialog', { name: /isn’t running for this session/ });
    expect(modal.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(modal);
    fireEvent.keyDown(modal, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /isn’t running for this session/ })).toBeNull());
    expect(screen.getByRole('dialog', { name: `Peek: ${source.items['2']!.question}` })).toBe(peek);
    expect((within(peek).getByRole('textbox', { name: 'One-line answer' }) as HTMLInputElement).value).toBe('Keep this draft after cancel.');
    expect(transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(0);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: `Peek: ${source.items['2']!.question}` })).toBeNull();
  });
});
