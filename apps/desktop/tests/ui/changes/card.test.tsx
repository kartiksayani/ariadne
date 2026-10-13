import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AnswerChanges } from '../../../src/ui/changes/AnswerChanges';
import { limitGroups, type CardGroup } from '../../../src/ui/changes/model';
import { changeCard } from '../../../src/selectors/changes/card';
import { changesFixture } from './fixture';

afterEach(cleanup);
function show(updated: number, replaced: number, added: number) {
  const value = changesFixture(updated, replaced, added), open = vi.fn();
  render(<AnswerChanges session={value.session} inputId={value.input.id} onOpenItem={open} />);
  return { ...value, open, card: screen.getByRole('region', { name: 'What your answer changed' }) };
}
function names(card: HTMLElement) { return [...card.querySelectorAll('.change-name')].map(element => element.textContent); }

describe('the answer’s changes', () => {
  it('shows five names from a group of twelve and reveals all seven remaining names under the same heading', () => {
    const { card } = show(12, 0, 0);
    expect(names(card)).toHaveLength(5);
    expect(within(card).getAllByRole('heading', { name: 'Updated' })).toHaveLength(1);
    fireEvent.click(within(card).getByRole('button', { name: 'and 7 more: 7 updated' }));
    expect(names(card)).toHaveLength(12);
    expect(within(card).getAllByRole('heading', { name: 'Updated' })).toHaveLength(1);
  });
  it('shows groups of three plus three without hiding the single sixth name', () => {
    const { card } = show(3, 3, 0);
    expect(names(card)).toHaveLength(6);
    expect(within(card).queryByRole('button', { name: /and .* more:/ })).toBeNull();
  });
  it('shows all six names in one group', () => { expect(names(show(6, 0, 0).card)).toHaveLength(6); });
  it('shows five of seven names with a grouped two-name summary', () => {
    const { card } = show(3, 4, 0);
    expect(names(card)).toHaveLength(5);
    expect(names(card).slice(3)).toEqual(['Replaced name A', 'Replaced name B']);
    expect(within(card).getByRole('button', { name: 'and 2 more: 2 replaced' })).toBeTruthy();
  });
  it('never renders empty headings and summarizes hidden groups in display order', () => {
    const { card } = show(5, 1, 2);
    expect(within(card).queryByRole('heading', { name: 'Replaced' })).toBeNull();
    expect(within(card).queryByRole('heading', { name: 'New' })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'and 3 more: 1 replaced, 2 new' }));
    expect(names(card)).toHaveLength(8);
    expect(within(card).getByRole('heading', { name: 'New' })).toBeTruthy();
  });
  it('shows exactly five names without a summary', () => {
    const { card } = show(2, 1, 2);
    expect(names(card)).toHaveLength(5);
    expect(within(card).queryByRole('button', { name: /and .* more:/ })).toBeNull();
  });
  it('shows the owner’s own typed words before the batch Read as explanation without losing lines', () => {
    const { card, answer } = show(1, 0, 0);
    expect(card.querySelector('blockquote')?.textContent).toBe(answer.text);
    expect(card.querySelector('.change-read-as')?.textContent).toBe('Read as: keep the change small.\nPreserve the full explanation.');
    expect(card.querySelector('blockquote')?.nextElementSibling?.className).toBe('change-read-as');
  });
  it('uses the chosen option’s saved label and opens a named item', () => {
    const value = changesFixture(), open = vi.fn();
    value.answer.options_snapshot = [{ id: 'small', label: 'Keep it small', consequence: '', recommended: true }];
    value.answer.selected_option_id = 'small';
    render(<AnswerChanges session={value.session} inputId={value.input.id} onOpenItem={open} />);
    expect(screen.getByText('Because you chose Keep it small:')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Updated name A' }));
    expect(open).toHaveBeenCalledWith('updated-0');
  });
  it('quietly reveals wording-only records with the common compare control', () => {
    const value = changesFixture(); value.session.items['updated-0']!.changes![0].wording_only = true;
    render(<AnswerChanges session={value.session} inputId={value.input.id} onOpenItem={vi.fn()} />);
    expect(screen.queryByRole('heading', { name: 'Updated' })).toBeNull();
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
    expect(screen.getByRole('heading', { name: 'Now blocked' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Wait for the proposal' })).toBeTruthy();
  });
  it('does not attribute an existing blockage to a wording or note update', () => {
    const value = changesFixture();
    value.add('dependent', 'Already waiting', { changes: [], depends_on: ['updated-0'] });
    render(<AnswerChanges session={value.session} inputId={value.input.id} onOpenItem={vi.fn()} />);
    expect(screen.queryByRole('heading', { name: 'Now blocked' })).toBeNull();
  });
  it('does not attribute an existing blockage to an answer that completes another dependency', () => {
    const value = changesFixture();
    value.session.items['updated-0']!.status = 'done'; value.session.items['updated-0']!.changes![0].before.status = 'open';
    value.add('other', 'Still unfinished', { changes: [] });
    value.add('dependent', 'Already waiting', { changes: [], depends_on: ['updated-0', 'other'] });
    render(<AnswerChanges session={value.session} inputId={value.input.id} onOpenItem={vi.fn()} />);
    expect(screen.queryByRole('heading', { name: 'Now blocked' })).toBeNull();
  });
  it('never leaves an empty heading when asked to limit empty groups', () => {
    const groups: CardGroup[] = [{ label: 'Updated', rows: [] }];
    expect(limitGroups(groups)).toEqual({ shown: [], hidden: [], summary: '' });
  });
});
