// Test-only rule: finds elements by role, label, text or data-testid, never by CSS class.
// It reports a class selector (".name") passed to a DOM or Playwright lookup call.

const LOOKUPS = new Set([
  'locator', 'querySelector', 'querySelectorAll', 'closest', 'matches',
  'waitForSelector', '$', '$$', '$eval', '$$eval',
]);

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

export const noClassSelectors = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      classSelector: 'Find elements by role, label, text or data-testid, not by CSS class ({{selector}}).',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (!name || !LOOKUPS.has(name)) return;
        const text = selectorText(node.arguments[0]);
        if (text !== null && hasClassSelector(text)) {
          context.report({ node: node.arguments[0], messageId: 'classSelector', data: { selector: text.length > 40 ? `${text.slice(0, 37)}...` : text } });
        }
      },
    };
  },
};

export default { rules: { 'no-class-selectors': noClassSelectors } };
