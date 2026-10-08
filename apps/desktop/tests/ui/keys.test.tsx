import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { useWorkspaceKeys, workspaceIntent, type KeyScope, type WorkspaceHandlers } from '../../src/ui/keys';

afterEach(cleanup);

describe('workspace keymap', () => {
  it('reads Option digits from physical codes and ignores repeat and other modifiers', () => {
    for (let digit = 1; digit <= 9; digit++) expect(workspaceIntent({ key: '¡', code: `Digit${digit}`, altKey: true })).toEqual({ kind: 'choose-send', index: digit - 1 });
    expect(workspaceIntent({ key: 'º', code: 'Digit0', altKey: true })).toEqual({ kind: 'answer-words' });
    for (const extra of [{ repeat: true }, { shiftKey: true }, { metaKey: true }, { ctrlKey: true }]) {
      expect(workspaceIntent({ key: '¡', code: 'Digit1', altKey: true, ...extra })).toBeNull();
    }
    expect(workspaceIntent({ key: '1', altKey: true })).toBeNull();
    expect(workspaceIntent({ key: '0', code: 'Digit0', metaKey: true })).toEqual({ kind: 'text-default' });
  });
  it('maps the README keyboard table to intents', () => {
    const kinds = (keys: string[]) => keys.map(key => workspaceIntent({ key })?.kind ?? null);
    expect(kinds(['ArrowDown', 'j', 'ArrowUp', 'k', 'Home', 'End'])).toEqual(['move-down', 'move-down', 'move-up', 'move-up', 'first', 'last']);
    expect(kinds(['ArrowRight', 'l', 'ArrowLeft', 'h', 'Enter'])).toEqual(['unfold', 'unfold', 'fold', 'fold', 'enter']);
    expect(kinds(['a', 'b', 'r', 'd', 'z', 'x', 'o', 'e'])).toEqual(['answer', 'bring', 'respond', 'drop', 'later', 'hide', 'reopen', 'archive']);
    expect(kinds(['/', 'g', 'm', 'w', 'Escape', 'Backspace', 'Delete'])).toEqual(['search', 'graph', 'messages', 'waiting', 'escape', 'remove', 'remove']);
    expect(workspaceIntent({ key: '1' })).toEqual({ kind: 'choose', index: 0 });
    expect(workspaceIntent({ key: '9' })).toEqual({ kind: 'choose', index: 8 });
    expect(kinds(['0', 'A', 'X', 'Tab', ' '])).toEqual([null, null, null, null, null]);
  });

  it('accepts Cmd+F, Cmd+Enter and item history chords among modified keys', () => {
    expect(workspaceIntent({ key: 'f', metaKey: true })?.kind).toBe('search');
    expect(workspaceIntent({ key: 'F', metaKey: true })?.kind).toBe('search');
    expect(workspaceIntent({ key: 'Enter', metaKey: true })?.kind).toBe('send');
    expect(workspaceIntent({ key: '[', metaKey: true })?.kind).toBe('history-back');
    expect(workspaceIntent({ key: ']', metaKey: true })?.kind).toBe('history-forward');
    expect(workspaceIntent({ key: '[', metaKey: true, shiftKey: true })).toBeNull();
    expect(workspaceIntent({ key: '[', ctrlKey: true })).toBeNull();
    expect(workspaceIntent({ key: 'g', metaKey: true })).toBeNull();
    expect(workspaceIntent({ key: 'f', metaKey: true, ctrlKey: true })).toBeNull();
    expect(workspaceIntent({ key: 'j', ctrlKey: true })).toBeNull();
    expect(workspaceIntent({ key: 'j', altKey: true })).toBeNull();
  });
});

function Probe({ scope, handlers }: { readonly scope: KeyScope; readonly handlers: WorkspaceHandlers<HTMLDivElement> }) {
  const keys = useWorkspaceKeys(handlers, { scope });
  return <div data-testid="root" tabIndex={0} onKeyDown={keys}>
    <select data-testid="select"><option>Choice</option></select><div contentEditable data-testid="editable" /><div role="textbox" data-testid="textbox" /><input data-testid="input" /><textarea data-testid="area" /><button type="button" data-testid="button">B</button>
    <div role="dialog"><button type="button" data-testid="dialog">D</button></div>
  </div>;
}
const node = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

describe('useWorkspaceKeys', () => {
  it('uses x for hide and unhide while keeping it in owner text fields', () => {
    const hide = vi.fn(() => true);
    render(<Probe scope="workspace" handlers={{ hide }} />);
    expect(fireEvent.keyDown(node('button'), { key: 'x' })).toBe(false);
    expect(hide).toHaveBeenCalledWith({ kind: 'hide' }, expect.anything());
    fireEvent.keyDown(node('input'), { key: 'x' }); fireEvent.keyDown(node('area'), { key: 'x' });
    expect(hide).toHaveBeenCalledOnce();
  });

  it.each(['workspace', 'row', 'editor'] as const)('keeps Option digits in all text fields in %s scope', scope => {
    const quick = vi.fn(() => true);
    render(<Probe scope={scope} handlers={{ 'choose-send': quick, 'answer-words': quick }} />);
    for (const field of ['input', 'area', 'select', 'editable', 'textbox']) {
      for (const digit of [0, 1]) expect(fireEvent.keyDown(node(field), { key: '¡', code: `Digit${digit}`, altKey: true })).toBe(true);
    }
    expect(quick).not.toHaveBeenCalled();
  });
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
