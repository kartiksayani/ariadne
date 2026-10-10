import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NoticeStore, Notices } from '../../../src/ui/pages/notices';
import { Dialog } from '../../../src/ui/dialogs/Dialog';

const info = { icon: 'ph ph-check', text: 'Saved.' };
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe('toast store', () => {
  let store: NoticeStore;
  beforeEach(() => { vi.useFakeTimers(); store = new NoticeStore(); });
  afterEach(() => { store.clear(); vi.useRealTimers(); });

  it('keeps the producer snapshot immediate but debounces display and starts six seconds on display', () => {
    store.push(info);
    expect(store.getSnapshot()).toHaveLength(1);
    expect(store.getVisibleSnapshot()).toEqual([]);
    advance(299);
    expect(store.getVisibleSnapshot()).toEqual([]);
    advance(1);
    expect(store.getVisibleSnapshot()[0]?.text).toBe('Saved.');
    advance(5999);
    expect(store.getVisibleSnapshot()).toHaveLength(1);
    advance(1);
    expect(store.getSnapshot()).toEqual([]);
  });

  it('cancels a pending toast without ever displaying it', () => {
    const listener = vi.fn();
    store.subscribe(listener);
    const id = store.push(info);
    advance(100);
    store.dismiss(id);
    listener.mockClear();
    advance(10000);
    expect(store.getVisibleSnapshot()).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('deduplicates pending repeats and refreshes callbacks without delaying display indefinitely', () => {
    const oldRun = vi.fn(), newRun = vi.fn();
    const id = store.push({ ...info, actions: [{ label: 'View', run: oldRun }] });
    advance(200);
    expect(store.push({ ...info, actions: [{ label: 'View', run: newRun }] })).toBe(id);
    expect(store.getSnapshot()).toHaveLength(1);
    advance(99);
    expect(store.getVisibleSnapshot()).toEqual([]);
    advance(1);
    store.getVisibleSnapshot()[0]?.actions?.[0]?.run();
    expect(newRun).toHaveBeenCalledOnce();
    expect(oldRun).not.toHaveBeenCalled();
  });

  it('refreshes an existing id in place and resets its lifetime without removing it', () => {
    const id = store.push(info, 1000);
    store.push({ ...info, text: 'Another save.' });
    advance(300);
    advance(900);
    store.push({ ...info, id, text: 'Saved again.' }, 2000);
    expect(store.getVisibleSnapshot().map(notice => notice.text)).toEqual(['Saved again.', 'Another save.']);
    advance(1999);
    expect(store.getSnapshot().some(notice => notice.id === id)).toBe(true);
    advance(1);
    expect(store.getSnapshot().some(notice => notice.id === id)).toBe(false);
  });

  it('deduplicates already visible identical notices and refreshes their full lifetime', () => {
    const id = store.push(info, 1000);
    advance(300);
    advance(999);
    expect(store.push(info, 1000)).toBe(id);
    expect(store.getVisibleSnapshot()).toHaveLength(1);
    advance(999);
    expect(store.getVisibleSnapshot()).toHaveLength(1);
    advance(1);
    expect(store.getVisibleSnapshot()).toEqual([]);
  });

  it('keeps identical content with different explicit ids scoped to its producer', () => {
    expect(store.push({ ...info, id: 'session-one' })).toBe('session-one');
    expect(store.push({ ...info, id: 'session-two' })).toBe('session-two');
    advance(300);
    store.dismiss('session-one');
    expect(store.getVisibleSnapshot().map(notice => notice.id)).toEqual(['session-two']);
    expect(store.push(info)).not.toBe('session-two');
  });

  it('persists actions and problems regardless of explicit timeouts', () => {
    store.push({ ...info, actions: [{ label: 'Undo', run: vi.fn() }] }, 1);
    store.push({ icon: 'ph ph-warning', iconColor: 'var(--a-warn)', text: 'Not saved.' }, 1);
    store.push({ ...info, text: 'Unavailable.', tone: 'problem' }, 1);
    store.push({ icon: 'ph ph-warning-circle', text: 'Could not open.' }, 1);
    advance(60000);
    expect(store.getVisibleSnapshot()).toHaveLength(4);
  });

  it('pauses the remaining lifetime independently for hover and focus', () => {
    const id = store.push(info, 1000);
    advance(300);
    advance(400);
    store.pause(id, 'hover');
    store.pause(id, 'hover');
    store.pause(id, 'focus');
    advance(10000);
    store.resume(id, 'hover');
    advance(10000);
    expect(store.getVisibleSnapshot()).toHaveLength(1);
    store.resume(id, 'focus');
    advance(599);
    expect(store.getVisibleSnapshot()).toHaveLength(1);
    advance(1);
    expect(store.getVisibleSnapshot()).toEqual([]);
  });

  it('refreshes a paused toast without resuming until both pause sources leave', () => {
    const id = store.push(info, 1000);
    advance(300);
    store.pause(id, 'focus');
    store.push(info, 2000);
    advance(10000);
    expect(store.getVisibleSnapshot()).toHaveLength(1);
    store.resume(id, 'focus');
    advance(1999);
    expect(store.getVisibleSnapshot()).toHaveLength(1);
    advance(1);
    expect(store.getVisibleSnapshot()).toEqual([]);
  });

  it('clears pending and visible timers and supports detaching a subscription', () => {
    const listener = vi.fn(), unsubscribe = store.subscribe(listener);
    store.push(info);
    advance(300);
    store.push({ ...info, text: 'Pending.' });
    unsubscribe();
    listener.mockClear();
    store.clear();
    advance(10000);
    expect(store.getSnapshot()).toEqual([]);
    expect(store.getVisibleSnapshot()).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('toast region', () => {
  let store: NoticeStore;
  beforeEach(() => { vi.useFakeTimers(); store = new NoticeStore(); });
  afterEach(() => { cleanup(); store.clear(); vi.useRealTimers(); });
  const push = (input: Parameters<NoticeStore['push']>[0], timeout?: number) => {
    let id = '';
    act(() => { id = store.push(input, timeout); });
    advance(300);
    return id;
  };

  it('keeps one persistent region with polite information and assertive problems', () => {
    render(<Notices store={store} />);
    const region = screen.getByRole('region', { name: 'Notifications' });
    const polite = region.querySelector('[aria-live="polite"]');
    const assertive = region.querySelector('[aria-live="assertive"]');
    expect(polite).not.toBeNull();
    expect(assertive).not.toBeNull();
    expect(within(region).queryByRole('alert')).toBeNull();
    push(info);
    push({ ...info, text: 'Retry needed.', iconColor: 'var(--a-danger)' });
    expect(within(screen.getByRole('status')).getByText('Saved.')).toBeTruthy();
    expect(within(screen.getByRole('alert')).getByText('Retry needed.')).toBeTruthy();
    act(() => { store.clear(); });
    expect(screen.getByRole('region', { name: 'Notifications' })).toBe(region);
    expect(region.querySelector('[aria-live="polite"]')).toBe(polite);
    expect(region.querySelector('[aria-live="assertive"]')).toBe(assertive);
    expect(within(region).queryByRole('alert')).toBeNull();
  });

  it('preserves a visible card and focus when identical content refreshes', () => {
    render(<Notices store={store} />);
    push(info);
    const card = screen.getByText(info.text).closest<HTMLElement>('.pw-note')!;
    act(() => { card.focus(); store.push(info); });
    expect(screen.getByText(info.text).closest('.pw-note')).toBe(card);
    expect(document.activeElement).toBe(card);
  });

  it('supports F6, Escape, default dismiss and restoration to the previous control', () => {
    const onDismiss = vi.fn();
    render(<><button type="button">Editor</button><Notices store={store} /></>);
    const editor = screen.getByRole('button', { name: 'Editor' });
    editor.focus();
    push({ ...info, onDismiss });
    expect(document.activeElement).toBe(editor);
    fireEvent.keyDown(document, { key: 'F6' });
    const card = screen.getByText(info.text).closest('.pw-note');
    expect(document.activeElement).toBe(card);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(screen.queryByText(info.text)).toBeNull();
    expect(document.activeElement).toBe(editor);
  });

  it('returns from F6 and restores focus when a focused action is dismissed externally', () => {
    render(<><button type="button">Editor</button><Notices store={store} /></>);
    const editor = screen.getByRole('button', { name: 'Editor' });
    editor.focus();
    const id = push(info);
    fireEvent.keyDown(document, { key: 'F6' });
    fireEvent.keyDown(document, { key: 'F6', shiftKey: true });
    expect(document.activeElement).toBe(editor);
    act(() => { screen.getByRole('button', { name: 'Dismiss' }).focus(); });
    act(() => { store.dismiss(id); });
    expect(document.activeElement).toBe(editor);
  });

  it.each(['dialog', 'alertdialog'] as const)('preserves modal %s input focus and selection when F6 is pressed', role => {
    render(<><Notices store={store} /><Dialog label="Rename" width={420} role={role} onCancel={vi.fn()}>
      <input aria-label="Name" defaultValue="Planning notes" />
    </Dialog></>);
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' });
    act(() => { input.focus(); input.setSelectionRange(3, 8, 'backward'); });
    push(info);
    expect(screen.getByText(info.text)).toBeTruthy();
    expect(screen.getByRole(role, { name: 'Rename' }).getAttribute('aria-modal')).toBe('true');
    for (const shiftKey of [false, true]) {
      fireEvent.keyDown(input, { key: 'F6', shiftKey });
      expect(document.activeElement).toBe(input);
      expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([3, 8, 'backward']);
    }
  });

  it('pauses on mouse hover and focus and resumes only after both have left', () => {
    render(<><button type="button">Editor</button><Notices store={store} /></>);
    push(info, 1000);
    const card = screen.getByText(info.text).closest<HTMLElement>('.pw-note')!;
    advance(400);
    fireEvent.mouseEnter(card);
    act(() => { card.focus(); });
    advance(10000);
    fireEvent.mouseLeave(card);
    advance(10000);
    expect(screen.getByText(info.text)).toBeTruthy();
    act(() => { screen.getByRole('button', { name: 'Editor' }).focus(); });
    advance(599);
    expect(screen.getByText(info.text)).toBeTruthy();
    advance(1);
    expect(screen.queryByText(info.text)).toBeNull();
  });

  it('dismisses an explicitly synchronous action without invoking owner dismissal', () => {
    const run = vi.fn(), onDismiss = vi.fn();
    render(<Notices store={store} />);
    push({ ...info, onDismiss, actions: [{ label: 'View', run, dismissOnRun: true }] });
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(run).toHaveBeenCalledOnce();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.queryByText(info.text)).toBeNull();
  });

  it('keeps identical scoped action toasts bound to their respective producer callbacks', () => {
    const firstRun = vi.fn(), latestFirstRun = vi.fn(), secondRun = vi.fn();
    render(<Notices store={store} />);
    push({ ...info, id: 'session-one', actions: [{ label: 'View', run: firstRun, dismissOnRun: true }] });
    push({ ...info, id: 'session-two', actions: [{ label: 'View', run: secondRun, dismissOnRun: true }] });
    act(() => { store.push({ ...info, id: 'session-one', actions: [{ label: 'View', run: latestFirstRun, dismissOnRun: true }] }); });
    expect(screen.getAllByText(info.text)).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'View' })[0]!);
    expect(latestFirstRun).toHaveBeenCalledOnce();
    expect(firstRun).not.toHaveBeenCalled();
    expect(secondRun).not.toHaveBeenCalled();
    expect(store.getSnapshot().map(notice => notice.id)).toEqual(['session-two']);
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(secondRun).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toEqual([]);
  });

  it('keeps async or unresolved actions available until their producer dismisses', () => {
    const run = vi.fn(async () => {});
    render(<Notices store={store} />);
    push({ ...info, actions: [{ label: 'Check again', run }] }, 1);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    advance(10000);
    expect(run).toHaveBeenCalledOnce();
    expect(screen.getByText(info.text)).toBeTruthy();
  });

  it('retains an action returning a Promise even if synchronous dismissal was requested', () => {
    render(<Notices store={store} />);
    push({ ...info, actions: [{ label: 'Retry', run: vi.fn(async () => {}), dismissOnRun: true }] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByText(info.text)).toBeTruthy();
  });

  it('keeps disabled actions unavailable without removing their toast', () => {
    const run = vi.fn();
    render(<Notices store={store} />);
    push({ ...info, actions: [{ label: 'Undo', run, disabled: true, dismissOnRun: true }] });
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByText(info.text)).toBeTruthy();
  });

  it('does not dismiss a fresh failure produced synchronously by an action', () => {
    render(<Notices store={store} />);
    const id = 'save';
    push({ ...info, id, actions: [{ label: 'Try again', dismissOnRun: true,
      run: () => { store.push({ id, icon: 'ph ph-warning', tone: 'problem', text: 'Still unavailable.' }); } }] });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Still unavailable.')).toBeTruthy();
  });

  it('honors explicit nondismissibility and dismiss callbacks', () => {
    const onDismiss = vi.fn();
    render(<Notices store={store} />);
    const id = push({ ...info, dismissible: false });
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
    fireEvent.keyDown(screen.getByText(info.text).closest('.pw-note')!, { key: 'Escape' });
    expect(store.getSnapshot()).toHaveLength(1);
    act(() => { store.push({ ...info, id, onDismiss }); });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toEqual([]);
  });
});
