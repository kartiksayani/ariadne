import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import type { OwnerMutationRequest, OwnerQueryRequest } from '../../../src/generated/core';
import type { ItemStatus } from '../../../src/generated/domain/models';
import { ackTarget, flushAckHold } from '../../../src/ui/shared/ack';
import { currentQuestionReplied, ownerReplied } from '../../../src/selectors/waiting/replied';
import { AppTransport, route, secondId } from '../app/transport';
import { goToSession } from '../app/open';
import { notices } from '../../../src/ui/pages/notices';
import { toasts } from '../../../src/ui/shell/toast';
import { clearToast, heldToast } from './ackFixture';

// A held Ack outlives its view by design, so a test drains it before the next one starts: no timer or notice leaks across tests.
afterEach(async () => { await act(async () => { await flushAckHold(route.session_id); }); cleanup(); notices.clear(); clearToast(); vi.restoreAllMocks(); });
/** An Ack waits 6 s for its Undo (pinned in hold.test.tsx). These tests are about what an Ack does, so the window is over here:
 * whatever is held saves now, as it does when the owner leaves the session. */
const holdOver = () => act(async () => { await flushAckHold(route.session_id); });

class AckTransport extends AppTransport {
  refuse = false;
  refuseArchive = false;
  ackWait: Promise<void> | null = null;
  constructor() {
    super();
    const session = this.sessions.get(route.session_id)!;
    session.items['1.1']!.type = 'finding';
    session.items['1.1']!.ack_to = 'done';
    session.items['1.1']!.question = 'Record the retry limits';
    session.items['1.1']!.ask = null;
    session.items['2']!.ack_to = 'decided';
  }
  override async invoke<T>(name: string, args: { request: OwnerQueryRequest | OwnerMutationRequest }): Promise<T> {
    const request = args.request;
    if ('command' in request && request.command.command === 'topic_archive' && this.refuseArchive) {
      this.mutations.push(structuredClone(request));
      return { api_version: 1, ok: false, error: {
        code: 'invalid_transition', message: 'The topic could not be archived.', hint: '', retryable: false, field_errors: [],
      } } as T;
    }
    if ('command' in request && request.command.command === 'ack') {
      this.mutations.push(structuredClone(request));
      await this.ackWait;
      const command = request.command;
      if (this.refuse) return { api_version: 1, ok: false, error: {
        code: 'invalid_transition', message: 'Ack predicate no longer holds.', hint: 'Reload item state.', retryable: false, field_errors: [],
      } } as T;
      const session = this.sessions.get(request.session!.session_id)!, item = session.items[command.params.item_id]!, status = item.ack_to!;
      const messageId = crypto.randomUUID();
      item.status = status; item.ack_to = null; ++item.revision; ++session.revision;
      return { api_version: 1, ok: true, data: { operation_id: command.op_id, session_id: session.id, revision: session.revision,
        data: { kind: 'item_ack', item_id: item.id, item_revision: item.revision, status, message_id: messageId } } } as T;
    }
    return super.invoke(name, args);
  }
}
const row = (id = '1.1') => document.querySelector<HTMLElement>(`[role="treeitem"][data-item-id="${id}"]`)!;
const detail = () => screen.getByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1.1"]' });
const acks = (transport: AppTransport) => transport.mutations.filter(value => value.command.command === 'ack');
const refusal = 'This item can’t be acknowledged now. Check its current status and any question waiting for you.';
async function mount(transport = new AckTransport()) {
  render(<DesktopApp service={createDesktopService(transport)} />);
  await goToSession(route);
  await screen.findByRole('region', { name: 'Session tree' });
  await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready');
      expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-busy')).toBe('false');
    });
  return transport;
}

