// A small, safe Markdown reader for agent message bodies. It turns text into a
// plain tree (paragraphs, line breaks, headings, lists, quotes, code, tables,
// emphasis, links); Markdown.tsx renders that tree as React elements. Raw HTML
// is never interpreted: it stays text. External links keep only http, https and
// mailto targets; item references select items inside the app. Parsing is linear
// in the input: every scan is a single pass or a
// bounded lookahead, and the input and nesting depth are capped.

export type Inline =
  | string
  | { readonly t: 'br' }
  | { readonly t: 'code'; readonly text: string }
  /** A `file.go:123` reference: shown as code, and a link when the desktop finds the file. */
  | { readonly t: 'ref'; readonly text: string }
  /** A bare `src/app.ts` path (no line): plain text, and a link when the desktop finds the file. */
  | { readonly t: 'path'; readonly text: string }
  | { readonly t: 'strong' | 'em' | 'del'; readonly children: readonly Inline[] }
  | { readonly t: 'item'; readonly itemId: string; readonly children: readonly Inline[] }
  | { readonly t: 'link'; readonly href: string; readonly children: readonly Inline[] };

export type Align = 'left' | 'center' | 'right' | null;
export type Block =
  | { readonly t: 'p'; readonly children: readonly Inline[] }
  | { readonly t: 'h'; readonly level: number; readonly children: readonly Inline[] }
  | { readonly t: 'code'; readonly lang: string; readonly text: string }
  | { readonly t: 'quote'; readonly children: readonly Block[] }
  | { readonly t: 'list'; readonly ordered: boolean; readonly start: number; readonly items: readonly (readonly Block[])[] }
  | { readonly t: 'hr' }
  | { readonly t: 'table'; readonly align: readonly Align[]; readonly head: readonly (readonly Inline[])[]; readonly rows: readonly (readonly (readonly Inline[])[])[] };

/** Characters read as Markdown; the rest of a longer body follows as plain text. */
export const MARKDOWN_LIMIT = 100_000;
const BLOCK_DEPTH = 8, INLINE_DEPTH = 6, URL_LIMIT = 2048;

/** A local item target, using the core's positive safe-integer dotted identity syntax. */
export function itemReference(raw: string): string | null {
  if (!raw.startsWith('item:')) return null;
  const id = raw.slice(5);
  return id.split('.').every(segment => {
    const ordinal = Number(segment);
    return ordinal > 0 && Number.isSafeInteger(ordinal) && String(ordinal) === segment;
  }) ? id : null;
}

/** The link target when it is a safe external URL (http, https or mailto), else null. */
export function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (!url || url.length > URL_LIMIT) return null;
  for (let index = 0; index < url.length; index++) {
    const code = url.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return null;
  }
  const lower = url.toLowerCase();
  if (lower.startsWith('mailto:')) return url.length > 7 ? url : null;
  if (!lower.startsWith('https://') && !lower.startsWith('http://')) return null;
  return parses(url) ? url : null;
}
/** Whether the URL parser accepts `url`; URL.canParse (WebKit 17+) avoids a thrown error per non-URL. */
const parses: (url: string) => boolean = typeof (URL as { canParse?: unknown }).canParse === 'function'
  ? url => (URL as unknown as { canParse(url: string): boolean }).canParse(url)
  : url => { try { new URL(url); return true; } catch { return false; } };

// ------------------------------------------------------------------ blocks

const blank = (line: string) => line.trim() === '';
/** Leading spaces, with a tab counting as four. */
function indentOf(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === ' ') width++;
    else if (char === '\t') width += 4 - (width % 4);
    else break;
  }
  return width;
}
/** The line without its first `width` columns of indentation. */
function dedent(line: string, width: number): string {
  let column = 0, index = 0;
  while (index < line.length && column < width) {
    const char = line[index];
    if (char === ' ') column++;
    else if (char === '\t') column += 4 - (column % 4);
    else break;
    index++;
  }
  return line.slice(index);
}

