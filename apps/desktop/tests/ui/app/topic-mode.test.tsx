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
});
