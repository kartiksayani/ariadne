import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import plugin, { hasClassSelector } from '../../../../../scripts/eslint/no-class-selectors.mjs';

const root = resolve(__dirname, '../../../../..');
const baseline: string[] = JSON.parse(readFileSync(resolve(root, 'scripts/eslint/class-selector-baseline.json'), 'utf8'));

function lint(code: string, file = 'sample.test.ts') {
  const linter = new Linter();
  return linter.verify(code, [{ files: ['**/*.{js,mjs,ts,tsx,mts}'], languageOptions: { parser: tseslint.parser }, plugins: { ariadne: plugin }, rules: { 'ariadne/no-class-selectors': 'error' } }], file);
}

describe('class selector detection', () => {
  it.each([
    ['.row', true], ['div.row', true], ['.a .b', true], ['li:not(.done)', true], ['[data-x] > .tail', true],
    ['[data-testid="a.b"]', false], ['[aria-label=\'a.b\']', false], ['button', false], ['#panel', false],
    ['text=Save. Then close', false], ['xpath=//a[@class="x"]', false], ['a[href$=".md"]', false],
  ])('%s -> %s', (selector, expected) => {
    expect(hasClassSelector(selector)).toBe(expected);
  });
});

describe('no-class-selectors rule', () => {
  it.each([
    ["page.locator('.row')", 1],
    ['container.querySelector(`.row-${id}`)', 1],
    ["el.closest('.card')", 1],
    ["page.locator('[data-testid=\"row\"]')", 0],
    ["page.getByRole('button', { name: 'Save.' })", 0],
    ["page.locator('li').filter({ hasText: 'a.b' })", 0],
    ["document.querySelectorAll('[data-id]')", 0],
    ['locator(selector)', 0],
    // Forms beyond a lookup call's first argument.
    ["document.getElementsByClassName('row')", 1],
    ["container.getElementsByClassName(`row-${id}`)", 1],
    ["document.getElementsByClassName(name)", 0],
    ["screen.getByText('Save', { selector: '.btn' })", 1],
    ["screen.getAllByLabelText('Name', { selector: 'div.field' })", 1],
    ["screen.getByText('Save', { exact: false, selector: `.btn-${kind}` })", 1],
    ["screen.getByText('Save', { selector: 'button' })", 0],
    ["screen.getByText('Save', { selector })", 0],
    ["page.click('.save')", 1],
    ["page.fill('form .name', 'x')", 1],
    ["page.hover('li.row')", 1],
    ["mainPage.dblclick('.row')", 1],
    ["frame.check('.agree')", 1],
    ["page.frameLocator('.embed')", 1],
    ["page.click('button')", 0],
    ["page.click('[data-testid=\"save\"]')", 0],
    ["page.fill('input[name=\"a.b\"]', 'x')", 0],
    ["page.keyboard.type('hello.world')", 0],
    ["userEvent.type(field, 'a.b')", 0],
    ["page.click(selector)", 0],
  ])('%s reports %i', (code, count) => {
    expect(lint(code)).toHaveLength(count);
  });
});

// The baseline may only shrink. This is how many files it listed when frozen: adding a file to it fails here. When a file leaves
// the list (the stale-entry test below), lower this to the new length in the same change.
const CEILING = 101;

describe('frozen class-selector baseline', () => {
  it('is no longer than when it was frozen (never add a file to it)', () => {
    expect(baseline.length).toBeLessThanOrEqual(CEILING);
  });

  it('is sorted and has no duplicates', () => {
    expect(baseline).toEqual([...new Set(baseline)].sort());
  });

  it('lists only files that still have a class selector (remove a converted file from the baseline)', () => {
    const stale = baseline.filter(file => {
      if (!existsSync(resolve(root, file))) return true;
      return !lint(readFileSync(resolve(root, file), 'utf8'), file).some(m => m.ruleId === 'ariadne/no-class-selectors');
    });
    expect(stale).toEqual([]);
  });
});
