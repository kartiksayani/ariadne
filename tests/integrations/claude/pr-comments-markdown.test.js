import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inline, parseMarkdown } from '../../../apps/desktop/src/ui/shared/markdown.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../crates/ariadne-cli/tests/fixtures/pr-comments.json', import.meta.url), 'utf8'));

// Interpret the literal escaping prescribed by the authored recipe, then use
// the desktop's real parser rather than a test-only Markdown implementation.
function literalText(text) {
  return text.replace(/\\/g, '\\\\').replace(/[<[\]`]/g, '\\$&')
    .replace(/https?:\/\//gi, scheme => scheme.replace(':', '\\:'));
}

function reviewerText(source) {
  let result = '', fence = null;
  for (const line of source.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const marker = /^ {0,3}(`{3,}|~{3,})([^\n]*)\n?$/.exec(line);
    if (fence) {
      result += line;
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (marker && (marker[1][0] !== '`' || !marker[2].includes('`'))) {
      result += line;
      fence = marker[1];
    } else result += literalText(line);
  }
  return result;
}

function links(value) {
  if (Array.isArray(value)) return value.flatMap(links);
  if (value && typeof value === 'object') {
    if (value.t === 'link' || value.t === 'item') return [value];
    return Object.values(value).flatMap(links);
  }
  return [];
}

function text(nodes) {
  return nodes.map(node => typeof node === 'string' ? node :
    node.t === 'br' ? '\n' : 'children' in node ? text(node.children) : node.text).join('');
}

describe('PR comments recipe Markdown escaping', () => {
  it('defuses bare and Markdown reviewer URLs in the fixture note', () => {
    const comment = fixture.threads[0].comments[0];
    expect(links(parseMarkdown(comment.body)).length).toBeGreaterThan(0);
    const quoted = reviewerText(comment.body).split('\n').map(line => `> ${line}`).join('\n');
    const note = `Where: ${literalText(comment.path)}, line ${comment.line}\n\nReviewer said:\n${quoted}\n\nSuggested action: ${comment.suggestion}`;
    expect(links(parseMarkdown(note))).toEqual([]);
    expect(text(inline(reviewerText(comment.body), 0))).toBe(comment.body);
    expect(note).toContain('https\\://docs.example.test/guide');
    expect(note).toContain('HTTP\\://docs.example.test/notes');
  });

  it('keeps escaped reviewer titles and paths readable without HTML entities', () => {
    for (const original of [fixture.markdown_title, fixture.threads[0].comments[0].path, '<original> & [saved]']) {
      const escaped = reviewerText(original);
      const parsed = inline(escaped, 0);
      expect(links(parsed)).toEqual([]);
      expect(text(parsed)).toBe(original);
      expect(escaped).not.toContain('&lt;');
      expect(escaped).not.toContain('&amp;');
    }
  });

  it('preserves existing backslashes while defusing mixed-case and angle URLs', () => {
    const original = String.raw`\[guide](https://docs.example.test) \<HTTPS://docs.example.test> <mailto:reviewer@example.test>`;
    const parsed = inline(reviewerText(original), 0);
    expect(links(parsed)).toEqual([]);
    expect(text(parsed)).toBe(original);
  });

  it('escapes inline backticks and their contents just like other reviewer text', () => {
    const original = '`arr[i]` and `https://x` outside: arr[i] https://x';
    const escaped = reviewerText(original);
    expect(escaped).toBe('\\`arr\\[i\\]\\` and \\`https\\://x\\` outside: arr\\[i\\] https\\://x');
    const parsed = inline(escaped, 0);
    expect(parsed.filter(node => node.t === 'code')).toEqual([]);
    expect(text(parsed)).toBe(original);
    expect(links(parsed)).toEqual([]);
    const multipleTicks = reviewerText('``arr[`i`] https://x``');
    expect(text(inline(multipleTicks, 0))).toBe('``arr[`i`] https://x``');
    expect(links(parseMarkdown(multipleTicks))).toEqual([]);
  });

  it('preserves fenced suggestions verbatim across quoted lines without links', () => {
    for (const fence of ['```suggestion', '~~~suggestion']) {
      const code = String.raw`arr[i] = "https://x"; // \[saved] <value>`;
      const original = `${fence}\n${code}\n${fence.slice(0, 3)}\nOutside arr[i] https://x`;
      const escaped = reviewerText(original);
      expect(escaped).toContain(`${fence}\n${code}\n${fence.slice(0, 3)}`);
      expect(escaped).toContain('Outside arr\\[i\\] https\\://x');
      const parsed = parseMarkdown(escaped.split('\n').map(line => `> ${line}`).join('\n'));
      expect(parsed.blocks[0].children[0]).toEqual({ t: 'code', lang: 'suggestion', text: code });
      expect(links(parsed)).toEqual([]);
    }
  });

  it('escapes unmatched and escaped backticks as ordinary reviewer text', () => {
    for (const original of ['`arr[i] https://x', '``arr[i]` https://x', '\\`arr[i] https://x']) {
      const escaped = reviewerText(original);
      expect(escaped).toContain('arr\\[i\\]');
      expect(escaped).toContain('https\\://x');
      const parsed = inline(escaped, 0);
      expect(text(parsed)).toBe(original);
      expect(links(parsed)).toEqual([]);
      expect(parsed.filter(node => node.t === 'code')).toEqual([]);
    }
  });

  it.each([
    ['paragraph breaks', '`a\n\nhttps://evil.test/x `'],
    ['emphasis', '*`a* https://evil.test/x `'],
    ['strikethrough', '~~`a~~ https://evil.test/x `'],
    ['headings', '`a\n# https://evil.test/x `'],
    ['table cells', 'a | b\n--- | ---\n`x | https://evil.test/x`'],
  ])('defuses reviewer URLs across inline-run boundaries: %s', (_name, body) => {
    const escaped = reviewerText(body);
    expect(escaped).toContain('https\\://evil.test/x');
    const quoted = escaped.split('\n').map(line => `> ${line}`).join('\n');
    expect(links(parseMarkdown(quoted))).toEqual([]);
  });
});
