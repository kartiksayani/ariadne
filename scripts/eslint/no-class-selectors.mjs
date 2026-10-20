// Test-only rule: finds elements by role, label, text or data-testid, never by CSS class.
// It reports a class selector (".name") written as a string literal (or a template literal) in these forms:
//   - a DOM or Playwright lookup call: querySelector, querySelectorAll, closest, matches, locator, frameLocator, $, $$, $eval, ...
//   - a Playwright page method that takes a selector first: page.click('.x'), page.fill('.x', ...), page.hover('.x'), ...
//   - a Testing Library options object: getByText('a', { selector: '.x' })
//   - getElementsByClassName('x'), whose argument is a class name, not a selector
// A selector held in a variable or built by a call is not read (the rule reads literals only); keep selectors literal.

const LOOKUPS = new Set([
  'locator', 'frameLocator', 'querySelector', 'querySelectorAll', 'closest', 'matches',
  'waitForSelector', '$', '$$', '$eval', '$$eval',
]);

// Methods of a Playwright page or frame whose first argument is a selector.
const PAGE_METHODS = new Set([
  'click', 'dblclick', 'fill', 'hover', 'check', 'uncheck', 'press', 'type', 'focus', 'blur', 'tap',
  'textContent', 'innerText', 'innerHTML', 'inputValue', 'getAttribute', 'isVisible', 'isHidden', 'isEnabled',
  'isDisabled', 'isChecked', 'isEditable', 'selectOption', 'setInputFiles', 'dragAndDrop', 'dispatchEvent',
]);
// `page.click(...)`, `frame.fill(...)`, `popup.hover(...)`, `mainPage.type(...)`; not `keyboard.type('a.b')` or `userEvent.click(el)`.
const PAGE_OBJECT = /^(page|frame|popup|[a-z][A-Za-z0-9]*(Page|Frame))$/;

// Playwright engines whose text is not CSS ("text=a.b", "xpath=//a[@class]", "role=button").
const NON_CSS = /^\s*(text|xpath|role|id|data-testid|internal:[a-z-]+)\s*=/i;

// Drops quoted strings and attribute brackets so "a.b" inside a value is not read as a class.
function stripValues(selector) {
  return selector
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')
    .replace(/\[[^\]]*\]/g, '[]');
}

export function hasClassSelector(selector) {
  if (NON_CSS.test(selector)) return false;
  return /\.-?[A-Za-z_][\w-]*/.test(stripValues(selector));
}

function selectorText(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral') return node.quasis.map(q => q.value.cooked ?? q.value.raw).join('x');
  return null;
}

function calleeName(callee) {
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') return callee.property.name;
  if (callee.type === 'Identifier') return callee.name;
  return null;
}

function pageMethod(callee) {
  return callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier'
    && PAGE_METHODS.has(callee.property.name) && callee.object.type === 'Identifier' && PAGE_OBJECT.test(callee.object.name);
}

// `{ selector: '.x' }` in any argument: Testing Library's `getByText(text, { selector })` and its siblings.
function optionSelectors(args) {
  const found = [];
  for (const arg of args) {
    if (arg.type !== 'ObjectExpression') continue;
    for (const property of arg.properties) {
      if (property.type !== 'Property' || property.computed) continue;
      const key = property.key.type === 'Identifier' ? property.key.name : property.key.type === 'Literal' ? property.key.value : null;
      if (key === 'selector') found.push(property.value);
    }
  }
  return found;
}

export const noClassSelectors = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      classSelector: 'Find elements by role, label, text or data-testid, not by CSS class ({{selector}}).',
    },
  },
  create(context) {
    const report = (node, text) => context.report({ node, messageId: 'classSelector',
      data: { selector: text.length > 40 ? `${text.slice(0, 37)}...` : text } });
    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (name === 'getElementsByClassName') {
          const text = selectorText(node.arguments[0]);
          if (text !== null) report(node.arguments[0], text);
        } else if (name && (LOOKUPS.has(name) || pageMethod(node.callee))) {
          const text = selectorText(node.arguments[0]);
          if (text !== null && hasClassSelector(text)) report(node.arguments[0], text);
        }
        for (const value of optionSelectors(node.arguments)) {
          const text = selectorText(value);
          if (text !== null && hasClassSelector(text)) report(value, text);
        }
      },
    };
  },
};

export default { rules: { 'no-class-selectors': noClassSelectors } };
