// The switcher during an owner write (never dead-end the owner, never lose text, never send twice). The table:
//
// | Step                                          | What must hold                                                    |
// |-----------------------------------------------|-------------------------------------------------------------------|
// | Type a draft in the dock                      | the words box holds it                                            |
// | Start a theme save; the core holds it         | the switcher stays enabled                                        |
// | Choose another session in the switcher        | it queues as the newest navigation; nothing else is sent          |
// | The core releases the save                    | the theme lands once; the session chosen is on screen and saved   |
// | Go back to the first session, open the dock   | the draft is there, word for word; no answer was sent             |
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { OwnerMutationRequest } from '../../../src/generated/core';
import { DesktopApp } from '../../../src/App';
import { createDesktopService, type DesktopTransport } from '../../../src/data/service';
import { notices } from '../../../src/ui/pages/notices';
import { answerWords } from '../answer/words';
import { AppTransport, route, secondId } from './transport';

afterEach(() => { cleanup(); notices.clear(); });

class HeldTransport extends AppTransport {
  hold: Promise<void> | null = null;
  /** Theme changes the core is holding right now. */
  held = 0;
  /** Theme changes the core applied: each request whose theme differs from the saved one. */
  readonly themeSaves: OwnerMutationRequest[] = [];
  override async invoke<T>(name: string, args: Parameters<DesktopTransport['invoke']>[1]): Promise<T> {
    const request = args.request;
    const changesTheme = () => 'command' in request && request.command.command === 'preferences_patch'
      && request.command.params.entries.some(entry => entry.kind === 'set_global' && entry.preferences.theme !== this.preferences.global.theme);
    if (this.hold && changesTheme()) { ++this.held; await this.hold; --this.held; }
    if (changesTheme()) this.themeSaves.push(structuredClone(request as OwnerMutationRequest));
    return super.invoke<T>(name, args);
  }
}

const switcherButton = () => screen.getByRole<HTMLButtonElement>('button', { name: /^Switch session or project/ });
const themeSaves = (transport: HeldTransport) => transport.themeSaves;
const sends = (transport: AppTransport) => transport.mutations.filter(request => request.command.command === 'input_submit');
async function ready() {
  await waitFor(() => expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready'));
}
async function choose(name: RegExp) {
  fireEvent.click(switcherButton());
  const menu = await screen.findByRole('dialog', { name: 'Switch session or project' });
  await act(async () => { fireEvent.click(within(menu).getByRole('option', { name })); });
}
async function dockWords() {
  const dock = screen.getByRole('region', { name: 'Answer dock' });
  if (dock.getAttribute('data-open') !== 'true') fireEvent.click(await within(dock).findByRole('button', { name: /^1 waiting$/ }));
  await waitFor(() => expect(dock.getAttribute('data-open')).toBe('true'));
  return answerWords(dock);
}

describe('the switcher during an owner write', () => {
  it('keeps the draft, saves the held write once, and shows the session the owner chose', async () => {
    const transport = new HeldTransport();
    transport.preferences.global.selected_navigation = { kind: 'session', session: route };
    Object.assign(transport.preferences.sessions[0]!, { tab_open: true });
    render(<DesktopApp service={createDesktopService(transport)} />);
    await ready();
    const draft = ' Keep my exact draft: café\nsecond line ';
    fireEvent.change(await dockWords(), { target: { value: draft } });
    await waitFor(() => expect(transport.preferences.drafts.some(saved => JSON.stringify(saved).includes('café'))).toBe(true));

    let release!: () => void;
    transport.hold = new Promise<void>(resolve => { release = resolve; });
    fireEvent.click(screen.getByRole('button', { name: /^Switch to (light|dark)$/ }));
    await waitFor(() => expect(transport.held).toBe(1));
    expect(themeSaves(transport)).toHaveLength(0);
    expect(switcherButton().disabled).toBe(false);
    await choose(/Separate session/);
    expect(switcherButton().textContent).not.toContain('Separate session');

    await act(async () => { release(); });
    await waitFor(() => expect(switcherButton().textContent).toContain('Separate session'));
    await ready();
    expect(themeSaves(transport)).toHaveLength(1);
    expect(transport.preferences.global.theme).not.toBe('system');
    expect(transport.preferences.global.selected_navigation).toEqual({ kind: 'session', session: { ...route, session_id: secondId } });

    transport.hold = null;
    await choose(/Notes review/);
    await waitFor(() => expect(switcherButton().textContent).toContain('Notes review'));
    await ready();
    await waitFor(async () => expect((await dockWords()).value).toBe(draft));
    expect(themeSaves(transport)).toHaveLength(1);
    expect(sends(transport)).toHaveLength(0);
  });
});
