import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConnectionCard, ConnectionLine } from '../../../src/ui/topbar/ConnectionCard';
import { cardActions, connectionCopy, connectionLine, lineActions } from '../../../src/ui/topbar/connection';
import type { ConnectionCardActions, ConnectionKind, ConnectionView } from '../../../src/ui/topbar/model';

afterEach(cleanup);

const everything = (): Required<ConnectionCardActions> => ({
  onSending: vi.fn(), onHowToConnect: vi.fn(), onTryAgain: vi.fn(), onTryAgainUnsaved: vi.fn(), onShowFile: vi.fn(), onShowFolder: vi.fn(), onClose: vi.fn(), onReopen: vi.fn(),
  onCopyId: vi.fn(() => Promise.resolve(true)), onCopyCommand: vi.fn(() => Promise.resolve(true)), onCopyInstruction: vi.fn(() => Promise.resolve(true)),
});
const kinds: ConnectionKind[] = ['live', 'loading', 'none', 'off', 'closed', 'reconnect', 'unreadable', 'stale', 'unsaved'];
const view = (kind: ConnectionKind, patch: Partial<ConnectionView> = {}): ConnectionView => ({ kind, agent: 'Claude Code', where: 'Claude Code in iTerm window 1', ...patch });

describe('connection card wording', () => {
  it('Live says where the agent runs, when it last spoke, and what is on its way', () => {
    const copy = connectionCopy(view('live', { lastMessageAt: '21:25', sending: { onItsWay: 1, queued: 1 } }));
    expect(copy.title).toBe('Live');
    expect(copy.lines).toEqual(['Connected to Claude Code in iTerm window 1.', 'Last message at 21:25. Sending is on; 1 answer is on its way and 1 reply is queued behind it.']);
    expect(connectionCopy(view('live', { sending: { onItsWay: 2, queued: 0 } })).lines[1]).toBe('Sending is on; 2 answers are on its way.');
    expect(connectionCopy(view('live', { sending: { onItsWay: 0, queued: 3 } })).lines[1]).toBe('Sending is on; 3 replies are queued.');
    expect(connectionCopy(view('live', { sending: { onItsWay: 0, queued: 0 } })).lines[1]).toBe('Sending is on; nothing is waiting to go out.');
    expect(connectionCopy(view('live')).lines[1]).toBe('Sending is on.');
  });

  it.each([
    ['none', 'Not connected', 'No agent is connected to this session. Answers you write wait here until one connects.'],
    ['closed', 'Closed', 'It’s read-only.'],
    ['loading', 'Connecting…', 'Looking for Claude Code in iTerm window 1.'],
    ['unreadable', 'Can’t read this session', 'Ariadne can’t read this session right now, so it can’t build the Map. Nothing in the file was changed.'],
  ] as const)('%s reads as the board says', (kind, title, line) => {
    const copy = connectionCopy(view(kind));
    expect(copy.title).toBe(title);
    expect(copy.lines.join(' ')).toContain(line);
  });

  it('carries the times it is given: last seen, dropped, last good copy, unsaved', () => {
    expect(connectionCopy(view('off', { lastSeenAt: '20:58' })).lines[0]).toBe('Last seen at 20:58 in Claude Code in iTerm window 1. What you send waits and goes out once when it runs again.');
    expect(connectionCopy(view('reconnect', { droppedAt: '21:30' })).lines[0]).toBe('The connection to Claude Code in iTerm window 1 dropped at 21:30. Ariadne tries again every few seconds.');
    expect(connectionCopy(view('stale', { lastGoodAt: '21:24' })).lines[0]).toBe('Ariadne last read this session at 21:24. Newer changes couldn’t be read; it keeps trying.');
    expect(connectionCopy(view('unsaved', { unsavedAt: '21:31' })).lines[1]).toContain('noticed at 21:31');
    expect(connectionCopy(view('closed', { closedAt: '21:33' })).lines[0]).toBe('You closed this session today at 21:33. It’s read-only.');
  });

  it('the line above the Map exists for each state that changes what I can do, and for no other', () => {
    expect(kinds.filter(kind => connectionLine(view(kind)) === null)).toEqual(['live', 'loading']);
    expect(connectionLine(view('unreadable', { corrupt: true, unreadableLine: 1204 }))!.text).toContain('line 1,204');
    expect(connectionLine(view('unsaved', { unsavedAt: '21:31' }))).toMatchObject({ title: 'Ariadne isn’t sure your last change was saved.', text: 'It checks again when you press Try again.' });
    expect(connectionLine(view('stale', { lastGoodAt: '21:24' }))!.title).toBe('Showing the last good copy, from 21:24.');
  });
});

