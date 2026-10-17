import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockStore } from '../../../src/state/dock/store';
import { compareOtherGroups, dockPath } from '../../../src/ui/dock/model';
import { immutable } from '../../../src/data/session-store';
import demo from '../../../../../fixtures/domain/demo/session.json';
import type { Session } from '../../../src/generated/domain/models';

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
    const dock = new DockStore(); dock.sync('session-a', questions); dock.show();
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
  it('keeps "1 of N" true during the Sent hold: the held question stays in its place', () => {
    vi.useFakeTimers(); const dock = new DockStore();
    dock.sync('session-a', questions); dock.show('q2'); dock.sent('q2');
    dock.sync('session-a', [questions[0]!, questions[2]!]);
    expect(dock.getSnapshot().questions.map(question => question.id)).toEqual(['q1', 'q2', 'q3']);
    expect(dock.getSnapshot().current?.id).toBe('q2');
    // Another question answered elsewhere meanwhile: the held one keeps its place among the rest.
    dock.sync('session-a', [questions[2]!]);
    expect(dock.getSnapshot().questions.map(question => question.id)).toEqual(['q2', 'q3']);
    vi.advanceTimersByTime(2700);
    expect(dock.getSnapshot().questions.map(question => question.id)).toEqual(['q3']);
    expect(dock.getSnapshot().current?.id).toBe('q3');
    dock.dispose();
  });
  it('[ and ] open a folded dock at the current question without moving it', () => {
    const dock = new DockStore(); dock.sync('session-a', questions); dock.show('q2'); dock.fold();
    dock.step(1);
    expect(dock.getSnapshot()).toMatchObject({ open: true, current: { id: 'q2' } });
    dock.fold(); dock.step(-1);
    expect(dock.getSnapshot()).toMatchObject({ open: true, current: { id: 'q2' } });
    dock.dispose();
  });
  it.each(['same session', 'session not loaded yet', 'answered meanwhile'] as const)('openAt opens at the asked question: %s', path => {
    const dock = new DockStore(); dock.sync('session-a', questions);
    if (path === 'same session') {
      dock.openAt('session-a', '3');
      expect(dock.getSnapshot()).toMatchObject({ open: true, current: { id: 'q3' } });
    } else {
      dock.openAt('session-b', path === 'answered meanwhile' ? '9' : '3');
      expect(dock.getSnapshot().open).toBe(false);
      dock.sync('session-b', [], false);
      expect(dock.getSnapshot().open).toBe(false);
      dock.sync('session-b', questions, true);
      expect(dock.getSnapshot()).toMatchObject({ open: true, current: { id: path === 'answered meanwhile' ? 'q1' : 'q3' } });
      // The request is spent: a later session change does not open it again.
      dock.fold(); dock.sync('session-a', questions); dock.sync('session-b', questions);
      expect(dock.getSnapshot().open).toBe(false);
    }
    dock.dispose();
  });
  it('cancels auto-advance when Undo returns the question to the queue', () => {
    vi.useFakeTimers(); const dock = new DockStore();
    dock.sync('session-a', questions); dock.show('q1'); dock.sent('q1');
    dock.sync('session-a', questions.slice(1)); dock.sync('session-a', questions);
    vi.advanceTimersByTime(2700);
    expect(dock.getSnapshot().current?.id).toBe('q1'); dock.dispose();
  });
});

describe('the other-sessions list', () => {
  it('orders groups by project, then session name, not by who waited longest', () => {
    const groups = [{ project: 'notes-web', name: 'flaky tests' }, { project: 'notes-api', name: 'schema review' }, { project: 'notes-api', name: 'auth rewrite' }];
    expect([...groups].sort(compareOtherGroups).map(group => `${group.project} · ${group.name}`)).toEqual([
      'notes-api · auth rewrite', 'notes-api · schema review', 'notes-web · flaky tests']);
  });
});

describe('the dock head path', () => {
  const session = () => structuredClone(demo) as unknown as Session;
  it('runs from the topic through the ancestors and stops at the parent: the question itself is the title, not a segment', () => {
    expect(dockPath(immutable(session()), '1.1').map(part => [part.itemId, part.full])).toEqual([
      [null, 'Delivery decisions'], ['1', 'Keep the full reply history?']]);
    expect(dockPath(immutable(session()), '2').map(part => part.itemId)).toEqual([null]);
    expect(dockPath(immutable(session()), 'missing')).toEqual([]);
  });
  it('folds past three parts to first, second, "…", the parent until expanded', () => {
    const value = session();
    value.items['1.1']!.parent = '1'; value.items['4']!.parent = '1.1'; value.items['5']!.parent = '4';
    const folded = dockPath(immutable(value), '5');
    expect(folded.map(part => part.more ? '…' : part.itemId)).toEqual([null, '1', '…', '4']);
    expect(dockPath(immutable(value), '5', true).map(part => part.itemId)).toEqual([null, '1', '1.1', '4']);
    // Three parts (topic and two ancestors) are not folded.
    expect(dockPath(immutable(value), '4').map(part => part.itemId)).toEqual([null, '1', '1.1']);
  });
});
