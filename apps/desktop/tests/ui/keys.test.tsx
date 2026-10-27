import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { intentKeyHandlers, keyIntents, useWorkspaceKeys, workspaceIntent, type KeyLike, type KeyScope, type WorkspaceHandlers, type WorkspaceIntent } from '../../src/ui/keys';
import { dispatchIntent, hasIntentHandler, registerIntent } from '../../src/ui/intents';

afterEach(cleanup);

// Every supported key crosses every focus owner. Workspace actions belong only
// to the unoccluded Map; typing and overlays must never mutate its selection.
const bindings: readonly (readonly [KeyLike, WorkspaceIntent | null])[] = [
  ...Object.entries({ ArrowDown: 'move-down', j: 'move-down', ArrowUp: 'move-up', k: 'move-up', Home: 'first', End: 'last',
    ArrowRight: 'unfold', ArrowLeft: 'fold', Enter: 'enter', a: 'answer', b: 'bring', r: 'respond', d: 'drop', z: 'later', x: 'hide', o: 'reopen',
    '/': 'search', g: 'graph', f: 'filter', c: 'continue', n: 'next-unseen', '?': 'help', Escape: 'escape', Backspace: 'remove', Delete: 'remove', ' ': 'peek',
    '.': 'back-to-selected', '[': 'dock-prev', ']': 'dock-next',
  }).map(([key, kind]) => [{ key }, { kind } as WorkspaceIntent] as const),
  [{ key: 'F', shiftKey: true }, { kind: 'focus' }],
  [{ key: '?', shiftKey: true }, { kind: 'help' }],
  ...Object.entries({ o: 'switcher', e: 'recent', f: 'search', Enter: 'send', '[': 'history-back', ']': 'history-forward', '-': 'text-smaller', '+': 'text-larger', '0': 'text-default' })
    .map(([key, kind]) => [{ key, metaKey: true }, { kind } as WorkspaceIntent] as const),
  ...Array.from({ length: 9 }, (_, index) => [{ key: String(index + 1) }, { kind: 'choose', index }] as const),
  ...['e', 'h', 'w', 'l', '0', 'A', 'H'].map(key => [{ key }, null] as const),
  [{ key: 'j', metaKey: true }, null],
  // ⌥1–9 choose and send by the physical key (macOS types ¡™£ for them); ⌥0 stays unbound; a held ⌥digit resolves to nothing.
  ...Array.from({ length: 9 }, (_, index) => [{ key: '¡™£'[index % 3], code: `Digit${index + 1}`, altKey: true }, { kind: 'choose-send', index }] as const),
  [{ key: 'º', code: 'Digit0', altKey: true }, null],
  [{ key: '¡', code: 'Digit1', altKey: true, repeat: true }, null],
  // ⌥↑ / ⌥↓ scroll Details and repeat while held; with ⇧, ⌘ or ⌃ they are not ours.
  [{ key: 'ArrowUp', altKey: true }, { kind: 'details-up' }],
  [{ key: 'ArrowDown', altKey: true }, { kind: 'details-down' }],
  [{ key: 'ArrowDown', altKey: true, repeat: true }, { kind: 'details-down' }],
  [{ key: 'ArrowDown', altKey: true, shiftKey: true }, null],
  [{ key: 'ArrowDown', altKey: true, ctrlKey: true }, null],
  [{ key: 'ArrowDown', altKey: true, metaKey: true }, null],
];

type Overlay = 'dialog' | 'switcher' | 'help' | 'peek';
function Probe({ scope = 'workspace', handlers, overlay }: {
  readonly scope?: KeyScope; readonly handlers: WorkspaceHandlers<HTMLDivElement>; readonly overlay?: Overlay;
}) {
  const keys = useWorkspaceKeys(handlers, { scope });
  return <div data-testid="root" tabIndex={0} onKeyDown={keys}>
    <select data-testid="select"><option>Choice</option></select><div contentEditable data-testid="editable" /><div role="textbox" data-testid="textbox" />
    <input data-testid="input" /><textarea data-testid="area" /><button type="button" data-testid="button">B</button>
    {overlay === 'peek' ? <div role="dialog" className="item-peek" aria-label="Peek: an item"><button type="button" data-testid="overlay">P</button></div>
      : overlay === 'dialog' ? <div role="dialog"><button type="button" data-testid="overlay">D</button></div>
        : overlay && <div role="dialog" data-workspace-overlay={overlay}><button type="button" data-testid="overlay">D</button></div>}
  </div>;
}
const node = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