interface Fence { readonly char: string; readonly length: number; readonly lang: string }
function fenceOf(line: string): Fence | null {
  if (indentOf(line) > 3) return null;
  const text = line.trimStart(), char = text[0];
  if (char !== '`' && char !== '~') return null;
  let length = 0;
  while (text[length] === char) length++;
  if (length < 3) return null;
  const info = text.slice(length).trim();
  if (char === '`' && info.includes('`')) return null;
  return { char, length, lang: info.split(/\s/, 1)[0] ?? '' };
}
function closesFence(line: string, fence: Fence): boolean {
  if (indentOf(line) > 3) return false;
  const text = line.trim();
  if (text.length < fence.length) return false;
  for (const char of text) if (char !== fence.char) return false;
  return true;
}
function headingOf(line: string): { level: number; text: string } | null {
  if (indentOf(line) > 3) return null;
  const text = line.trimStart();
  let level = 0;
  while (text[level] === '#') level++;
  if (level < 1 || level > 6) return null;
  const rest = text.slice(level);
  if (rest && rest[0] !== ' ' && rest[0] !== '\t') return null;
  // A closing run of #s preceded by a space is not content.
  let end = rest.trimEnd(), cut = end.length;
  while (cut > 0 && end[cut - 1] === '#') cut--;
  if (cut === 0 || end[cut - 1] === ' ' || end[cut - 1] === '\t') end = end.slice(0, cut);
  return { level, text: end.trim() };
}
function isRule(line: string): boolean {
  if (indentOf(line) > 3) return false;
  const text = line.trim(), char = text[0];
  if (char !== '-' && char !== '*' && char !== '_') return false;
  let count = 0;
  for (const value of text) {
    if (value === char) count++;
    else if (value !== ' ' && value !== '\t') return false;
  }
  return count >= 3;
}
interface Marker { readonly ordered: boolean; readonly start: number; readonly bullet: string; readonly indent: number; readonly content: number; readonly text: string }
function markerOf(line: string): Marker | null {
  const indent = indentOf(line), text = dedent(line, indent);
  let length = 0, ordered = false, start = 1, bullet = text[0] ?? '';
  if (bullet === '-' || bullet === '*' || bullet === '+') length = 1;
  else {
    while (length < 9 && text[length] >= '0' && text[length] <= '9') length++;
    if (length === 0 || (text[length] !== '.' && text[length] !== ')')) return null;
    ordered = true; start = Number(text.slice(0, length)); bullet = text[length]; length++;
  }
  const after = text.slice(length);
  if (after && after[0] !== ' ' && after[0] !== '\t') return null;
  const gap = indentOf(after), body = after.trim() === '' ? '' : dedent(after, gap > 4 ? 1 : gap);
  return { ordered, start, bullet, indent, content: indent + length + (after.trim() === '' || gap > 4 ? 1 : gap), text: body };
}
const quoteText = (line: string) => { const text = line.trimStart(); return text[1] === ' ' ? text.slice(2) : text.slice(1); };
const isQuote = (line: string) => indentOf(line) <= 3 && line.trimStart().startsWith('>');