describe('a plugin that does not match the app', () => {
  const words = 'This Claude session’s Ariadne plugin doesn’t match the app. Run /reload-plugins there, then /ariadne-connect.';
  it.each(['off', 'reconnect'] as const)('%s: the line and the card say so', kind => {
    const line = connectionLine(view(kind, { pluginMismatch: true }))!;
    expect(`${line.title} ${line.text}`).toBe(words);
    expect(connectionCopy(view(kind, { pluginMismatch: true })).lines[0]).toBe(words);
  });
  it.each(['none', 'live', 'loading', 'closed', 'unreadable', 'stale', 'unsaved'] as const)('%s: a stale mismatch never replaces what is true', kind => {
    expect(connectionLine(view(kind, { pluginMismatch: true }))).toEqual(connectionLine(view(kind)));
    expect(connectionCopy(view(kind, { pluginMismatch: true }))).toEqual(connectionCopy(view(kind)));
  });
  it('without a mismatch the words do not change', () => {
    for (const kind of kinds) expect(connectionLine(view(kind, { pluginMismatch: false }))).toEqual(connectionLine(view(kind)));
    expect(connectionCopy(view('off')).lines.join(' ')).not.toContain('/reload-plugins');
  });
  it('the line draws the words and keeps its buttons', () => {
    render(<ConnectionLine view={view('reconnect', { pluginMismatch: true })} actions={everything()} />);
    expect(screen.getByRole('status').textContent).toContain(words);
    expect(screen.getByRole('button', { name: 'Try now' })).toBeTruthy();
  });
});

describe('12.7 names a cut-off file only when the file is cut off', () => {
  const neutral = 'Nothing in the file was changed, and Ariadne tries again when it changes.';
  it('corrupt_session: the line and the card say the file ends partway through a line', () => {
    const line = connectionLine(view('unreadable', { corrupt: true }))!;
    expect(line.title).toBe('This session can’t be read.');
    expect(line.text).toBe(`Its file ends partway through a line, so there’s no Map to show. ${neutral}`);
    expect(connectionCopy(view('unreadable', { corrupt: true })).lines).toEqual(['The session file ends partway through a line, so Ariadne can’t build the Map. Nothing in the file was changed.']);
  });
  it.each([undefined, false])('any other cause (corrupt: %s) is neutral on the line and the card', corrupt => {
    const line = connectionLine(view('unreadable', corrupt === undefined ? {} : { corrupt }))!;
    expect(`${line.title} ${line.text}`).toBe(`This session can’t be read right now. ${neutral}`);
    expect(`${line.title} ${line.text}`).not.toMatch(/partway/);
    expect(connectionCopy(view('unreadable', corrupt === undefined ? {} : { corrupt })).lines.join(' ')).not.toMatch(/partway/);
  });
});

describe('connection actions', () => {
  it('every card can copy the session ID, and an open session can be closed (a closed one reopened)', () => {
    const a = everything();
    for (const kind of kinds) {
      const keys = cardActions(view(kind), a).map(action => action.key);
      expect(keys).toContain('copy-id');
      if (kind === 'closed') { expect(keys).toContain('reopen'); expect(keys).not.toContain('close'); }
      else if (kind !== 'loading') expect(keys).toContain('close');
    }
  });

  it('an archived session’s card and line say Restore session; a closed one’s say Reopen session', () => {
    const a = everything();
    for (const [closed, label] of [[view('closed'), 'Reopen session'], [view('closed', { archived: true }), 'Restore session']] as const) {
      expect(cardActions(closed, a).find(action => ['reopen', 'restore'].includes(action.key))!.label).toBe(label);
      expect(lineActions(closed, a).map(action => action.label)).toEqual([label]);
    }
    const archived = everything();
    render(<ConnectionLine view={view('closed', { archived: true })} actions={archived} />);
    expect(screen.queryByRole('button', { name: 'Reopen session' })).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('This session is archived.');
    fireEvent.click(screen.getByRole('button', { name: 'Restore session' }));
    expect(archived.onReopen).toHaveBeenCalledTimes(1);
  });

  it('draws only what the caller can do', () => {
    expect(cardActions(view('live'), {})).toEqual([]);
    expect(cardActions(view('none'), { onCopyId: vi.fn() }).map(action => action.key)).toEqual(['copy-id']);
  });

  it('puts the state\'s own button first', () => {
    const a = everything();
    expect(cardActions(view('live'), a)[0]!.label).toBe('Sending…');
    // Off has no sending to speak of: its button opens the Connection dialog, on the card and on the line.
    expect(cardActions(view('off'), a)[0]!.label).toBe('Connection…');
    expect(lineActions(view('off'), a).map(action => action.label)).toEqual(['Connection…']);
    expect(cardActions(view('none'), a)[0]!.label).toBe('How to connect');
    expect(cardActions(view('reconnect'), a)[0]!.label).toBe('Try now');
    expect(cardActions(view('unreadable'), a).slice(0, 2).map(action => action.label)).toEqual(['Try again', 'Show the file']);
    expect(lineActions(view('unsaved'), a).map(action => action.label)).toEqual(['Try again', 'Show folder']);
    expect(lineActions(view('live'), a)).toEqual([]);
  });
});

