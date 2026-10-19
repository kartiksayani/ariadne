// Topic mode in Details (alpha.21 E5, E6): the dock keeps a selected waiting item's question, and what is typed about the topic
// survives Esc, selecting an item and coming back.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { AppTransport, route } from './transport';

afterEach(cleanup);
const row = (id: string) => document.querySelector<HTMLElement>(`[role="treeitem"][data-item-id="${id}"]`)!;
const dock = () => screen.getByRole('region', { name: 'Answer dock' });
const dockText = () => dock().textContent ?? '';
const topicBox = () => document.querySelector<HTMLElement>('[data-composer="topic"]');
async function mount(transport = new AppTransport()) {
  transport.preferences.global.selected_navigation = { kind: 'session', session: route };
  transport.preferences.sessions.find(view => view.session.session_id === route.session_id)!.tab_open = true;
  const app = render(<DesktopApp service={createDesktopService(transport)} />);
  await screen.findByRole('region', { name: 'Session tree' });
  await waitFor(() => expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready'));
  return { transport, ...app };
}
const openTopic = () => {
  const band = document.querySelector<HTMLElement>('.tree-topic')!;
  fireEvent.click(within(band).getByRole('button', { name: /^More actions for/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: /^Reply to topic/ }));
};

describe('topic mode in Details', () => {
  it('keeps the dock’s question for a selected waiting item, and keeps what was typed through Esc, another item and back', async () => {
    const { transport } = await mount();
    fireEvent.click(row('2'));
    await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="2"]' });
    // Details answers item 2: the dock says so and holds only the other question.
    await waitFor(() => expect(dockText()).toContain('Answering “Which delivery window?” in Details'));
    openTopic();
    await waitFor(() => expect(topicBox()).not.toBeNull());
    // Topic mode answers nothing: item 2's question is back in the dock, and it stays selected in the Map.
    await waitFor(() => expect(dockText()).not.toContain('Answering'));
    expect(dockText()).toContain('Which delivery window?');
    expect(row('2').getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('[data-detail-item-id]')).toBeNull();
    const text = within(topicBox()!).getByRole('textbox') as HTMLTextAreaElement;
    await waitFor(() => expect(text.disabled).toBe(false));
    fireEvent.change(text, { target: { value: 'About the whole topic.' } });
    fireEvent.keyDown(text, { key: 'Escape' });
    expect(document.activeElement).toBe(document.querySelector('.tree-topic'));
    // Esc again closes Details; nothing typed is lost.
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Item detail' })).toBeNull());
    await waitFor(() => expect(transport.preferences.drafts.find(draft => draft.target.item_id === null)).toMatchObject({ intent: 'topic_reply', text: 'About the whole topic.' }));
    // Reply to topic again: the same words; picking an item leaves topic mode.
    openTopic();
    await waitFor(() => expect((within(topicBox()!).getByRole('textbox') as HTMLTextAreaElement).value).toBe('About the whole topic.'));
    fireEvent.click(row('4'));
    await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="4"]' });
    expect(topicBox()).toBeNull();
  });
  it('lets go of the topic box on Esc in the Graph, where there is no topic row, so the next Esc closes Details', async () => {
    const { transport } = await mount();
    openTopic();
    await waitFor(() => expect(topicBox()).not.toBeNull());
    fireEvent.click(screen.getByLabelText('Graph', { selector: 'button' }));
    await screen.findAllByRole('tree', { name: / graph$/ });
    expect(document.querySelector('.tree-topic')).toBeNull();
    const text = within(topicBox()!).getByRole('textbox') as HTMLTextAreaElement;
    await waitFor(() => expect(text.disabled).toBe(false));
    fireEvent.change(text, { target: { value: 'Typed in the Graph.' } });
    text.focus();
    fireEvent.keyDown(text, { key: 'Escape' });
    expect(document.activeElement).not.toBe(text);
    // Focus is on the page now, so Esc reaches the workspace keys and closes Details; the words stay saved.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(topicBox()).toBeNull());
    await waitFor(() => expect(transport.preferences.drafts.find(draft => draft.target.item_id === null)).toMatchObject({ intent: 'topic_reply', text: 'Typed in the Graph.' }));
  });

  // The topic of item 8 gets a reply to the whole topic that is queued (the agent has not taken it yet).
  const words = 'Keep the retry limits as they are';
  const queuedReply = (transport: AppTransport) => {
    const session = transport.sessions.get(route.session_id)!, topic = session.items['8']!.topic_id;
    const input = Object.values(session.inputs).find(value => value?.target.topic_id === topic)!;
    input.state = 'queued'; input.kind = 'topic_reply'; input.target = { topic_id: topic, item_id: null }; input.attempts = []; input.active_attempt_id = null;
    input.binding_id = session.active_binding_id!; input.payload.text = words; input.payload.selected_option_id = null;
    input.payload.target_snapshot.question_revision = null; input.payload.target_snapshot.item_question = null;
    // Alone in the session: a message queued behind another one that stopped has StuckNote's controls instead of an Undo.
    session.inputs = { [input.id]: input };
    return input.id;
  };
  const cancels = (transport: AppTransport) => transport.mutations.filter(request => request.command.command === 'input_cancel');
  // A queued reply cannot be taken back from the band's menu without opening topic mode first; the stuck notice's Edit (2 minutes on)
  // opens the topic's Details and takes it back in one step.
  const staleQueued = (transport: AppTransport) => {
    const id = queuedReply(transport), session = transport.sessions.get(route.session_id)!, input = session.inputs[id]!;
    input.created_at = new Date(Date.now() - 3 * 60_000).toISOString();
    return id;
  };
  const draftWith = (transport: AppTransport, text: string) => transport.preferences.drafts.some(draft => draft.target.item_id === null && draft.intent === 'topic_reply' && draft.text === text);
  const undoButton = async () => within((await screen.findByText(/Sent .*waiting for the agent/u)).closest('.detail-bubble-status') as HTMLElement).getByRole('button', { name: 'Undo' });
  const replyToContinued = () => {
    const band = [...document.querySelectorAll<HTMLElement>('.tree-topic')].find(value => value.textContent?.includes('Continued context'))!;
    fireEvent.click(within(band).getByRole('button', { name: /^More actions for/ }));
    const reply = screen.getByRole<HTMLButtonElement>('menuitem', { name: /^Reply to topic/ });
    expect(reply.disabled, 'Reply to topic is never a dead end').toBe(false);
    fireEvent.click(reply);
  };

  it('opens topic mode from the band while a topic reply is queued: its bubble has Undo, and Undo puts the words back in the composer', async () => {
    const transport = new AppTransport(); const id = queuedReply(transport);
    await mount(transport);
    replyToContinued();
    await waitFor(() => expect(topicBox()).not.toBeNull());
    fireEvent.click(await undoButton());
    await waitFor(() => expect((within(topicBox()!).getByRole('textbox') as HTMLTextAreaElement).value).toBe(words));
    expect(cancels(transport).map(request => request.command.params)).toMatchObject([{ input_id: id, purpose: 'edit' }]);
    // No draft held the words before the cancel went out: they could have been sent twice.
    const cancelAt = transport.mutations.findIndex(request => request.command.command === 'input_cancel');
    const holdsWords = (request: (typeof transport.mutations)[number]) => request.command.command === 'preferences_patch'
      && request.command.params.entries.some(entry => entry.kind === 'upsert_draft' && entry.draft.text === words);
    expect(transport.mutations.slice(0, cancelAt).some(holdsWords)).toBe(false);
    await waitFor(() => expect(draftWith(transport, words)).toBe(true));
  });

  it('never overwrites a topic reply the owner already started: the queued one stays and its words are offered to copy', async () => {
    const transport = new AppTransport(); queuedReply(transport);
    await mount(transport);
    replyToContinued();
    await waitFor(() => expect(topicBox()).not.toBeNull());
    const box = within(topicBox()!).getByRole('textbox') as HTMLTextAreaElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    fireEvent.change(box, { target: { value: 'Something else' } });
    fireEvent.click(await undoButton());
    expect((await screen.findByLabelText('Your earlier message') as HTMLTextAreaElement).value).toBe(words);
    expect((within(topicBox()!).getByRole('textbox') as HTMLTextAreaElement).value).toBe('Something else');
    expect(cancels(transport)).toHaveLength(0);
  });

  it('takes a queued topic reply back from the stuck notice: the queued reply is cancelled first, then its words are in the topic box', async () => {
    const transport = new AppTransport(); const id = staleQueued(transport);
    await mount(transport);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(topicBox()).not.toBeNull());
    await waitFor(() => expect((within(topicBox()!).getByRole('textbox') as HTMLTextAreaElement).value).toBe(words));
    expect(cancels(transport).map(request => request.command.params)).toMatchObject([{ input_id: id, purpose: 'edit' }]);
    // No draft held the words before the cancel went out: they could have been sent twice.
    const cancelAt = transport.mutations.findIndex(request => request.command.command === 'input_cancel');
    const holdsWords = (request: (typeof transport.mutations)[number]) => request.command.command === 'preferences_patch'
      && request.command.params.entries.some(entry => entry.kind === 'upsert_draft' && entry.draft.text === words);
    expect(transport.mutations.slice(0, cancelAt).some(holdsWords)).toBe(false);
    await waitFor(() => expect(draftWith(transport, words)).toBe(true));
    // Sent once: the cancel is the only input command, and the words were never submitted again.
    expect(transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(0);
  });

  it('recovered words: the notice\'s Show it opens topic mode, the queued reply keeps its Undo and the started words stay', async () => {
    const transport = new AppTransport(); staleQueued(transport);
    const session = transport.sessions.get(route.session_id)!, topic = session.items['8']!.topic_id;
    transport.preferences.drafts = [{ submission_attempted: false, op_id: '00000000-0000-4000-8000-0000000000d5', session: route, binding_id: session.active_binding_id!,
      target: { topic_id: topic, item_id: null }, intent: 'topic_reply', text: 'Something else', selected_option_id: null,
      target_revision: session.topics[topic]!.revision, question_revision: null, supersedes_answer_id: null }];
    await mount(transport);
    fireEvent.click(await screen.findByRole('button', { name: 'Show it' }));
    await waitFor(() => expect(topicBox()).not.toBeNull());
    fireEvent.click(await undoButton());
    expect((await screen.findByLabelText('Your earlier message') as HTMLTextAreaElement).value).toBe(words);
    expect((within(topicBox()!).getByRole('textbox') as HTMLTextAreaElement).value).toBe('Something else');
    expect(cancels(transport)).toHaveLength(0);
  });

  it('still lets the owner write a second topic reply behind a queued one (it goes out after the first)', async () => {
    const transport = new AppTransport(); queuedReply(transport);
    await mount(transport);
    replyToContinued();
    await waitFor(() => expect(topicBox()).not.toBeNull());
    const box = within(topicBox()!).getByRole('textbox') as HTMLTextAreaElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    fireEvent.change(box, { target: { value: 'And one more thing' } });
    await waitFor(() => expect(within(topicBox()!).getByRole('button', { name: 'Send reply' }).hasAttribute('disabled')).toBe(false));
    expect(box.value).toBe('And one more thing');
  });
});
