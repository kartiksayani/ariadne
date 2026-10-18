// The line above the Map and the dock's chip in the composed app (SPEC 5.12; alpha.21 E22-E25): a stale read counts only when a
// refresh failed, an unreadable session has its Map panel, an unsure save is the line's "Try again", and the dock says where
// answers wait.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { copyText } from '../../../src/ui/shared/clipboard';
import { notices } from '../../../src/ui/pages/notices';
import sessionsFixture from '../../../../../fixtures/domain/projections/sessions.json';
import type { PresenceObservation } from '../../../src/generated/domain/models';
import { AppTransport, route } from './transport';

vi.mock('../../../src/ui/shared/clipboard', () => ({ copyText: vi.fn() }));
afterEach(() => { cleanup(); notices.clear(); vi.resetAllMocks(); });

/** A transport whose session reads can be made to fail, as a locked or damaged session file does. */
class Flaky extends AppTransport {
  failReads = false;
  /** What a failed read says: a cut-off file (core's `corrupt_session`), or no cause at all. */
  failure: 'unknown' | 'corrupt' = 'unknown';
  /** A write named here waits for `release()` before it lands: it is "in flight". */
  hold: string | null = null;
  private gate: Promise<void> | null = null;
  held = 0;
  release = () => {};
  holdWrites(name: string) { this.hold = name; this.gate = new Promise<void>(resolve => { this.release = () => { this.hold = null; resolve(); }; }); }
  async invoke<T>(name: string, args: Parameters<AppTransport['invoke']>[1]): Promise<T> {
    const { request } = args;
    if ('command' in request && request.command.command === this.hold) { ++this.held; await this.gate; }
    if (this.failReads && !('command' in request) && request.request.command === 'session_get') {
      if (this.failure === 'corrupt') return { api_version: 1, ok: false, error: { code: 'corrupt_session', message: 'The session file is cut off.', hint: '', retryable: false, field_errors: [] } } as T;
      throw new Error('The session file could not be read.');
    }
    return super.invoke<T>(name, args);
  }
}
const session = (transport: AppTransport) => transport.sessions.get(route.session_id)!;
const binding = (transport: AppTransport) => session(transport).bindings[session(transport).active_binding_id!]!;
const dot = () => document.querySelector<HTMLButtonElement>('[data-popover-trigger="connection"]')!;
const line = () => screen.queryByRole('status', { name: 'Connection' });
const hint = (transport: AppTransport, revision = session(transport).revision + 1) => transport.emit('ariadne://session_changed', { session_id: route.session_id, revision });
/** The host reports the agent's connection as reconnecting (a fresh observation outranks the stored state). */
const reconnecting = (transport: AppTransport) => {
  const binding = session(transport).bindings[session(transport).active_binding_id!]!;
  const observation = { ...structuredClone(sessionsFixture.items[0].active_binding.presence), connection_state: 'reconnecting', last_seen_at: '2026-10-03T12:01:00.000Z' } as PresenceObservation;
  transport.emit('ariadne://presence_changed', { binding_id: binding.id, generation: binding.generation, observation });
};
const dockLine = () => document.querySelector<HTMLElement>('.answer-dock-line')!;

async function open(change: (transport: Flaky) => void = () => {}) {
  const transport = new Flaky();
  transport.preferences.global.selected_navigation = { kind: 'session', session: route };
  Object.assign(transport.preferences.sessions[0]!, { tab_open: true });
  change(transport);
  render(<DesktopApp service={createDesktopService(transport)} />);
  await waitFor(() => {
    expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready');
    expect(dot()).not.toBeNull();
  });
  return transport;
}

describe('a failed read is the last good copy; an ordinary change hint is nothing', () => {
  it('a change hint ahead of the read draws no line, no edge notice and no new dot', async () => {
    const transport = await open();
    expect(line()).toBeNull();
    await act(async () => { hint(transport); });
    await waitFor(() => expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('stale'));
    expect(line()).toBeNull();
    expect(document.querySelector('[data-edge-state]')).toBeNull();
    expect(dot().getAttribute('aria-label')).not.toMatch(/last good/i);
  });

  it('a failed read draws the line once, names the copy, and Try again reads until it clears', async () => {
    const transport = await open();
    transport.failReads = true;
    await act(async () => { hint(transport); });
    const shown = await screen.findByRole('status', { name: 'Connection' });
    expect(shown.textContent).toMatch(/Showing the last good copy, from \d\d:\d\d\./);
    expect(shown.textContent).toContain('answers wait until it can be read again');
    expect(document.querySelectorAll('[role="status"][aria-label="Connection"]')).toHaveLength(1);
    expect(document.querySelector('[data-edge-state]')).toBeNull();
    expect(dot().getAttribute('aria-label')).toMatch(/^Last good copy/);
    transport.failReads = false; session(transport).revision += 1;
    await act(async () => { fireEvent.click(within(shown).getByRole('button', { name: 'Try again' })); });
    await waitFor(() => expect(line()).toBeNull());
    expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready');
  });
});