describe('ConnectionCard', () => {
  it('shows the title and lines, and runs an action after dismissing itself', () => {
    const a = everything(), onDismiss = vi.fn();
    render(<ConnectionCard view={view('reconnect', { droppedAt: '21:30' })} actions={a} onDismiss={onDismiss} />);
    expect(screen.getByRole('dialog', { name: 'Reconnecting…' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try now' }));
    expect(a.onTryAgain).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('Copy session ID stays open and says Copied for a moment', async () => {
    vi.useFakeTimers();
    try {
      const a = everything(), onDismiss = vi.fn();
      render(<ConnectionCard view={view('live')} actions={a} onDismiss={onDismiss} />);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy session ID' })); });
      expect(a.onCopyId).toHaveBeenCalledTimes(1);
      expect(onDismiss).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
      act(() => { vi.advanceTimersByTime(2100); });
      expect(screen.getByRole('button', { name: 'Copy session ID' })).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });

  it('Esc dismisses; so does a press outside, but not one on the connection button', () => {
    const onDismiss = vi.fn();
    render(<ConnectionCard view={view('live')} actions={everything()} onDismiss={onDismiss} />);
    const trigger = document.createElement('button');
    trigger.dataset.popoverTrigger = 'connection';
    document.body.append(trigger);
    fireEvent.pointerDown(trigger);
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(2);
    trigger.remove();
  });
});

describe('ConnectionLine', () => {
  it('draws nothing for Live and Connecting', () => {
    for (const kind of ['live', 'loading'] as const) {
      const { container } = render(<ConnectionLine view={view(kind)} actions={everything()} />);
      expect(container.textContent).toBe('');
      cleanup();
    }
  });

  it('says what happened in bold, then what it means, and offers the way out', () => {
    const a = everything();
    render(<ConnectionLine view={view('off')} actions={a} />);
    const line = screen.getByRole('status');
    expect(line.textContent).toContain('Claude Code isn’t running for this session.');
    expect(line.textContent).toContain('What you send is queued and goes out once, when it runs again.');
    fireEvent.click(screen.getByRole('button', { name: 'Connection…' }));
    expect(a.onSending).toHaveBeenCalledTimes(1);
  });

  it('a copy that fails says so and never says Copied (the card and both steps of the line)', async () => {
    vi.useFakeTimers();
    try {
      const failing = { onCopyId: vi.fn(() => Promise.resolve(false)), onCopyCommand: vi.fn(() => Promise.reject(new Error('no clipboard'))),
        onCopyInstruction: vi.fn(() => Promise.resolve(false)) };
      const card = render(<ConnectionCard view={view('live')} actions={failing} onDismiss={vi.fn()} />);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy session ID' })); });
      expect(screen.getByRole('button', { name: 'Couldn’t copy' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
      act(() => { vi.advanceTimersByTime(2100); });
      expect(screen.getByRole('button', { name: 'Copy session ID' })).toBeTruthy();
      card.unmount();
      render(<ConnectionLine view={view('none')} actions={failing} />);
      fireEvent.click(screen.getByRole('button', { name: 'How to connect' }));
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy' })); });
      expect(screen.getByRole('button', { name: 'Couldn’t copy' })).toBeTruthy();
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy instruction' })); });
      expect(screen.getAllByRole('button', { name: 'Couldn’t copy' })).toHaveLength(2);
      expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('Not connected folds its steps until asked, then shows both commands with their Copy buttons', async () => {
    const a = everything();
    render(<ConnectionLine view={view('none')} actions={a} />);
    expect(screen.queryByText('/ariadne-connect')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'How to connect' }));
    expect(screen.getByText('/ariadne-connect')).toBeTruthy();
    expect(screen.getByText('Connecting sends nothing to the model. The dot by the session name turns green when it’s done.')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy instruction' })); });
    expect(a.onCopyCommand).toHaveBeenCalledTimes(1);
    expect(a.onCopyInstruction).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Hide steps' }));
    expect(screen.queryByText('/ariadne-connect')).toBeNull();
  });

  it('without a setup receipt there is no Copy instruction; the step says the plain next thing to do', () => {
    const { onCopyInstruction, ...noReceipt } = everything();
    render(<ConnectionLine view={view('none')} actions={noReceipt} />);
    fireEvent.click(screen.getByRole('button', { name: 'How to connect' }));
    expect(screen.queryByRole('button', { name: 'Copy instruction' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
    const steps = document.querySelector('.cl-steps')!.textContent!;
    expect(steps).toContain('Using Codex? Choose “Connect existing session” on the project’s page');
    expect(steps).toContain('setup instruction to paste into its thread once');
    expect(steps).toContain('Connecting sends nothing to the model.');
    expect(onCopyInstruction).not.toHaveBeenCalled();
  });

  it('can be told to open its steps from outside (the card\'s "How to connect")', () => {
    const onToggle = vi.fn();
    const { rerender } = render(<ConnectionLine view={view('none')} actions={everything()} steps={{ open: false, onToggle }} />);
    fireEvent.click(screen.getByRole('button', { name: 'How to connect' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('/ariadne-connect')).toBeNull();
    rerender(<ConnectionLine view={view('none')} actions={everything()} steps={{ open: true, onToggle }} command="/connect-me" />);
    expect(screen.getByText('/connect-me')).toBeTruthy();
  });
});