/** Splits a table row on unescaped pipes outside code spans. */
function cells(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const out: string[] = [];
  let cell = '', code = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '\\' && text[index + 1] === '|') { cell += '|'; index++; continue; }
    if (char === '`') code = !code;
    if (char === '|' && !code) { out.push(cell.trim()); cell = ''; continue; }
    cell += char;
  }
  out.push(cell.trim());
  return out;
}
function alignmentOf(line: string): Align[] | null {
  if (!line.includes('-')) return null;
  const parts = cells(line), out: Align[] = [];
  for (const part of parts) {
    const left = part.startsWith(':'), right = part.endsWith(':');
    const dashes = part.slice(left ? 1 : 0, right ? part.length - 1 : part.length);
    if (!dashes || [...dashes].some(char => char !== '-')) return null;
    out.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return out;
}
const tableStart = (lines: readonly string[], index: number) => {
  const head = lines[index], rule = lines[index + 1];
  if (head === undefined || rule === undefined || !head.includes('|') || !rule.includes('|')) return null;
  const align = alignmentOf(rule);
  return align && cells(head).length === align.length ? align : null;
};

/** Whether a line ends the paragraph above it. */
function interrupts(lines: readonly string[], index: number): boolean {
  const line = lines[index];
  if (fenceOf(line) || headingOf(line) || isRule(line) || isQuote(line) || tableStart(lines, index)) return true;
  const marker = markerOf(line);
  // As in CommonMark, only a list starting at 1 interrupts a paragraph ("2023. was…" stays text).
  return !!marker && !!marker.text && (!marker.ordered || marker.start === 1);
}

function blocks(lines: readonly string[], depth: number): Block[] {
  const out: Block[] = [];
  let index = 0;
  const paragraph = (text: string) => ({ t: 'p' as const, children: inline(text, 0) });
  while (index < lines.length) {
    const line = lines[index];
    if (blank(line)) { index++; continue; }
    if (depth >= BLOCK_DEPTH) {
      const start = index;
      while (index < lines.length && !blank(lines[index])) index++;
      out.push(paragraph(lines.slice(start, index).map(value => value.trimStart()).join('\n')));
      continue;
    }
    const fence = fenceOf(line);
    if (fence) {
      const indent = indentOf(line), body: string[] = [];
      index++;
      while (index < lines.length && !closesFence(lines[index], fence)) { body.push(dedent(lines[index], indent)); index++; }
      index++;
      out.push({ t: 'code', lang: fence.lang, text: body.join('\n') });
      continue;
    }
    if (indentOf(line) >= 4 && !markerOf(line)) {
      const body: string[] = [];
      while (index < lines.length && (blank(lines[index]) || indentOf(lines[index]) >= 4)) { body.push(dedent(lines[index], 4)); index++; }
      while (body.length && blank(body[body.length - 1])) body.pop();
      out.push({ t: 'code', lang: '', text: body.join('\n') });
      continue;
    }
    const heading = headingOf(line);
    if (heading) { out.push({ t: 'h', level: heading.level, children: inline(heading.text, 0) }); index++; continue; }
    if (isRule(line)) { out.push({ t: 'hr' }); index++; continue; }
    if (isQuote(line)) {
      const body: string[] = [];
      while (index < lines.length && !blank(lines[index])) {
        if (isQuote(lines[index])) body.push(quoteText(lines[index]));
        else if (body.length && !interrupts(lines, index)) body.push(lines[index]);
        else break;
        index++;
      }
      out.push({ t: 'quote', children: blocks(body, depth + 1) });
      continue;
    }
    const align = tableStart(lines, index);
    if (align) {
      const head = cells(line).map(cell => inline(cell, 0)), rows: Inline[][][] = [];
      index += 2;
      while (index < lines.length && !blank(lines[index]) && lines[index].includes('|')) {
        const row = cells(lines[index]);
        rows.push(align.map((_value, column) => inline(row[column] ?? '', 0)));
        index++;
      }
      out.push({ t: 'table', align, head, rows });
      continue;
    }
    const marker = markerOf(line);
    if (marker) { index = list(lines, index, marker, depth, out); continue; }
    const start = index;
    index++;
    while (index < lines.length && !blank(lines[index]) && !interrupts(lines, index)) index++;
    out.push(paragraph(lines.slice(start, index).map(value => value.trimStart()).join('\n')));
  }
  return out;
}

/** Reads one list from `index`; returns the index after it. */
function list(lines: readonly string[], index: number, first: Marker, depth: number, out: Block[]): number {
  const items: Block[][] = [];
  let marker: Marker | null = first;
  while (marker) {
    const body = [marker.text];
    let next = index + 1, gap = false;
    while (next < lines.length) {
      const line = lines[next];
      if (blank(line)) { gap = true; body.push(''); next++; continue; }
      const indent = indentOf(line);
      if (indent >= marker.content) { body.push(dedent(line, marker.content)); gap = false; next++; continue; }
      // Lazy continuation: an unindented line straight after paragraph text.
      if (!gap && !interrupts(lines, next) && !markerOf(line)) { body.push(line.trim()); next++; continue; }
      break;
    }
    while (body.length && blank(body[body.length - 1])) body.pop();
    items.push(blocks(body, depth + 1));
    // A marker of the same kind continues the list; anything else ends it.
    index = next;
    const candidate = index < lines.length ? markerOf(lines[index]) : null;
    marker = candidate && candidate.ordered === first.ordered && candidate.bullet === first.bullet && candidate.indent < first.content ? candidate : null;
  }
  out.push({ t: 'list', ordered: first.ordered, start: first.start, items });
  return index;
}

// ------------------------------------------------------------------ inline

const punctuation = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const alnum = (char: string | undefined) => !!char && /[\p{L}\p{N}]/u.test(char);
const space = (char: string | undefined) => char === undefined || /\s/.test(char);

interface Run { readonly start: number; readonly length: number; readonly char: string; readonly open: boolean; readonly close: boolean }
/** One left-to-right pass: delimiter runs, backtick runs and bracket pairs, each with its partner looked up in O(1). */
function scan(text: string) {
  const runs: Run[] = [], runAt = new Map<number, number>(), ticks: { start: number; length: number }[] = [], tickAt = new Map<number, number>();
  const brackets = new Map<number, number>(), stack: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '\\' && index + 1 < text.length && punctuation.includes(text[index + 1])) { index++; continue; }
    if (char === '`') {
      let end = index;
      while (text[end] === '`') end++;
      tickAt.set(index, ticks.length); ticks.push({ start: index, length: end - index });
      index = end - 1; continue;
    }
    if (char === '*' || char === '_' || char === '~') {
      let end = index;
      while (text[end] === char) end++;
      const before = text[index - 1], after = text[end];
      let open = !space(after), close = !space(before);
      if (char === '_') { open = open && !alnum(before); close = close && !alnum(after); }
      if (char === '~' && end - index !== 2) { open = false; close = false; }
      runAt.set(index, runs.length); runs.push({ start: index, length: end - index, char, open, close });
      index = end - 1; continue;
    }
    if (char === '[') stack.push(index);
    else if (char === ']' && stack.length) brackets.set(stack.pop()!, index);
  }
  // Partners, found right to left: the next closing run with the same character and length,
  // and the next backtick run with the same length.
  const closer = new Array<number>(runs.length).fill(-1), latest = new Map<string, number>();
  for (let index = runs.length - 1; index >= 0; index--) {
    const run = runs[index], key = `${run.char}${run.length}`;
    closer[index] = latest.get(key) ?? -1;
    if (run.close) latest.set(key, index);
  }
  const tickPartner = new Array<number>(ticks.length).fill(-1), latestTick = new Map<number, number>();
  for (let index = ticks.length - 1; index >= 0; index--) {
    tickPartner[index] = latestTick.get(ticks[index].length) ?? -1;
    latestTick.set(ticks[index].length, index);
  }
  // Link targets: each `(` with the `)` that balances it, and the next whitespace from each
  // position, so a `[label](target)` is checked in O(1) instead of rescanning the target.
  const parenClose = new Map<number, number>(), parens: number[] = [], nextSpace = new Int32Array(text.length + 1);
  nextSpace[text.length] = text.length;
  for (let index = text.length - 1; index >= 0; index--) nextSpace[index] = space(text[index]) ? index : nextSpace[index + 1];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '(') parens.push(index);
    else if (text[index] === ')' && parens.length) parenClose.set(parens.pop()!, index);
  }
  return { runs, runAt, closer, ticks, tickAt, tickPartner, brackets, parenClose, nextSpace };
}
type Scan = ReturnType<typeof scan>;

