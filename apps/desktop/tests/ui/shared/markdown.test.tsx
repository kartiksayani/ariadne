import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { inline, MARKDOWN_LIMIT, parseMarkdown, safeHref } from '../../../src/ui/shared/markdown';
import { LinkOpener, Markdown } from '../../../src/ui/shared/MarkdownText';

const blocks = (text: string) => parseMarkdown(text).blocks;

describe('markdown parser', () => {
  it('keeps paragraphs apart and line breaks inside them', () => {
    expect(blocks('First line\nsecond line\n\nNext paragraph')).toEqual([
      { t: 'p', children: ['First line', { t: 'br' }, 'second line'] },
      { t: 'p', children: ['Next paragraph'] },
    ]);
  });

  it('reads bullets that a sentence introduces instead of running them inline', () => {
    expect(blocks('Changes:\n- On a bundle miss, retry\n- Keep `cache.go` warm')).toEqual([
      { t: 'p', children: ['Changes:'] },
      { t: 'list', ordered: false, start: 1, items: [
        [{ t: 'p', children: ['On a bundle miss, retry'] }],
        [{ t: 'p', children: ['Keep ', { t: 'code', text: 'cache.go' }, ' warm'] }],
      ] },
    ]);
  });

  it('nests lists by indentation and keeps an ordered start', () => {
    const [list] = blocks('3. three\n   - inner\n4. four');
    expect(list).toEqual({ t: 'list', ordered: true, start: 3, items: [
      [{ t: 'p', children: ['three'] }, { t: 'list', ordered: false, start: 1, items: [[{ t: 'p', children: ['inner'] }]] }],
      [{ t: 'p', children: ['four'] }],
    ] });
  });

  it('only lets a list starting at 1 interrupt a sentence', () => {
    expect(blocks('It shipped in\n2023. Then it grew.')).toEqual([{ t: 'p', children: ['It shipped in', { t: 'br' }, '2023. Then it grew.'] }]);
  });

  it('keeps fenced code literal, including markdown and html inside it', () => {
    expect(blocks('```go\nfunc a() { *b* }\n<b>x</b>\n```\nafter')).toEqual([
      { t: 'code', lang: 'go', text: 'func a() { *b* }\n<b>x</b>' },
      { t: 'p', children: ['after'] },
    ]);
  });

  it('reads headings, quotes, rules and tables', () => {
    expect(blocks('## Plan ##\n> quoted\n> more\n\n---\n| a | b |\n|:--|--:|\n| 1 | 2 |')).toEqual([
      { t: 'h', level: 2, children: ['Plan'] },
      { t: 'quote', children: [{ t: 'p', children: ['quoted', { t: 'br' }, 'more'] }] },
      { t: 'hr' },
      { t: 'table', align: ['left', 'right'], head: [['a'], ['b']], rows: [[['1'], ['2']]] },
    ]);
    expect(blocks('#5 is not a heading')).toEqual([{ t: 'p', children: ['#5 is not a heading'] }]);
  });

  it('reads nested emphasis', () => {
    expect(inline('**bold *and italic* text** and ~~gone~~', 0)).toEqual([
      { t: 'strong', children: ['bold ', { t: 'em', children: ['and italic'] }, ' text'] }, ' and ', { t: 'del', children: ['gone'] },
    ]);
    expect(inline('***both***', 0)).toEqual([{ t: 'strong', children: [{ t: 'em', children: ['both'] }] }]);
  });

  it('leaves snake_case names, lone stars and unclosed markers as text', () => {
    expect(inline('use snake_case_name and 2 * 3 and **open', 0)).toEqual(['use snake_case_name and 2 * 3 and **open']);
    expect(inline('\\*not italic\\*', 0)).toEqual(['*not italic*']);
  });

  it('links http, https and mailto targets and auto-links bare URLs without trailing punctuation', () => {
    expect(inline('[docs](https://example.com/a) see https://example.com/b_(c). mail <mailto:a@b.c>', 0)).toEqual([
      { t: 'link', href: 'https://example.com/a', children: ['docs'] }, ' see ',
      { t: 'link', href: 'https://example.com/b_(c)', children: ['https://example.com/b_(c)'] }, '. mail ',
      { t: 'link', href: 'mailto:a@b.c', children: ['a@b.c'] },
    ]);
    expect(inline('(see https://example.com/x)', 0)).toEqual(['(see ', { t: 'link', href: 'https://example.com/x', children: ['https://example.com/x'] }, ')']);
  });

  it('never links javascript:, data: or file: targets', () => {
    for (const target of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'file:///etc/hosts', 'vbscript:x', '//evil.example']) {
      expect(safeHref(target)).toBeNull();
      expect(inline(`[click](${target})`, 0)).toEqual(['click']);
    }
    expect(inline('<javascript:alert(1)>', 0)).toEqual(['<javascript:alert(1)>']);
    expect(safeHref('https://example.com/\nx')).toBeNull();
    expect(safeHref(`https://example.com/${'a'.repeat(3000)}`)).toBeNull();
  });

  it('marks file:line references as code', () => {
    expect(inline('see internal/billing/pricing.go:123 and a.ts:4:2, not 10.30:45', 0)).toEqual([
      'see ', { t: 'ref', text: 'internal/billing/pricing.go:123' }, ' and ', { t: 'ref', text: 'a.ts:4:2' }, ', not 10.30:45',
    ]);
  });

  it('parses a very long line and a pathological input in linear time', () => {
    const long = `${'a'.repeat(60_000)} https://example.com/${'b'.repeat(1_000)} ${'x_'.repeat(20_000)}`;
    const started = performance.now();
    expect(parseMarkdown(long).blocks).toHaveLength(1);
    parseMarkdown('*a '.repeat(20_000));
    parseMarkdown('['.repeat(20_000) + '](' .repeat(5_000));
    parseMarkdown('`'.repeat(1) + ' x ``'.repeat(10_000));
    parseMarkdown('> - > - '.repeat(5_000).split(' ').join('\n'));
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('reads link targets with balanced parentheses, and no whitespace or < inside a target', () => {
    expect(inline('[w](https://en.wikipedia.org/wiki/A_(b)) [x](https://a.b/c d) <https://a.b<c> <https://a.b/d>', 0)).toEqual([
      { t: 'link', href: 'https://en.wikipedia.org/wiki/A_(b)', children: ['w'] }, ' [x](',
      { t: 'link', href: 'https://a.b/c', children: ['https://a.b/c'] }, ' d) <',
      { t: 'link', href: 'https://a.b', children: ['https://a.b'] }, '<c> ',
      { t: 'link', href: 'https://a.b/d', children: ['https://a.b/d'] },
    ]);
    expect(inline('http://[bad http://example.com', 0)).toEqual(['http://[bad ', { t: 'link', href: 'http://example.com', children: ['http://example.com'] }]);
  });

  // Each failed link scan used to rescan up to URL_LIMIT characters per opener: 100k `<` took 13 s.
  it.each([
    ['<', '<'], ['<a', '<a'], ['[](', '[]('], ['[a](x', '[a](x'], ['**', '**'], ['**a', '**a'],
    ['<http://', '<http://'], ['http://(', 'http://('], ['http://[', 'http://['], ['(http://', '(http://'], ['<http://[', '<http://['], ['<>', '<<>'],
  ])('parses %s repeated to the Markdown limit in linear time', (_name, unit) => {
    const text = unit.repeat(Math.ceil(MARKDOWN_LIMIT / unit.length)).slice(0, MARKDOWN_LIMIT);
    parseMarkdown(text.slice(0, 1_000));
    // The best of three runs, so a busy machine does not fail a linear parse.
    const timings = [0, 1, 2].map(() => {
      const started = performance.now();
      expect(parseMarkdown(text).rest).toBe('');
      return performance.now() - started;
    });
    expect(Math.min(...timings)).toBeLessThan(100);
  });

  it('reads only the first MARKDOWN_LIMIT characters as markdown', () => {
    const text = `${'a'.repeat(MARKDOWN_LIMIT)}**rest**`;
    expect(parseMarkdown(text).rest).toBe('**rest**');
  });
});

describe('Markdown component', () => {
  it('renders raw html as text, never as elements', () => {
    const { container } = render(<Markdown text={'<img src=x onerror=alert(1)> <script>alert(1)</script> <b>bold</b>'} />);
    expect(container.querySelector('img,script,b')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('opens links through the opener and never navigates the window', () => {
    const open = vi.fn();
    render(<LinkOpener.Provider value={open}><Markdown text={'Read [the PR](https://github.com/o/r/pull/1) and [this](javascript:alert(1))'} /></LinkOpener.Provider>);
    const link = screen.getByRole('link', { name: 'the PR' });
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    fireEvent(link, click);
    expect(click.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith('https://github.com/o/r/pull/1');
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByText(/and this/)).toBeTruthy();
  });

  it('renders lists, code and emphasis as elements', () => {
    const { container } = render(<Markdown text={'**Done:**\n- one\n- two `x`\n\n```\ncode\n```'} />);
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('strong')?.textContent).toBe('Done:');
    expect(container.querySelector('pre')?.textContent).toBe('code');
    expect(container.querySelector('li code')?.textContent).toBe('x');
  });
});
