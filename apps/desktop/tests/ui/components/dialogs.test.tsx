import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NameSessionDialog } from '../../../src/ui/dialogs/NameSessionDialog';
import { RegisterProjectDialog } from '../../../src/ui/dialogs/RegisterProjectDialog';
import { RemoveProjectDialog } from '../../../src/ui/dialogs/RemoveProjectDialog';
import { RemoveSessionDialog } from '../../../src/ui/dialogs/RemoveDialog';
import type { WordsEntry } from '../../../src/ui/remove/words';

afterEach(cleanup);

describe('NameSessionDialog', () => {
  const mount = (patch = {}) => {
    const h = { onSave: vi.fn(), onCancel: vi.fn() };
    render(<NameSessionDialog unnamedAs="the Claude Code session from today 14:02" {...h} {...patch} />);
    return h;
  };

  it('says what the session shows as until named, puts focus in the name, and selects what is there', () => {
    mount({ initialName: 'cache PR review' });
    expect(screen.getByRole('dialog', { name: 'Name this session' })).toBeTruthy();
    expect(screen.getByText(/Until it has a name it shows as “the Claude Code session from today 14:02”\./)).toBeTruthy();
    const name = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement;
    expect(document.activeElement).toBe(name);
    expect(name.value).toBe('cache PR review');
  });

  it('Save is off while the name is empty, and on once there are words', () => {
    mount();
    const save = screen.getByRole('button', { name: /Save name/ }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: '  ' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'cache PR review' } });
    expect(save.disabled).toBe(false);
  });

  it('saves the trimmed name and description, from the button and from Enter in either field, once each', () => {
    const h = mount({ initialName: ' cache PR review ', initialDescription: ' what it is for ' });
    fireEvent.click(screen.getByRole('button', { name: /Save name/ }));
    expect(h.onSave).toHaveBeenLastCalledWith({ name: 'cache PR review', description: 'what it is for' });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name' }), { key: 'Enter' });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Description (optional)' }), { key: 'Enter' });
    expect(h.onSave).toHaveBeenCalledTimes(3);
  });

  it('does not save an empty name from Enter', () => {
    const h = mount();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name' }), { key: 'Enter' });
    expect(h.onSave).not.toHaveBeenCalled();
  });

  it('Esc and Cancel cancel; a press on the scrim does not, so typed words are not lost to a stray click', () => {
    const h = mount({ initialName: 'x' });
    fireEvent.click(document.querySelector('.dg-scrim')!);
    expect(h.onCancel).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(h.onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(h.onCancel).toHaveBeenCalledTimes(2);
  });

  it('keeps the words and says why when saving failed; while saving it cannot be sent twice', () => {
    const { rerender } = render(<NameSessionDialog unnamedAs="u" initialName="kept" error="Ariadne couldn’t save the name." onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toBe('Ariadne couldn’t save the name.');
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('kept');
    rerender(<NameSessionDialog unnamedAs="u" initialName="kept" busy onSave={vi.fn()} onCancel={vi.fn()} />);
    const saving = screen.getByRole('button', { name: /Saving…/ }) as HTMLButtonElement;
    expect(saving.disabled).toBe(true);
  });

  it('keeps focus inside: Tab from the last control wraps to the first', () => {
    mount({ initialName: 'x' });
    const save = screen.getByRole('button', { name: /Save name/ });
    save.focus();
    fireEvent.keyDown(save, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Name' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name' }), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(save);
  });

  it('gives focus back to the control that opened it', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const view = render(<NameSessionDialog unnamedAs="u" onSave={vi.fn()} onCancel={vi.fn()} />);
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

describe('RegisterProjectDialog', () => {
  const mount = (patch = {}) => {
    const h = { onRegister: vi.fn(), onCancel: vi.fn() };
    render(<RegisterProjectDialog {...h} {...patch} />);
    return h;
  };

  it('explains what registering does and does not do, and starts in the folder field', () => {
    mount();
    expect(screen.getByText('Ariadne watches this folder and shows each agent session that starts in it. Nothing is sent to an agent, and the folder isn’t changed.')).toBeTruthy();
    const folder = screen.getByRole('textbox', { name: 'Folder' }) as HTMLInputElement;
    expect(document.activeElement).toBe(folder);
    expect(folder.placeholder).toBe('~/code/my-project');
    expect(screen.getByText('The project is named after the folder. You can rename it later.')).toBeTruthy();
  });

  it('registers the trimmed path from the button or Enter, and not an empty one', () => {
    const h = mount();
    const register = screen.getByRole('button', { name: /Register project/ }) as HTMLButtonElement;
    expect(register.disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Folder' }), { key: 'Enter' });
    expect(h.onRegister).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Folder' }), { target: { value: '  ~/code/notes-mobile ' } });
    fireEvent.click(register);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Folder' }), { key: 'Enter' });
    expect(h.onRegister).toHaveBeenCalledTimes(2);
    expect(h.onRegister).toHaveBeenLastCalledWith('~/code/notes-mobile');
  });

  it('Esc cancels, and the path typed stays when an error comes back', () => {
    const h = mount({ initialPath: '~/code/x' });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(h.onCancel).toHaveBeenCalledTimes(1);
    cleanup();
    render(<RegisterProjectDialog initialPath="~/code/x" error="That folder doesn’t exist." onRegister={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toBe('That folder doesn’t exist.');
    expect((screen.getByRole('textbox', { name: 'Folder' }) as HTMLInputElement).value).toBe('~/code/x');
  });
});

describe('RemoveProjectDialog', () => {
  const base = { name: 'notes-api', path: '~/code/notes-api', sessionCount: 2, waitingCount: 2, words: { words: [], complete: true } };
  const mount = (patch = {}) => {
    const h = { onRemove: vi.fn(), onCancel: vi.fn() };
    render(<RemoveProjectDialog {...base} {...h} {...patch} />);
    return h;
  };

  it('names the project and the folder, says what goes and what stays, and warns about waiting questions', () => {
    mount();
    expect(screen.getByRole('dialog', { name: 'Remove “notes-api” from Ariadne?' })).toBeTruthy();
    expect(screen.getByText('Ariadne stops watching ~/code/notes-api and forgets its 2 sessions and their Maps. The folder and its files aren’t touched, and running agents keep running. A session that connects there later brings the project back.')).toBeTruthy();
    expect(screen.getByText('2 questions waiting on you in it go too, unanswered.')).toBeTruthy();
  });

  it('uses the singular for one, and says "forgets it" for a project with nothing in it', () => {
    mount({ sessionCount: 1, waitingCount: 1 });
    expect(screen.getByText(/forgets its 1 session and their Maps\./)).toBeTruthy();
    expect(screen.getByText('1 question waiting on you in it goes too, unanswered.')).toBeTruthy();
    cleanup();
    mount({ sessionCount: 0, waitingCount: 0 });
    expect(screen.getByText(/and forgets it\. The folder/)).toBeTruthy();
    expect(screen.queryByText(/waiting on you in it/)).toBeNull();
  });

  it('starts on Cancel, so Enter never removes; Remove has to be chosen', () => {
    const h = mount();
    const cancel = screen.getByRole('button', { name: /Cancel/ });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: 'Enter' });
    expect(h.onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove project' }));
    expect(h.onRemove).toHaveBeenCalledTimes(1);
  });

  it('Esc and a press on the scrim cancel; while removing, the button cannot be pressed twice', () => {
    const h = mount();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.click(document.querySelector('.dg-scrim')!);
    expect(h.onCancel).toHaveBeenCalledTimes(2);
    cleanup();
    mount({ busy: true });
    expect((screen.getByRole('button', { name: 'Removing…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows why it failed and stays open', () => {
    mount({ error: 'Ariadne couldn’t remove it. Nothing was changed.' });
    expect(screen.getByRole('alert').textContent).toBe('Ariadne couldn’t remove it. Nothing was changed.');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

// E27: a session or project removal deletes every word of the owner's in it. Each is quoted with Copy, and Remove waits
// until they are all on screen: while reading, and when a session can't be read, it can't be pressed.
const quoted: readonly WordsEntry[] = [
  { kind: 'input', key: 'input:a', about: 'Retry plan', text: 'Use the slower queue.', intent: 'reply', state: 'queued' },
  { kind: 'input', key: 'input:b', about: 'Retry plan', text: 'Never mind the cache.', intent: 'reply', state: 'cancelled' },
  { kind: 'draft', key: 'draft:c', about: 'Sync fixes', text: 'Half a thought', intent: 'topic_reply' },
];
describe.each([
  ['RemoveProjectDialog', 'Remove project', (words: unknown, h: { onRemove: () => void; onCancel: () => void }) =>
    <RemoveProjectDialog name="notes-api" path="~/code/notes-api" sessionCount={2} waitingCount={0} words={words as never} onRemove={h.onRemove} onCancel={h.onCancel} />],
  ['RemoveSessionDialog', 'Remove session', (words: unknown, h: { onRemove: () => void; onCancel: () => void }) =>
    <RemoveSessionDialog subject={{ kind: 'session', agent: 'Codex', when: 'Yesterday', topics: 1, items: 2, shared: 0, waiting: 0 }} words={words as never} onConfirm={h.onRemove} onCancel={h.onCancel} />],
] as const)('%s words', (_, confirm, dialog) => {
  const mount = (words: unknown) => { const h = { onRemove: vi.fn(), onCancel: vi.fn() }; render(dialog(words, h)); return h; };
  const button = () => screen.getByRole('button', { name: confirm }) as HTMLButtonElement;

  it.each([
    ['reading', null, 'Reading your words…', true],
    ['a session could not be read', { words: [], complete: false }, /couldn’t read every session in it/, true],
    ['nothing of yours in it', { words: [], complete: true }, null, false],
    ['words in it', { words: quoted, complete: true }, null, false],
  ] as const)('%s', (_, words, note, blocked) => {
    const h = mount(words);
    if (note) expect(screen.getByText(note)).toBeTruthy();
    expect(button().disabled).toBe(blocked);
    fireEvent.click(button());
    expect(h.onRemove).toHaveBeenCalledTimes(blocked ? 0 : 1);
  });

  it('quotes every word with Copy, and says how many haven’t reached the agent', () => {
    mount({ words: quoted, complete: true });
    expect(screen.getAllByTestId('dialog-quote').map(quote => quote.querySelector('blockquote')!.textContent)).toEqual(quoted.map(entry => entry.text));
    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(3);
    expect(screen.getByText(/1 of your messages hasn’t reached .* yet; removing cancels it; copy your words below first\./)).toBeTruthy();
  });
});