describe('key routing invariant: key × focus owner', () => {
  for (const [event, intent] of bindings) {
    const name = `${event.metaKey ? 'Cmd+' : ''}${event.altKey ? 'Alt+' : ''}${event.shiftKey ? 'Shift+' : ''}${JSON.stringify(event.key)}`;
    it(`${name} resolves to ${intent?.kind ?? 'unbound'}`, () => { expect(workspaceIntent(event)).toEqual(intent); });
    // 'map under peek': a peek is showing and focus stays on the Map. The peek is a hover card, not a dialog:
    // the Map keeps its keys. 'in peek': focus is inside the card, which owns its own keys.
    for (const focus of ['plain', 'text', 'dialog', 'switcher', 'help', 'map under peek', 'in peek'] as const) {
      const dispatches = (focus === 'plain' || focus === 'map under peek') && !!intent;
      it(`${name} with ${focus} focus ${dispatches ? 'dispatches its action' : 'does not dispatch'}`, () => {
        const action = vi.fn(() => true);
        const overlay = focus === 'dialog' || focus === 'switcher' || focus === 'help' ? focus : focus === 'map under peek' || focus === 'in peek' ? 'peek' : undefined;
        render(<Probe handlers={intent ? { [intent.kind]: action } : {}} overlay={overlay} />);
        fireEvent.keyDown(node(focus === 'text' ? 'area' : focus === 'plain' || focus === 'map under peek' ? 'button' : 'overlay'), event);
        expect(action).toHaveBeenCalledTimes(dispatches ? 1 : 0);
      });
    }
  }

  it.each(['dialog', 'switcher', 'help'] as const)('blocks every workspace action when %s is open but focus remains on the Map', overlay => {
    const action = vi.fn(() => true);
    const handlers = Object.fromEntries(bindings.flatMap(([, intent]) => intent ? [[intent.kind, action]] : []));
    render(<Probe handlers={handlers} overlay={overlay} />);
    for (const [event] of bindings) fireEvent.keyDown(node('button'), event);
    expect(action).not.toHaveBeenCalled();
  });
});

// C5: a key either asks for an intent (answered by whichever view registered it) or belongs to where focus is.
describe('intent keys × focus owner', () => {
  const scoped = new Set(['move-down', 'move-up', 'first', 'last', 'unfold', 'fold', 'enter', 'send', 'choose', 'choose-send', 'details-up', 'details-down', 'escape', 'peek',
    'history-back', 'history-forward', 'text-smaller', 'text-larger', 'text-default']);
  function IntentProbe({ overlay }: { readonly overlay?: Overlay }) {
    return <Probe handlers={intentKeyHandlers<HTMLDivElement>()} overlay={overlay} />;
  }
  it('every bound key is scoped to its focus owner or names an intent, and every intent key is bound', () => {
    for (const [, intent] of bindings) if (intent) expect([intent.kind, scoped.has(intent.kind) || !!keyIntents[intent.kind]]).toEqual([intent.kind, true]);
    const bound = new Set(bindings.flatMap(([, intent]) => intent ? [intent.kind] : []));
    for (const kind of Object.keys(keyIntents)) expect(bound.has(kind as WorkspaceIntent['kind'])).toBe(true);
  });
  for (const [event, intent] of bindings.filter(([, value]) => value && keyIntents[value.kind])) {
    const asked = keyIntents[intent!.kind]!;
    const name = `${event.metaKey ? 'Cmd+' : ''}${event.shiftKey ? 'Shift+' : ''}${JSON.stringify(event.key)}`;
    it.each(['plain', 'text', 'dialog', 'switcher', 'help', 'map under peek'] as const)(`${name} asks for ${asked} only from the Map (focus %s)`, focus => {
      const handler = vi.fn(() => true), off = registerIntent(asked, handler);
      const overlay = focus === 'dialog' || focus === 'switcher' || focus === 'help' ? focus : focus === 'map under peek' ? 'peek' : undefined;
      render(<IntentProbe overlay={overlay} />);
      const notCancelled = fireEvent.keyDown(node(focus === 'text' ? 'area' : focus === 'plain' || focus === 'map under peek' ? 'button' : 'overlay'), event);
      const expected = focus === 'plain' || focus === 'map under peek' ? 1 : 0;
      expect(handler).toHaveBeenCalledTimes(expected);
      expect(notCancelled).toBe(expected === 0);
      off();
    });
  }
  it('the latest registration answers first; one that declines passes the intent on, and nobody answering keeps the default', () => {
    const map = vi.fn(() => true), bigger = vi.fn(() => false);
    const offMap = registerIntent('focus.toggle', map), offBigger = registerIntent('focus.toggle', bigger);
    expect(dispatchIntent('focus.toggle')).toBe(true);
    expect(bigger).toHaveBeenCalledOnce(); expect(map).toHaveBeenCalledOnce();
    offMap(); offBigger();
    expect(hasIntentHandler('focus.toggle')).toBe(false);
    render(<IntentProbe />);
    expect(fireEvent.keyDown(node('button'), { key: 'F', shiftKey: true })).toBe(true);
  });
  it('passes a held key on as a repeat', () => {
    const handler = vi.fn(() => true), off = registerIntent('item.hide', handler);
    render(<IntentProbe />);
    fireEvent.keyDown(node('button'), { key: 'x', repeat: true });
    expect(handler).toHaveBeenCalledWith({ repeat: true });
    off();
  });
});

