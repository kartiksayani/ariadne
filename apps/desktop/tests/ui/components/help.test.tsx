import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { HelpPanel } from '../../../src/ui/help/HelpPanel';
import { KEY_GROUPS, STATUS_HELP } from '../../../src/ui/help/content';

afterEach(cleanup);

const keyOf = (group: string, text: string) => KEY_GROUPS.find(entry => entry.label === group)!.keys.find(([, line]) => line === text)?.[0];

describe('Help keys', () => {
  it('opens on Keys with the four groups, and every key of the approved map', () => {
    render(<HelpPanel narrow={false} onClose={vi.fn()} />);
    expect(screen.getByRole('tab', { name: 'Keys' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getAllByRole('region').map(group => group.getAttribute('aria-label'))).toEqual(['Move around the Map', 'Answer and reply', 'On the selected item', 'Find and switch']);
    expect(keyOf('On the selected item', 'Ack')).toEqual(['a']);
    expect(keyOf('On the selected item', 'Drop')).toEqual(['d']);
    expect(keyOf('On the selected item', 'Hide')).toEqual(['h']);
    expect(keyOf('On the selected item', 'Remove; asks first when items below it would go too')).toEqual(['⌫']);
    expect(keyOf('On the selected item', 'Focus on it, or Unfocus')).toEqual(['⇧', 'F']);
    expect(keyOf('On the selected item', 'Bring it up with the agent')).toEqual(['b']);
    expect(keyOf('On the selected item', 'Later, or back from Later')).toEqual(['z']);
    expect(keyOf('On the selected item', 'Back to Open')).toEqual(['o']);
    expect(keyOf('Find and switch', 'Filter by status')).toEqual(['f']);
    expect(keyOf('Find and switch', 'Search the Map')).toEqual(['/']);
    expect(keyOf('Find and switch', 'Tree or Graph')).toEqual(['g']);
    expect(keyOf('Find and switch', 'Continue the topic in another session')).toEqual(['c']);
    expect(keyOf('Find and switch', 'Recent')).toEqual(['⌘', 'E']);
    expect(keyOf('Find and switch', 'Switch session or project')).toEqual(['⌘', 'O']);
    expect(keyOf('Find and switch', 'This help')).toEqual(['?']);
    expect(keyOf('Answer and reply', 'Open the answer dock at the previous or next waiting question')).toEqual(['[', ']']);
    expect(keyOf('Answer and reply', 'Reply about the selected item, in Details')).toEqual(['r']);
    expect(keyOf('Answer and reply', 'Close the box; your words stay as a draft')).toEqual(['esc']);
    expect(keyOf('Move around the Map', 'Peek at an item; the Map stays put')).toEqual(['Space']);
    expect(keyOf('Move around the Map', 'Outline the next unseen item; Next on the topic band does the same')).toEqual(['n']);
  });

  it('draws each key as a cap beside its words', () => {
    render(<HelpPanel narrow={false} onClose={vi.fn()} />);
    const group = screen.getByRole('region', { name: 'On the selected item' });
    expect(within(group).getByText('Focus on it, or Unfocus').previousElementSibling!.textContent).toBe('⇧F');
    expect(within(group).getByText('Drop').previousElementSibling!.textContent).toBe('d');
  });

  it('explains how single letters, ⌘↵ and esc behave in a text box', () => {
    render(<HelpPanel narrow={false} onClose={vi.fn()} />);
    expect(screen.getByText(/Single-letter keys work when no text box has focus\./)).toBeTruthy();
  });
});

describe('Help markers and statuses', () => {
  it('lists the 11 statuses with their meaning, in the board\'s order', () => {
    render(<HelpPanel narrow={false} initialTab="markers" onClose={vi.fn()} />);
    expect(STATUS_HELP.map(status => status.label)).toEqual(['Open', 'Waiting on me', 'Sent', 'Queued', 'In progress', 'Blocked', 'Decided', 'Done', 'Later', 'Dropped', 'Replaced']);
    const section = screen.getByRole('region', { name: 'Statuses' });
    for (const status of STATUS_HELP) expect(section.textContent).toContain(`${status.label} ${status.text}`);
    expect(section.querySelectorAll('i')).toHaveLength(11);
  });

  it('explains New, Changed and the diamond, and shows the five branch tints', () => {
    render(<HelpPanel narrow={false} initialTab="markers" onClose={vi.fn()} />);
    const markers = screen.getByRole('region', { name: 'Markers' });
    expect(markers.textContent).toContain('You haven’t seen it yet: a new question, task or finding.');
    expect(markers.textContent).toContain('A rewording alone doesn’t count.');
    expect(markers.textContent).toContain('solid for New, outlined for Changed.');
    const branches = screen.getByRole('region', { name: 'Branches' });
    expect(branches.querySelectorAll('.hlp-sw')).toHaveLength(5);
    expect(branches.textContent).toContain('Markers never use them.');
  });
});

describe('Help panel', () => {
  it('switches tabs by click and by the arrow keys, and reports each change', () => {
    const onTabChange = vi.fn();
    render(<HelpPanel narrow={false} onTabChange={onTabChange} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Markers and statuses' }));
    expect(onTabChange).toHaveBeenLastCalledWith('markers');
    expect(screen.getByRole('tabpanel').textContent).toContain('You haven’t seen it yet');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Markers and statuses' }), { key: 'ArrowLeft' });
    expect(onTabChange).toHaveBeenLastCalledWith('keys');
    expect(screen.getByRole('tab', { name: 'Keys' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Keys' }).tabIndex).toBe(0);
    expect(screen.getByRole('tab', { name: 'Markers and statuses' }).tabIndex).toBe(-1);
  });

  it('closes with the × button, with Esc, and with a press outside, but not on its own "?" button', () => {
    const onClose = vi.fn();
    render(<HelpPanel narrow={false} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close help' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(3);
    const trigger = document.createElement('button');
    trigger.dataset.popoverTrigger = 'help';
    document.body.append(trigger);
    fireEvent.pointerDown(trigger);
    trigger.remove();
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('takes focus when it opens and gives it back when it closes', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const view = render(<HelpPanel narrow={false} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Help: keys and markers' })).toBe(document.activeElement);
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('takes the narrow layout (the window\'s width less 16px) when narrow', () => {
    const { rerender } = render(<HelpPanel narrow={false} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog').className).toBe('hlp');
    rerender(<HelpPanel narrow onClose={vi.fn()} />);
    expect(screen.getByRole('dialog').className).toBe('hlp hlp-narrow');
  });
});
