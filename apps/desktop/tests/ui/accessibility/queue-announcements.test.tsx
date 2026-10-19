import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { QueueAnnouncements } from '../../../src/components/accessibility/QueueAnnouncements';
import type { WaitingState } from '../../../src/selectors/waiting/store';

afterEach(cleanup);

/** A waiting row for a question, in the one fields the announcements read. */
const row = (id: string, revision = 1, session = 's') => ({ route: { project_id: 'p', session_id: session }, item: { id, question_revision: revision } });
/** A listed session, in the one fields the announcements read. `created` is when the session was created. */
const listed = (session = 's', created = 0) => ({ summary: { created_at: String(created) }, session: { project_id: 'p', id: session, inputs: {} } });
const state = (patch: Partial<Record<keyof WaitingState, unknown>> = {}): WaitingState => ({
  status: 'ready', counts: { completeness: 'complete', unavailable_session_ids: [] }, waiting: [], sent: [], sessions: [listed()], unavailableProjects: [], error: null, ...patch,
}) as unknown as WaitingState;
const updates = () => screen.getByRole('status', { name: 'Queue updates' });
const failed = { status: 'stale', error: new Error('read failed') };

describe('QueueAnnouncements while the waiting reader is not ready', () => {
  it.each([
    ['stale', { status: 'stale' }],
    ['errored', failed],
  ])('announces a new question from the sessions a %s reader lists, once it has been seeded by a complete read', (_name, patch) => {
    const view = render(<QueueAnnouncements state={state({ waiting: [row('1')] })} />);
    expect(updates().textContent).toBe('');
    act(() => { view.rerender(<QueueAnnouncements state={state({ ...patch, waiting: [row('1'), row('2')] })} />); });
    expect(updates().textContent).toBe('1 new waiting question.');
    act(() => { view.rerender(<QueueAnnouncements state={state({ ...patch, waiting: [row('1'), row('2')] })} />); });
    expect(updates().textContent).toBe('1 new waiting question.');
  });

  it('does not read a half-loaded first list out as new questions', () => {
    const view = render(<QueueAnnouncements state={state({ status: 'stale', sessions: [], waiting: [row('1')] })} />);
    act(() => { view.rerender(<QueueAnnouncements state={state({ waiting: [row('1'), row('2')] })} />); });
    expect(updates().textContent).toBe('');
  });

  it.each([
    ['loading', { status: 'loading', counts: null }],
    ['unavailable', { status: 'unavailable', counts: null }],
  ])('skips a %s reader that has no data yet', (_name, patch) => {
    const view = render(<QueueAnnouncements state={state({ waiting: [row('1')] })} />);
    act(() => { view.rerender(<QueueAnnouncements state={state({ ...patch, sessions: [] })} />); });
    expect(updates().textContent).toBe('');
  });
});

describe('QueueAnnouncements seeds per session', () => {
  it('seeds a session silently when it first reads, then announces its new question', () => {
    // B is unreadable (not listed) while the reader is degraded: the first publish has only A.
    const view = render(<QueueAnnouncements state={state({ ...failed, sessions: [listed('a')], waiting: [row('1', 1, 'a')] })} />);
    act(() => { view.rerender(<QueueAnnouncements state={state({ ...failed, sessions: [listed('a'), listed('b')], waiting: [row('1', 1, 'a'), row('9', 1, 'b')] })} />); });
    expect(updates().textContent).toBe('');
    act(() => { view.rerender(<QueueAnnouncements state={state({ ...failed, sessions: [listed('a'), listed('b')], waiting: [row('1', 1, 'a'), row('9', 1, 'b'), row('10', 1, 'b')] })} />); });
    expect(updates().textContent).toBe('1 new waiting question.');
  });

  it('announces a new question in A while B stays unreadable', () => {
    const view = render(<QueueAnnouncements state={state({ ...failed, sessions: [listed('a')], waiting: [row('1', 1, 'a')] })} />);
    expect(updates().textContent).toBe('');
    act(() => { view.rerender(<QueueAnnouncements state={state({ ...failed, sessions: [listed('a')], waiting: [row('1', 1, 'a'), row('2', 1, 'a')] })} />); });
    expect(updates().textContent).toBe('1 new waiting question.');
  });

  it('announces the first question of a session created after the view mounted', () => {
    const view = render(<QueueAnnouncements state={state({ sessions: [listed('a')], waiting: [] })} />);
    act(() => { view.rerender(<QueueAnnouncements state={state({ sessions: [listed('a'), listed('c', Date.now() + 60_000)], waiting: [row('1', 1, 'c')] })} />); });
    expect(updates().textContent).toBe('1 new waiting question.');
  });
});
