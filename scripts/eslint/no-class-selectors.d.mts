import type { Rule } from 'eslint';
export function hasClassSelector(selector: string): boolean;
export const noClassSelectors: Rule.RuleModule;
declare const plugin: { rules: { 'no-class-selectors': Rule.RuleModule } };
export default plugin;
