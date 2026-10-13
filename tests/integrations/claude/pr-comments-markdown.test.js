import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { fileReferences, MARKDOWN_LIMIT, parseMarkdown } from '../../../apps/desktop/src/ui/shared/markdown.ts';
import { Markdown } from '../../../apps/desktop/src/ui/shared/MarkdownText.tsx';

const fixture = JSON.parse(readFileSync(new URL('../../../crates/ariadne-cli/tests/fixtures/pr-comments.json', import.meta.url), 'utf8'));
const comment = fixture.threads[0].comments[0];
const normalize = source => source.replace(/\r\n?/g, '\n');

// Interpret the authored recipe with no Markdown parsing or escaping of data.
function reviewerText(source) {
  const longest = (source.match(/`+/g) ?? []).reduce((length, run) => Math.max(length, run.length), 0);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${source}\n${fence}`;
}

function reviewerNote(comment) {
  const line = comment.line ?? comment.originalLine;
  const position = line == null ? 'line no longer available' : `line ${line}`;
  const location = /^[a-z0-9/._ -]+$/i.test(comment.path) ?
    `Where: ${comment.path}, ${position}` : 'Where: the file shown in the quote below';
  const quote = `${comment.path}, ${position}\n${comment.body}`;
  const note = `${location}\n\n${comment.summary}\n${comment.suggestion}\n\nReviewer wrote:\n\n${reviewerText(quote)}`;
  return comment.suggested_reply == null ? note :
    `${note}\n\nSuggested reply:\n\n${reviewerText(comment.suggested_reply)}`;
}

function links(value) {
  if (Array.isArray(value)) return value.flatMap(links);
  if (value && typeof value === 'object') {
    if (value.t === 'link' || value.t === 'item') return [value];
    return Object.values(value).flatMap(links);
  }
  return [];
}

function expectNoRenderedLinks(note) {
  const parsed = parseMarkdown(note);
  expect(links(parsed)).toEqual([]);
  for (const compact of [false, true]) {
    const markup = renderToStaticMarkup(createElement(Markdown, { text: note, compact }));
    expect(markup).not.toMatch(/<a(?:\s|>)|role="link"/);
  }
  return parsed;
}

describe('PR comments controlled reviewer fence', () => {
  const cases = fixture.reviewer_bodies.map(({ name, body }) => [name, body]);
  cases.push(['body past MARKDOWN_LIMIT', 'x'.repeat(MARKDOWN_LIMIT + 200) + '\r\n[x](https://evil.test/x)\n```']);

  it.each(cases)('keeps reviewer data inert and unchanged: %s', (_name, body) => {
    const note = reviewerNote({ ...comment, body });
    const parsed = expectNoRenderedLinks(note);
    expect(fileReferences(parsed.blocks)).toEqual([]);
    const code = parsed.blocks.filter(block => block.t === 'code');
    expect(code).toHaveLength(1);
    expect(code[0].lang).toBe('');
    const quote = normalize(`${comment.path}, line ${comment.line}\n${body}`);
    if (parsed.rest) {
      // The parser caps its code block at MARKDOWN_LIMIT; the renderer keeps
      // the remaining source as literal text. Together they preserve all data.
      const fence = note.split('Reviewer wrote:\n\n')[1].split('\n')[0];
      expect(code[0].text + parsed.rest).toBe(`${quote}\n${fence}`);
      expect(parsed.rest).toContain('https://evil.test/x');
      const markup = renderToStaticMarkup(createElement(Markdown, { text: note }));
      expect(markup).toContain('class="md-rest"');
    } else {
      expect(code[0].text).toBe(quote);
      expect(code[0].text.slice(quote.indexOf('\n') + 1)).toBe(normalize(body));
    }
  });

  it('uses longest backtick run plus one with a minimum of three', () => {
    for (const [source, length] of [['', 3], ['a`b``c', 3], ['a```b', 4], ['``````\nbody\n``````', 7], ['a````````b', 9]]) {
      const fenced = reviewerText(source);
      const fence = '`'.repeat(length);
      expect(fenced).toBe(`${fence}\n${source}\n${fence}`);
    }
    const path = 'src/``````````/sync.rs';
    const note = reviewerNote({ ...comment, path, body: '```\nhttps://evil.test/x\n```' });
    expect(note.split('Reviewer wrote:\n\n')[1].split('\n')[0]).toBe('`'.repeat(11));
    expectNoRenderedLinks(note);
  });

  it('keeps unusual paths and raw reviewer text only inside the controlled fence', () => {
    for (const path of [comment.path, 'src/\r\n``````\r\n[x](https://evil.test/x)', 'src/`arr[i]` <original>.rs']) {
      const note = reviewerNote({ ...comment, path });
      const prose = note.split('Reviewer wrote:')[0];
      expect(prose.startsWith('Where: the file shown in the quote below\n\n')).toBe(true);
      expect(prose).not.toContain(path);
      expect(prose).not.toContain('https://');
      expect(prose).not.toContain(comment.body);
      const parsed = expectNoRenderedLinks(note);
      expect(parsed.blocks.find(block => block.t === 'code').text).toBe(normalize(`${path}, line ${comment.line}\n${comment.body}`));
    }
    const note = reviewerNote({ ...comment, path: 'src/harbor_sync-2.rs' });
    expect(note.startsWith('Where: src/harbor_sync-2.rs, line 24\n\n')).toBe(true);
    expectNoRenderedLinks(note);
  });

  it('preserves fetched whitespace, backslashes and inline code unchanged', () => {
    for (const body of ['', '  `arr[i]` and `https://x` \\ <original> [saved]  ', '\n\ntrailing\r\n']) {
      const note = reviewerNote({ ...comment, body });
      expect(note).toContain(reviewerText(`${comment.path}, line ${comment.line}\n${body}`));
      const parsed = expectNoRenderedLinks(note);
      expect(parsed.blocks.find(block => block.t === 'code').text).toBe(normalize(`${comment.path}, line ${comment.line}\n${body}`));
    }
  });

  it('shows the exact suggested reply in its own controlled fence', () => {
    const reply = '  Approved text.\r\n``````\n[x](https://evil.test/x) \\ <original>  ';
    const note = reviewerNote({ ...comment, suggested_reply: reply });
    expect(note.split('Suggested reply:\n\n')[1]).toBe(reviewerText(reply));
    const parsed = expectNoRenderedLinks(note);
    expect(parsed.blocks.filter(block => block.t === 'code')[1].text).toBe(normalize(reply));
  });
});
