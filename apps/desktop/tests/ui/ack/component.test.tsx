import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import type { ContinuePreview, OwnerMutationRequest, OwnerQueryRequest } from '../../../src/generated/core';
import type { ItemStatus } from '../../../src/generated/domain/models';
import { ackTarget } from '../../../src/ui/shared/ack';
import { ownerReplied } from '../../../src/selectors/waiting/replied';
import { continueGroups } from '../../../src/ui/pages/model';
import { AppTransport, route } from '../app/transport';
import { sessionButton } from '../app/open';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

class AckTransport extends AppTransport {
  refuse = false;
  refuseArchive = false;
  ackWait: Promise<void> | null = null;
  constructor() {
    super();
    const session = this.sessions.get(route.session_id)!;
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
const detail = () => screen.getByLabelText('Detail of #1.1');
const acks = (transport: AppTransport) => transport.mutations.filter(value => value.command.command === 'ack');
const refusal = 'This item can’t be acknowledged now. Check its current status and any question waiting for you.';
async function mount(transport = new AckTransport()) {
  render(<DesktopApp service={createDesktopService(transport)} />);
  fireEvent.click(await sessionButton(route));
  await screen.findByRole('region', { name: 'Session tree' });
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Close session' }).disabled).toBe(false));
  return transport;
}

describe('local acknowledgement', () => {
  it('offers a quiet row Ack with a target tooltip and a topic count, while questions keep their answer controls', async () => {
    await mount();
    const button = within(row()).getByRole('button', { name: 'Ack: mark Done' });
    expect(button.textContent).toBe('Ack'); expect(button.title).toBe('Ack: mark Done');
    expect(button.closest('.tree-ack-slot')).not.toBeNull();
    expect(button.closest('.tree-actions')).toBeNull();
    expect(button.classList.contains('tree-action-ack')).toBe(true);
    expect(screen.getByText('1 to ack')).toBeTruthy();
    expect(within(row('2')).queryByRole('button', { name: /^Ack/ })).toBeNull();
    expect(document.querySelector('.shell-footer')?.textContent).toContain('ack / answer');
    const css = readFileSync(resolve(__dirname, '../../../src/ui/tree/tree.css'), 'utf8');
    expect(css).toMatch(/\.tree-actions\s*\{[^}]*visibility:\s*hidden/s);
    expect(css).toMatch(/\.tree-ack-slot\s*\{[^}]*display:\s*flex;[^}]*flex:\s*none/s);
    expect(css).toMatch(/\.tree-action-label\s*\{[^}]*white-space:\s*nowrap/s);
  });

  it.each(['done', 'decided', 'dropped'] as const)('names %s in the detail tooltip, refreshes and keeps Follow up and Back to Open', async target => {
    const transport = new AckTransport(), item = transport.sessions.get(route.session_id)!.items['1.1']!;
    item.ack_to = target;
    const revision = item.revision;
    await mount(transport);
    fireEvent.click(row()); await screen.findByLabelText('Detail of #1.1');
    const label = target[0].toUpperCase() + target.slice(1);
    const button = within(detail()).getByRole('button', { name: `Ack: mark ${label}` });
    expect(button.title).toBe(`Ack: mark ${label}`);
    expect(within(detail()).getByText(`Mark ${label}`)).toBeTruthy();
    expect(within(detail()).getByRole('button', { name: /^Reply/ })).toBeTruthy();
    await act(async () => { fireEvent.click(button); });
    await waitFor(() => expect(detail().getAttribute('data-status')).toBe(target));
    expect(acks(transport)).toHaveLength(1);
    expect(acks(transport)[0]).toMatchObject({ session: route, command: { api_version: 1, params: { item_id: '1.1', expected_revision: revision } } });
    expect(within(detail()).queryByRole('button', { name: /^Ack/ })).toBeNull();
    expect(within(detail()).getByRole('button', { name: /^Follow up/ })).toBeTruthy();
    expect(within(detail()).getByRole<HTMLButtonElement>('button', { name: /^Back to Open/ }).disabled).toBe(false);
    expect(screen.queryByText('1 to ack')).toBeNull();
    fireEvent.click(within(detail()).getByRole('button', { name: /^Follow up/ }));
    await waitFor(() => expect(within(detail()).getByRole('textbox')).toBeTruthy());
  });

  it('shows the proposed outcome and rationale before acknowledging it', async () => {
    const transport = new AckTransport(), item = transport.sessions.get(route.session_id)!.items['1.1']!;
    item.outcome = 'Retry limits are recorded.'; item.why = 'The limits now have an explicit owner.';
    await mount(transport);
    expect(row().querySelector('.tree-outcome')?.textContent).toContain(item.outcome);
    fireEvent.click(row()); await screen.findByLabelText('Detail of #1.1');
    expect(within(within(detail()).getByRole('region', { name: 'Current outcome' })).getByText('Proposed Done')).toBeTruthy();
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
    await mount(transport); fireEvent.click(row()); await screen.findByLabelText('Detail of #1.1');
    await act(async () => { fireEvent.click(within(detail()).getByRole('button', { name: 'Ack: mark Done' })); });
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
    if (source === 'detail') { fireEvent.click(target); target = await screen.findByLabelText('Detail of #1.1'); }
    if (source === 'graph') { fireEvent.keyDown(target, { key: 'g' }); await screen.findByText('One graph per topic'); target = row(); }
    await act(async () => { target.focus(); fireEvent.keyDown(target, { key: 'a' }); });
    await waitFor(() => expect(acks(transport)).toHaveLength(1));
    expect(transport.mutations.some(value => value.command.command === 'input_submit')).toBe(false);
    expect(transport.sessions.get(route.session_id)!.items['1.1']!.status).toBe('done');
  });

  it('keeps a as answer on a waiting question and leaves typing alone', async () => {
    const transport = await mount();
    row('2').focus(); fireEvent.keyDown(row('2'), { key: 'a' });
    await waitFor(() => expect(row('2').querySelector('.tree-answer')).not.toBeNull());
    expect(acks(transport)).toHaveLength(0);
    fireEvent.click(row()); await screen.findByLabelText('Detail of #1.1');
    const words = within(detail()).getByRole('textbox');
    fireEvent.keyDown(words, { key: 'a' });
    expect(acks(transport)).toHaveLength(0);
  });

  it('shows a small graph marker that opens detail, where Ack can be applied', async () => {
    const transport = await mount();
    fireEvent.keyDown(row(), { key: 'g' }); await screen.findByText('One graph per topic');
    const marker = within(row()).getByText('Ack');
    expect(marker.classList.contains('graph-node-ack')).toBe(true);
    expect(marker.title).toContain('Ack: mark Done');
    expect(within(row('2')).queryByText('Ack')).toBeNull();
    fireEvent.click(marker); await screen.findByLabelText('Detail of #1.1');
    expect(acks(transport)).toHaveLength(0);
    await act(async () => { fireEvent.click(within(detail()).getByRole('button', { name: 'Ack: mark Done' })); });
    await waitFor(() => expect(within(row()).queryByText('Ack')).toBeNull());
  });

  it.each(['tree', 'detail'] as const)('surfaces a plain refusal from %s and permits another attempt', async source => {
    const transport = new AckTransport(); transport.refuse = true; await mount(transport);
    if (source === 'detail') { fireEvent.click(row()); await screen.findByLabelText('Detail of #1.1'); }
    const host = source === 'detail' ? detail() : row();
    await act(async () => { fireEvent.click(within(host).getByRole('button', { name: 'Ack: mark Done' })); });
    expect(await screen.findByText('This item can’t be acknowledged now. Check its current status and any question waiting for you.')).toBeTruthy();
    expect(screen.queryByText('Ack predicate no longer holds.')).toBeNull();
    transport.refuse = false;
    await act(async () => { fireEvent.click(within(source === 'detail' ? detail() : row()).getByRole('button', { name: 'Ack: mark Done' })); });
    await waitFor(() => expect(acks(transport)).toHaveLength(2));
    expect(transport.sessions.get(route.session_id)!.items['1.1']!.status).toBe('done');
  });

  it.each(['tree', 'detail'] as const)('clears a %s refusal when another item is selected and keeps it cleared on return', async source => {
    const transport = new AckTransport(); transport.refuse = true; await mount(transport);
    fireEvent.click(row()); await screen.findByLabelText('Detail of #1.1');
    await act(async () => { fireEvent.click(within(source === 'tree' ? row() : detail()).getByRole('button', { name: 'Ack: mark Done' })); });
    expect(await screen.findByText(refusal)).toBeTruthy();
    fireEvent.click(row('2')); await screen.findByLabelText('Detail of #2');
    await waitFor(() => expect(screen.queryByText(refusal)).toBeNull());
    fireEvent.click(row()); await screen.findByLabelText('Detail of #1.1');
    expect(screen.queryByText(refusal)).toBeNull();
  });

  it.each(['tree', 'detail'] as const)('clears both views’ refusals after Ack succeeds from %s', async source => {
    const transport = new AckTransport(); transport.refuse = true; await mount(transport);
    fireEvent.click(row()); await screen.findByLabelText('Detail of #1.1');
    for (const host of [row(), detail()]) {
      await act(async () => { fireEvent.click(within(host).getByRole('button', { name: 'Ack: mark Done' })); });
    }
    expect(screen.getAllByText(refusal)).toHaveLength(2);
    transport.refuse = false;
    await act(async () => { fireEvent.click(within(source === 'tree' ? row() : detail()).getByRole('button', { name: 'Ack: mark Done' })); });
    await waitFor(() => expect(detail().getAttribute('data-status')).toBe('done'));
    expect(screen.queryByText(refusal)).toBeNull();
    expect(acks(transport)).toHaveLength(3);
  });

  it('does not restore a delayed refusal after the owner selects another item', async () => {
    const transport = new AckTransport(); transport.refuse = true;
    let release!: () => void;
    transport.ackWait = new Promise(resolve => { release = resolve; });
    await mount(transport);
    fireEvent.click(row()); await screen.findByLabelText('Detail of #1.1');
    fireEvent.click(within(row()).getByRole('button', { name: 'Ack: mark Done' }));
    await waitFor(() => expect(acks(transport)).toHaveLength(1));
    fireEvent.click(row('2')); await screen.findByLabelText('Detail of #2');
    await act(async () => { release(); });
    await waitFor(() => expect(within(row()).getByRole<HTMLButtonElement>('button', { name: 'Ack: mark Done' }).disabled).toBe(false));
    expect(screen.queryByText(refusal)).toBeNull();
  });

  it.each(['detail', 'graph'] as const)('clears a keyboard Ack refusal from %s on selection changes and on a button Ack success', async source => {
    const transport = new AckTransport(); transport.refuse = true; await mount(transport);
    fireEvent.click(row()); await screen.findByLabelText('Detail of #1.1');
    if (source === 'graph') { fireEvent.keyDown(row(), { key: 'g' }); await screen.findByText('One graph per topic'); }
    const host = () => source === 'detail' ? detail() : row();
    const pressAck = async () => { await act(async () => { host().focus(); fireEvent.keyDown(host(), { key: 'a' }); }); };
    await pressAck();
    expect(await screen.findByText(refusal, { selector: '.pw-note-text' })).toBeTruthy();
    fireEvent.click(row('2')); await screen.findByLabelText('Detail of #2');
    await waitFor(() => expect(screen.queryByText(refusal)).toBeNull());
    fireEvent.click(row()); await screen.findByLabelText('Detail of #1.1');
    expect(screen.queryByText(refusal)).toBeNull();
    await pressAck();
    expect(await screen.findByText(refusal, { selector: '.pw-note-text' })).toBeTruthy();
    transport.refuse = false;
    await act(async () => { fireEvent.click(within(source === 'detail' ? row() : detail()).getByRole('button', { name: 'Ack: mark Done' })); });
    await waitFor(() => expect(detail().getAttribute('data-status')).toBe('done'));
    expect(screen.queryByText(refusal)).toBeNull();
    expect(acks(transport)).toHaveLength(3);
  });

  it('ignores a delayed keyboard Ack refusal after selecting another item', async () => {
    const transport = new AckTransport(); transport.refuse = true;
    let release!: () => void;
    transport.ackWait = new Promise(resolve => { release = resolve; });
    await mount(transport);
    fireEvent.click(row()); await screen.findByLabelText('Detail of #1.1');
    await act(async () => { detail().focus(); fireEvent.keyDown(detail(), { key: 'a' }); });
    await waitFor(() => expect(acks(transport)).toHaveLength(1));
    fireEvent.click(row('2')); await screen.findByLabelText('Detail of #2');
    await act(async () => { release(); });
    await waitFor(() => expect(within(row()).getByRole<HTMLButtonElement>('button', { name: 'Ack: mark Done' }).disabled).toBe(false));
    expect(screen.queryByText(refusal)).toBeNull();
  });

  it('keeps a lifecycle failure visible alongside an Ack refusal', async () => {
    const transport = new AckTransport(); transport.refuse = true; transport.refuseArchive = true;
    const session = transport.sessions.get(route.session_id)!, template = Object.values(session.topics).find(topic => topic)!;
    const topicId = '00000000-0000-4000-8000-000000000090';
    session.topics[topicId] = { ...structuredClone(template), id: topicId, name: 'Archived notes', archived_at: null, order: 99 };
    await mount(transport);
    await act(async () => { fireEvent.click(within(row()).getByRole('button', { name: 'Ack: mark Done' })); });
    expect(await screen.findByText(refusal)).toBeTruthy();
    const band = screen.getByText('Archived notes', { selector: '.tree-topic-name' }).closest('[role="treeitem"]') as HTMLElement;
    await act(async () => { fireEvent.click(within(band).getByRole('button', { name: 'Archive' })); });
    expect(await screen.findByText('This changed while you were working. Look at it as it is now, then try again.')).toBeTruthy();
    expect(screen.getByText(refusal)).toBeTruthy();
  });
});

describe('Ack eligibility follows the current question episode', () => {
  it('previews preserved finished statuses and internal replacements without requesting Ack', () => {
    const transport = new AckTransport(), source = transport.sessions.get(route.session_id)!, ids = ['1', '5', '6', '7', '1.1'];
    for (const [id, status] of [['1', 'decided'], ['5', 'done'], ['6', 'dropped'], ['7', 'replaced']] as const) {
      source.items[id]!.status = status; source.items[id]!.outcome = `Recorded ${status} outcome.`;
    }
    source.items['7']!.replaced_by = '1';
    const before = JSON.stringify(source);
    const preview: ContinuePreview = { source: route, target: { ...route, session_id: 'other-session' }, source_topic_id: source.items['1']!.topic_id,
      source_revision: source.revision, source_sha256: 'a'.repeat(64), summary: 'Continue the notes.', readiness: { kind: 'blocked', reasons: ['target_closed'] },
      mapping: ids.map(id => ({ source_item_id: id, action: { kind: 'copy' } })) };
    const groups = continueGroups(source, preview);
    expect(groups.map(group => group.title)).toEqual(['Open or in progress · 1', 'Decided or done · 2', 'Dropped or replaced · 2']);
    expect(groups[0].lines).toEqual([{ id: '1.1', text: source.items['1.1']!.question }]);
    expect(groups[1].lines).toEqual([{ id: '1', text: 'Recorded decided outcome.' }, { id: '5', text: 'Recorded done outcome.' }]);
    expect(groups[2].lines).toEqual([{ id: '6', text: 'Recorded dropped outcome.' }, { id: '7', text: 'Recorded replaced outcome.' }]);
    expect(groups.some(group => group.title.includes('Ack') || group.lines.some(line => line.text.startsWith('Mark ')))).toBe(false);
    expect(JSON.stringify(source)).toBe(before);
    expect(source.items['7']!.replaced_by).toBe('1');
  });

  it('previews an external ImportedDrop with its imported outcome and preserves source history', () => {
    const transport = new AckTransport(), source = transport.sessions.get(route.session_id)!, item = source.items['7']!;
    item.status = 'replaced'; item.replaced_by = '8'; item.outcome = 'The original replacement outcome.';
    const before = JSON.stringify(source), outcome = 'Imported replacement outside the continued topic: 8';
    const preview: ContinuePreview = { source: route, target: { ...route, session_id: 'other-session' }, source_topic_id: item.topic_id,
      source_revision: source.revision, source_sha256: 'a'.repeat(64), summary: 'Continue the notes.', readiness: { kind: 'blocked', reasons: ['target_closed'] },
      mapping: [{ source_item_id: item.id, action: { kind: 'imported_drop', external_replacement_id: '8', outcome,
        why: 'The original source replacement remains provenance; it is not a live target edge.' } }] };
    expect(continueGroups(source, preview)).toEqual([{ title: 'Dropped or replaced · 1', icon: 'ph ph-x-circle', color: 'var(--st-dropped)',
      lines: [{ id: item.id, text: outcome }] }]);
    expect(JSON.stringify(source)).toBe(before);
  });
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
    input.target.item_id = item.id; input.answer_id = null; input.state = state;
    input.payload.target_snapshot.question_revision = item.question_revision;
    session.inputs = { [input.id]: input }; session.answers = [];
    const expected = state === 'queued' || state === 'in_flight' ? 'done' : null;
    expect(ackTarget(session, item)).toBe(expected);
    expect(ownerReplied(session, item)).toBe(false); // The Waiting rail remains status-scoped.
    ++input.payload.target_snapshot.question_revision!;
    expect(ackTarget(session, item)).toBeNull();
    input.payload.target_snapshot.question_revision = item.question_revision;
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

  it.each(['queued', 'in_flight', 'standing'] as const)('accepts a %s reply at the current revision even when an older round is retained', state => {
    const transport = new AckTransport(), session = transport.sessions.get(route.session_id)!, item = session.items['2']!;
    const round = session.rounds[item.current_round_id!]!;
    round.question_snapshot = item.question; round.ask_snapshot = item.ask; round.options_snapshot = structuredClone(item.options);
    round.question_revision = item.question_revision;
    const input = structuredClone(Object.values(session.inputs).find(input => input)!);
    item.status = 'open'; ++item.question_revision;
    input.target.item_id = item.id; input.payload.target_snapshot.question_revision = item.question_revision;
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
