import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AnswerChanges } from '../../../src/ui/changes/AnswerChanges';
import { latestChangedAnswer, limitEffects, type Effect } from '../../../src/ui/changes/model';
import { changeCard } from '../../../src/selectors/changes/card';
import { immutable } from '../../../src/data';
import { changesFixture } from './fixture';

afterEach(cleanup);
function show(updated: number, replaced: number, added: number) {
  const value = changesFixture(updated, replaced, added), open = vi.fn();
  render(<AnswerChanges session={value.session} inputId={value.input.id} onOpenItem={open} />);
  return { ...value, open, card: screen.getByRole('region', { name: 'What your answer changed' }) };
}
function names(card: HTMLElement) { return [...card.querySelectorAll('.change-name')].map(element => element.textContent); }
/** The kind column of each effect row, in order. */
const kinds = (card: HTMLElement) => [...card.querySelectorAll('.because-kind')].map(element => element.textContent);

describe('the Because card', () => {
  it('shows five effects of twelve, reveals the rest under "and 7 more", and folds back with "Show fewer"', () => {
    const { card } = show(12, 0, 0);
    expect(names(card)).toHaveLength(5);
    fireEvent.click(within(card).getByRole('button', { name: 'and 7 more' }));
    expect(names(card)).toHaveLength(12);
    expect(within(card).queryByRole('button', { name: /and .* more/ })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Show fewer' }));
    expect(names(card)).toHaveLength(5);
    expect(within(card).getByRole('button', { name: 'and 7 more' })).toBeTruthy();
  });
  it('shows six effects whole rather than hiding exactly one', () => {
    const { card } = show(6, 0, 0);
    expect(names(card)).toHaveLength(6);
    expect(within(card).queryByRole('button', { name: /and .* more/ })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Show fewer' })).toBeNull();
  });
  it('shows exactly five without a summary', () => {
    const { card } = show(2, 1, 2);
    expect(names(card)).toHaveLength(5);
    expect(within(card).queryByRole('button', { name: /and .* more/ })).toBeNull();
  });
  it('lists Created, then Changed (updated and replaced), then Blocked, with the kind named in a 78px column', () => {
    const value = changesFixture(2, 1, 1);
    value.session.items['updated-0']!.changes![0].before.status = 'done';
    value.add('dependent', 'Wait for the proposal', { changes: [], depends_on: ['updated-0'] });
    render(<AnswerChanges session={value.session} inputId={value.input.id} onOpenItem={vi.fn()} />);
    const card = screen.getByRole('region', { name: 'What your answer changed' });
    expect(kinds(card)).toEqual(['Created', 'Changed', 'Changed', 'Changed', 'Blocked']);
    expect(card.querySelector('.because-effect[data-kind="blocked"]')?.textContent).toContain('waits on');
  });
  it('shows the owner’s own words under You wrote and the agent’s reading under Read as, without the prefix or lost lines', () => {
    const { card, answer } = show(1, 0, 0);
    const terms = [...card.querySelectorAll('dt')].map(element => element.textContent);
    expect(terms).toEqual(['You wrote', 'Read as']);
    expect(card.querySelector('.because-words')?.textContent).toBe(answer.text);
    expect(card.querySelector('.because-read')?.textContent).toBe('keep the change small.\nPreserve the full explanation.');
    expect(card.querySelector('h3')?.textContent).toBe('Because of what you wrote');
  });
  it('titles the card with the chosen option’s saved label and opens a named item', () => {
    const value = changesFixture(), open = vi.fn();
    value.answer.options_snapshot = [{ id: 'small', label: 'Keep it small', consequence: '', recommended: true }];
    value.answer.selected_option_id = 'small';
    render(<AnswerChanges session={value.session} inputId={value.input.id} onOpenItem={open} />);
    expect(screen.getByRole('heading', { name: 'Because you chose “Keep it small”' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Updated name A' }));
    expect(open).toHaveBeenCalledWith('updated-0');
  });
  it('quietly reveals wording-only records with the common compare control', () => {
    const value = changesFixture(); value.session.items['updated-0']!.changes![0].wording_only = true;
    render(<AnswerChanges session={value.session} inputId={value.input.id} onOpenItem={vi.fn()} />);
    expect(screen.queryByText('Changed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '1 rewording not shown' }));
    const compare = screen.getByRole('button', { name: 'Show before and after' });
    expect(compare.title).toBe('Show before and after');
    fireEvent.click(compare);
    expect(compare.getAttribute('aria-expanded')).toBe('true');
    expect(compare.classList.contains('is-open')).toBe(true);
    expect(screen.getByText('Earlier note.')).toBeTruthy();
    expect(screen.getByText('Current note.')).toBeTruthy();
  });
  it('adds a blocked dependent only when the declared dependency remains unfinished', () => {
    const value = changesFixture(); value.session.items['updated-0']!.affects = ['dependent'];
    value.session.items['updated-0']!.changes![0].before.status = 'done';
    value.add('dependent', 'Wait for the proposal', { changes: [], depends_on: ['updated-0'] });
    const result = changeCard(value.session, value.input.id);
    expect(result.total).toBe(1);
    render(<AnswerChanges session={value.session} inputId={value.input.id} onOpenItem={vi.fn()} />);
    expect(kinds(screen.getByRole('region', { name: 'What your answer changed' }))).toContain('Blocked');
    expect(screen.getByRole('button', { name: 'Wait for the proposal' })).toBeTruthy();
  });
  it('does not attribute an existing blockage to a wording or note update', () => {
    const value = changesFixture();
    value.add('dependent', 'Already waiting', { changes: [], depends_on: ['updated-0'] });
    render(<AnswerChanges session={value.session} inputId={value.input.id} onOpenItem={vi.fn()} />);
    expect(kinds(screen.getByRole('region', { name: 'What your answer changed' }))).not.toContain('Blocked');
  });
  it('does not attribute an existing blockage to an answer that completes another dependency', () => {
    const value = changesFixture();
    value.session.items['updated-0']!.status = 'done'; value.session.items['updated-0']!.changes![0].before.status = 'open';
    value.add('other', 'Still unfinished', { changes: [] });
    value.add('dependent', 'Already waiting', { changes: [], depends_on: ['updated-0', 'other'] });
    render(<AnswerChanges session={value.session} inputId={value.input.id} onOpenItem={vi.fn()} />);
    expect(kinds(screen.getByRole('region', { name: 'What your answer changed' }))).not.toContain('Blocked');
  });
  it('limits an empty list to nothing', () => {
    const effects: Effect[] = [];
    expect(limitEffects(effects)).toEqual({ shown: [], more: 0 });
  });
});

describe('where the card shows (once, under the newest answer that changed something)', () => {
  it('picks the newest owner message whose answer has changes, and none when nothing changed', () => {
    const value = changesFixture(), session = immutable(value.session);
    const owner = value.answer.message_id;
    const entries = [{ id: 'agent-1' }, { id: owner, you: {} }, { id: 'agent-2' }, { id: 'later-owner', you: {} }];
    expect(latestChangedAnswer(session, entries)).toBe(owner);
    expect(latestChangedAnswer(session, [{ id: 'agent-1' }, { id: 'later-owner', you: {} }])).toBeNull();
    const plain = changesFixture(0, 0, 0);
    expect(latestChangedAnswer(immutable(plain.session), [{ id: plain.answer.message_id, you: {} }])).toBeNull();
  });
});
