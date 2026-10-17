// Which owner actions unfold a folded Details column (maintainer decision, alpha.19). Every "open the item" action
// unfolds it, by click or key. Browsing moves (focus or selection without opening) never do: unfolding narrows the Map,
// so the Map never moves on its own. The answer dock and the switcher's openAt open the dock, not Details.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { FOLDED_KEY } from '../../../src/state/details/column';
import { AppTransport, route } from '../app/transport';
import { goToSession } from '../app/open';

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); localStorage.clear(); });

async function click(element: Element) { await act(async () => { fireEvent.click(element); }); }
async function key(element: Element, value: string, metaKey = false) { await act(async () => { fireEvent.keyDown(element, { key: value, metaKey }); }); }
const treeRow = (id: string) => document.querySelector<HTMLElement>(`[role="treeitem"][data-item-id="${id}"]`)!;
const graphNode = (id: string) => document.querySelector<HTMLElement>(`.graph-node[data-item-id="${id}"]`)!;
const rail = () => screen.queryByRole('button', { name: 'Show Details' });
const shown = (id: string) => document.querySelector(`[data-detail-item-id="${id}"]`);

async function open() {
  await act(async () => { render(<DesktopApp service={createDesktopService(new AppTransport())} />); });
  await goToSession(route, click);
  await screen.findByRole('tree', { name: 'Session items' });
}
async function pick(id: string) { await click(treeRow(id)); expect(shown(id)).not.toBeNull(); }
async function fold() {
  await click(screen.getByRole('button', { name: 'Fold Details' }));
  expect(rail()).not.toBeNull();
}
async function graph() {
  await click(screen.getByLabelText('Graph', { selector: 'button' }));
  expect(graphNode('4')).not.toBeNull();
}

type Case = readonly [trigger: string, unfolds: boolean, before: () => Promise<void>, act: () => Promise<void>, shows?: string];
const cases: readonly Case[] = [
  // Open the item: unfolds.
  ['a click on a Tree row', true, async () => {}, () => click(treeRow('5')), '5'],
  ['Enter on a Tree row', true, async () => {}, async () => { treeRow('5').focus(); await key(treeRow('5'), 'Enter'); }, '5'],
  ['r on the selected row (Reply opens in Details)', true, async () => {}, async () => { treeRow('4').focus(); await key(treeRow('4'), 'r'); }, '4'],
  ['d on the selected row (Drop opens in Details)', true, async () => {}, async () => { treeRow('4').focus(); await key(treeRow('4'), 'd'); }, '4'],
  ['⌘[ item history back', true, () => pick('1'), () => key(document.body, '[', true), '4'],
  ['⌘] item history forward', true, async () => { await pick('1'); await pick('4'); await key(document.body, '[', true); }, () => key(document.body, ']', true), '4'],
  ['an item chosen in Recent (⌘E)', true, () => pick('1'), async () => {
    await key(document.body, 'e', true);
    const entries = [...document.querySelectorAll<HTMLElement>('.recent-item')];
    expect(entries.length).toBeGreaterThan(0);
    await click(entries.at(-1)!);
  }],
  ['a click on a Graph node', true, graph, () => click(graphNode('5')), '5'],
  ['Enter in the Graph', true, graph, () => key(graphNode('4'), 'Enter'), '4'],
  // Browsing: stays folded.
  // Each move must really move (focus in the Tree, the selection in the Graph), so a key that did nothing cannot pass.
  ...(['ArrowDown', 'ArrowUp', 'j', 'k', 'Home', 'End'] as const).map((value): Case =>
    [`Tree ${value} (moves focus only)`, false, async () => {}, async () => {
      treeRow('4').focus(); await key(treeRow('4'), value);
      expect(document.activeElement).not.toBe(treeRow('4'));
    }]),
  ...(['ArrowDown', 'ArrowUp', 'j', 'k'] as const).map((value): Case =>
    [`Graph ${value} (moves the selection without opening)`, false, graph, async () => {
      await key(graphNode('4'), value);
      expect(graphNode('4').getAttribute('aria-selected')).toBe('false');
    }]),
  ['] opens the answer dock, not Details', false, async () => {}, () => key(document.body, ']')],
];

describe('a folded Details column', () => {
  for (const [name, unfolds, before, trigger, shows] of cases) it(`${name}: unfolds = ${unfolds}`, async () => {
    await open();
    await pick('4');
    await before();
    await fold();
    await trigger();
    if (unfolds) {
      expect(rail()).toBeNull();
      expect(localStorage.getItem(FOLDED_KEY)).toBe('false');
      if (shows) expect(shown(shows)).not.toBeNull();
    } else {
      expect(rail()).not.toBeNull();
      expect(localStorage.getItem(FOLDED_KEY)).toBe('true');
    }
  });
});
