// Never miss a question (SPEC 2.1, 5.13, 5.14, 6.16): on every screen a question waiting on me is in view, whether
// it is in the session on screen or in another one. The table:
//
// | Screen                         | Waiting in this session                    | Waiting in another session            |
// |--------------------------------|--------------------------------------------|---------------------------------------|
// | The session's Map              | the answer dock's line                     | the pill on the switcher button       |
// | Projects, All sessions, Archive| "N waiting in this session" chip           | the pill on the switcher button       |
// | The switcher, open             | (the Map behind it)                        | the question, under its session's row |
// | First run (no projects)        | none can exist                             | none can exist                        |
//
// The page chip takes me back to the session with the dock open at its first waiting question (C6 openAt).
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { notices } from '../../../src/ui/pages/notices';
import { AppTransport, route, secondId } from './transport';

afterEach(() => { cleanup(); notices.clear(); });

const question = 'Which delivery window?';
const switcherButton = () => screen.getByRole('button', { name: /^Switch session or project/ });
/** The first session is on screen; the second ("Separate session") has the same question waiting. */
async function setup() {
  const transport = new AppTransport();
  const first = transport.sessions.get(route.session_id)!, second = transport.sessions.get(secondId)!;
  // A waiting row needs the message that asked it, so the asking messages and rounds come along with the items.
  Object.assign(second, structuredClone({ items: first.items, topics: first.topics, messages: first.messages, rounds: first.rounds, answers: first.answers }), { inputs: {} });
  transport.preferences.global.selected_navigation = { kind: 'session', session: route };
  Object.assign(transport.preferences.sessions[0]!, { tab_open: true });
  render(<DesktopApp service={createDesktopService(transport)} />);
  await waitFor(() => {
    expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready');
    expect(switcherButton().getAttribute('aria-label')).toContain('1 question waiting in other sessions');
  }, { timeout: 5000 });
  return transport;
}
async function openPage(name: 'Projects' | 'All sessions' | 'Archive') {
  fireEvent.click(switcherButton());
  fireEvent.click(within(await screen.findByRole('dialog', { name: 'Switch session or project' })).getByRole('button', { name }));
  await screen.findByRole('heading', { name: name === 'All sessions' ? 'All sessions' : name });
}

describe('never miss a question', () => {
  it('the Map: this session’s question is on the dock’s line; another session’s is on the switcher button', async () => {
    await setup();
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Answer dock' })).getAllByText(question).length).toBeGreaterThan(0));
    expect(switcherButton().querySelector('[aria-label*="waiting on you in other sessions"], [title*="waiting on you in other sessions"]')).not.toBeNull();
  });

  it.each(['Projects', 'All sessions', 'Archive'] as const)('%s: the chip says what waits in this session, the switcher what waits elsewhere', async name => {
    await setup();
    await openPage(name);
    expect(await screen.findByRole('button', { name: '1 waiting in this session' })).toBeTruthy();
    expect(switcherButton().getAttribute('aria-label')).toContain('1 question waiting in other sessions');
  });

  it('the page chip returns to the session with the dock open at its first waiting question', async () => {
    await setup();
    await openPage('All sessions');
    fireEvent.click(await screen.findByRole('button', { name: '1 waiting in this session' }));
    await screen.findByRole('region', { name: 'Session tree' });
    const dock = await screen.findByRole('region', { name: 'Answer dock' });
    await waitFor(() => expect(dock.getAttribute('data-open')).toBe('true'));
    expect(dock.querySelector('.dock-question-title')?.textContent).toBe(question);
  });

  it.each(['the Map', 'the body'] as const)('[ and ] reach the dock as intents: ] from %s opens it at the current question', async from => {
    await setup();
    const dock = screen.getByRole('region', { name: 'Answer dock' });
    expect(dock.getAttribute('data-open')).toBeNull();
    if (from === 'the body') (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(from === 'the Map' ? document.querySelector('.product-app')! : document.body, { key: ']' });
    await waitFor(() => expect(dock.getAttribute('data-open')).toBe('true'));
  });

  it('the switcher, open, names the question waiting in the other session under its row', async () => {
    await setup();
    fireEvent.click(switcherButton());
    const menu = await screen.findByRole('dialog', { name: 'Switch session or project' });
    expect(within(menu).getByRole('option', { name: /Separate session/ })).toBeTruthy();
    expect(within(menu).getByRole('option', { name: new RegExp(question) })).toBeTruthy();
  });

  it('first run: with no project there is no session, so no question can wait unseen', async () => {
    const transport = new AppTransport();
    transport.sessions.clear();
    Object.assign(transport, { projectsOverride: [] });
    render(<DesktopApp service={createDesktopService(transport)} />);
    // The first-run bar keeps no switcher; nothing can be waiting.
    expect(screen.queryByRole('button', { name: /waiting in this session/ })).toBeNull();
  });
});
