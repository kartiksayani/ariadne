import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState, type KeyboardEvent } from 'react';
import { HOLD_MAX, HOLD_MS, keyAnchor, routeWindowKey, useWindowKeys } from '../../../src/ui/shell/windowKeys';
import { watchFullscreen, SETTLE_MS } from '../../../src/ui/shell/fullscreen';
import { RootBoundary } from '../../../src/RootBoundary';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); document.body.innerHTML = ''; });

/** A stand-in for the workspace: an app root with its own keymap and a tree with a roving row. */
function Workspace({ tree = true, onKey }: { readonly tree?: boolean; readonly onKey: (where: string, key: string) => boolean }) {
  const root = useRef<HTMLDivElement>(null);
  useWindowKeys(root);
  const handle = (where: string) => (event: KeyboardEvent<HTMLElement>) => {
    if (where === 'row' && event.target !== event.currentTarget) return;
    if (onKey(where, event.key)) event.preventDefault();
  };
  return <div ref={root} className="product-app" data-testid="root" onKeyDown={handle('root')}>
    {tree && <section className="tree-column">
      <div data-row="1" tabIndex={-1} data-testid="row-1" onKeyDown={handle('row')}>1</div>
      <div data-row="2" tabIndex={0} data-testid="row-2" onKeyDown={handle('row')}>2</div>
    </section>}
    <p data-testid="text">Session connected</p>
    <input aria-label="Search" />
  </div>;
}
const press = (target: EventTarget, key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
};

