import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { AppTransport, route, secondId } from '../app/transport';
import { goToSession } from '../app/open';
import userEvent from '@testing-library/user-event';
import { answerWords } from '../answer/words';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function openFirst() {
  await goToSession(route);
  await waitFor(() => expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready'));
}

describe('peek desktop composition', { timeout: 10_000 }, () => {
  it.each(['Tree', 'Graph'] as const)('Go to from a filtered detail child focuses the revealed %s row without scrolling via focus', async mode => {
    const transport = new AppTransport(), source = transport.sessions.get(route.session_id)!;
    source.items['1']!.question = 'Parent search match';
    transport.preferences.sessions[0]!.filters.search = 'Parent search match';
    transport.preferences.sessions[0]!.expanded_item_ids = [];
    render(<DesktopApp service={createDesktopService(transport)} />); await openFirst();
    if (mode === 'Graph') await userEvent.click(screen.getByRole('button', { name: 'Graph' }));
    const rowSelector = mode === 'Tree' ? '[role="treeitem"]' : '.graph-node';
    await userEvent.click(document.querySelector(`${rowSelector}[data-item-id="1"]`)!);
    const detail = await screen.findByRole('article', { name: 'Detail of Parent search match' });
    await waitFor(() => expect(transport.preferences.sessions[0]!.selected_item_id).toBe('1'));
    const expansion = [...transport.preferences.sessions[0]!.expanded_item_ids];
    const chip = within(within(detail).getByRole('region', { name: 'Child items' })).getByRole('button', { name: source.items['1.1']!.question });
    await userEvent.click(chip);
    await screen.findByRole('dialog', { name: `Peek: ${source.items['1.1']!.question}` });
    await userEvent.keyboard('{Escape}');
    expect(document.activeElement).toBe(chip);
    await userEvent.click(chip);
    const peek = await screen.findByRole('dialog', { name: `Peek: ${source.items['1.1']!.question}` });
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    await userEvent.click(within(peek).getByRole('button', { name: 'Go to' }));
    await screen.findByRole('article', { name: `Detail of ${source.items['1.1']!.question}` });
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector(`${rowSelector}[data-item-id="1.1"]`)));
    expect(focus.mock.calls.some((args, index) => focus.mock.contexts[index] === document.activeElement && args[0]?.preventScroll)).toBe(true);
    expect(chip.isConnected).toBe(false);
    expect(transport.preferences.sessions[0]!.filters.search).toBe('Parent search match');
    expect(transport.preferences.sessions[0]!.expanded_item_ids).toEqual(expansion);
  });

  it.each(['Tree', 'Graph'] as const)('Go to from %s Markdown peeks focuses the target and Escape returns to the source', async mode => {
    const transport = new AppTransport(), source = transport.sessions.get(route.session_id)!;
    source.items['8']!.why = 'Review [the parent](item:1).';
    source.items['2']!.parent = '1'; source.items['2']!.topic_id = source.items['1']!.topic_id;
    render(<DesktopApp service={createDesktopService(transport)} />); await openFirst();
    if (mode === 'Graph') await userEvent.click(screen.getByRole('button', { name: 'Graph' }));
    const selector = mode === 'Tree' ? '[role="treeitem"]' : '.graph-node';
    await userEvent.click(document.querySelector(`${selector}[data-item-id="8"]`)!);
    const detail = await screen.findByRole('article', { name: `Detail of ${source.items['8']!.question}` });
    const chip = within(detail).getByRole('button', { name: `${source.items['1']!.question} · Done` });
    await userEvent.click(chip); await screen.findByRole('dialog', { name: `Peek: ${source.items['1']!.question}` });
    await userEvent.keyboard('{Escape}'); expect(document.activeElement).toBe(chip);
    await userEvent.click(chip);
    const peek = await screen.findByRole('dialog', { name: `Peek: ${source.items['1']!.question}` });
    await userEvent.click(within(peek).getByRole('button', { name: 'Go to' }));
    await screen.findByRole('article', { name: `Detail of ${source.items['1']!.question}` });
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector(`${selector}[data-item-id="1"]`)));
  });

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
    expect(document.activeElement).toBe(document.querySelector(`[role="treeitem"][data-item-id="${fork.id}"]`));
  });

  it.each(['dock', 'detail'] as const)('records a successful ordinary %s answer in Recent', async surface => {
    const transport = new AppTransport();
    transport.sessions.get(route.session_id)!.items['2']!.options = [{ id: 'yes', label: 'Approve delivery', recommended: true, consequence: 'Keep the delivery window.' }];
    render(<DesktopApp service={createDesktopService(transport)} />); await openFirst();
    let control: HTMLElement;
    if (surface === 'dock') {
      control = screen.getByRole('region', { name: 'Answer dock' });
      fireEvent.click(await within(control).findByRole('button', { name: /^1 waiting$/ }));
      fireEvent.click(await within(control).findByRole('button', { name: /^Approve delivery/ }));
    } else {
      fireEvent.click(document.querySelector('[role="treeitem"][data-item-id="2"]')!);
      control = await screen.findByRole('article', { name: `Detail of ${transport.sessions.get(route.session_id)!.items['2']!.question}` });
      await waitFor(() => expect(control.querySelector('[data-answer-own]')).not.toBeNull());
      fireEvent.change(answerWords(control), { target: { value: `Answer from ${surface}.` } });
    }
    const send = within(control).getByRole('button', { name: 'Send' });
    await waitFor(() => expect(send.hasAttribute('disabled')).toBe(false));
    fireEvent.click(send);
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

  it('answers another session’s question from the dock’s list without switching the workspace, and records it in that session', async () => {
    const transport = new AppTransport(), first = transport.sessions.get(route.session_id)!;
    const other = structuredClone(first); other.id = secondId; other.title = 'Separate session';
    other.items['2']!.question = 'Approve the other session delivery?'; other.items['2']!.short = 'Other delivery';
    other.items['2']!.options = [{ id: 'yes', label: 'Keep this delivery', recommended: true, consequence: 'Ship it as planned.' }];
    transport.sessions.set(secondId, other);
    render(<DesktopApp service={createDesktopService(transport)} />); await openFirst();
    fireEvent.click(document.querySelector('[role="treeitem"][data-item-id="1"]')!);
    await screen.findByRole('article', { name: `Detail of ${first.items['1']!.question}` });
    const dock = screen.getByRole('region', { name: 'Answer dock' });
    fireEvent.click(await within(dock).findByRole('button', { name: /in other sessions$/ }));
    const list = within(dock).getByRole('dialog', { name: 'Questions in other sessions' });
    fireEvent.click(within(list).getByRole('button', { name: /Approve the other session delivery\?/ }));
    fireEvent.click(await within(list).findByRole('button', { name: /^Keep this delivery/ }));
    fireEvent.click(within(list).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(1));
    const saved = transport.mutations.find(request => request.command.command === 'input_submit')!;
    expect(saved.session).toEqual({ ...route, session_id: secondId });
    expect(saved.command).toMatchObject({ params: { target: { item_id: '2' }, selected_option_id: 'yes', kind: 'answer' } });
    expect(transport.preferences.global.selected_navigation).toEqual({ kind: 'session', session: route });
    expect(screen.getByRole('article').getAttribute('data-detail-item-id')).toBe('1');
    await waitFor(() => expect(transport.preferences.sessions.find(view => view.session.session_id === secondId)?.recent_items).toEqual(expect.arrayContaining([expect.objectContaining({ item_id: '2', action: 'answered' })])));
  });

  it('keeps the stopped-agent modal in control of Escape while preserving the peek and its draft', async () => {
    const transport = new AppTransport(), source = transport.sessions.get(route.session_id)!;
    source.items['1']!.why = 'Review [#2](item:2).'; source.items['2']!.short = 'Delivery choice';
    source.items['2']!.options = [1, 2].map(index => ({ id: `choice-${index}`, label: `Window ${index}`, consequence: `Use window ${index}.`, recommended: index === 1 }));
    const binding = source.bindings[source.active_binding_id!]!;
    binding.connection_state = 'disconnected'; binding.dispatch_state = 'disconnected';
    render(<DesktopApp service={createDesktopService(transport)} />); await openFirst();
    fireEvent.click(document.querySelector('[role="treeitem"][data-item-id="1"]')!);
    const detail = await screen.findByRole('article', { name: `Detail of ${source.items['1']!.question}` });
    fireEvent.click(within(detail).getByRole('button', { name: `${source.items['2']!.question} · Waiting on me` }));
    const peek = await screen.findByRole('dialog', { name: `Peek: ${source.items['2']!.question}` });
    fireEvent.click(within(peek).getByRole('button', { name: /^Window 2/ }));
    fireEvent.click(within(peek).getByRole('button', { name: 'Send' }));
    const modal = await screen.findByRole('dialog', { name: /isn’t running for this session/ });
    expect(modal.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(modal);
    fireEvent.keyDown(modal, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /isn’t running for this session/ })).toBeNull());
    expect(screen.getByRole('dialog', { name: `Peek: ${source.items['2']!.question}` })).toBe(peek);
    // Cancel keeps the pick and sends nothing.
    expect(within(peek).getByRole('button', { name: /^Window 2/ }).getAttribute('aria-pressed')).toBe('true');
    expect(transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(0);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: `Peek: ${source.items['2']!.question}` })).toBeNull();
  });
});
