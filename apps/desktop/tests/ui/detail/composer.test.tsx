import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createDesktopService } from '../../../src/data/service';
import { OpenSessions } from '../../../src/data/session-store';
import { SessionActions } from '../../../src/components/bindings/actions';
import { AppTransport, route } from '../app/transport';
import { Composer, type ComposerProps } from '../../../src/ui/detail/Composer';
import type { Words } from '../../../src/ui/detail/submit';

const opened: OpenSessions[] = [];
afterEach(() => { cleanup(); opened.splice(0).forEach(sessions => sessions.closeAll()); });
let actions: SessionActions;
beforeEach(async () => {
  const service = createDesktopService(new AppTransport()), sessions = new OpenSessions(service);
  opened.push(sessions);
  const store = sessions.open(route); await store.refresh();
  actions = new SessionActions(service, store);
});
const slot = (patch: Partial<Words> = {}): Words => ({ id: 'draft-1', kind: 'reply', text: '', locked: false, changed: false, ...patch });
function view(patch: Partial<ComposerProps> & { readonly words?: Words } = {}) {
  const { words = slot(), ...rest } = patch;
  const handlers = { onEdit: vi.fn(), onKeyDown: vi.fn(() => vi.fn()), onSend: vi.fn(), onCancel: vi.fn(), onReview: vi.fn(), register: vi.fn() };
  render(<Composer kind="plain" ownerKey="item-1" actions={actions} sentAs="reply" slots={[words]} slotKey={value => value.id ?? 'blank'} sendOff={() => false} closable={false} {...handlers} {...rest} />);
  return handlers;
}
const bar = () => document.querySelector('.detail-composer-bar .detail-box-hint')!.textContent;

describe('Composer', () => {
  it('a plain item: two rows, "Reply about this item…", and where the words go', () => {
    view();
    const box = screen.getByRole('textbox', { name: 'Reply message' }) as HTMLTextAreaElement;
    expect(box.rows).toBe(2); expect(box.placeholder).toBe('Reply about this item…');
    expect(bar()).toBe('Goes to the agent with this item’s name.');
    expect(document.querySelector('[data-owner-input="item-1"]')!.getAttribute('data-composer')).toBe('plain');
  });

  it('the bigger view takes three rows', () => {
    view({ expanded: true });
    expect((screen.getByRole('textbox', { name: 'Reply message' }) as HTMLTextAreaElement).rows).toBe(3);
  });

  it('a topic: its own label, placeholder, button and bar', () => {
    view({ kind: 'topic', words: slot({ text: '' }) });
    const box = screen.getByRole('textbox', { name: 'Reply to this topic' }) as HTMLTextAreaElement;
    expect(box.placeholder).toBe('Reply about this topic…');
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeTruthy();
    expect(bar()).toBe('Goes to the agent with the topic’s name.');
    expect(screen.queryByText(/This will be sent as/u)).toBeNull();
  });

  it.each([
    ['recovered', '↺ Recovered after a restart', '↺ Back as you left it before the restart. Not sent.'],
    ['taken_back', '✎ Taken back to edit', 'Taken back from the queue. It isn’t sent until you send it again.'],
  ] as const)('a draft that is %s: its chip and its bar', (origin, chip, text) => {
    view({ words: slot({ text: 'Exact words', origin }) });
    expect(screen.getByTestId('composer-chip').textContent).toBe(chip);
    expect(bar()).toBe(text);
  });

  it('typed words are kept, and a send in progress or a removal says so', () => {
    view({ words: slot({ text: 'Typed' }) });
    expect(document.querySelector('.detail-bar-long')!.textContent).toBe('Draft kept. It stays here until you send it.');
    cleanup();
    view({ words: slot({ text: 'Typed', locked: true }), sending: true });
    expect(bar()).toBe('◌ Sending…');
    cleanup();
    view({ words: slot({ text: 'Typed' }), removing: true, sendOff: () => true });
    expect(bar()).toBe('Being removed · Undo first');
    expect((screen.getByRole('button', { name: 'Send reply' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('textbox', { name: 'Reply message' }) as HTMLTextAreaElement).value).toBe('Typed');
  });

  it('routes edits, sends and keys to the caller with the slot', () => {
    const calls = view({ words: slot({ text: 'Hello' }) });
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply message' }), { target: { value: 'Hello again' } });
    expect(calls.onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'draft-1' }), 'Hello again');
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    expect(calls.onSend).toHaveBeenCalledWith(expect.objectContaining({ id: 'draft-1' }));
  });
});