/** Where a bare URL starting at `start` ends, before `to`, and where its scan stopped. */
function urlEnd(text: string, start: number, to: number): { end: number; stop: number } {
  let end = start;
  const count: Record<string, number> = { '(': 0, ')': 0, '[': 0, ']': 0 };
  while (end < to && end - start < URL_LIMIT && !space(text[end]) && text[end] !== '<' && text[end] !== '>') {
    if (text[end] in count) count[text[end]]++;
    end++;
  }
  const stop = end;
  // Trailing sentence punctuation and an unbalanced closing bracket are not part of the URL.
  for (;;) {
    const last = text[end - 1];
    if ('.,:;!?\'"*_~'.includes(last)) { end--; continue; }
    if ((last === ')' && count[')'] > count['(']) || (last === ']' && count[']'] > count['['])) { count[last]--; end--; continue; }
    return { end, stop };
  }
}
const pathChar = (char: string | undefined) => !!char && /[\w./-]/.test(char);
const digit = (char: string | undefined) => !!char && char >= '0' && char <= '9';
/** The end of a `dir/file.ext:123` (or `:123:4`) reference starting at `start`, else -1. */
function referenceEnd(text: string, start: number, to: number): number {
  let end = start, dot = -1;
  while (end < to && end - start < 512 && pathChar(text[end])) { if (text[end] === '.') dot = end; else if (text[end] === '/') dot = -1; end++; }
  // A file extension right before the colon: letters or digits after the last dot of the last segment.
  if (dot < 0 || dot <= start || dot === end - 1 || text[end] !== ':' || !digit(text[end + 1])) return -1;
  if (!/[A-Za-z]/.test(text[dot + 1])) return -1;
  for (let index = dot + 1; index < end; index++) if (!/[A-Za-z0-9]/.test(text[index])) return -1;
  end++;
  while (end < to && digit(text[end])) end++;
  if (text[end] === ':' && digit(text[end + 1])) { end++; while (end < to && digit(text[end])) end++; }
  return end;
}