describe('local acknowledgement', () => {
  it.each([
    { status: 'open', target: 'open', hint: 'Ack → keeps it open' },
    { status: 'open', target: 'in_progress', hint: 'Ack → In progress' },
    { status: 'open', target: 'done', hint: 'Ack → Done' },
    { status: 'in_progress', target: 'open', hint: 'Ack → Open' },
    { status: 'in_progress', target: 'in_progress', hint: 'Ack → keeps it in progress' },
    { status: 'in_progress', target: 'done', hint: 'Ack → Done' },
  ] as const)(
    'shows the real $status status with the $target Ack hint in tree, detail and graph', async ({ status, target, hint }) => {
      const transport = new AckTransport(), item = transport.sessions.get(route.session_id)!.items['1.1']!;
      item.status = status; item.ack_to = target;
      item.outcome = 'Retry limits are recorded.'; item.why = 'The limits have an explicit owner.';
      const label = status === 'open' ? 'Open' : 'In progress', colour = status === 'open' ? 'open' : 'progress';
      await mount(transport);
      expect(within(row()).getByRole('img', { name: label })).toBeTruthy();
      expect(row().querySelector('.tree-end-badge .status-badge')?.textContent).toBe(label);
      // The row names the target on its Ack button only; its old "Ack → …" body line rewrapped the row (alpha.20 C4).
      expect(within(row()).getByRole('button', { name: hint }).title).toBe(hint);
      expect(within(row()).queryByText(hint)).toBeNull();
      expect(row().querySelector<HTMLElement>('.tree-outcome i')?.style.color).toBe(`var(--st-${colour})`);
      fireEvent.click(row()); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1.1"]' });
      expect(detail().querySelector('.detail-badge')?.textContent).toBe(label);
      expect(detail().querySelector<HTMLElement>('.detail-badge .status-badge')?.style.color).toBe(`var(--st-${colour})`);
      expect(within(detail()).getByText(hint)).toBeTruthy();
      expect(within(detail()).getByRole('button', { name: hint }).title).toBe(hint);
      expect(detail().querySelector<HTMLElement>('.detail-outcome .detail-label')?.style.color).toBe(`var(--st-${colour})`);
      fireEvent.keyDown(row(), { key: 'g' }); await screen.findByRole('group', { name: 'Graph legend' });
      expect(within(row()).getByRole('img', { name: label })).toBeTruthy();
      expect(row().querySelector<HTMLElement>('.graph-node-icon')?.style.color).toBe(`var(--st-${colour})`);
      // A Graph node is icon, name and marker only (SPEC 1.3); the Ack hint lives in the Tree and Details.
      expect(within(row()).queryByText(hint)).toBeNull();
      expect(acks(transport)).toHaveLength(0);
    });

  it.each((['open', 'in_progress'] as const).flatMap(status => (['archived', 'unanswered', 'answered'] as const).map(question => ({ status, question }))))(
    'shows Ack hints only when available for $status with an $question question in tree, detail and graph', async ({ status, question }) => {
      const transport = new AckTransport(), session = transport.sessions.get(route.session_id)!, item = session.items['1.1']!;
      item.status = status; item.ack_to = 'done';
      const input = structuredClone(Object.values(session.inputs).find(value => value)!);
      session.inputs = {}; session.answers = [];
      if (question !== 'archived') item.ask = 'Confirm these limits?';
      if (question === 'answered') {
        input.target.item_id = item.id; input.target.topic_id = item.topic_id;
        input.answer_id = null; input.state = 'handled'; input.kind = 'reply'; input.payload.intent = 'reply';
        input.payload.target_snapshot.question_revision = item.question_revision;
        session.inputs[input.id] = input;
      }
      await mount(transport);
      fireEvent.click(row()); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1.1"]' });
      if (question === 'archived') {
        session.state = 'closed'; session.archived_at = session.updated_at; ++session.revision;
        act(() => { transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision }); });
      }
      const available = question === 'answered';
      await waitFor(() => expect(!!within(row()).queryByRole('button', { name: /^Ack/ })).toBe(available));
      for (const host of [row(), detail()]) expect(!!within(host).queryByRole('button', { name: /^Ack/ })).toBe(available);
      // The Map row names the target on its button only; the detail also writes it out.
      expect(!!within(detail()).queryByText(/^Ack →/)).toBe(available);
      expect(!!screen.queryByText('Ack all (1)')).toBe(available);
      fireEvent.keyDown(row(), { key: 'g' }); await screen.findByRole('group', { name: 'Graph legend' });
      expect(within(row()).queryByText(/^Ack →/)).toBeNull();
      expect(acks(transport)).toHaveLength(0);
    });

  it.each(['open', 'in_progress'] as const)('acknowledges to %s once, preserves the report and keeps it nonterminal', async target => {
    const transport = new AckTransport(), session = transport.sessions.get(route.session_id)!, item = session.items['1.1']!;
    item.status = 'in_progress'; item.ack_to = target;
    item.outcome = 'Retry limits are recorded.'; item.why = 'The limits have an explicit owner.';
    await mount(transport);
    fireEvent.click(row()); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1.1"]' });
    await act(async () => { detail().focus(); fireEvent.keyDown(detail(), { key: 'a' }); });
    expect(acks(transport)).toHaveLength(0);   // held, with its Undo
    await holdOver();
    await waitFor(() => expect(detail().getAttribute('data-status')).toBe(target === 'in_progress' ? 'progress' : 'open'));
    await waitFor(() => expect(within(detail()).queryByRole('button', { name: /^Ack/ })).toBeNull());
    expect(acks(transport)).toHaveLength(1);
    await waitFor(() => expect(transport.preferences.sessions[0].recent_items?.find(entry => entry.item_id === item.id)?.action).toBe('acked'));
    expect(item.status).toBe(target); expect(item.ack_to).toBeNull();
    expect(screen.queryByText('Ack all (1)')).toBeNull();
    const counts = screen.getAllByTestId('band-counts')[0]!;     // the first topic's band holds item 1.1
    expect(counts.textContent).toContain(target === 'open' ? '2 open' : '1 open');
    expect(counts.textContent).toContain(target === 'open' ? '1 in progress' : '2 in progress');
    expect(row().querySelector('.tree-outcome')?.textContent).toContain(item.outcome);
    expect(within(detail()).getByText(item.outcome)).toBeTruthy();
    expect(within(detail()).getByText(item.why)).toBeTruthy();
    expect(within(detail()).queryByRole('button', { name: /^Ack/ })).toBeNull();
    expect(within(detail()).getByRole('button', { name: target === 'open' ? /^Reply/ : /^Add a note/ })).toBeTruthy();
    await act(async () => { detail().focus(); fireEvent.keyDown(detail(), { key: 'a' }); });
    expect(acks(transport)).toHaveLength(1);
    expect(transport.mutations.some(value => value.command.command === 'input_submit')).toBe(false);
  });

  it('explains keyboard Ack during a view save and allows it once the view is saved', async () => {
    const transport = await mount();
    // Keys act on the selected item.
    fireEvent.click(row()); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1.1"]' });
    let release!: () => void, saving = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('command' in args.request && args.request.command.command === 'preferences_patch') { saving = true; await gate; }
      return invoke(name, args);
    });
    const band = row().closest('.tree-topic-group')!.querySelector<HTMLElement>('[role="treeitem"]')!;
    band.focus(); fireEvent.keyDown(band, { key: 'ArrowLeft' });
    await waitFor(() => expect(saving).toBe(true));
    // Unfolding acts locally while the preference write is still pending.
    fireEvent.keyDown(band, { key: 'ArrowRight' });
    const button = within(row()).getByRole<HTMLButtonElement>('button', { name: 'Ack → Done' });
    expect(button.disabled).toBe(true);
    row().focus(); fireEvent.keyDown(row(), { key: 'a' });
    expect(await screen.findByText('Another view change is being saved. Wait for it, then try Ack again.')).toBeTruthy();
    expect(acks(transport)).toHaveLength(0);
    await act(async () => { release(); });
    await waitFor(() => expect(within(row()).getByRole<HTMLButtonElement>('button', { name: 'Ack → Done' }).disabled).toBe(false));
    await act(async () => { fireEvent.keyDown(row(), { key: 'a' }); });
    await holdOver();
    await waitFor(() => expect(acks(transport)).toHaveLength(1));
  });

  it.each(['tree', 'detail', 'graph'] as const)('explains a keyboard Ack from %s while another change is being saved or awaits confirmation', async source => {
    const transport = await mount();
    fireEvent.click(row()); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1.1"]' });
    let release!: () => void, saving = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('command' in args.request && args.request.command.command === 'session_close') { saving = true; await gate; throw new Error('Lost save response'); }
      return invoke(name, args);
    });
    if (source === 'graph') { fireEvent.keyDown(row(), { key: 'g' }); await screen.findByRole('group', { name: 'Graph legend' }); }
    // The other change is Close session (the connection card): it asks first, then saves while its review stays open.
    fireEvent.click(document.querySelector<HTMLElement>('[data-popover-trigger="connection"]')!);
    fireEvent.click(await within(await waitFor(() => document.querySelector<HTMLElement>('.cc')!)).findByRole('button', { name: 'Close session' }));
    const review = await screen.findByRole('dialog', { name: /^Close / });
    fireEvent.click(within(review).getByRole('button', { name: 'Close session' }));
    await waitFor(() => expect(saving).toBe(true));
    const host = () => source === 'detail' ? detail() : row();
    // While the save runs its review owns the keys, so `a` reaches nothing and nothing is acknowledged.
    host().focus(); fireEvent.keyDown(host(), { key: 'a' });
    expect(acks(transport)).toHaveLength(0);
    await act(async () => { release(); });
    await within(review).findByText(/Ariadne isn’t sure your last change was saved/);
    fireEvent.click(within(review).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Close / })).toBeNull());
    host().focus(); fireEvent.keyDown(host(), { key: 'a' });
    expect(await screen.findByText('Ariadne isn’t sure your last change was saved. Check again before trying Ack.')).toBeTruthy();
    expect(acks(transport)).toHaveLength(0);
  });

  it('opens an Ack proposal from Related and refreshes its listed status after acknowledging', async () => {
    const transport = new AckTransport(), session = transport.sessions.get(route.session_id)!;
    session.items['1']!.related = ['1.1'];
    session.items['1.1']!.short = 'Retry limits';
    await mount(transport);
    fireEvent.click(row('1')); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1"]' });
    const related = screen.getByRole('region', { name: 'Related items' });
    const linked = within(related).getByRole('button', { name: `${session.items['1.1']!.question} · Open` });
    expect(linked.textContent).toContain('Retry limits');
    expect(linked.textContent).toContain('Open');
    fireEvent.click(linked); fireEvent.click(screen.getByRole('button', { name: 'Go to' })); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1.1"]' });
    await act(async () => { fireEvent.click(within(detail()).getByRole('button', { name: 'Ack → Done' })); });
    await holdOver();
    await waitFor(() => expect(detail().getAttribute('data-status')).toBe('done'));
    expect(acks(transport)).toHaveLength(1);
    fireEvent.click(row('1')); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1"]' });
    const acknowledged = within(screen.getByRole('region', { name: 'Related items' })).getByRole('button', { name: `${session.items['1.1']!.question} · Done` });
    expect(acknowledged.textContent).toContain('Retry limits');
    expect(acknowledged.textContent).toContain('Done');
  });

  it('offers a quiet row Ack with a target tooltip and a topic count, while questions keep their answer controls', async () => {
    await mount();
    const button = within(row()).getByRole('button', { name: 'Ack → Done' });
    expect(button.textContent).toBe(''); expect(button.title).toBe('Ack → Done');
    expect(button.closest('.tree-ack-slot')).not.toBeNull();
    expect(button.closest('.tree-actions')).toBeNull();
    expect(button.classList.contains('tree-action-ack')).toBe(true);
    expect(screen.getByText('Ack all (1)')).toBeTruthy();
    expect(within(row('2')).queryByRole('button', { name: /^Ack/ })).toBeNull();
    // The footer's key legend is gone; Help (?) lists the Ack key under the selected item's keys.
    fireEvent.keyDown(row(), { key: '?', shiftKey: true });
    const keys = await screen.findByRole('region', { name: 'On the selected item' });
    expect(within(keys).getByText('Ack')).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    const css = readFileSync(resolve(__dirname, '../../../src/ui/tree/tree.css'), 'utf8');
    expect(css).toMatch(/\.tree-actions\s*\{[^}]*visibility:\s*hidden/s);
    // Ack has its own fixed-width slot in the end cluster, so it landing or going never rewraps the row.
    expect(button.closest('.tree-end')).not.toBeNull();
    expect(css).toMatch(/\.tree-ack-slot\s*\{[^}]*width:\s*var\(--tree-end-ack\)/s);
  });

  it.each(['done', 'decided', 'dropped'] as const)('names %s in the detail tooltip, refreshes and keeps Follow up and Back to Open', async target => {
    const transport = new AckTransport(), item = transport.sessions.get(route.session_id)!.items['1.1']!;
    item.ack_to = target;
    const revision = item.revision;
    await mount(transport);
    fireEvent.click(row()); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1.1"]' });
    const label = target[0].toUpperCase() + target.slice(1);
    const button = within(detail()).getByRole('button', { name: `Ack → ${label}` });
    expect(button.title).toBe(`Ack → ${label}`);
    expect(within(detail()).getByText(`Ack → ${label}`)).toBeTruthy();
    expect(within(detail()).getByRole('button', { name: /^Reply/ })).toBeTruthy();
    await act(async () => { fireEvent.click(button); });
    await holdOver();
    await waitFor(() => expect(detail().getAttribute('data-status')).toBe(target));
    expect(acks(transport)).toHaveLength(1);
    expect(acks(transport)[0]).toMatchObject({ session: route, command: { api_version: 1, params: { item_id: '1.1', expected_revision: revision } } });
    expect(within(detail()).queryByRole('button', { name: /^Ack/ })).toBeNull();
    expect(within(detail()).getByRole('button', { name: /^Follow up/ })).toBeTruthy();
    expect(within(detail()).getByRole<HTMLButtonElement>('button', { name: /^Back to Open/ }).disabled).toBe(false);
    expect(screen.queryByText('Ack all (1)')).toBeNull();
    fireEvent.click(within(detail()).getByRole('button', { name: /^Follow up/ }));
    await waitFor(() => expect(within(detail()).getByRole('textbox')).toBeTruthy());
  });

  it('keeps a hidden Ack item hidden and counted, and acknowledges from the dock without unhiding it', async () => {
    const transport = await mount();
    fireEvent.click(within(row()).getByRole('button', { name: 'Hide (h)' }));
    await waitFor(() => expect(row()).toBeNull());
    expect(screen.getByText('Ack all (1)')).toBeTruthy();
    const view = () => transport.preferences.sessions.find(value => value.session.session_id === route.session_id)!;
    expect(view().hidden_item_ids).toContain('1.1');
    await act(async () => { transport.emit('ariadne://route', { ...route, item_id: '1.1' }); });
    await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1.1"]' });
    expect(row().classList.contains('tree-item-hidden')).toBe(true);
    const button = within(detail()).getByRole('button', { name: 'Ack → Done' });
    expect(button.closest('.detail-dock')).not.toBeNull();
    expect(detail().querySelectorAll('.detail-chat')).toHaveLength(1);
    await act(async () => { fireEvent.click(button); });
    await holdOver();
    await waitFor(() => expect(detail().getAttribute('data-status')).toBe('done'));
    expect(view().hidden_item_ids).toContain('1.1');
    expect(row().classList.contains('tree-item-hidden')).toBe(true);
    expect(screen.queryByText('Ack all (1)')).toBeNull();
  });

  it.each(['tree', 'detail', 'key'] as const)('refuses a held %s Ack whose proposal moved on during a stale-store wait, then acks the refreshed one once', async source => {
    class RefreshTransport extends AckTransport {
      hold: Promise<void> | null = null;
      override async invoke<T>(name: string, args: { request: OwnerQueryRequest | OwnerMutationRequest }): Promise<T> {
        if (name === 'session_get' && this.hold) await this.hold;
        return super.invoke<T>(name, args);
      }
    }
    const transport = new RefreshTransport(); await mount(transport);
    fireEvent.click(row()); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1.1"]' });
    let release!: () => void;
    transport.hold = new Promise<void>(resolve => { release = resolve; });
    const session = transport.sessions.get(route.session_id)!, item = session.items['1.1']!;
    ++session.revision; ++item.revision;
    act(() => { transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision }); });
    const press = () => {
      if (source === 'key') { detail().focus(); fireEvent.keyDown(detail(), { key: 'a' }); }
      else {
        const button = within(source === 'detail' ? detail() : row()).getByRole<HTMLButtonElement>('button', { name: 'Ack → Done' });
        expect(button.disabled).toBe(false);
        fireEvent.click(button);
      }
    };
    press();
    expect(acks(transport)).toHaveLength(0);
    const revision = item.revision;
    await act(async () => { transport.hold = null; release(); });
    // The hold's save reads the refreshed item: its revision is not the one the owner reviewed, so nothing is saved.
    await holdOver();
    expect(acks(transport)).toHaveLength(0);
    expect(await screen.findByText('Not acked: it changed')).toBeTruthy();
    expect(item.ack_to).toBe('done');
    // The refreshed proposal is acked by a fresh click, at its refreshed revision, once.
    await waitFor(() => expect(within(source === 'detail' ? detail() : row()).getByRole<HTMLButtonElement>('button', { name: 'Ack → Done' }).disabled).toBe(false));
    press(); await holdOver();
    await waitFor(() => expect(acks(transport)).toHaveLength(1));
    expect(acks(transport)[0].command).toMatchObject({ params: { expected_revision: revision } });
    await waitFor(() => expect(detail().getAttribute('data-status')).toBe('done'));
  });

  it('shows the proposed outcome and rationale before acknowledging it', async () => {
    const transport = new AckTransport(), item = transport.sessions.get(route.session_id)!.items['1.1']!;
    item.outcome = 'Retry limits are recorded.'; item.why = 'The limits now have an explicit owner.';
    await mount(transport);
    expect(row().querySelector('.tree-outcome')?.textContent).toContain(item.outcome);
    fireEvent.click(row()); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1.1"]' });
    expect(within(within(detail()).getByRole('region', { name: 'Current outcome' })).getByText('Outcome')).toBeTruthy();
    expect(within(detail()).getByText(item.outcome)).toBeTruthy();
    expect(within(detail()).getByText(item.why)).toBeTruthy();
  });

  it.each(['followup', 'reopen'] as const)('keeps %s available after Ack while an earlier input is queued', async intent => {
    const transport = new AckTransport(), session = transport.sessions.get(route.session_id)!, item = session.items['1.1']!;
    const earlier = Object.values(session.inputs).find(input => input?.state === 'queued')!;
    earlier.target.item_id = item.id; earlier.target.topic_id = item.topic_id;
    earlier.payload.target_snapshot.question_revision = item.question_revision;
    earlier.payload.target_snapshot.item_question = item.question;
    item.ask = 'Are these limits acceptable?';
    const earlierId = earlier.id;
    await mount(transport); fireEvent.click(row()); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1.1"]' });
    await act(async () => { fireEvent.click(within(detail()).getByRole('button', { name: 'Ack → Done' })); });
    await holdOver();
    await waitFor(() => expect(detail().getAttribute('data-status')).toBe('done'));
    expect(session.inputs[earlierId]!.state).toBe('queued');
    expect(within(row()).getByRole('button', { name: 'Back to Open (o)' })).toBeTruthy();
    expect(within(row()).getByRole('button', { name: 'Follow up (r)' })).toBeTruthy();
    const button = within(detail()).getByRole<HTMLButtonElement>('button', { name: intent === 'followup' ? /^Follow up/ : /^Back to Open/ });
    expect(button.disabled).toBe(false);
    if (intent === 'followup') {
      fireEvent.click(button);
      fireEvent.change(within(detail()).getByRole('textbox'), { target: { value: 'Please check the new limits once more.' } });
      await act(async () => { fireEvent.click(within(detail()).getByRole('button', { name: /Send follow/ })); });
    } else await act(async () => { fireEvent.click(button); });
    await waitFor(() => expect(transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(1));
    expect(transport.mutations.find(request => request.command.command === 'input_submit')?.command).toMatchObject({ params: { kind: intent } });
    const next = Object.values(session.inputs).find(input => input?.target.item_id === item.id && input.id !== earlierId)!;
    expect(next.seq).toBeGreaterThan(earlier.seq);
    expect(session.inputs[earlierId]!.state).toBe('queued');
  });

  it.each(['tree', 'detail', 'graph'] as const)('uses a to Ack from %s without opening an answer', async source => {
    const transport = await mount();
    let target = row();
    // `a` acts on the selected item, so the item is selected first (the Map row stays the focus owner).
    fireEvent.click(target);
    const opened = await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1.1"]' });
    if (source === 'detail') target = opened;
    if (source === 'graph') { fireEvent.keyDown(target, { key: 'g' }); await screen.findByRole('group', { name: 'Graph legend' }); target = row(); }
    await act(async () => { target.focus(); fireEvent.keyDown(target, { key: 'a' }); });
    await holdOver();
    await waitFor(() => expect(acks(transport)).toHaveLength(1));
    expect(transport.mutations.some(value => value.command.command === 'input_submit')).toBe(false);
    expect(transport.sessions.get(route.session_id)!.items['1.1']!.status).toBe('done');
  });

  it('keeps a as answer on a waiting question and leaves typing alone', async () => {
    const transport = await mount();
    // `a` acts on the selected item: select the question, then ask to answer it.
    fireEvent.click(row('2')); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="2"]' });
    row('2').focus(); fireEvent.keyDown(row('2'), { key: 'a' });
    const waiting = await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="2"]' });
    expect(within(waiting).getByRole('group', { name: 'Answer' })).toBeDefined();
    expect(row('2').querySelector('.tree-answer')).toBeNull();
    expect(acks(transport)).toHaveLength(0);
    fireEvent.click(row()); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1.1"]' });
    const words = within(detail()).getByRole('textbox');
    fireEvent.keyDown(words, { key: 'a' });
    expect(acks(transport)).toHaveLength(0);
  });

  it('opens detail from a graph node, where Ack can be applied', async () => {
    const transport = await mount();
    fireEvent.keyDown(row(), { key: 'g' }); await screen.findByRole('group', { name: 'Graph legend' });
    expect(row().classList.contains('graph-node')).toBe(true);
    fireEvent.click(row()); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1.1"]' });
    expect(acks(transport)).toHaveLength(0);
    await act(async () => { fireEvent.click(within(detail()).getByRole('button', { name: 'Ack → Done' })); });
    await holdOver();
    await waitFor(() => expect(acks(transport)).toHaveLength(1));
  });

  it.each(['tree', 'detail'] as const)('surfaces a plain refusal from %s and permits another attempt', async source => {
    const transport = new AckTransport(); transport.refuse = true; await mount(transport);
    if (source === 'detail') { fireEvent.click(row()); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1.1"]' }); }
    const host = source === 'detail' ? detail() : row();
    await act(async () => { fireEvent.click(within(host).getByRole('button', { name: 'Ack → Done' })); });
    await holdOver();
    expect(await screen.findByText('This item can’t be acknowledged now. Check its current status and any question waiting for you.')).toBeTruthy();
    expect(screen.queryByText('Ack predicate no longer holds.')).toBeNull();
    transport.refuse = false;
    await act(async () => { fireEvent.click(within(source === 'detail' ? detail() : row()).getByRole('button', { name: 'Ack → Done' })); });
    await holdOver();
    await waitFor(() => expect(acks(transport)).toHaveLength(2));
    expect(transport.sessions.get(route.session_id)!.items['1.1']!.status).toBe('done');
  });

  it.each(['tree', 'detail'] as const)('clears a %s refusal when another item is selected and keeps it cleared on return', async source => {
    const transport = new AckTransport(); transport.refuse = true; await mount(transport);
    fireEvent.click(row()); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1.1"]' });
    await act(async () => { fireEvent.click(within(source === 'tree' ? row() : detail()).getByRole('button', { name: 'Ack → Done' })); });
    await holdOver();
    expect(await screen.findByText(refusal)).toBeTruthy();
    fireEvent.click(row('2')); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="2"]' });
    await waitFor(() => expect(screen.queryByText(refusal)).toBeNull());
    fireEvent.click(row()); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1.1"]' });
    expect(screen.queryByText(refusal)).toBeNull();
  });

  it.each(['tree', 'detail'] as const)('shares one item refusal across both views and clears it after Ack succeeds from %s', async source => {
    const transport = new AckTransport(); transport.refuse = true; await mount(transport);
    fireEvent.click(row()); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1.1"]' });
    for (const [index, host] of [row(), detail()].entries()) {
      await act(async () => { fireEvent.click(within(host).getByRole('button', { name: 'Ack → Done' })); });
      await holdOver();
      await waitFor(() => expect(acks(transport)).toHaveLength(index + 1));
      expect(await screen.findByText(refusal, { selector: '.pw-note-text' })).toBeTruthy();
    }
    expect(screen.getAllByText(refusal)).toHaveLength(1);
    expect(notices.getSnapshot().filter(notice => notice.text === refusal).map(notice => notice.id))
      .toEqual([JSON.stringify(['item-ack', route.project_id, route.session_id, '1.1'])]);
    transport.refuse = false;
    await act(async () => { fireEvent.click(within(source === 'tree' ? row() : detail()).getByRole('button', { name: 'Ack → Done' })); });
    await holdOver();
    await waitFor(() => expect(detail().getAttribute('data-status')).toBe('done'));
    expect(screen.queryByText(refusal)).toBeNull();
    expect(acks(transport)).toHaveLength(3);
  });

  it('still reports a refusal that arrives after the owner selected another item: a failed Ack is never lost silently', async () => {
    const transport = new AckTransport(); transport.refuse = true;
    let release!: () => void;
    transport.ackWait = new Promise(resolve => { release = resolve; });
    await mount(transport);
    fireEvent.click(row()); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1.1"]' });
    fireEvent.click(within(row()).getByRole('button', { name: 'Ack → Done' }));
    const saving = flushAckHold(route.session_id);   // the window is over; the write waits on the gate
    await waitFor(() => expect(acks(transport)).toHaveLength(1));
    fireEvent.click(row('2')); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="2"]' });
    await act(async () => { release(); await saving; });
    await waitFor(() => expect(within(row()).getByRole<HTMLButtonElement>('button', { name: 'Ack → Done' }).disabled).toBe(false));
    // The item stays to ack and the owner is told, wherever they are looking now.
    expect(await screen.findByText(refusal)).toBeTruthy();
    expect(transport.sessions.get(route.session_id)!.items['1.1']!.ack_to).toBe('done');
  });

  it.each(['detail', 'graph'] as const)('clears a keyboard Ack refusal from %s on selection changes and on a button Ack success', async source => {
    const transport = new AckTransport(); transport.refuse = true; await mount(transport);
    fireEvent.click(row()); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1.1"]' });
    if (source === 'graph') { fireEvent.keyDown(row(), { key: 'g' }); await screen.findByRole('group', { name: 'Graph legend' }); }
    const host = () => source === 'detail' ? detail() : row();
    const pressAck = async () => { await act(async () => { host().focus(); fireEvent.keyDown(host(), { key: 'a' }); }); await holdOver(); };
    await pressAck();
    expect(await screen.findByText(refusal, { selector: '.pw-note-text' })).toBeTruthy();
    expect(notices.getSnapshot().find(notice => notice.text === refusal)?.id)
      .toBe(JSON.stringify(['item-ack', route.project_id, route.session_id, '1.1']));
    fireEvent.click(row('2')); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="2"]' });
    await waitFor(() => expect(screen.queryByText(refusal)).toBeNull());
    fireEvent.click(row()); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1.1"]' });
    expect(screen.queryByText(refusal)).toBeNull();
    await pressAck();
    expect(await screen.findByText(refusal, { selector: '.pw-note-text' })).toBeTruthy();
    transport.refuse = false;
    await act(async () => { fireEvent.click(within(source === 'detail' ? row() : detail()).getByRole('button', { name: 'Ack → Done' })); });
    await holdOver();
    await waitFor(() => expect(detail().getAttribute('data-status')).toBe('done'));
    expect(screen.queryByText(refusal)).toBeNull();
    expect(acks(transport)).toHaveLength(3);
  });

  it('still reports a keyboard Ack refusal that arrives after selecting another item', async () => {
    const transport = new AckTransport(); transport.refuse = true;
    let release!: () => void;
    transport.ackWait = new Promise(resolve => { release = resolve; });
    await mount(transport);
    fireEvent.click(row()); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1.1"]' });
    await act(async () => { detail().focus(); fireEvent.keyDown(detail(), { key: 'a' }); });
    const saving = flushAckHold(route.session_id);   // the window is over; the write waits on the gate
    await waitFor(() => expect(acks(transport)).toHaveLength(1));
    fireEvent.click(row('2')); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="2"]' });
    await act(async () => { release(); await saving; });
    await waitFor(() => expect(within(row()).getByRole<HTMLButtonElement>('button', { name: 'Ack → Done' }).disabled).toBe(false));
    expect(await screen.findByText(refusal)).toBeTruthy();
  });

  it('removes the app keyboard Ack refusal when the workspace unmounts', async () => {
    const transport = new AckTransport(); transport.refuse = true;
    await mount(transport);
    fireEvent.click(row()); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1.1"]' });
    await act(async () => { detail().focus(); fireEvent.keyDown(detail(), { key: 'a' }); });
    await holdOver();
    expect(await screen.findByText(refusal, { selector: '.pw-note-text' })).toBeTruthy();
    cleanup();
    expect(notices.getSnapshot().some(notice => notice.id === JSON.stringify(['item-ack', route.project_id, route.session_id, '1.1']))).toBe(false);
  });

  it('keeps a lifecycle failure visible alongside an Ack refusal', async () => {
    const transport = new AckTransport(); transport.refuse = true; transport.refuseArchive = true;
    const session = transport.sessions.get(route.session_id)!, template = Object.values(session.topics).find(topic => topic)!;
    const topicId = '00000000-0000-4000-8000-000000000090';
    session.topics[topicId] = { ...structuredClone(template), id: topicId, name: 'Archived notes', archived_at: null, order: 99 };
    await mount(transport);
    await act(async () => { fireEvent.click(within(row()).getByRole('button', { name: 'Ack → Done' })); });
    await holdOver();
    expect(await screen.findByText(refusal)).toBeTruthy();
    const band = screen.getByText('Archived notes', { selector: '.tree-topic-name' }).closest('[role="treeitem"]') as HTMLElement;
    fireEvent.click(within(band).getByRole('button', { name: /^More actions for/ }));
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: /^Archive topic/ })); });
    expect(await screen.findByText('This changed while you were working. Look at it as it is now, then try again.')).toBeTruthy();
    expect(screen.getByText(refusal)).toBeTruthy();
  });
});

