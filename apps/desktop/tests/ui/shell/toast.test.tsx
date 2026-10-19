import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Toast } from '../../../src/ui/shell/ToastView';
import { toasts } from '../../../src/ui/shell/toast';
import { NoticeStore } from '../../../src/ui/pages/notices';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { const current = toasts.current(); if (current) toasts.dismiss(current.id); cleanup(); vi.useRealTimers(); });

describe('toast store', () => {
  it('shows one toast at a time; the newest replaces the shown one and the replaced Undo is not run', () => {
    const first = vi.fn(), second = vi.fn();
    const a = toasts.show({ text: 'First.', undo: first });
    const b = toasts.show({ text: 'Second.', undo: second });
    expect(a).not.toBe(b);
    expect(toasts.current()?.text).toBe('Second.');
    toasts.runUndo(a);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it('closes after its display time (6 s by default, or ms)', () => {
    toasts.show({ text: 'Default.' });
    act(() => { vi.advanceTimersByTime(5999); });
    expect(toasts.current()).not.toBeNull();
    act(() => { vi.advanceTimersByTime(2); });
    expect(toasts.current()).toBeNull();
    toasts.show({ text: 'Short.', ms: 1000 });
    act(() => { vi.advanceTimersByTime(1001); });
    expect(toasts.current()).toBeNull();
  });

  it('expire removes Undo at once but leaves the text until its display time ends', () => {
    const undo = vi.fn();
    const id = toasts.show({ text: 'Removed.', undo });
    toasts.expire(id);
    expect(toasts.current()).toMatchObject({ text: 'Removed.', expired: true });
    toasts.runUndo(id);
    expect(undo).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(6001); });
    expect(toasts.current()).toBeNull();
  });

  it('expire of a replaced or unknown toast changes nothing', () => {
    const a = toasts.show({ text: 'A.', undo: vi.fn() });
    toasts.show({ text: 'B.', undo: vi.fn() });
    toasts.expire(a);
    expect(toasts.current()).toMatchObject({ text: 'B.', expired: false });
    toasts.expire('nope');
    expect(toasts.current()?.expired).toBe(false);
  });

  it('runs Undo once, then closes', () => {
    const undo = vi.fn();
    const id = toasts.show({ text: 'Hid.', undo });
    toasts.runUndo(id);
    toasts.runUndo(id);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(toasts.current()).toBeNull();
  });

  it('dismiss never runs Undo', () => {
    const undo = vi.fn();
    toasts.dismiss(toasts.show({ text: 'Hid.', undo }));
    expect(undo).not.toHaveBeenCalled();
    expect(toasts.current()).toBeNull();
  });

  it('hover pauses only the display timer and resumes with the time left', () => {
    const id = toasts.show({ text: 'Slow.', undo: vi.fn() });
    act(() => { vi.advanceTimersByTime(4000); });
    toasts.pause(id);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(toasts.current()).not.toBeNull();
    toasts.expire(id);
    expect(toasts.current()?.expired).toBe(true);
    toasts.resume(id);
    act(() => { vi.advanceTimersByTime(1999); });
    expect(toasts.current()).not.toBeNull();
    act(() => { vi.advanceTimersByTime(2); });
    expect(toasts.current()).toBeNull();
  });

  it('notifies subscribers', () => {
    const seen = vi.fn();
    const off = toasts.subscribe(seen);
    const id = toasts.show({ text: 'x' });
    toasts.dismiss(id);
    off();
    toasts.show({ text: 'y' });
    expect(seen).toHaveBeenCalledTimes(2);
  });
});

describe('<Toast/>', () => {
  it('renders the text, Undo and Dismiss; × closes without undoing', () => {
    const undo = vi.fn();
    render(<Toast />);
    expect(screen.queryByTestId('toast')).toBeNull();
    act(() => { toasts.show({ text: 'Hid “x”.', undo }); });
    expect(screen.getByTestId('toast').textContent).toContain('Hid “x”.');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(undo).not.toHaveBeenCalled();
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('keeps one polite live region mounted, empty or not, so the first toast is announced', () => {
    const { container } = render(<Toast />);
    const live = container.querySelector<HTMLElement>('[aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(live!.children).toHaveLength(0);
    act(() => { toasts.show({ text: 'First.' }); });
    expect(within(live!).getByTestId('toast').textContent).toContain('First.');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(container.querySelector('[aria-live="polite"]')).toBe(live);
    expect(live!.children).toHaveLength(0);
  });

  it('Undo runs once and closes', () => {
    const undo = vi.fn();
    render(<Toast />);
    act(() => { toasts.show({ text: 'Hid “x”.', undo }); });
    const button = screen.getByRole('button', { name: /Undo/ });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('hovering past an expired Undo shows no Undo', () => {
    render(<Toast />);
    let id = '';
    act(() => { id = toasts.show({ text: 'Removed.', undo: vi.fn() }); });
    fireEvent.mouseEnter(screen.getByTestId('toast'));
    expect(screen.getByRole('button', { name: /Undo/ })).toBeTruthy();
    act(() => { toasts.expire(id); });
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
    expect(screen.getByTestId('toast').textContent).toContain('Removed.');
  });

  it('a toast without Undo shows only × ', () => {
    render(<Toast />);
    act(() => { toasts.show({ text: 'Copied.' }); });
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
  });
});

describe('notice tone', () => {
  it('neutral without actions expires; warn and problem stay', () => {
    const store = new NoticeStore();
    store.push({ id: 'n', icon: 'ph ph-info', tone: 'neutral', text: 'n' }, 100);
    store.push({ id: 'w', icon: 'ph ph-info', tone: 'warn', text: 'w' }, 100);
    store.push({ id: 'p', icon: 'ph ph-info', tone: 'problem', text: 'p' }, 100);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(store.getSnapshot().map(notice => notice.id)).toEqual(['w', 'p']);
  });

  it('keeps today’s inference when no tone is given', () => {
    const store = new NoticeStore();
    store.push({ id: 'i', icon: 'ph ph-info', text: 'info' }, 100);
    store.push({ id: 'x', icon: 'ph ph-warning', text: 'warn icon' }, 100);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(store.getSnapshot().map(notice => notice.id)).toEqual(['x']);
  });
});
