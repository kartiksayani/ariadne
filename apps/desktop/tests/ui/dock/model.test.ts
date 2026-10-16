import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockStore } from '../../../src/state/dock/store';

const questions = [
  { id: 'q1', itemId: '1', question: 'First question' },
  { id: 'q2', itemId: '2', question: 'Second question' },
  { id: 'q3', itemId: '3', question: 'Third question' },
];
afterEach(() => vi.useRealTimers());

describe('dock view invariant: only owner actions open it; no Map side effects', () => {
  it.each(['question arriving', 'answered elsewhere', 'session switch'] as const)('%s', event => {
    const dock = new DockStore();
    dock.sync('session-a', questions.slice(0, 2));
    if (event === 'question arriving') dock.sync('session-a', questions);
    if (event === 'answered elsewhere') dock.sync('session-a', questions.slice(1));
    if (event === 'session switch') dock.sync('session-b', questions);
    expect(dock.getSnapshot().open).toBe(false);
    // The model contains no scroll/focus command or callback to replay later.
    expect(Object.keys(dock.getSnapshot()).sort()).toEqual(['current', 'open', 'questions', 'session']);
    dock.dispose();
  });
  it('keeps a manual question change ahead of a pending auto-advance', () => {
    vi.useFakeTimers();
    const dock = new DockStore(); dock.sync('session-a', questions); dock.show('q1');
    dock.sent('q1'); vi.advanceTimersByTime(2600);
    expect(dock.getSnapshot().current?.id).toBe('q1');
    dock.show('q3'); vi.advanceTimersByTime(200);
    expect(dock.getSnapshot().current?.id).toBe('q3');
    dock.dispose();
  });
  it.each(['last answer sent', 'last question withdrawn'] as const)('stays folded when a question arrives after %s', trigger => {
    vi.useFakeTimers(); const dock = new DockStore();
    dock.sync('session-a', questions.slice(0, 1)); dock.show();
    if (trigger === 'last answer sent') dock.sent('q1');
    dock.sync('session-a', []); vi.advanceTimersByTime(2700);
    expect(dock.getSnapshot().open).toBe(false);
    dock.sync('session-a', questions.slice(1));
    expect(dock.getSnapshot().open).toBe(false);
    dock.dispose();
  });
  it('shows Sent for 2.7 seconds then advances without changing the open state', () => {
    vi.useFakeTimers(); const dock = new DockStore();
    dock.sync('session-a', questions); dock.show('q1'); dock.sent('q1');
    dock.sync('session-a', questions.slice(1));
    expect(dock.getSnapshot().current?.id).toBe('q1');
    vi.advanceTimersByTime(2700);
    expect(dock.getSnapshot().current?.id).toBe('q2');
    expect(dock.getSnapshot().open).toBe(true);
    dock.fold(); dock.sync('session-a', []);
    expect(dock.getSnapshot().open).toBe(false);
    dock.dispose();
  });
  it('brackets step in order and the pager selects without touching drafts', () => {
    const dock = new DockStore(); dock.sync('session-a', questions);
    dock.step(1); expect(dock.getSnapshot().current?.id).toBe('q2');
    dock.step(-1); expect(dock.getSnapshot().current?.id).toBe('q1');
    dock.show('q3'); expect(dock.getSnapshot().current?.id).toBe('q3');
    dock.sync('session-b', questions); expect(dock.getSnapshot().open).toBe(false);
    dock.dispose();
  });
  it('advances past the answered position before wrapping to earlier waiting questions', () => {
    vi.useFakeTimers(); const dock = new DockStore();
    dock.sync('session-a', questions); dock.show('q2'); dock.sent('q2');
    dock.sync('session-a', [questions[0]!, questions[2]!]); vi.advanceTimersByTime(2700);
    expect(dock.getSnapshot().current?.id).toBe('q3'); dock.dispose();
  });
  it('cancels auto-advance when Undo returns the question to the queue', () => {
    vi.useFakeTimers(); const dock = new DockStore();
    dock.sync('session-a', questions); dock.show('q1'); dock.sent('q1');
    dock.sync('session-a', questions.slice(1)); dock.sync('session-a', questions);
    vi.advanceTimersByTime(2700);
    expect(dock.getSnapshot().current?.id).toBe('q1'); dock.dispose();
  });
});
