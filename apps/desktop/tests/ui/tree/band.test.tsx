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
    { name: 'an item selected', focusedName: null, canFocus: true, busy: false, disabled: false, label: 'Focus', title: 'Focus on the selected item and its branch ( ⇧F )' },
    { name: 'focused', focusedName: 'Cache', canFocus: true, busy: false, disabled: false, label: 'Unfocus “Cache”', title: 'Show the whole Map again ( ⇧F )' },
    { name: 'focused with the selection gone', focusedName: 'Cache', canFocus: false, busy: false, disabled: false, label: 'Unfocus “Cache”', title: 'Show the whole Map again ( ⇧F )' },
    { name: 'a view change being saved', focusedName: null, canFocus: true, busy: true, disabled: true, label: 'Focus', title: 'Focus on the selected item and its branch ( ⇧F )' },
  ] as const;
  it('holds its 92px slot as a hidden, unfocusable placeholder while nothing is focused and nothing is selected', () => {
    const { container } = render(<FocusButton focusedName={null} canFocus={false} busy={false} onToggle={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Focus/ })).toBeNull();
    const slot = container.querySelector<HTMLButtonElement>('[data-testid="band-focus"]')!;
    expect(slot.getAttribute('aria-hidden')).toBe('true');
    expect(slot.tabIndex).toBe(-1);
    expect(slot.disabled).toBe(true);
    expect(slot.dataset.hidden).toBeDefined();
  });
  const band = (focusedName: string | null, canFocus: boolean, selected: boolean) => <div role="tree">
    <div role="treeitem" aria-label="Topic" tabIndex={-1}><FocusButton focusedName={focusedName} canFocus={canFocus} busy={false} onToggle={vi.fn()} /></div>
    <div role="treeitem" aria-label="Row" aria-selected={selected} tabIndex={-1} />
  </div>;
  it.each([
    { name: 'the band when nothing is selected', selected: false, landed: 'Topic' },
    { name: 'the selected row when one is', selected: true, landed: 'Row' },
  ])('moves keyboard focus to $name when the button goes while it has focus', ({ selected, landed }) => {
    const { rerender } = render(band('Cache', true, selected));
    screen.getByRole('button', { name: 'Unfocus “Cache”' }).focus();
    rerender(band(null, false, selected));
    expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: landed }));
  });
  it('leaves focus alone when the button goes while something else has it', () => {
    const { rerender } = render(<><input aria-label="Elsewhere" />{band('Cache', true, false)}</>);
    screen.getByRole('textbox', { name: 'Elsewhere' }).focus();
    rerender(<><input aria-label="Elsewhere" />{band(null, false, false)}</>);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Elsewhere' }));
  });
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
    const labels = ['Reply to topic', 'Open the bin', 'Archive topic…', 'Remove topic…'];
    expect(within(menu).getAllByRole('menuitem').map(item => labels.find(label => item.textContent!.startsWith(label))))
      .toEqual(labels);
    expect(within(menu).queryByText(/Continue here/)).toBeNull();
    expect(within(menu).getByText('Write to the agent about the whole topic, in Details')).toBeTruthy();
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
    expect(bin.disabled).toBe(true); expect(bin.title).toBe('Nothing in the bin'); expect(bin.textContent).toContain('Empty'); expect(bin.textContent).not.toContain('Restore or empty');
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
    const wide = screen.getByText('on you');                    // the part the container query hides
    expect(wide.parentElement!.textContent).toBe('1 waiting on you');
    expect(wide.classList.contains('tree-wide-only')).toBe(true);
  });
  it('puts the tally, the changes opener and Next on the counts line, and Ack all, Focus, Continue and the menu on the title line, in that order', () => {
    render(<TopicRow row={row()} {...props} ackAll={<button type="button">Ack all (2)</button>}
      slots={{ changes: <span>opener</span>, next: <button type="button">Next</button>, focus: <button type="button">Focus</button>,
        continue: <button type="button">Continue</button>, menu: <button type="button">More</button> }} />);
    const line = screen.getByTestId('band-counts'), head = screen.getByTestId('band-head');
    expect([...line.children].map(child => child.getAttribute('data-testid') === 'band-tally' ? 'tally' : child.textContent)).toEqual(['tally', 'opener', 'Next']);
    expect(within(head).getAllByRole('button').map(button => button.textContent)).toEqual(['', 'Ack all (2)', 'Focus', 'Continue', 'More']);
  });
  it('keeps the title line to one row of buttons after the name, with Ack all before Focus', () => {
    render(<TopicRow row={row()} {...props} ackAll={<button type="button">Ack all (2)</button>} slots={{ focus: <button type="button">Focus</button> }} />);
    const head = screen.getByTestId('band-head');
    expect(within(head).getByRole('button', { name: 'Ack all (2)' }).nextElementSibling?.textContent).toBe('Focus');
    expect(within(screen.getByTestId('band-counts')).queryByRole('button', { name: /Ack all/ })).toBeNull();
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