const SOURCE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'mdx', 'rs', 'py', 'go', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs',
  'rb', 'php', 'sh', 'zsh', 'bash', 'toml', 'yaml', 'yml', 'css', 'scss', 'html', 'sql', 'txt', 'lock', 'xml', 'gradle', 'vue', 'svelte', 'rst', 'ini', 'cfg',
]);
const REFERENCE_LIMIT = 512;
export interface FileReference {
  /** The path as written, without a `:line` suffix. */
  readonly path: string;
  /** The line the reference points at, when it names one. */
  readonly line: number | null;
}
/**
 * The path and line of `text` when the whole text reads as a reference to a file:
 * `src/app.ts`, `crates/foo/src/bar.rs:123`, `./a.py`, `~/p/a.rs`, `/abs/a.rs:4:2`. A name must have a
 * path separator or a known source extension (any extension when a line is given). Whether the file
 * exists is for the desktop to say; this only keeps ordinary words and URLs from being asked about.
 */
export function fileReference(text: string): FileReference | null {
  if (!text || text.length > REFERENCE_LIMIT || !/^[\w./@+~-]+(?::\d+){0,2}$/.test(text)) return null;
  const match = /^(.*?)((?::\d+){1,2})?$/.exec(text)!;
  const path = match[1], line = match[2] ? Number(match[2].split(':')[1]) : null;
  if (path.startsWith('//') || path.endsWith('/') || path === '~' || (path.startsWith('~') && !path.startsWith('~/'))) return null;
  const name = path.slice(path.lastIndexOf('/') + 1), dot = name.lastIndexOf('.');
  if (!name || !/[A-Za-z]/.test(name) || name === '.' || name === '..') return null;
  const extension = dot > 0 ? name.slice(dot + 1) : '';
  const known = SOURCE_EXTENSIONS.has(extension.toLowerCase()) || (line !== null && /^[A-Za-z][A-Za-z0-9]*$/.test(extension));
  return path.includes('/') || known ? { path, line } : null;
}
/** The words on a file link: "Open bar.rs (line 123) in your text editor". */
export function fileLinkTitle(reference: FileReference): string {
  const name = reference.path.slice(reference.path.lastIndexOf('/') + 1);
  return `Open ${name}${reference.line === null ? '' : ` (line ${reference.line})`} in your text editor`;
}
/** Every distinct file-shaped text in `blocks` (code spans and bare paths; never fenced code), in reading order. */
export function fileReferences(blocks: readonly Block[]): string[] {
  const found = new Set<string>();
  const visit = (nodes: readonly Inline[]) => {
    for (const node of nodes) {
      if (typeof node === 'string') continue;
      if (node.t === 'ref' || node.t === 'path') found.add(node.text);
      else if (node.t === 'code') { if (fileReference(node.text)) found.add(node.text); }
      else if (node.t === 'strong' || node.t === 'em' || node.t === 'del') visit(node.children);
      // A link keeps its own target; text inside it is its label.
    }
  };
  const walk = (list: readonly Block[]) => {
    for (const block of list) {
      if (block.t === 'p' || block.t === 'h') visit(block.children);
      else if (block.t === 'quote') walk(block.children);
      else if (block.t === 'list') block.items.forEach(walk);
      else if (block.t === 'table') { block.head.forEach(visit); block.rows.forEach(row => row.forEach(visit)); }
    }
  };
  walk(blocks);
  return [...found];
}

/** Inline content of `text`; `depth` caps nested emphasis and links. */
export function inline(text: string, depth: number): Inline[] {
  return spans(text, scan(text), 0, text.length, depth, false);
}