describe('window-level workspace keys', () => {
  it('routes Cmd brackets directly from body, buttons and tree rows while leaving removal keys unchanged', () => {
    const root = document.createElement('div'); root.innerHTML = '<button>Back</button><div tabindex="0"></div>';
    document.body.append(root);
    const history = { back: vi.fn(() => true), forward: vi.fn(() => true) };
    const route = (target: EventTarget, key: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true, ...init });
      target.addEventListener('keydown', event => routeWindowKey(event as globalThis.KeyboardEvent, root, null, history), { once: true });
      target.dispatchEvent(event); return event;
    };
    expect(route(document.body, '[').defaultPrevented).toBe(true);
    expect(route(root.querySelector('button')!, ']').defaultPrevented).toBe(true);
    expect(route(root.querySelector('div')!, '[').defaultPrevented).toBe(true);
    expect(history.back).toHaveBeenCalledTimes(2); expect(history.forward).toHaveBeenCalledOnce();
    route(root, 'Backspace', { metaKey: false }); route(root, 'Delete', { metaKey: false });
    expect(history.back).toHaveBeenCalledTimes(2); expect(history.forward).toHaveBeenCalledOnce();
  });

  it('never routes history chords in text fields, editable content, dialogs, composition or stranded fields', () => {
    const root = document.createElement('div');
    root.innerHTML = '<input /><textarea></textarea><select></select><div contenteditable="true"><span>Editing</span></div><div contenteditable=""></div><div contenteditable="plaintext-only"></div><div role="textbox"></div>';
    document.body.append(root);
    const history = { back: vi.fn(() => true), forward: vi.fn(() => true) };
    const route = (target: Element, init: KeyboardEventInit = {}, stranded = false) => {
      const event = new KeyboardEvent('keydown', { key: '[', metaKey: true, bubbles: true, cancelable: true, ...init });
      target.addEventListener('keydown', event => routeWindowKey(event as globalThis.KeyboardEvent, root,
        stranded ? { field: root.querySelector('input')!, hold: vi.fn(), resume: vi.fn() } : null, history), { once: true });
      target.dispatchEvent(event); expect(event.defaultPrevented).toBe(false);
    };
    for (const target of root.querySelectorAll('input,textarea,select,span,[contenteditable],[role="textbox"]')) route(target);
    root.querySelector('input')!.focus(); route(document.body); root.querySelector('input')!.blur();
    route(document.body, { isComposing: true }); route(document.body, {}, true);
    const dialog = document.body.appendChild(document.createElement('div')); dialog.setAttribute('role', 'dialog');
    route(document.body); route(dialog);
    expect(history.back).not.toHaveBeenCalled(); expect(history.forward).not.toHaveBeenCalled();
  });

  it('replays a key pressed on <body> at the tree’s roving row, focuses it and consumes the key when handled', () => {
    const seen: string[] = [];
    render(<Workspace onKey={(where, key) => { seen.push(`${where}:${key}`); return where === 'row' && key === 'ArrowDown'; }} />);
    expect(document.activeElement).toBe(document.body);
    const event = press(document.body, 'ArrowDown');
    expect(seen).toEqual(['row:ArrowDown', 'root:ArrowDown']);
    expect(document.activeElement).toBe(screen.getByTestId('row-2'));
    expect(event.defaultPrevented).toBe(true);
  });

  it('sends workspace keys the row does not own on to the app root (g, /), without a tree to the root itself', () => {
    const seen: string[] = [];
    const { unmount } = render(<Workspace onKey={(where, key) => { seen.push(`${where}:${key}`); return where === 'root'; }} />);
    expect(press(document.body, 'g').defaultPrevented).toBe(true);
    expect(seen).toEqual(['row:g', 'root:g']);
    unmount(); seen.length = 0;
    render(<Workspace tree={false} onKey={(where, key) => { seen.push(`${where}:${key}`); return true; }} />);
    expect(press(document.body, '/').defaultPrevented).toBe(true);
    expect(seen).toEqual(['root:/']);
    expect(document.activeElement).toBe(document.body);
  });

  it('leaves keys inside the root, unbound keys, text fields and open dialogs alone', () => {
    const onKey = vi.fn(() => true);
    render(<Workspace onKey={onKey} />);
    // Inside the root its own handler already ran once; no replay doubles it.
    fireEvent.keyDown(screen.getByTestId('text'), { key: 'g' });
    expect(onKey).toHaveBeenCalledTimes(1);
    onKey.mockClear();
    expect(press(document.body, 'q').defaultPrevented).toBe(false);
    expect(press(document.body, 'j', { metaKey: true }).defaultPrevented).toBe(false);
    const outside = document.body.appendChild(document.createElement('textarea'));
    press(outside, 'g');
    const dialog = document.body.appendChild(document.createElement('div'));
    dialog.setAttribute('role', 'dialog');
    press(document.body, 'g');
    expect(onKey).not.toHaveBeenCalled();
  });

  it('does not replay keys as shortcuts when the focused text field was disabled under the owner, until they click away', () => {
    const onKey = vi.fn(() => true);
    render(<Workspace onKey={onKey} />);
    const field = document.body.appendChild(document.createElement('textarea'));
    act(() => { field.focus(); });
    // A save starts: the field is disabled and focus falls to <body>.
    field.disabled = true; field.blur();
    expect(press(document.body, 'e').defaultPrevented).toBe(false);
    expect(onKey).not.toHaveBeenCalled();
    // Clicking elsewhere is a deliberate move: keys on <body> are shortcuts again.
    act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(press(document.body, 'e').defaultPrevented).toBe(true);
    expect(onKey).toHaveBeenCalled();
    // A field that is enabled again, or gone, no longer holds the keys back.
    onKey.mockClear();
    act(() => { field.disabled = false; field.focus(); field.disabled = true; field.blur(); });
    field.remove();
    expect(press(document.body, 'e').defaultPrevented).toBe(true);
  });

  /** A text field outside the app root that the owner is typing in, then a save disables it (focus falls to <body>). */
  const strand = () => {
    const field = document.body.appendChild(document.createElement('textarea'));
    act(() => { field.focus(); });
    field.disabled = true; field.blur();
    return field;
  };
  const settle = () => act(async () => { await Promise.resolve(); });

  it('gives the field its focus back and the held keys once it is enabled again, instead of replaying them on the tree', async () => {
    const onKey = vi.fn(() => true);
    render(<Workspace onKey={onKey} />);
    const field = strand();
    await settle();
    // Typed while it was disabled: held, neither lost nor treated as the tree’s d, e and 1.
    press(document.body, 'd'); press(document.body, 'e'); press(document.body, '1');
    expect(field.value).toBe('');
    field.disabled = false;
    await settle();
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe('de1');
    expect(onKey).not.toHaveBeenCalled();
  });

  it('refocuses the field and types into it when a key comes right after it was enabled again', async () => {
    vi.useFakeTimers();
    const onKey = vi.fn(() => true);
    render(<Workspace onKey={onKey} />);
    const field = strand();
    await settle();
    field.disabled = false;
    await settle();
    act(() => { vi.advanceTimersByTime(HOLD_MS - 100); });
    const event = press(document.body, 'd');
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe('d');
    expect(onKey).not.toHaveBeenCalled();
    // The caret is kept: the owner is back in the field, and keys inside it are theirs alone.
    expect(press(field, 'e').defaultPrevented).toBe(false);
  });

  it('treats a key long after the field was enabled again as a shortcut on the tree, not as typing', async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    render(<Workspace onKey={(where, key) => { seen.push(`${where}:${key}`); return where === 'row'; }} />);
    const field = strand();
    await settle();
    field.disabled = false;
    await settle();
    // Minutes later, with nothing typed in between.
    act(() => { vi.advanceTimersByTime(5 * 60_000); });
    const event = press(document.body, 'j');
    expect(event.defaultPrevented).toBe(true);
    expect(seen).toEqual(['row:j', 'root:j']);
    expect(field.value).toBe('');
    expect(document.activeElement).toBe(screen.getByTestId('row-2'));
    // The tree’s arrows and Esc work too.
    expect(press(document.body, 'ArrowDown').defaultPrevented).toBe(true);
  });

  it('inserts at the caret and reports the change to the field’s own handler', async () => {
    render(<Workspace onKey={() => true} />);
    const field = strand();
    await settle();
    field.disabled = false;
    field.value = 'ac'; field.setSelectionRange(1, 1);
    const seen: string[] = [];
    field.addEventListener('input', () => seen.push(field.value));
    await settle();
    press(document.body, 'b');
    expect(field.value).toBe('abc');
    expect(seen).toEqual(['abc']);
  });

  it('keeps the held keys for a slow save and hands them over once the field is enabled, never to the tree', async () => {
    vi.useFakeTimers();
    const onKey = vi.fn(() => true);
    render(<Workspace onKey={onKey} />);
    const field = strand();
    await settle();
    press(document.body, 'd'); press(document.body, 'e');
    act(() => { vi.advanceTimersByTime(HOLD_MS * 4); });
    press(document.body, '1');
    expect(field.value).toBe('');
    field.disabled = false;
    await settle();
    expect(field.value).toBe('de1');
    expect(document.activeElement).toBe(field);
    expect(onKey).not.toHaveBeenCalled();
  });

  it('applies Backspace typed while the field was disabled, to the held text and then to the field’s own text', async () => {
    render(<Workspace onKey={() => true} />);
    const field = strand();
    field.value = 'abc';
    await settle();
    press(document.body, 'x'); press(document.body, 'y'); press(document.body, 'Backspace'); press(document.body, 'z');
    press(document.body, 'Backspace'); press(document.body, 'Backspace'); press(document.body, 'Backspace');
    field.disabled = false;
    await settle();
    // x y <- z <- <- <-  : the three Backspaces remove z, x, then the “c” before the caret.
    expect(field.value).toBe('ab');
  });

  it('never holds or replays Enter or shortcut chords, so nothing is sent twice', async () => {
    const onKey = vi.fn(() => true);
    render(<Workspace onKey={onKey} />);
    const field = strand();
    const submitted = vi.fn();
    field.addEventListener('keydown', submitted);
    await settle();
    press(document.body, 'a'); press(document.body, 'Enter'); press(document.body, 'Enter', { metaKey: true });
    press(document.body, 'b', { metaKey: true }); press(document.body, 'Backspace', { metaKey: true }); press(document.body, 'ArrowDown');
    field.disabled = false;
    await settle();
    expect(field.value).toBe('a');
    expect(submitted).not.toHaveBeenCalled();
    expect(onKey).not.toHaveBeenCalled();
    // In the window after, Enter is not typed into the field either.
    expect(press(document.body, 'Enter').defaultPrevented).toBe(false);
    expect(field.value).toBe('a');
  });

  it('holds at most HOLD_MAX characters', async () => {
    render(<Workspace onKey={() => true} />);
    const field = strand();
    await settle();
    for (let at = 0; at < HOLD_MAX + 50; at += 1) press(document.body, 'a');
    field.disabled = false;
    await settle();
    expect(field.value).toBe('a'.repeat(HOLD_MAX));
  });

  it('drops what was held when the field is removed from the page', async () => {
    const onKey = vi.fn(() => true);
    render(<Workspace onKey={onKey} />);
    const field = strand();
    await settle();
    press(document.body, 'd');
    field.remove();
    // The keys went with the field: a later field gets none of them, and keys are shortcuts again.
    expect(press(document.body, 'e').defaultPrevented).toBe(true);
    expect(onKey).toHaveBeenCalled();
    const later = document.body.appendChild(document.createElement('textarea'));
    act(() => { later.focus(); });
    await settle();
    expect(later.value).toBe('');
  });

  it('always consumes plain Esc so macOS does not leave full screen, except for dialogs and input methods', () => {
    render(<Workspace onKey={() => false} />);
    expect(press(document.body, 'Escape').defaultPrevented).toBe(true);
    expect(press(screen.getByLabelText('Search'), 'Escape').defaultPrevented).toBe(true);
    expect(press(document.body, 'Escape', { metaKey: true }).defaultPrevented).toBe(false);
    expect(press(screen.getByLabelText('Search'), 'Escape', { isComposing: true }).defaultPrevented).toBe(false);
    const dialog = document.body.appendChild(document.createElement('div'));
    dialog.setAttribute('role', 'dialog');
    const inside = dialog.appendChild(document.createElement('button'));
    expect(press(inside, 'Escape').defaultPrevented).toBe(false);
    dialog.remove();
    const native = document.body.appendChild(document.createElement('dialog'));
    native.setAttribute('open', '');
    expect(press(document.body, 'Escape').defaultPrevented).toBe(false);
  });

  it('stops listening when the workspace unmounts', () => {
    const onKey = vi.fn(() => true);
    const { unmount } = render(<Workspace onKey={onKey} />);
    unmount();
    expect(press(document.body, 'Escape').defaultPrevented).toBe(false);
    expect(onKey).not.toHaveBeenCalled();
  });

  it('anchors on the graph’s roving node, then the graph scroller, then the root', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div class="graph-scroll" tabindex="-1"><div class="graph-node" tabindex="-1"></div><div class="graph-node" tabindex="0" id="node"></div></div>';
    expect(keyAnchor(root).id).toBe('node');
    root.querySelector('#node')!.setAttribute('tabindex', '-1');
    expect(keyAnchor(root).className).toBe('graph-scroll');
    root.innerHTML = '';
    expect(keyAnchor(root)).toBe(root);
  });
});

