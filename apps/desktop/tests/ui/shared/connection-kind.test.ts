// Where a session stands (SPEC 5.12; alpha.21 E22, E23): a stale read counts only when a refresh failed, and an unsure save is
// the live state's own report or a second line under another state.
import { describe, expect, it, vi } from 'vitest';
import demo from '../../../../../fixtures/domain/demo/session.json';
import { OpenSessions, type SessionState } from '../../../src/data/session-store';
import { CoreFailure, ServiceFailure, createDesktopService, type DesktopTransport } from '../../../src/data/service';
import type { Session } from '../../../src/generated/domain/models';
import { connectionView } from '../../../src/components/navigation/WorkspaceTopBar';
import { connectionKind, readAt } from '../../../src/ui/shared/connection';

const base = () => structuredClone(demo) as unknown as Session;
const state = (patch: Partial<SessionState> & { session?: Session | null } = {}): SessionState => {
  const { session = base(), ...rest } = patch;
  return { route: { project_id: 'p', session_id: 's' }, snapshot: session ? { session, freshness: 'fresh' } : null, presence: {}, status: 'ready', error: null, ...rest } as unknown as SessionState;
};
const failure = new ServiceFailure('transport');

describe('connectionKind', () => {
  it.each([
    ['a ready read of a connected agent', {}, 'live'],
    ['a change hint ahead of the read (stale, no failure)', { status: 'stale' }, 'live'],
    ['a stale freshness on a ready read', { snapshot: { session: base(), freshness: 'stale' } }, 'live'],
    ['a refresh that failed after a good read', { status: 'stale', error: failure }, 'stale'],
    ['a read that is refused with a copy still held', { status: 'inaccessible', error: failure }, 'unreadable'],
    ['no read at all, and still loading', { session: null, status: 'loading' }, 'loading'],
    ['no read at all, and failed', { session: null, status: 'inaccessible', error: failure }, 'unreadable'],
  ] as const)('%s is %s', (_name, patch, kind) => {
    expect(connectionKind(state(patch as Partial<SessionState>))).toBe(kind);
  });

  it('a failed read leaves the closed state on top: its own words say read-only', () => {
    const closed = base(); closed.state = 'closed';
    expect(connectionKind(state({ session: closed, status: 'stale', error: failure }))).toBe('closed');
  });

  it('a core refusal is unreadable only for the codes that mean the file can’t be reached', () => {
    const refusal = new CoreFailure({ code: 'io_error', message: 'No.', hint: '', field_errors: [], retryable: true });
    expect(connectionKind(state({ status: 'inaccessible', error: refusal }))).toBe('unreadable');
  });
});

describe('readAt', () => {
  it('stamps a read when the store publishes it, not when the bar first draws it', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-07T21:24:00'));
      let fail = false;
      const transport: DesktopTransport = {
        async invoke<T>() {
          if (fail) throw new Error('The session file could not be read.');
          return { api_version: 1, ok: true, data: { kind: 'session_get', data: { session: structuredClone(demo), freshness: 'fresh' } } } as T;
        },
        async listen() { return () => {}; },
      };
      const opened = new OpenSessions(createDesktopService(transport));
      const route = { project_id: demo.project_id, session_id: demo.id };
      const store = opened.open(route);
      await vi.advanceTimersByTimeAsync(0); await store.refresh();
      const good = store.getSnapshot().snapshot!;
      // Nothing drew it yet, and time passes before the failed read and before anything asks.
      vi.setSystemTime(new Date('2026-10-07T21:31:00'));
      fail = true; await store.refresh();
      expect(store.getSnapshot().status).not.toBe('ready');
      expect(store.getSnapshot().snapshot).toBe(good);
      vi.setSystemTime(new Date('2026-10-07T21:40:00'));
      expect(readAt(good)).toBe(new Date('2026-10-07T21:24:00').getTime());
      expect(connectionView(store.getSnapshot()).lastGoodAt).toBe('21:24');
      opened.closeAll();
    } finally { vi.useRealTimers(); }
  });
});

describe('connectionView', () => {
  it('names the last good copy by the time that read was first seen, not the time the failure was', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-07T21:24:00'));
      const snapshot = { session: base(), freshness: 'fresh' } as const;
      expect(connectionView(state({ snapshot: snapshot as never })).kind).toBe('live');
      expect(readAt(snapshot)).toBe(Date.now());
      vi.setSystemTime(new Date('2026-10-07T21:31:00'));
      const view = connectionView(state({ snapshot: snapshot as never, status: 'stale', error: failure }));
      expect(view.kind).toBe('stale');
      expect(view.lastGoodAt).toBe('21:24');
    } finally { vi.useRealTimers(); }
  });

  it('an unsure save is the live state itself, so the dot says "not saving"', () => {
    const live = connectionView(state(), { at: Date.UTC(2026, 9, 7, 21, 31) });
    expect(live.kind).toBe('unsaved');
    expect(live.unsavedToo).toBeUndefined();
    expect(live.unsavedAt).toMatch(/^\d\d:\d\d$/);
  });

  it.each(['stale', 'unreadable', 'closed'] as const)('over %s it adds its own line and leaves that state on the dot', kind => {
    const closed = base(); closed.state = 'closed';
    const patch = kind === 'stale' ? { status: 'stale', error: failure } : kind === 'unreadable' ? { status: 'inaccessible', error: failure } : { session: closed };
    const view = connectionView(state(patch as Partial<SessionState>), { at: 1 });
    expect(view.kind).toBe(kind);
    expect(view.unsavedToo).toBe(true);
  });

  it('while the first read is loading an unsure save still has its surface: the second line', () => {
    expect(connectionView(state({ session: null, status: 'loading' }))).toEqual({ kind: 'loading' });
    const view = connectionView(state({ session: null, status: 'loading' }), { at: 1 });
    expect(view).toMatchObject({ kind: 'loading', unsavedToo: true });
    expect(view.unsavedAt).toMatch(/^\d\d:\d\d$/);
    expect(connectionView(state({ session: null, status: 'loading' }), {})).toEqual({ kind: 'loading', unsavedToo: true });
  });

  it('only a cut-off file (corrupt_session) says so; any other cause of unreadable does not', () => {
    const corrupt = new CoreFailure({ code: 'corrupt_session', message: 'x', hint: '', field_errors: [], retryable: false });
    const busy = new CoreFailure({ code: 'io_error', message: 'x', hint: '', field_errors: [], retryable: true });
    const unreadable = (error: unknown) => connectionView(state({ session: null, status: 'inaccessible', error: error as never }));
    expect(unreadable(corrupt)).toMatchObject({ kind: 'unreadable', corrupt: true });
    for (const other of [busy, failure, null]) expect(unreadable(other).corrupt).toBeUndefined();
    // With a held copy that the host refuses, the kind is unreadable too, and the same rule applies.
    const held = connectionView(state({ status: 'inaccessible', error: corrupt }));
    expect(held).toMatchObject({ kind: 'unreadable', corrupt: true });
  });

  it('Live counts what is on its way and what is queued behind it', () => {
    const view = connectionView(state());
    expect(view.sending).toEqual(expect.objectContaining({ onItsWay: expect.any(Number), queued: expect.any(Number) }));
  });
});