function spans(text: string, found: Scan, from: number, to: number, depth: number, inLink: boolean): Inline[] {
  const out: Inline[] = [];
  let buffer = '';
  const flush = () => { if (buffer) { out.push(buffer); buffer = ''; } };
  let index = from, noUrlBefore = from;
  while (index < to) {
    const char = text[index];
    if (char === '\\' && index + 1 < to) {
      const next = text[index + 1];
      if (next === '\n') { flush(); out.push({ t: 'br' }); index += 2; continue; }
      if (punctuation.includes(next)) { buffer += next; index += 2; continue; }
    }
    if (char === '\n') { flush(); out.push({ t: 'br' }); index++; continue; }
    const tick = found.tickAt.get(index);
    if (tick !== undefined) {
      const { length } = found.ticks[tick], partner = found.tickPartner[tick];
      const close = partner >= 0 ? found.ticks[partner] : undefined;
      if (close && close.start + close.length <= to) {
        let code = text.slice(index + length, close.start).replace(/\n/g, ' ');
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
        flush(); out.push({ t: 'code', text: code });
        index = close.start + close.length; continue;
      }
      buffer += text.slice(index, index + length); index += length; continue;
    }
    const runIndex = found.runAt.get(index);
    if (runIndex !== undefined) {
      const run = found.runs[runIndex], partner = found.closer[runIndex];
      const close = partner >= 0 ? found.runs[partner] : undefined;
      if (run.open && close && close.start + close.length <= to && close.start > index + run.length && depth < INLINE_DEPTH && run.length <= 3) {
        const inner = spans(text, found, index + run.length, close.start, depth + 1, inLink);
        flush();
        if (run.char === '~') out.push({ t: 'del', children: inner });
        else if (run.length === 1) out.push({ t: 'em', children: inner });
        else if (run.length === 2) out.push({ t: 'strong', children: inner });
        else out.push({ t: 'strong', children: [{ t: 'em', children: inner }] });
        index = close.start + close.length; continue;
      }
      buffer += text.slice(index, index + run.length); index += run.length; continue;
    }
    if (char === '[' && !inLink) {
      const end = found.brackets.get(index);
      if (end !== undefined && end < to && text[end + 1] === '(') {
        // The target may hold balanced parentheses, as in https://en.wikipedia.org/wiki/A_(b),
        // and no whitespace.
        const close = found.parenClose.get(end + 1) ?? -1;
        if (close >= 0 && close < to && close - end < URL_LIMIT && found.nextSpace[end + 2] > close) {
          const target = text.slice(end + 2, close), href = safeHref(target), itemId = itemReference(target);
          const label = depth < INLINE_DEPTH ? spans(text, found, index + 1, end, depth + 1, true) : [text.slice(index + 1, end)];
          flush();
          // An unsafe target keeps only the label, as text.
          if (itemId) out.push({ t: 'item', itemId, children: label });
          else if (href) out.push({ t: 'link', href, children: label });
          else out.push(...label);
          index = close + 1; continue;
        }
      }
    }
    if (char === '<' && !inLink) {
      // An autolink holds no `<`: stopping there keeps every scan to its own stretch of text.
      let close = index + 1;
      while (close < to && close - index < URL_LIMIT && text[close] !== '>' && text[close] !== '<' && !space(text[close])) close++;
      const href = text[close] === '>' && close < to ? safeHref(text.slice(index + 1, close)) : null;
      if (href) { flush(); out.push({ t: 'link', href, children: [href.replace(/^mailto:/i, '')] }); index = close + 1; continue; }
    }
    const wordStart = !alnum(text[index - 1]) && !pathChar(text[index - 1]);
    if ((char === 'h' || char === 'H') && !inLink && wordStart && index >= noUrlBefore) {
      const head = text.slice(index, index + 8).toLowerCase();
      if (head.startsWith('https://') || head.startsWith('http://')) {
        const { end, stop } = urlEnd(text, index, to);
        const href = end > index + head.indexOf('//') + 2 ? safeHref(text.slice(index, end)) : null;
        if (href) { flush(); out.push({ t: 'link', href, children: [href] }); index = end; continue; }
        // Not a URL: no bare URL starts inside the same stretch, so it is never rescanned.
        noUrlBefore = stop;
      }
    }
    if (wordStart && pathChar(char)) {
      // A whole path token is read (or skipped) at once, so each character is looked at once.
      const end = referenceEnd(text, index, to);
      if (end > 0) { flush(); out.push({ t: 'ref', text: text.slice(index, end) }); index = end; continue; }
      // A bare path without a line: `src/app.ts`, read as one token, minus the sentence's own full stop.
      if (!inLink && text[index - 1] !== ':') {
        let stop = index;
        while (stop < to && stop - index < REFERENCE_LIMIT && pathChar(text[stop])) stop++;
        while (stop > index && text[stop - 1] === '.') stop--;
        const token = text.slice(index, stop);
        if (stop > index && fileReference(token)) { flush(); out.push({ t: 'path', text: token }); index = stop; continue; }
      }
    }
    buffer += char; index++;
  }
  flush();
  return out;
}

/** The whole body: Markdown blocks up to MARKDOWN_LIMIT, then any rest as plain text. */
export function parseMarkdown(source: string): { readonly blocks: readonly Block[]; readonly rest: string } {
  const text = source.replace(/\r\n?/g, '\n');
  const head = text.length > MARKDOWN_LIMIT ? text.slice(0, MARKDOWN_LIMIT) : text;
  return { blocks: blocks(head.split('\n'), 0), rest: text.slice(head.length) };
}