describe('full-screen strip', () => {
  it('marks <html data-fullscreen> from the native window and re-checks after the transition settles', async () => {
    vi.useFakeTimers();
    let fullscreen = false;
    const probe = { isFullscreen: vi.fn(() => Promise.resolve(fullscreen)) };
    const root = document.createElement('div');
    const stop = watchFullscreen(probe, root, window);
    await act(async () => { await Promise.resolve(); });
    expect(root.dataset.fullscreen).toBeUndefined();
    fullscreen = true;
    window.dispatchEvent(new Event('resize'));
    await act(async () => { await Promise.resolve(); });
    expect(root.dataset.fullscreen).toBe('');
    // Leaving full screen: the resize can arrive before the native state flips; the settled re-check corrects it.
    fullscreen = true;
    window.dispatchEvent(new Event('resize'));
    fullscreen = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_MS); });
    expect(root.dataset.fullscreen).toBeUndefined();
    expect(probe.isFullscreen).toHaveBeenCalledTimes(4);
    stop();
    window.dispatchEvent(new Event('resize'));
    expect(probe.isFullscreen).toHaveBeenCalledTimes(4);
  });

  it('keeps the windowed layout when there is no native window, and drops a stale answer', async () => {
    const root = document.createElement('div');
    watchFullscreen({ isFullscreen: () => Promise.reject(new Error('no window')) }, root, window)();
    await act(async () => { await Promise.resolve(); });
    expect(root.dataset.fullscreen).toBeUndefined();
    let answer!: (value: boolean) => void;
    const stop = watchFullscreen({ isFullscreen: () => new Promise(resolve => { answer = resolve; }) }, root, window);
    stop();
    await act(async () => { answer(true); await Promise.resolve(); });
    expect(root.dataset.fullscreen).toBeUndefined();
  });
});

describe('RootBoundary', () => {
  function Broken(): never { throw new Error('render exploded'); }
  it('offers Reload on a render error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reload = vi.fn();
    render(<RootBoundary reload={reload}><Broken /></RootBoundary>);
    expect(screen.getByRole('alert').textContent).toContain('render exploded');
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it('reloads the window by default and renders children when nothing failed', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    function Toggle() { const [broken, setBroken] = useState(false); return broken ? <Broken /> : <button type="button" onClick={() => setBroken(true)}>Break</button>; }
    render(<RootBoundary><Toggle /></RootBoundary>);
    fireEvent.click(screen.getByRole('button', { name: 'Break' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
