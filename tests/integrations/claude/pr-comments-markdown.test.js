import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inline, parseMarkdown } from '../../../apps/desktop/src/ui/shared/markdown.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../crates/ariadne-cli/tests/fixtures/pr-comments.json', import.meta.url), 'utf8'));

// Interpret the literal escaping prescribed by the authored recipe, then use
// the desktop's real parser rather than a test-only Markdown implementation.
function reviewerText(text) {
  return text.replace(/\\/g, '\\\\').replace(/[<[\]]/g, '\\$&')
    .replace(/https?:\/\//gi, scheme => scheme.replace(':', '\\:'));
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
    const quoted = comment.body.split('\n').map(line => `> ${reviewerText(line)}`).join('\n');
    const note = `Where: ${reviewerText(comment.path)}, line ${comment.line}\n\nReviewer said:\n${quoted}\n\nSuggested action: ${comment.suggestion}`;
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
});
