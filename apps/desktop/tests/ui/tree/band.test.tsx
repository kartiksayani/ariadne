import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextUnseen } from '../../../src/ui/tree/band/NextUnseen';
import { FocusButton } from '../../../src/ui/tree/band/FocusButton';
import { ContinueButton } from '../../../src/ui/tree/band/ContinueButton';
import { TopicMenu } from '../../../src/ui/tree/band/TopicMenu';
import { TopicRow } from '../../../src/ui/tree/TopicRow';
import { topicCounts, type TopicRow as Row } from '../../../src/ui/tree/model';
import { AppTransport, route } from '../app/transport';

afterEach(cleanup);

describe('Next unseen (D21)', () => {
  it('draws nothing when there is nothing unseen', () => {
    render(<NextUnseen position={null} total={0} onNext={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
  it.each([
    [null, 5, 'Next unseen'],
    [3, 5, 'Next unseen, 3 of 5'],
  ] as const)('names itself for position %s of %s', (position, total, name) => {
    const next = vi.fn();
    render(<NextUnseen position={position} total={total} onNext={next} />);
    const button = screen.getByRole('button', { name });
    expect(button.title).toBe('Go to the next unseen item ( n )');
    expect(button.textContent).toBe(position === null ? 'Next unseen' + 'n' : `Next · 3 of 5n`);
    fireEvent.click(button);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('Focus button (D9)', () => {
  const cases = [
    { name: 'nothing selected, nothing focused', focusedName: null, canFocus: false, busy: false, disabled: true, label: 'Focus', title: 'Select an item to focus' },
    { name: 'an item selected', focusedName: null, canFocus: true, busy: false, disabled: false, label: 'Focus', title: 'Focus on the selected item and its branch ( ⇧F )' },
    { name: 'focused', focusedName: 'Cache', canFocus: true, busy: false, disabled: false, label: 'Unfocus “Cache”', title: 'Show the whole Map again ( ⇧F )' },
    { name: 'focused with the selection gone', focusedName: 'Cache', canFocus: false, busy: false, disabled: false, label: 'Unfocus “Cache”', title: 'Show the whole Map again ( ⇧F )' },
    { name: 'a view change being saved', focusedName: null, canFocus: true, busy: true, disabled: true, label: 'Focus', title: 'Focus on the selected item and its branch ( ⇧F )' },
  ] as const;
  it.each(cases)('$name', ({ focusedName, canFocus, busy, disabled, label, title }) => {
    const toggle = vi.fn();
    render(<FocusButton focusedName={focusedName} canFocus={canFocus} busy={busy} onToggle={toggle} />);
    const button = screen.getByRole<HTMLButtonElement>('button', { name: label });
    expect(button.disabled).toBe(disabled);
    expect(button.title).toBe(title);
    expect(button.textContent).toBe(focusedName ? 'Unfocus' : 'Focus');
    expect(button.getAttribute('aria-pressed')).toBe(String(!!focusedName));
    fireEvent.click(button);
    expect(toggle).toHaveBeenCalledTimes(disabled ? 0 : 1);
  });
});

describe('Continue elsewhere (D10)', () => {
  it('keeps the label in the DOM for the container query to hide, and names the icon-only form', () => {
    const go = vi.fn();
    render(<ContinueButton disabled={false} onContinue={go} />);
    const button = screen.getByRole('button', { name: 'Continue elsewhere' });
    expect(button.title).toBe('Continue this topic in another session ( c )');
    fireEvent.click(button);
    expect(go).toHaveBeenCalledOnce();
  });
  it('says why it is greyed', () => {
    render(<ContinueButton disabled title="A reply to this topic is on its way" onContinue={vi.fn()} />);
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Continue elsewhere' });
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('A reply to this topic is on its way');
  });
});

describe('the "…" menu (D12)', () => {
  const open = (props: Partial<Parameters<typeof TopicMenu>[0]> = {}) => {
    const calls = { reply: vi.fn(), bin: vi.fn(), archive: vi.fn(), remove: vi.fn() };
    render(<TopicMenu topicName="Cache" reply={{ run: calls.reply, unavailable: null }} bin={{ count: 2, open: calls.bin }} archive={calls.archive}
      remove={{ run: calls.remove, items: 25 }} {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions for “Cache”' }));
    return { calls, menu: screen.getByRole('menu') };
  };
  it('offers Reply, the bin, Archive and Remove, and no "Continue here"', () => {
    const { menu } = open();
    expect(within(menu).getAllByRole('menuitem').map(item => item.querySelector('.tree-menu-label')!.textContent))
      .toEqual(['Reply to topic', 'Open the bin', 'Archive topic…', 'Remove topic…']);
    expect(within(menu).queryByText(/Continue here/)).toBeNull();
    expect(within(menu).getByText('2 removed · Restore or empty')).toBeTruthy();
    expect(within(menu).getByText('It and its 25 items, with 5 seconds to undo')).toBeTruthy();
  });
  it.each([
    ['Reply to topic', 'reply'], ['Open the bin', 'bin'], ['Archive topic…', 'archive'], ['Remove topic…', 'remove'],
  ] as const)('%s runs its action once and closes the menu', (label, call) => {
    const { calls } = open();
    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${label}`) }));
    expect(calls[call]).toHaveBeenCalledOnce();
    for (const other of Object.values(calls)) if (other !== calls[call]) expect(other).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });
  it('greys the bin at count 0 with the reason, and Reply while the agent is away', () => {
    const { calls } = open({ bin: { count: 0, open: vi.fn() }, reply: { run: vi.fn(), unavailable: 'the agent is not running' } });
    const bin = screen.getByRole<HTMLButtonElement>('menuitem', { name: /^Open the bin/ }), reply = screen.getByRole<HTMLButtonElement>('menuitem', { name: /^Reply to topic/ });
    expect(bin.disabled).toBe(true); expect(bin.title).toBe('Nothing in the bin'); expect(bin.textContent).toContain('Nothing in the bin');
    expect(reply.disabled).toBe(true); expect(reply.title).toBe('Reply to topic: the agent is not running');
    fireEvent.click(bin); fireEvent.click(reply);
    expect(calls.bin).not.toHaveBeenCalled(); expect(calls.reply).not.toHaveBeenCalled();
  });
  it('leaves Reply out entirely when the topic takes none', () => {
    open({ reply: null });
    expect(screen.queryByRole('menuitem', { name: /^Reply to topic/ })).toBeNull();
  });
  it('singular item count', () => {
    open({ remove: { run: vi.fn(), items: 1 } });
    expect(screen.getByText('It and its 1 item, with 5 seconds to undo')).toBeTruthy();
  });
});

describe('the band row (D10)', () => {
  const row = (): Row => {
    const session = new AppTransport().sessions.get(route.session_id)!;
    const topic = Object.values(session.topics)[0]!;
    return { kind: 'topic', key: topic.id, topic, depth: 0, expanded: true, first: true, guides: [], earlier: false, chip: null, allClosed: false, delivery: null,
      counts: topicCounts(['waiting_on_me', 'open'], 0) };
  };
  const props = { focused: false, actions: [], prompt: null, remember: () => {}, onFocus: () => {}, onKeyDown: () => {}, onToggle: () => {} };
  it('says "waiting on you" wide and lets the container query cut it to "waiting"', () => {
    render(<TopicRow row={row()} {...props} />);
    const count = screen.getByText('waiting', { exact: false, selector: '.tree-count' });
    expect(count.textContent).toBe('1 waiting on you');
    expect(count.querySelector('.tree-wide-only')!.textContent).toBe(' on you');
  });
  it('puts the tally, the changes opener, Next and Ack all on one counts line, in that order, and the buttons in the head', () => {
    render(<TopicRow row={row()} {...props} ackAll={<button type="button">Ack all (2)</button>}
      slots={{ changes: <span>opener</span>, next: <button type="button">Next</button>, focus: <button type="button">Focus</button>,
        continue: <button type="button">Continue</button>, menu: <button type="button">More</button> }} />);
    const line = document.querySelector('.tree-topic-counts')!, head = document.querySelector('.tree-topic-head')!;
    expect([...line.children].map(child => child.className === 'tree-topic-tally' ? 'tally' : child.textContent)).toEqual(['tally', 'opener', 'Next', 'Ack all (2)']);
    expect([...head.querySelectorAll('button')].map(button => button.textContent)).toEqual(['', 'Focus', 'Continue', 'More']);
  });
  it('never rewrites the to-ack count (the "one by one" wording is gone)', () => {
    const value = { ...row(), counts: topicCounts(['open', 'open', 'open'], 3) };
    render(<TopicRow row={value} {...props} ackAll={<button type="button">Ack all (2)</button>} />);
    expect(screen.getByText('3 to ack')).toBeTruthy();
    expect(screen.queryByText(/one by one/)).toBeNull();
  });
  it('the counts slot replaces the counts (Focused on …)', () => {
    render(<TopicRow row={row()} {...props} slots={{ counts: <span>Focused on “Cache” · 3 items</span> }} />);
    expect(screen.getByText('Focused on “Cache” · 3 items')).toBeTruthy();
    expect(screen.queryByText(/waiting/)).toBeNull();
  });
});
