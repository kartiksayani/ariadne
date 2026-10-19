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
  ])('%s reports %i', (code, count) => {
    expect(lint(code)).toHaveLength(count);
  });
});

describe('frozen class-selector baseline', () => {
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
