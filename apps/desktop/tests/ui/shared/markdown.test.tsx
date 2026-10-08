import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { fileLinkTitle, fileReference, fileReferences, inline, MARKDOWN_LIMIT, parseMarkdown, safeHref } from '../../../src/ui/shared/markdown';
import { FileRefProject, FileRefs, LinkOpener, Markdown, type FileOpener } from '../../../src/ui/shared/MarkdownText';

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

  it('marks bare paths with a separator or a source extension, and leaves ordinary words alone', () => {
    expect(inline('Edit src/app.ts, then run.', 0)).toEqual(['Edit ', { t: 'path', text: 'src/app.ts' }, ', then run.']);
    expect(inline('see ./a/b.py and config.json.', 0)).toEqual(['see ', { t: 'path', text: './a/b.py' }, ' and ', { t: 'path', text: 'config.json' }, '.']);
    for (const plain of ['done. Then v1.2 or 10/20 on 2024/05/01, e.g. maybe', 'mail me@example.com', 'ftp://example.com/x.txt', 'a.b']) {
      expect(JSON.stringify(inline(plain, 0))).not.toContain('"path"');
    }
  });

  it('does not make a path of text inside a link label or a url', () => {
    expect(inline('[src/app.ts](https://a.b/c) https://a.b/src/app.ts', 0)).toEqual([
      { t: 'link', href: 'https://a.b/c', children: ['src/app.ts'] }, ' ',
      { t: 'link', href: 'https://a.b/src/app.ts', children: ['https://a.b/src/app.ts'] },
    ]);
  });

  it('reads a reference as a path and a line', () => {
    expect(fileReference('crates/foo/src/bar.rs:123')).toEqual({ path: 'crates/foo/src/bar.rs', line: 123 });
    expect(fileReference('src/app.ts')).toEqual({ path: 'src/app.ts', line: null });
    expect(fileReference('a.ts:4:2')).toEqual({ path: 'a.ts', line: 4 });
    expect(fileReference('~/p/a.rs')).toEqual({ path: '~/p/a.rs', line: null });
    expect(fileReference('/abs/dir/a.rs:9')).toEqual({ path: '/abs/dir/a.rs', line: 9 });
    expect(fileReference('Makefile')).toBeNull();
    for (const text of ['', 'two words.ts', 'src/', '//host/x.ts', '~', '~user/a.ts', 'foo.bar', '10/20', 'https://a.b/c.ts', 'a b/c.ts', `${'a'.repeat(600)}.ts`]) {
      expect(fileReference(text), text).toBeNull();
    }
    expect(fileLinkTitle({ path: 'crates/foo/src/bar.rs', line: 123 })).toBe('Open bar.rs (line 123) in your text editor');
    expect(fileLinkTitle({ path: 'src/app.ts', line: null })).toBe('Open app.ts in your text editor');
  });

  it('collects each file-shaped text once, from code spans and prose but never fenced code or link labels', () => {
    const found = fileReferences(blocks([
      'Look at `src/app.ts` and src/app.ts and `not a path` and `x.rs:3`.',
      '', '- item `lib/a.py`', '> quote b/c.go:7', '',
      '| h |', '| - |', '| `t/d.ts` |', '',
      '```', 'fenced/code.ts', '`fenced/inline.ts`', '```', '',
      '[label `link/label.ts`](https://a.b)',
    ].join('\n')));
    expect(found).toEqual(['src/app.ts', 'x.rs:3', 'lib/a.py', 'b/c.go:7', 't/d.ts']);
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

describe('file references in Markdown', () => {
  afterEach(cleanup);
  const PROJECT = '11111111-1111-4111-8111-111111111111';
  const files = (exists: readonly string[]) => {
    const opener = {
      resolve: vi.fn((_project: string, references: readonly string[]) => Promise.resolve(references.map(text => exists.includes(text)))),
      open: vi.fn(),
    } satisfies FileOpener;
    return opener;
  };
  const view = (opener: FileOpener | null, text: string, project: string | null = PROJECT, inline = false) => render(
    <FileRefs.Provider value={opener}><FileRefProject.Provider value={project}><Markdown text={text} inline={inline} /></FileRefProject.Provider></FileRefs.Provider>);

  it('turns a found code span and a found bare path into links that open the file', async () => {
    const opener = files(['crates/foo/src/bar.rs:123', 'src/app.ts']);
    view(opener, 'See `crates/foo/src/bar.rs:123` and src/app.ts now.');
    const code = await screen.findByRole('link', { name: 'crates/foo/src/bar.rs:123' });
    expect(code.getAttribute('title')).toBe('Open bar.rs (line 123) in your text editor');
    expect(code.textContent).toBe('crates/foo/src/bar.rs:123');
    expect(code.querySelector('code')).not.toBeNull();
    const bare = screen.getByRole('link', { name: 'src/app.ts' });
    expect(bare.getAttribute('title')).toBe('Open app.ts in your text editor');
    expect(opener.resolve).toHaveBeenCalledTimes(1);
    expect(opener.resolve).toHaveBeenCalledWith(PROJECT, ['crates/foo/src/bar.rs:123', 'src/app.ts']);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    fireEvent(code, click);
    expect(click.defaultPrevented).toBe(true);
    expect(opener.open).toHaveBeenCalledWith(PROJECT, 'crates/foo/src/bar.rs:123');
    fireEvent.click(bare);
    expect(opener.open).toHaveBeenLastCalledWith(PROJECT, 'src/app.ts');
  });

  it('keeps a reference the desktop does not find as plain code or plain words', async () => {
    const opener = files(['src/app.ts']);
    const { container } = view(opener, 'Not `lib/gone.rs:4`, not lib/gone.rs, but `src/app.ts`.');
    await screen.findByRole('link', { name: 'src/app.ts' });
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect([...container.querySelectorAll('code')].map(code => code.textContent)).toEqual(['lib/gone.rs:4', 'src/app.ts']);
    expect(container.textContent).toContain('not lib/gone.rs, but');
    expect(container.querySelector('a code.md-ref')?.textContent).toBe('src/app.ts');
  });

  it('renders every reference as before when nothing is found, there is no project, or the lookup fails', async () => {
    const none = files([]);
    const { container } = view(none, 'See `src/app.ts` and a/b.rs:2 and c/d.rs.');
    await vi.waitFor(() => expect(none.resolve).toHaveBeenCalled());
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect([...container.querySelectorAll('code')].map(code => code.textContent)).toEqual(['src/app.ts', 'a/b.rs:2']);
    const idle = files(['src/app.ts']);
    view(idle, 'See `src/app.ts`', null);
    view(null, 'See `src/app.ts`');
    const failing: FileOpener = { resolve: vi.fn(() => Promise.reject(new Error('x'))), open: vi.fn() };
    view(failing, 'See `src/app.ts`');
    await vi.waitFor(() => expect(failing.resolve).toHaveBeenCalled());
    expect(idle.resolve).not.toHaveBeenCalled();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('leaves fenced code blocks and link labels untouched, and never asks about them', async () => {
    const opener = files(['src/app.ts', 'fenced/code.ts', 'fenced/inline.ts', 'link/label.ts']);
    const { container } = view(opener, ['```', 'fenced/code.ts', '`fenced/inline.ts`', '```', '[see `link/label.ts`](https://a.b/c)', '', 'and `src/app.ts`'].join('\n'));
    await screen.findByRole('link', { name: 'src/app.ts' });
    expect(opener.resolve).toHaveBeenCalledWith(PROJECT, ['src/app.ts']);
    expect(container.querySelector('pre')?.textContent).toBe('fenced/code.ts\n`fenced/inline.ts`');
    expect(container.querySelector('pre a')).toBeNull();
    const web = screen.getByRole('link', { name: 'see link/label.ts' });
    expect(web.querySelector('a')).toBeNull();
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  it('works in inline text and keeps web links working beside file links', async () => {
    const open = vi.fn();
    const opener = files(['src/app.ts']);
    render(<LinkOpener.Provider value={open}><FileRefs.Provider value={opener}><FileRefProject.Provider value={PROJECT}>
      <Markdown text={'Edit `src/app.ts` per https://github.com/o/r/pull/1'} inline />
    </FileRefProject.Provider></FileRefs.Provider></LinkOpener.Provider>);
    fireEvent.click(await screen.findByRole('link', { name: 'src/app.ts' }));
    fireEvent.click(screen.getByRole('link', { name: 'https://github.com/o/r/pull/1' }));
    expect(opener.open).toHaveBeenCalledWith(PROJECT, 'src/app.ts');
    expect(open).toHaveBeenCalledWith('https://github.com/o/r/pull/1');
  });

  it('asks again for another project and drops the old answer meanwhile', async () => {
    const opener = files(['src/app.ts']);
    const { rerender } = view(opener, 'See `src/app.ts`');
    await screen.findByRole('link', { name: 'src/app.ts' });
    rerender(<FileRefs.Provider value={opener}><FileRefProject.Provider value="22222222-2222-4222-8222-222222222222"><Markdown text="See `src/app.ts`" /></FileRefProject.Provider></FileRefs.Provider>);
    await vi.waitFor(() => expect(opener.resolve).toHaveBeenLastCalledWith('22222222-2222-4222-8222-222222222222', ['src/app.ts']));
    expect(await screen.findByRole('link', { name: 'src/app.ts' })).toBeTruthy();
  });
});
