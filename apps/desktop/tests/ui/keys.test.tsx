import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { useWorkspaceKeys, workspaceIntent, type KeyScope, type WorkspaceHandlers } from '../../src/ui/keys';

afterEach(cleanup);

describe('workspace keymap', () => {
  it('maps the README keyboard table to intents', () => {
    const kinds = (keys: string[]) => keys.map(key => workspaceIntent({ key })?.kind ?? null);
    expect(kinds(['ArrowDown', 'j', 'ArrowUp', 'k', 'Home', 'End'])).toEqual(['move-down', 'move-down', 'move-up', 'move-up', 'first', 'last']);
    expect(kinds(['ArrowRight', 'l', 'ArrowLeft', 'h', 'Enter'])).toEqual(['unfold', 'unfold', 'fold', 'fold', 'enter']);
    expect(kinds(['a', 'b', 'r', 'd', 'z', 'o', 'e'])).toEqual(['answer', 'bring', 'respond', 'drop', 'later', 'reopen', 'archive']);
    expect(kinds(['/', 'g', 'm', 'w', 'Escape', 'Backspace', 'Delete'])).toEqual(['search', 'graph', 'messages', 'waiting', 'escape', 'remove', 'remove']);
    expect(workspaceIntent({ key: '1' })).toEqual({ kind: 'choose', index: 0 });
    expect(workspaceIntent({ key: '9' })).toEqual({ kind: 'choose', index: 8 });
    expect(kinds(['0', 'A', 'x', 'Tab', ' '])).toEqual([null, null, null, null, null]);
  });

  it('accepts only Cmd+F and Cmd+Enter among modified keys', () => {
    expect(workspaceIntent({ key: 'f', metaKey: true })?.kind).toBe('search');
    expect(workspaceIntent({ key: 'F', metaKey: true })?.kind).toBe('search');
    expect(workspaceIntent({ key: 'Enter', metaKey: true })?.kind).toBe('send');
    expect(workspaceIntent({ key: 'g', metaKey: true })).toBeNull();
    expect(workspaceIntent({ key: 'f', metaKey: true, ctrlKey: true })).toBeNull();
    expect(workspaceIntent({ key: 'j', ctrlKey: true })).toBeNull();
    expect(workspaceIntent({ key: 'j', altKey: true })).toBeNull();
  });
});

function Probe({ scope, handlers }: { readonly scope: KeyScope; readonly handlers: WorkspaceHandlers<HTMLDivElement> }) {
  const keys = useWorkspaceKeys(handlers, { scope });
  return <div data-testid="root" tabIndex={0} onKeyDown={keys}>
    <input data-testid="input" /><textarea data-testid="area" /><button type="button" data-testid="button">B</button>
    <div role="dialog"><button type="button" data-testid="dialog">D</button></div>
  </div>;
}
const node = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

describe('useWorkspaceKeys', () => {
  it('workspace scope skips fields, dialogs and keys already handled below', () => {
    const graph = vi.fn(() => true), remove = vi.fn(() => false);
    render(<Probe scope="workspace" handlers={{ graph, remove }} />);
    expect(fireEvent.keyDown(node('button'), { key: 'g' })).toBe(false); expect(graph).toHaveBeenCalledOnce();
    expect(fireEvent.keyDown(node('button'), { key: 'Backspace' })).toBe(true); expect(remove).toHaveBeenCalledOnce();
    fireEvent.keyDown(node('input'), { key: 'g' }); fireEvent.keyDown(node('area'), { key: 'g' }); fireEvent.keyDown(node('dialog'), { key: 'g' });
    const handled = new KeyboardEvent('keydown', { key: 'g', bubbles: true, cancelable: true }); handled.preventDefault(); node('button').dispatchEvent(handled);
    expect(fireEvent.keyDown(node('button'), { key: 'q' })).toBe(true);
    expect(graph).toHaveBeenCalledOnce();
  });

  it('row scope takes only keys pressed on the row itself', () => {
    const down = vi.fn(() => true);
    render(<Probe scope="row" handlers={{ 'move-down': down }} />);
    fireEvent.keyDown(node('button'), { key: 'j' }); expect(down).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(node('root'), { key: 'j' })).toBe(false); expect(down).toHaveBeenCalledOnce();
  });

  it('editor scope always takes Esc and Cmd+Enter, other keys only outside text fields', () => {
    const escape = vi.fn(), send = vi.fn(() => true), choose = vi.fn(() => true);
    render(<Probe scope="editor" handlers={{ escape, send, choose }} />);
    expect(fireEvent.keyDown(node('area'), { key: 'Escape' })).toBe(true); expect(escape).toHaveBeenCalledOnce();
    expect(fireEvent.keyDown(node('area'), { key: 'Enter', metaKey: true })).toBe(false); expect(send).toHaveBeenCalledOnce();
    fireEvent.keyDown(node('area'), { key: '2' }); fireEvent.keyDown(node('input'), { key: '2' }); expect(choose).not.toHaveBeenCalled();
    fireEvent.keyDown(node('button'), { key: '2' }); expect(choose).toHaveBeenCalledWith({ kind: 'choose', index: 1 }, expect.anything());
  });
});