describe('the Ack hold in the app (D11)', () => {
  const selectItem = async () => { fireEvent.click(row()); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1.1"]' }); };
  const ackButton = () => within(detail()).getByRole('button', { name: 'Ack → Done' });

  it('Details shows "Acked · Undo" in place of its Ack button, and Undo writes nothing', async () => {
    const transport = await mount(); await selectItem();
    await act(async () => { fireEvent.click(ackButton()); });
    expect(within(detail()).queryByRole('button', { name: 'Ack → Done' })).toBeNull();
    const undo = within(detail()).getByRole('button', { name: 'Undo Ack' });
    expect(undo.textContent).toBe('Acked · Undo');
    fireEvent.click(undo);
    expect(ackButton()).toBeTruthy();
    await holdOver();
    expect(acks(transport)).toHaveLength(0);
    expect(transport.sessions.get(route.session_id)!.items['1.1']!.ack_to).toBe('done');
  });

  it('writes one Ack however many times the owner presses Ack, a, or the Details button while it is held', async () => {
    const transport = await mount(); await selectItem();
    await act(async () => { fireEvent.click(within(row()).getByRole('button', { name: 'Ack → Done' })); });
    await act(async () => { detail().focus(); fireEvent.keyDown(detail(), { key: 'a' }); fireEvent.keyDown(detail(), { key: 'a' }); });
    await holdOver();
    await waitFor(() => expect(detail().getAttribute('data-status')).toBe('done'));
    await holdOver();
    expect(acks(transport)).toHaveLength(1);
  });

  it('a Tree to Graph switch does not flush a held Ack', async () => {
    const transport = await mount(); await selectItem();
    await act(async () => { fireEvent.click(within(row()).getByRole('button', { name: 'Ack → Done' })); });
    fireEvent.keyDown(row(), { key: 'g' }); await screen.findByRole('group', { name: 'Graph legend' });
    await act(async () => { await new Promise(done => setTimeout(done, 150)); });
    expect(acks(transport)).toHaveLength(0);
    await holdOver();
    await waitFor(() => expect(acks(transport)).toHaveLength(1));
  });

  it('switching to another session saves the held Ack at once, once', async () => {
    const transport = await mount(); await selectItem();
    await act(async () => { fireEvent.click(within(row()).getByRole('button', { name: 'Ack → Done' })); });
    expect(acks(transport)).toHaveLength(0);
    await goToSession({ project_id: route.project_id, session_id: secondId });
    await waitFor(() => expect(acks(transport)).toHaveLength(1));
    expect(transport.sessions.get(route.session_id)!.items['1.1']!.status).toBe('done');
  });

  const heldNotice = () => heldToast();
  const closeDetails = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Close detail' }));
    await waitFor(() => expect(screen.queryByLabelText(/^Detail of /)).toBeNull());
  };

  it('with the row and Details showing it there is no notice; closing Details leaves the row as the Undo', async () => {
    await mount(); await selectItem();
    await act(async () => { fireEvent.click(within(row()).getByRole('button', { name: 'Ack → Done' })); });
    expect(heldNotice()).toBeUndefined();
    await closeDetails();
    expect(heldNotice()).toBeUndefined();
  });

  it('a Tree to Graph switch mid-hold leaves an Undo that writes nothing', async () => {
    const transport = await mount(); await selectItem();
    await act(async () => { fireEvent.click(within(row()).getByRole('button', { name: 'Ack → Done' })); });
    await closeDetails();
    fireEvent.keyDown(row(), { key: 'g' }); await screen.findByRole('group', { name: 'Graph legend' });
    await waitFor(() => expect(heldNotice()).toBeDefined());
    expect(acks(transport)).toHaveLength(0);
    act(() => { toasts.runUndo(heldNotice()!.id); });
    await holdOver();
    expect(acks(transport)).toHaveLength(0);
    expect(heldNotice()).toBeUndefined();
  });

  it('an Ack whose row sits inside a folded topic shows the notice', async () => {
    const transport = await mount(); await selectItem();
    await act(async () => { fireEvent.click(within(row()).getByRole('button', { name: 'Ack → Done' })); });
    await closeDetails();
    expect(heldNotice()).toBeUndefined();
    fireEvent.click(within(row().closest('.tree-topic-group') as HTMLElement).getAllByRole('button', { name: 'Expand or collapse topic' })[0]!);
    await waitFor(() => expect(row()).toBeNull());
    expect(heldNotice()?.text).toBe('Acked “Record the retry limits”');
    await holdOver();
    await waitFor(() => expect(acks(transport)).toHaveLength(1));
    expect(heldNotice()).toBeUndefined();
  });

  it('an Ack from the Graph with no row or Details showing it says so in a notice whose Undo writes nothing', async () => {
    const transport = await mount(); await selectItem();
    fireEvent.keyDown(row(), { key: 'g' }); await screen.findByRole('group', { name: 'Graph legend' });
    fireEvent.click(screen.getByRole('button', { name: 'Close detail' }));
    await waitFor(() => expect(screen.queryByLabelText(/^Detail of /)).toBeNull());
    await act(async () => { row().focus(); fireEvent.keyDown(row(), { key: 'a' }); });
    const notice = await waitFor(() => {
      const found = heldToast();
      expect(found).toBeTruthy(); return found!;
    });
    expect(typeof notice.undo).toBe('function');
    act(() => { toasts.runUndo(notice.id); });
    await holdOver();
    expect(acks(transport)).toHaveLength(0);
    expect(heldToast()).toBeUndefined();
  });
});

