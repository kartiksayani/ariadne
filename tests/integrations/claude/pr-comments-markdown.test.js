import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../../apps/desktop/src/ui/shared/markdown.ts';
import { Markdown } from '../../../apps/desktop/src/ui/shared/MarkdownText.tsx';
import { detailModel } from '../../../apps/desktop/src/ui/detail/model.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../crates/ariadne-cli/tests/fixtures/pr-comments.json', import.meta.url), 'utf8'));
const normalize = source => source.replace(/\r\n?/g, '\n');
let saved;

function runRecipeFixture(output, run = execFileSync) {
  try {
    run('cargo', ['test', '-p', 'ariadne-cli', '--locked', '--offline', '--test', 'pr_comments_recipe',
      'recipe_exports_cli_stored_messages_for_markdown', '--', '--exact'], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      env: { ...process.env, ARIADNE_PR_COMMENTS_RENDER_FIXTURE: output },
      timeout: 120_000,
      stdio: 'pipe',
    });
  } catch (error) {
    throw new Error('PR comments fixture failed. Prebuild it from the repository root, then rerun:\n'
      + 'cargo test -p ariadne-cli --locked --offline --test pr_comments_recipe --no-run', { cause: error });
  }
}

beforeAll(() => {
  const directory = mkdtempSync(join(tmpdir(), 'ariadne-pr-comments-render-'));
  const output = join(directory, 'stored.json');
  try {
    // Rust interprets the recipe templates against the real CLI/Core/Store.
    // Render its saved messages; there is no JS copy of the recipe formatter.
    // check-commit.py prebuilds this binary before CI coverage; local runs build it here.
    runRecipeFixture(output);
    saved = JSON.parse(readFileSync(output, 'utf8'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 130_000);

it.each(['ETIMEDOUT', 'ENOENT'])('reports the exact fixture prebuild command on %s', code => {
  const cause = Object.assign(new Error('Fixture process failed'), { code });
  expect(() => runRecipeFixture('stored.json', () => { throw cause; })).toThrow(expect.objectContaining({
    message: expect.stringContaining('cargo test -p ariadne-cli --locked --offline --test pr_comments_recipe --no-run'),
    cause,
  }));
});

function stored(name) {
  const value = saved.find(value => value.name === name);
  const item = value.session.items[value.item_id];
  const reply = value.session.messages.find(message => message.kind === 'reply' && message.item_id === item.id);
  return { ...value, item, reply };
}

function links(value) {
  if (Array.isArray(value)) return value.flatMap(links);
  if (value && typeof value === 'object') {
    if (value.t === 'link' || value.t === 'item') return [value];
    return Object.values(value).flatMap(links);
  }
  return [];
}

function rendered(context) {
  const parsed = parseMarkdown(context);
  expect(parsed.rest).toBe('');
  expect(links(parsed)).toEqual([]);
  for (const compact of [false, true]) {
    const markup = renderToStaticMarkup(createElement(Markdown, { text: context, compact }));
    expect(markup).not.toMatch(/<a(?:\s|>)|role="link"/);
  }
  return parsed.blocks.filter(block => block.t === 'code');
}

describe('PR comments saved waiting conversation', () => {
  const names = [...fixture.reviewer_bodies, ...fixture.reviewer_cases].map(value => value.name);

  it.each(names)('renders CLI-stored reviewer data safely and unchanged: %s', name => {
    const { comment, reply } = stored(name);
    const code = rendered(reply.body);
    expect(code).toHaveLength(1);
    expect(code[0].lang).toBe('');
    expect(code[0].text).toBe(normalize(`${comment.path}, line 24\n${comment.body}`));
  });

  it('keeps the short waiting ask beside the visible context before approval', () => {
    const { session, item, reply, comment } = stored('exact suggested reply');
    const model = detailModel({ session, itemId: item.id, now: Date.parse(session.updated_at), mode: null, later: false, saving: null });
    expect(item.status).toBe('waiting_on_me');
    expect(item.note).toBeNull();
    expect(model.note).toBeNull();
    expect(item.ask).not.toMatch(/[\r\n]/);
    expect(item.ask.length).toBeLessThan(100);
    expect(item.ask).not.toContain(comment.body);
    expect(model.answer.options.map(option => option.label)).toEqual(['Fix', 'Reply', 'Skip']);
    expect(model.answer.options.find(option => option.label === 'Reply').consequence).toBe(
      "Post the suggested reply shown in this item's conversation, or your own one-line text instead.",
    );
    const context = model.chat.find(entry => entry.id === reply.id);
    expect(context.message.body).toBe(reply.body);
    expect(context.asks).toEqual([{ text: '', now: true, ordinal: 1 }]);
    expect(model.chat.filter(entry => entry.asks.some(ask => ask.now))).toHaveLength(1);
    expect(model.chat.indexOf(context)).toBeGreaterThan(model.chat.findIndex(entry => entry.id === item.created_message_id));
    expect(context.message.body).toContain('Where:');
    expect(context.message.body).toContain(comment.summary);
    expect(context.message.body).toContain(comment.suggestion);
    expect(context.message.body).toContain('Reviewer wrote:');
    expect(context.message.body).toContain('Suggested reply:');
    const code = rendered(context.message.body);
    expect(code[1].text).toBe(normalize(comment.suggested_reply));
  });

  it('computes a fence longer than every run in the actual stored quote', () => {
    for (const name of ['six-backtick line', 'unusual path', 'empty body', 'paragraph breaks', 'fence in a list item']) {
      const { reply, comment } = stored(name);
      const quote = `${comment.path}, line 24\n${comment.body}`;
      const longest = (quote.match(/`+/g) ?? []).reduce((length, run) => Math.max(length, run.length), 0);
      const fence = reply.body.split('Reviewer wrote:\n\n')[1].split('\n')[0];
      expect(fence).toBe('`'.repeat(Math.max(3, longest + 1)));
    }
  });

  it('renders safe underscore paths as literal inline code and uses the fallback for other paths', () => {
    const { reply } = stored('underscores in safe path');
    expect(reply.body.startsWith('Where: `src/__init__.py`, line 24\n\n')).toBe(true);
    const markup = renderToStaticMarkup(createElement(Markdown, { text: reply.body }));
    expect(markup).toContain('<code class="md-code">src/__init__.py</code>');
    expect(markup).not.toContain('<strong>init</strong>');
    const unusual = stored('unusual path');
    const prose = unusual.reply.body.split('Reviewer wrote:')[0];
    expect(prose.startsWith('Where: the file shown in the quote below\n\n')).toBe(true);
    expect(prose).not.toContain(unusual.comment.path);
    expect(prose).not.toContain('https://');
  });

  it.each(['ten KB body', 'oversize first body line'])('stores and safely renders a line-aligned prefix: %s', name => {
    const { comment, reply, item } = stored(name);
    expect(Buffer.byteLength(comment.body)).toBeGreaterThan(10_000);
    expect(Buffer.byteLength(reply.body)).toBeLessThanOrEqual(4096);
    expect(item.status).toBe('waiting_on_me');
    const code = rendered(reply.body);
    expect(code).toHaveLength(1);
    const original = normalize(`${comment.path}, line 24\n${comment.body}`);
    expect(original.startsWith(code[0].text)).toBe(true);
    expect(code[0].text.endsWith('\n')).toBe(true);
    expect(reply.body).toContain('\n```\n\nShortened; the full comment is on GitHub (Review comment link).');
    // The sixty-backtick run beyond the retained prefix must not enlarge its fence.
    expect(reply.body.split('Reviewer wrote:\n\n')[1].split('\n')[0]).toBe('```');
  });

  it.each(['oversize suggested reply', 'suggested reply with no room for wrappers'])('offers no partial suggested reply: %s', name => {
    const { comment, reply, item } = stored(name);
    expect(Buffer.byteLength(comment.suggested_reply)).toBeGreaterThanOrEqual(4096);
    expect(Buffer.byteLength(reply.body)).toBeLessThanOrEqual(4096);
    expect(reply.body).not.toContain('Suggested reply:');
    expect(item.ask).toContain('Reply needs your own text.');
    expect(item.options.find(option => option.label === 'Reply').consequence).toBe(
      'Post only the exact text you approve in this conversation.',
    );
    expect(rendered(reply.body)).toHaveLength(1);
  });
});
