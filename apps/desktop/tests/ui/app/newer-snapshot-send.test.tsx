// A Send that lands while the store already holds a newer session snapshot than the one on screen (a busy Mac renders the
// refresh a moment late). The owner's click is never a silent no-op: it sends exactly once with the owner's words, or, when
// the item itself changed, nothing goes and the review shows, with the words kept.
//
// | Trigger                                  | Newer snapshot           | Must hold                                                  |
// |------------------------------------------|--------------------------|------------------------------------------------------------|
// | Details reply, Send reply click          | another item only        | one send, the exact words                                  |
// | Details reply, Send reply click          | this item revised        | no send; the review and the refusal show; words kept       |
// | Details answer, own words, Send click    | another item only        | one send, the exact words                                  |
// | Details answer, own words, Send click    | this question revised    | no send; the review shows; words kept                      |
// | Details answer, 1–9 key (focus request)  | another item only        | one send, the picked option                                |
// | Details answer, 1–9 key (focus request)  | this question revised    | no send; the refusal stays after the next refresh          |
// | dock answer, picked option, Send click   | another item only        | one send, the picked option                                |
// | dock answer, picked option, Send click   | this question revised    | no send; the review shows; the choice kept                 |
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { SessionStore, type SessionState } from '../../../src/data/session-store';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { ItemDetail } from '../../../src/ui/detail/ItemDetail';
import { AnswerSlot, changedText } from '../../../src/ui/detail/AnswerSlot';
import { notices } from '../../../src/ui/pages/notices';
import type { Item, Session } from '../../../src/generated/domain/models';
import { AppTransport, route } from './transport';
import { answerWords } from '../answer/words';

const stores: SessionStore[] = [];
afterEach(() => { cleanup(); stores.splice(0).forEach(store => store.close()); notices.clear(); localStorage.clear(); vi.restoreAllMocks(); });

const itemChanged = 'This item changed. Review it before sending. Your text is kept.';
const sends = (transport: AppTransport) => transport.mutations.filter(request => request.command.command === 'input_submit');
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); });
const choices: Item['options'] = [
  { id: 'window-1', label: 'Window first', consequence: 'The first way.', recommended: true },
  { id: 'window-2', label: 'Window second', consequence: 'The second way.', recommended: false },
];
type Change = 'other' | 'this';
/** The newer snapshot the transport serves next: another item edited, or this item's question (and revision) moved on. */
function revise(session: Session, itemId: string, change: Change) {
  if (change === 'other') { session.items['4']!.question = `${session.items['4']!.question} (edited)`; ++session.items['4']!.revision; return; }
  const item = session.items[itemId]!, revised = `${item.question} Given the new rota?`;
  item.question = revised; item.question_revision++; item.revision++;
  const round = item.current_round_id ? session.rounds[item.current_round_id] : undefined;
  if (round) { round.question_revision = item.question_revision; round.question_snapshot = revised; }
}
type Publisher = { publish(update: Partial<SessionState>): void };
const publish = (SessionStore.prototype as unknown as Publisher).publish;
/**
 * The transport serves the newer session; the click lands in the same tick the store takes it, before React renders it.
 * The click handler therefore runs with the last rendered snapshot while the store already holds the newer one.
 */
async function clickAsNewerLands(transport: AppTransport, itemId: string, change: Change, target: () => HTMLElement) {
  const session = transport.sessions.get(route.session_id)!;
  revise(session, itemId, change);
  const revision = ++session.revision;
  let clicked = false;
  vi.spyOn(SessionStore.prototype as unknown as Publisher, 'publish').mockImplementation(function (this: SessionStore, update) {
    publish.call(this, update);
    const state = this.getSnapshot();
    if (clicked || state.status !== 'ready' || state.snapshot?.session.id !== session.id || state.snapshot.session.revision !== revision) return;
    clicked = true;
    target().click();
  });
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    for (let tick = 0; tick < 200 && !clicked; tick++) await new Promise(resolve => setTimeout(resolve, 10));
  });
  vi.mocked((SessionStore.prototype as unknown as Publisher).publish).mockRestore();
  expect(clicked).toBe(true);
}

async function setup() {
  const transport = new AppTransport(), service = createDesktopService(transport);
  const session = transport.sessions.get(route.session_id)!;
  session.items['2']!.options = structuredClone(choices);
  session.rounds[session.items['2']!.current_round_id!]!.options_snapshot = structuredClone(choices);
  const store = new SessionStore(service, route), drafts = new OwnerDraftStore(service);
  stores.push(store);
  await Promise.all([store.refresh(), drafts.load()]);
  return { transport, service, store, drafts, session };
}