describe('Ack eligibility follows the current question episode', () => {
  it.each(['open', 'in_progress', 'waiting_on_me', 'done', 'decided', 'dropped', 'replaced'] as ItemStatus[])('offers Ack only for eligible %s', status => {
    const transport = new AckTransport(), session = transport.sessions.get(route.session_id)!, item = session.items['1.1']!;
    item.status = status;
    expect(ackTarget(session, item)).toBe(status === 'open' || status === 'in_progress' ? 'done' : null);
    item.ack_to = null; expect(ackTarget(session, item)).toBeNull();
  });

  it.each(['queued', 'in_flight', 'handled', 'cancelled', 'skipped', 'needs_attention'] as const)('treats a %s input using question revision and supersession', state => {
    const transport = new AckTransport(), session = transport.sessions.get(route.session_id)!, item = session.items['1.1']!;
    item.ask = 'Confirm these limits?';
    expect(ackTarget(session, item)).toBeNull();
    const input = structuredClone(Object.values(session.inputs).find(value => value)!);
    input.target.item_id = item.id; input.answer_id = null; input.state = state; input.kind = 'reply'; input.payload.intent = 'reply';
    input.payload.target_snapshot.question_revision = item.question_revision;
    session.inputs = { [input.id]: input }; session.answers = [];
    const expected = state === 'queued' || state === 'in_flight' || state === 'handled' ? 'done' : null;
    expect(ackTarget(session, item)).toBe(expected);
    expect(ownerReplied(session, item)).toBe(false); // The Waiting rail remains status-scoped.
    ++input.payload.target_snapshot.question_revision!;
    expect(ackTarget(session, item)).toBeNull();
    input.payload.target_snapshot.question_revision = item.question_revision;
  });

  it.each(['followup', 'drop', 'reply'] as const)('keeps a handled %s answerable while the saved item is Waiting on me', kind => {
    const transport = new AckTransport(), session = transport.sessions.get(route.session_id)!, item = session.items['2']!;
    const input = structuredClone(Object.values(session.inputs).find(value => value)!);
    input.target.item_id = item.id; input.answer_id = null; input.state = 'handled'; input.kind = kind; input.payload.intent = kind;
    input.payload.target_snapshot.question_revision = item.question_revision;
    session.inputs = { [input.id]: input }; session.answers = [];
    expect(item.status).toBe('waiting_on_me');
    expect(currentQuestionReplied(session, item)).toBe(false);
    expect(ownerReplied(session, item)).toBe(false);
    expect(ackTarget(session, item)).toBeNull();
    // A saved Open/InProgress item retains handled replies for Ack; a candidate
    // status must never be substituted when checking a still-waiting item.
    for (const status of ['open', 'in_progress'] as const) {
      const saved = { ...item, status };
      expect(currentQuestionReplied(session, saved)).toBe(true);
      expect(ackTarget(session, saved)).toBe('decided');
    }
    expect(item.status).toBe('waiting_on_me');
    expect(ackTarget(session, item)).toBeNull();
  });

  it('allows a standing answer but refuses superseded answers and unanswered new episodes', () => {
    const transport = new AckTransport(), session = transport.sessions.get(route.session_id)!, item = session.items['1.1']!;
    item.ask = 'Confirm these limits?';
    const answer = structuredClone(session.answers[0]!);
    answer.item_id = item.id; answer.question_revision = item.question_revision; answer.supersedes_answer_id = null;
    session.answers = [answer]; session.inputs = {};
    expect(ackTarget(session, item)).toBe('done');
    const newer = { ...answer, id: crypto.randomUUID(), question_revision: item.question_revision + 1, supersedes_answer_id: answer.id };
    session.answers.push(newer);
    expect(ackTarget(session, item)).toBeNull();
    ++item.question_revision;
    expect(ackTarget(session, item)).toBe('done');
  });

  it.each(['question', 'ask', 'options', 'revision'] as const)('recognizes an answered retained round but blocks a genuine %s edit', change => {
    const transport = new AckTransport(), session = transport.sessions.get(route.session_id)!, item = session.items['2']!;
    const round = session.rounds[item.current_round_id!]!, answer = structuredClone(session.answers[0]!);
    round.question_snapshot = item.question; round.ask_snapshot = item.ask; round.options_snapshot = structuredClone(item.options);
    round.question_revision = item.question_revision;
    answer.item_id = item.id; answer.question_revision = item.question_revision; answer.supersedes_answer_id = null;
    session.answers = [answer]; session.inputs = {};
    item.status = 'open'; ++item.question_revision;
    expect(ackTarget(session, item)).toBe('decided');
    if (change === 'question') item.question += ' revised';
    else if (change === 'ask') item.ask += ' revised';
    else if (change === 'options') item.options.push({ id: 'revised-option', label: 'Revised limits', consequence: 'Use the revised limits.', recommended: false });
    else ++item.question_revision;
    expect(ackTarget(session, item)).toBeNull();
  });

  it('uses the latest saved closed round when its current pointer has been cleared', () => {
    const transport = new AckTransport(), session = transport.sessions.get(route.session_id)!, item = session.items['2']!;
    const round = session.rounds[item.current_round_id!]!, answer = structuredClone(session.answers[0]!);
    round.question_snapshot = item.question; round.ask_snapshot = item.ask; round.options_snapshot = structuredClone(item.options);
    round.question_revision = item.question_revision; round.closed_at = session.updated_at;
    answer.item_id = item.id; answer.question_revision = item.question_revision; answer.supersedes_answer_id = null;
    session.answers = [answer]; session.inputs = {};
    item.current_round_id = null; item.status = 'open'; ++item.question_revision;
    expect(ackTarget(session, item)).toBe('decided');
    // A newer round for another question must win over an older matching episode.
    session.rounds['new-round'] = { ...round, id: 'new-round', ordinal: round.ordinal + 1, question_revision: item.question_revision, ask_snapshot: 'A later question' };
    expect(ackTarget(session, item)).toBeNull();
  });

  it.each(['queued', 'in_flight', 'handled', 'standing'] as const)('accepts a %s reply at the current revision even when an older round is retained', state => {
    const transport = new AckTransport(), session = transport.sessions.get(route.session_id)!, item = session.items['2']!;
    const round = session.rounds[item.current_round_id!]!;
    round.question_snapshot = item.question; round.ask_snapshot = item.ask; round.options_snapshot = structuredClone(item.options);
    round.question_revision = item.question_revision;
    const input = structuredClone(Object.values(session.inputs).find(input => input)!);
    item.status = 'open'; ++item.question_revision;
    input.target.item_id = item.id; input.payload.target_snapshot.question_revision = item.question_revision;
    input.kind = 'reply'; input.payload.intent = 'reply';
    input.answer_id = null; input.state = state === 'standing' ? 'handled' : state;
    session.inputs = { [input.id]: input }; session.answers = [];
    if (state === 'standing') {
      const answer = structuredClone(new AckTransport().sessions.get(route.session_id)!.answers[0]!);
      answer.item_id = item.id; answer.question_revision = item.question_revision; answer.input_id = input.id; answer.supersedes_answer_id = null;
      session.answers = [answer];
    }
    expect(ackTarget(session, item)).toBe('decided');
  });
});