describe('a session that can’t be read at all', () => {
  it('says so on the line and in the Map’s own panel, and Copy the error copies the words', async () => {
    vi.mocked(copyText).mockResolvedValue(undefined);
    const transport = new Flaky();
    transport.preferences.global.selected_navigation = { kind: 'session', session: route };
    Object.assign(transport.preferences.sessions[0]!, { tab_open: true });
    transport.failReads = true;
    render(<DesktopApp service={createDesktopService(transport)} />);
    const shown = await screen.findByRole('status', { name: 'Connection' });
    expect(shown.textContent).toContain('This session can’t be read right now. Nothing in the file was changed, and Ariadne tries again when it changes.');
    expect(shown.textContent).not.toContain('partway');
    expect(await screen.findByText('No Map to show')).toBeTruthy();
    expect(screen.queryByText('Session unavailable')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy the error' })); });
    expect(copyText).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
    // Back readable: the panel and the line go.
    transport.failReads = false;
    await act(async () => { fireEvent.click(within(shown).getByRole('button', { name: 'Try again' })); });
    await waitFor(() => expect(screen.queryByText('No Map to show')).toBeNull());
    expect(line()).toBeNull();
  });
});

describe('a session whose file is cut off (corrupt_session)', () => {
  it('is the only cause the line says ends partway through a line', async () => {
    const transport = new Flaky();
    transport.preferences.global.selected_navigation = { kind: 'session', session: route };
    Object.assign(transport.preferences.sessions[0]!, { tab_open: true });
    transport.failReads = true; transport.failure = 'corrupt';
    render(<DesktopApp service={createDesktopService(transport)} />);
    const shown = await screen.findByRole('status', { name: 'Connection' });
    expect(shown.textContent).toContain('This session can’t be read.');
    expect(shown.textContent).toContain('Its file ends partway through a line, so there’s no Map to show. Nothing in the file was changed');
  });
});

describe('a closed session whose reads fail', () => {
  it('is not left silent: the line is the closed one, so the failure shows as the page alert', async () => {
    const transport = await open(value => { Object.assign(session(value), { state: 'closed', closed_at: session(value).updated_at }); });
    expect(screen.queryByRole('alert')).toBeNull();
    transport.failReads = true;
    await act(async () => { hint(transport); });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent!.length).toBeGreaterThan(0);
    expect(line()?.textContent).toContain('This session is closed.');
    transport.failReads = false; session(transport).revision += 1;
    await act(async () => { hint(transport); });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('an open session’s failed read stays on the line alone: no second alert', async () => {
    const transport = await open();
    transport.failReads = true;
    await act(async () => { hint(transport); });
    await screen.findByRole('status', { name: 'Connection' });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('a save Ariadne isn’t sure of', () => {
  it('Try again keeps the line on screen (the same node) while the check is in flight, and clears it when the check lands', async () => {
    const transport = await open();
    transport.failNext = 'preferences_patch';
    await act(async () => { fireEvent.keyDown(document.body, { key: '=', metaKey: true }); });
    const shown = await screen.findByRole('status', { name: 'Connection' });
    expect(shown.textContent).toContain('isn’t sure your last change was saved');
    transport.holdWrites('preferences_patch');
    const seen: (Element | null)[] = [];
    const watch = new MutationObserver(() => { seen.push(line()); });
    watch.observe(document.body, { childList: true, subtree: true });
    await act(async () => { fireEvent.click(within(shown).getByRole('button', { name: 'Try again' })); });
    await waitFor(() => expect(transport.held).toBe(1));
    expect(line()).toBe(shown);
    expect(shown.textContent).toContain('isn’t sure your last change was saved');
    expect(document.querySelector('.nav-banner')).toBeNull();
    await act(async () => { transport.release(); });
    await waitFor(() => expect(line()).toBeNull());
    watch.disconnect();
    // Never gone while the check ran: no mutation in between saw the line missing before it was cleared for good.
    const firstGone = seen.indexOf(null);
    expect(firstGone === -1 || seen.slice(firstGone).every(node => node === null)).toBe(true);
  });

  it('a lost Pause: Try again keeps the line while the same write is in flight again', async () => {
    const transport = await open();
    transport.failNext = 'binding_pause';
    fireEvent.click(dot());
    fireEvent.click(await screen.findByRole('button', { name: 'Sending…' }));
    const dialog = await screen.findByRole('dialog', { name: /Sending to / });
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Pause sending' })); });
    const shown = await screen.findByRole('status', { name: 'Connection' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    transport.holdWrites('binding_pause');
    await act(async () => { fireEvent.click(within(shown).getByRole('button', { name: 'Try again' })); });
    await waitFor(() => expect(transport.held).toBe(1));
    expect(line()).toBe(shown);
    expect(dot().getAttribute('aria-label')).toMatch(/^Live/);
    await act(async () => { transport.release(); });
    await waitFor(() => expect(line()).toBeNull());
    expect(binding(transport).owner_paused).toBe(true);
  });

  it('is the line’s report, not a banner; Try again checks the same write once more', async () => {
    const transport = await open();
    transport.failNext = 'preferences_patch';
    const before = transport.mutations.length;
    await act(async () => { fireEvent.keyDown(document.body, { key: '=', metaKey: true }); });
    const shown = await screen.findByRole('status', { name: 'Connection' });
    expect(shown.textContent).toContain('Ariadne isn’t sure your last change was saved.');
    expect(shown.textContent).toContain('It checks again when you press Try again.');
    expect(document.querySelector('.nav-banner')).toBeNull();
    expect(dot().getAttribute('aria-label')).toMatch(/^Live/);
    expect(transport.mutations.slice(before).filter(request => request.command.command === 'preferences_patch').length).toBeGreaterThan(0);
    await act(async () => { fireEvent.click(within(shown).getByRole('button', { name: 'Try again' })); });
    await waitFor(() => expect(line()).toBeNull());
    const after = transport.mutations.slice(before).filter(request => request.command.command === 'preferences_patch');
    // The same write is checked, not a second copy of the change: its op id repeats.
    expect(new Set(after.map(request => request.command.op_id)).size).toBe(1);
  });
});

describe('a write in flight is not an unsure save (SPEC 12.9)', () => {
  const unsure = () => screen.queryByText(/isn’t sure your last change was saved/);
  it('Pause in flight draws no line and keeps the Live dot; it lands without ever flagging', async () => {
    const transport = await open();
    transport.holdWrites('binding_pause');
    fireEvent.click(dot());
    fireEvent.click(await screen.findByRole('button', { name: 'Sending…' }));
    const dialog = await screen.findByRole('dialog', { name: /Sending to / });
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Pause sending' })); });
    await waitFor(() => expect(transport.held).toBe(1));
    expect(line()).toBeNull();
    expect(unsure()).toBeNull();
    expect(dot().getAttribute('aria-label')).toMatch(/^Live/);
    expect(dot().getAttribute('aria-label')).not.toMatch(/not saving/i);
    await act(async () => { transport.release(); });
    await waitFor(() => expect(binding(transport).owner_paused).toBe(true));
    expect(line()?.textContent ?? '').not.toMatch(/isn’t sure/);
    expect(dot().getAttribute('aria-label')).not.toMatch(/not saving/i);
  });

  it('Try now in flight keeps the Reconnecting line as it was and adds no unsure-save text', async () => {
    const transport = await open();
    await act(async () => { reconnecting(transport); });
    const shown = await screen.findByRole('status', { name: 'Connection' });
    transport.holdWrites('binding_connect');
    await act(async () => { fireEvent.click(within(shown).getByRole('button', { name: 'Try now' })); });
    await waitFor(() => expect(transport.held).toBe(1));
    expect(line()?.textContent).toContain('Reconnecting to');
    expect(unsure()).toBeNull();
    expect(dot().getAttribute('aria-label')).not.toMatch(/not saving/i);
    await act(async () => { transport.release(); });
  });

  it('an unsure Pause (lost response) does flag, and Try again with the write in flight again unflags nothing early', async () => {
    const transport = await open();
    transport.failNext = 'binding_pause';
    fireEvent.click(dot());
    fireEvent.click(await screen.findByRole('button', { name: 'Sending…' }));
    const dialog = await screen.findByRole('dialog', { name: /Sending to / });
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Pause sending' })); });
    await waitFor(() => expect(unsure()).not.toBeNull());
    expect(dot().getAttribute('aria-label')).toMatch(/^Live/);
  });
});

describe('Try now', () => {
  it('reconnects the same agent session once and waits while a save is in flight', async () => {
    const transport = await open();
    await act(async () => { reconnecting(transport); });
    const shown = await screen.findByRole('status', { name: 'Connection' });
    expect(shown.textContent).toContain('Reconnecting to');
    expect(shown.textContent).toContain('The connection dropped. What you send waits here');
    await act(async () => { fireEvent.click(within(shown).getByRole('button', { name: 'Try now' })); });
    const connects = transport.mutations.filter(request => request.command.command === 'binding_connect');
    expect(connects).toHaveLength(1);
    expect(connects[0]!.command.command === 'binding_connect' && connects[0]!.command.params.existing_session_id).toBe(route.session_id);
  });
});

describe('the dock keeps the owner’s draft in sight when the session can’t be read', () => {
  it('12.7: “Draft kept” stays beside the other-sessions chip', async () => {
    const transport = new Flaky();
    transport.preferences.global.selected_navigation = { kind: 'session', session: route };
    Object.assign(transport.preferences.sessions[0]!, { tab_open: true });
    const first = session(transport), item = first.items['2']!;
    transport.preferences.drafts = [{ op_id: '00000000-0000-4000-8000-000000000101', session: { project_id: first.project_id, session_id: first.id },
      binding_id: first.active_binding_id!, target: { topic_id: item.topic_id, item_id: item.id }, intent: 'answer', text: 'My words survive.',
      selected_option_id: null, target_revision: item.revision, question_revision: item.question_revision, supersedes_answer_id: null }];
    transport.failReads = true;
    render(<DesktopApp service={createDesktopService(transport)} />);
    await screen.findByRole('status', { name: 'Connection' });
    await waitFor(() => expect(dockLine().querySelector('.dock-line-text')?.textContent).toMatch(/can’t be read/));
    await waitFor(() => expect(dockLine().querySelector('.dock-draft')).not.toBeNull());
    expect(dockLine().querySelector('.dock-draft')!.textContent).toContain('Draft kept');
  });
});

describe('the dock says where answers wait', () => {
  it.each([
    ['no agent connected', (transport: Flaky) => { session(transport).active_binding_id = null; }, 'Answers wait here until an agent connects', 'Held here'],
    ['the agent not running', (transport: Flaky) => { binding(transport).connection_state = 'disconnected'; binding(transport).dispatch_state = 'disconnected'; }, 'Answers queue until it runs', 'Answers queue'],
    ['the connection reconnecting', (transport: Flaky) => { binding(transport).connection_state = 'reconnecting'; }, 'Answers wait until it’s back', 'Answers wait'],
  ] as const)('%s: a chip with its wide and narrow words', async (name, change, wide, narrow) => {
    const transport = await open(name === 'the connection reconnecting' ? () => {} : change);
    if (name === 'the connection reconnecting') await act(async () => { reconnecting(transport); });
    const chip = await waitFor(() => { const found = dockLine().querySelector<HTMLElement>('.dock-state'); expect(found).not.toBeNull(); return found!; });
    expect(chip.querySelector('.dock-wide')!.textContent).toBe(wide);
    expect(chip.querySelector('.dock-narrow')!.textContent).toBe(narrow);
  });

  it('live draws no such chip', async () => {
    await open();
    expect(dockLine().querySelector('.dock-state')).toBeNull();
  });

  it('a closed session reads "Read-only." with the questions that were waiting, and no pill or other chips', async () => {
    await open(transport => { Object.assign(session(transport), { state: 'closed', closed_at: session(transport).updated_at }); });
    const text = await waitFor(() => { const found = dockLine().querySelector('.dock-line-text'); expect(found?.textContent).toMatch(/^Read-only\./); return found!.textContent!; });
    expect(text).toMatch(/^Read-only\.( \d+ questions? (was|were) waiting when this session closed\.)?$/);
    expect(dockLine().querySelector('.dock-pill, .dock-state, .dock-others')).toBeNull();
  });

  it('while the session loads, a skeleton and "Checking for questions…"', async () => {
    const transport = new Flaky();
    transport.preferences.global.selected_navigation = { kind: 'session', session: route };
    Object.assign(transport.preferences.sessions[0]!, { tab_open: true });
    const gate = new Promise<void>(resolve => { (transport as unknown as { release: () => void }).release = resolve; });
    const original = transport.invoke.bind(transport);
    transport.invoke = (async (name: string, args: Parameters<AppTransport['invoke']>[1]) => {
      if (!('command' in args.request) && args.request.request.command === 'session_get') await gate;
      return original(name, args);
    }) as typeof transport.invoke;
    render(<DesktopApp service={createDesktopService(transport)} />);
    const loading = await screen.findByText('Checking for questions…');
    expect(loading.closest('.answer-dock-line')!.querySelector('.dock-skeleton')).not.toBeNull();
    await act(async () => { (transport as unknown as { release: () => void }).release(); });
    await waitFor(() => expect(screen.queryByText('Checking for questions…')).toBeNull());
  });
});