describe('useWorkspaceKeys scopes', () => {
  it('leaves composing keys with the input method', () => {
    const action = vi.fn(() => true);
    render(<Probe handlers={{ answer: action, drop: action, hide: action, remove: action }} />);
    for (const key of ['a', 'd', 'x', 'Backspace']) fireEvent.keyDown(node('button'), { key, isComposing: true });
    expect(action).not.toHaveBeenCalled();
  });
  it.each(['dialog', 'switcher', 'help'] as const)('keeps a covered editor from sending behind %s', overlay => {
    const send = vi.fn(() => true);
    render(<Probe scope="editor" handlers={{ send }} overlay={overlay} />);
    fireEvent.keyDown(node('area'), { key: 'Enter', metaKey: true });
    expect(send).not.toHaveBeenCalled();
    fireEvent.keyDown(node('overlay'), { key: 'Enter', metaKey: true });
    expect(send).toHaveBeenCalledOnce();
  });
  it.each(['input', 'area', 'select', 'editable', 'textbox'])('keeps destructive keys in %s', field => {
    const action = vi.fn(() => true);
    render(<Probe handlers={{ answer: action, drop: action, hide: action, remove: action, later: action, reopen: action }} />);
    for (const key of ['a', 'd', 'x', 'Backspace', 'Delete', 'z', 'o']) fireEvent.keyDown(node(field), { key });
    expect(action).not.toHaveBeenCalled();
  });
  it('ignores keys already handled below and unhandled keys keep their default', () => {
    const graph = vi.fn(() => true), remove = vi.fn(() => false);
    render(<Probe handlers={{ graph, remove }} />);
    const handled = new KeyboardEvent('keydown', { key: 'g', bubbles: true, cancelable: true });
    handled.preventDefault(); node('button').dispatchEvent(handled);
    expect(graph).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(node('button'), { key: 'Backspace' })).toBe(true);
    expect(remove).toHaveBeenCalledOnce();
  });
  it('row scope takes only keys pressed on the row itself', () => {
    const down = vi.fn(() => true);
    render(<Probe scope="row" handlers={{ 'move-down': down }} />);
    fireEvent.keyDown(node('button'), { key: 'j' }); expect(down).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(node('root'), { key: 'j' })).toBe(false); expect(down).toHaveBeenCalledOnce();
  });
  it('editor scope takes Esc and Cmd+Enter in fields, and option digits outside all editable fields', () => {
    const escape = vi.fn(), send = vi.fn(() => true), choose = vi.fn(() => true);
    render(<Probe scope="editor" handlers={{ escape, send, choose }} />);
    fireEvent.keyDown(node('area'), { key: 'Escape' }); expect(escape).toHaveBeenCalledOnce();
    expect(fireEvent.keyDown(node('area'), { key: 'Enter', metaKey: true })).toBe(false); expect(send).toHaveBeenCalledOnce();
    for (const field of ['input', 'area', 'select', 'editable', 'textbox']) fireEvent.keyDown(node(field), { key: '2' });
    expect(choose).not.toHaveBeenCalled();
    fireEvent.keyDown(node('button'), { key: '2' }); expect(choose).toHaveBeenCalledWith({ kind: 'choose', index: 1 }, expect.anything());
  });
});