describe('Details reply', () => {
  it.each(['other', 'this'] as const)('a newer snapshot (%s item changed) at the Send reply click', async change => {
    const { transport, store, drafts } = await setup();
    render(<ItemDetail store={store} drafts={drafts} itemId="1.1" later={false} onOpenItem={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    const words = 'Keep exactly these reply words.';
    fireEvent.change(screen.getByLabelText('Reply message'), { target: { value: words } });
    const button = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Send reply' });
    await waitFor(() => expect(button().disabled).toBe(false));
    await clickAsNewerLands(transport, '1.1', change, button);
    await flush();
    if (change === 'other') {
      await waitFor(() => expect(sends(transport)).toHaveLength(1));
      expect(sends(transport)[0]!.command).toMatchObject({ params: { kind: 'reply', target: { item_id: '1.1' }, text: words } });
    } else {
      expect(sends(transport)).toHaveLength(0);
      expect(screen.getByRole('button', { name: 'Review this question' })).toBeTruthy();
      expect(screen.getByLabelText<HTMLTextAreaElement>('Reply message').value).toBe(words);
      expect(button().disabled).toBe(true);
    }
    // A later refresh never turns the click into a send, nor hides why it did not go.
    await act(async () => { await store.refresh(true); });
    await flush();
    expect(sends(transport)).toHaveLength(change === 'other' ? 1 : 0);
    if (change === 'this') expect(screen.getAllByRole('alert').some(alert => alert.textContent === itemChanged || alert.textContent === changedText)).toBe(true);
  });
});

describe('Details answer', () => {
  it.each(['other', 'this'] as const)('a newer snapshot (%s item changed) at the Send click with own words', async change => {
    const { transport, store, drafts } = await setup();
    render(<ItemDetail store={store} drafts={drafts} itemId="2" later={false} onOpenItem={vi.fn()} />);
    const slot = () => document.querySelector<HTMLElement>('.detail-answer-slot')!;
    await waitFor(() => expect(slot().querySelector('[data-answer-own]')).not.toBeNull());
    const box = answerWords(slot()), words = 'Keep exactly these answer words.';
    fireEvent.change(box, { target: { value: words } });
    const button = () => slot().querySelector<HTMLButtonElement>('[data-answer-send]')!;
    await waitFor(() => expect(button().disabled).toBe(false));
    await clickAsNewerLands(transport, '2', change, button);
    await flush();
    if (change === 'other') {
      await waitFor(() => expect(sends(transport)).toHaveLength(1));
      expect(sends(transport)[0]!.command).toMatchObject({ params: { kind: 'answer', target: { item_id: '2' }, text: words, selected_option_id: null } });
    } else {
      expect(sends(transport)).toHaveLength(0);
      expect(within(slot()).getByText(changedText)).toBeTruthy();
      expect(answerWords(slot()).value).toBe(words);
    }
    await act(async () => { await store.refresh(true); });
    await flush();
    expect(sends(transport)).toHaveLength(change === 'other' ? 1 : 0);
  });

  it.each(['other', 'this'] as const)('a newer snapshot (%s item changed) as a 1–9 key sends the picked option', async change => {
    const { transport, service, store, drafts, session } = await setup();
    const item = session.items['2']!;
    const answerTarget = { optionId: 'window-1', revision: item.revision, questionRevision: item.question_revision, bindingId: session.active_binding_id };
    const props = { drafts, store, itemId: '2', onEscape: vi.fn() };
    const view = render(<AnswerSlot {...props} />);
    await waitFor(() => expect(document.querySelector('[data-answer-option="0"]')).not.toBeNull());
    // The newer snapshot, read through the transport by a second store, reaches this store right before the key's handler reads it.
    revise(session, '2', change); ++session.revision;
    const fresh = new SessionStore(service, route); stores.push(fresh);
    await fresh.refresh();
    const deliver = () => (store as unknown as Publisher).publish({ ...fresh.getSnapshot() });
    await act(async () => {
      view.rerender(<AnswerSlot {...props} focusRequest={{ token: 1, intent: 'answer', optionIndex: 0, sendOption: true, answerTarget }} onFocusRequestConsumed={deliver} />);
    });
    await flush();
    if (change === 'other') {
      await waitFor(() => expect(sends(transport)).toHaveLength(1));
      expect(sends(transport)[0]!.command).toMatchObject({ params: { kind: 'answer', target: { item_id: '2' }, selected_option_id: 'window-1' } });
    } else {
      expect(sends(transport)).toHaveLength(0);
      expect(screen.getByRole('alert').textContent).toBe('This item changed. Review it before sending. Your note is kept.');
    }
    await act(async () => { await store.refresh(true); });
    await flush();
    expect(sends(transport)).toHaveLength(change === 'other' ? 1 : 0);
    if (change === 'this') expect(screen.getByRole('alert').textContent).toBe('This item changed. Review it before sending. Your note is kept.');
  });
});

describe('dock answer', { timeout: 20_000 }, () => {
  it.each(['other', 'this'] as const)('a newer snapshot (%s item changed) at the dock Send click', async change => {
    const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
    session.items['2']!.options = structuredClone(choices);
    session.rounds[session.items['2']!.current_round_id!]!.options_snapshot = structuredClone(choices);
    transport.preferences.global.selected_navigation = { kind: 'session', session: route };
    Object.assign(transport.preferences.sessions[0]!, { tab_open: true });
    render(<DesktopApp service={createDesktopService(transport)} />);
    const dock = () => screen.getByRole('region', { name: 'Answer dock' });
    const current = () => dock().querySelector<HTMLElement>('.answer-dock-current');
    const tree = await screen.findByRole('tree', { name: 'Session items' });
    await waitFor(() => expect(tree.getAttribute('aria-busy')).toBe('false'));
    if (!current()) fireEvent.click(await within(dock()).findByRole('button', { name: /waiting$/ }));
    await waitFor(() => expect(current()?.querySelector('[data-answer-option="1"]')).not.toBeNull());
    fireEvent.click(current()!.querySelector<HTMLButtonElement>('[data-answer-option="1"]')!);
    const button = () => current()!.querySelector<HTMLButtonElement>('[data-answer-send]')!;
    await waitFor(() => expect(button().disabled).toBe(false));
    await clickAsNewerLands(transport, '2', change, button);
    await flush();
    if (change === 'other') {
      await waitFor(() => expect(sends(transport)).toHaveLength(1));
      expect(sends(transport)[0]!.command).toMatchObject({ params: { kind: 'answer', target: { item_id: '2' }, selected_option_id: 'window-2' } });
    } else {
      expect(sends(transport)).toHaveLength(0);
      expect(within(current()!).getByText(changedText)).toBeTruthy();
      expect(current()!.querySelector('[data-answer-option="1"]')?.getAttribute('aria-pressed')).toBe('true');
    }
  });
});
