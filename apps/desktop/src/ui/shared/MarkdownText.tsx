// Agent-written text rendered from Markdown (ui/shared/markdown.ts) as React
// elements: no HTML strings, nothing injected. Links open in the system
// browser through LinkOpener; a click never navigates the app's window.
import { createContext, Fragment, useContext, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { fileLinkTitle, fileReference, fileReferences, parseMarkdown, safeHref, type Block, type Inline } from './markdown';
import './markdown.css';

/** Opens a checked external URL; the composition supplies the desktop's opener. */
export const LinkOpener = createContext<(url: string) => void>(() => {});

/**
 * Files named in agent text. The desktop alone decides which references are files inside a project's
 * folder (`resolve`, one answer per reference) and opens them in the text editor (`open`).
 */
export interface FileOpener {
  resolve(projectId: string, references: readonly string[]): Promise<readonly boolean[]>;
  open(projectId: string, reference: string): void;
}
export const FileRefs = createContext<FileOpener | null>(null);
/** The project whose folder file references in the text below are read against; none means no file links. */
export const FileRefProject = createContext<string | null>(null);
/** The references the desktop found, for the text being rendered. */
const FoundFiles = createContext<{ readonly projectId: string; readonly found: ReadonlySet<string> } | null>(null);

/** A found file reference as a link; `code` keeps the code look an unfound one has. */
function FileLink({ text }: { readonly text: string }) {
  const files = useContext(FileRefs), found = useContext(FoundFiles), reference = fileReference(text);
  if (!files || !found || !reference) return null;
  const click = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault(); event.stopPropagation();
    files.open(found.projectId, text);
  };
  return <a className="md-link md-file" href="#" title={fileLinkTitle(reference)} onClick={click}><code className="md-code md-ref">{text}</code></a>;
}

function Spans({ nodes, plain = false }: { readonly nodes: readonly Inline[]; /** Inside a link label: no links within links. */ readonly plain?: boolean }) {
  const open = useContext(LinkOpener), found = useContext(FoundFiles);
  const file = (text: string) => !plain && !!found?.found.has(text);
  return <>{nodes.map((node, index) => {
    if (typeof node === 'string') return <Fragment key={index}>{node}</Fragment>;
    switch (node.t) {
      // The newline after <br> renders as nothing but keeps the text's lines in copied and read text.
      case 'br': return <Fragment key={index}><br />{'\n'}</Fragment>;
      case 'code': return file(node.text) ? <FileLink key={index} text={node.text} /> : <code key={index} className="md-code">{node.text}</code>;
      case 'ref': return file(node.text) ? <FileLink key={index} text={node.text} /> : <code key={index} className="md-code md-ref">{node.text}</code>;
      // A path that is no file in the project was only ever words.
      case 'path': return file(node.text) ? <FileLink key={index} text={node.text} /> : <Fragment key={index}>{node.text}</Fragment>;
      case 'strong': return <strong key={index}><Spans nodes={node.children} plain={plain} /></strong>;
      case 'em': return <em key={index}><Spans nodes={node.children} plain={plain} /></em>;
      case 'del': return <del key={index}><Spans nodes={node.children} plain={plain} /></del>;
      case 'link': {
        const click = (event: MouseEvent<HTMLAnchorElement>) => {
          event.preventDefault(); event.stopPropagation();
          const href = safeHref(node.href);
          if (href) open(href);
        };
        return <a key={index} className="md-link" href={node.href} title={node.href} rel="noreferrer noopener" onClick={click}><Spans nodes={node.children} plain /></a>;
      }
    }
  })}</>;
}

function Blocks({ blocks }: { readonly blocks: readonly Block[] }): ReactNode {
  return blocks.map((block, index) => {
    switch (block.t) {
      case 'p': return <p key={index}><Spans nodes={block.children} /></p>;
      // Headings inside a message are emphasis, not document structure.
      case 'h': return <p key={index} className={`md-heading md-h${block.level}`}><strong><Spans nodes={block.children} /></strong></p>;
      case 'code': return <pre key={index} className="md-pre"><code>{block.text}</code></pre>;
      case 'quote': return <blockquote key={index}><Blocks blocks={block.children} /></blockquote>;
      case 'hr': return <hr key={index} />;
      case 'list': {
        const items = block.items.map((item, at) => <li key={at}><Blocks blocks={item} /></li>);
        return block.ordered ? <ol key={index} start={block.start === 1 ? undefined : block.start}>{items}</ol> : <ul key={index}>{items}</ul>;
      }
      case 'table': return <div key={index} className="md-table" role="region" aria-label="Table" tabIndex={0}><table>
        <thead><tr>{block.head.map((cell, at) => <th key={at} style={{ textAlign: block.align[at] ?? undefined }}><Spans nodes={cell} /></th>)}</tr></thead>
        <tbody>{block.rows.map((row, at) => <tr key={at}>{row.map((cell, column) =>
          <td key={column} style={{ textAlign: block.align[column] ?? undefined }}><Spans nodes={cell} /></td>)}</tr>)}</tbody>
      </table></div>;
    }
  });
}

/** Whether `text` reads as one paragraph, so it can sit inline (inside quotes or a sentence). */
export function singleParagraph(text: string): boolean {
  const { blocks, rest } = parseMarkdown(text);
  return !rest && blocks.length === 1 && blocks[0].t === 'p';
}

/**
 * Agent text as Markdown: paragraphs, line breaks, lists, quotes, code, tables, emphasis and safe links.
 * `inline` renders a one-paragraph text as a span, so short text keeps its line; longer text stays blocks.
 */
export function Markdown({ text, className, inline = false }: { readonly text: string; readonly className?: string; readonly inline?: boolean }) {
  const parsed = useMemo(() => parseMarkdown(text), [text]);
  const found = useFoundFiles(parsed.blocks);
  const name = className ? `md ${className}` : 'md', only = parsed.blocks[0];
  if (inline && !parsed.rest && parsed.blocks.length === 1 && only.t === 'p') return <FoundFiles.Provider value={found}><span className={name}><Spans nodes={only.children} /></span></FoundFiles.Provider>;
  return <FoundFiles.Provider value={found}><div className={name}>
    <Blocks blocks={parsed.blocks} />
    {parsed.rest && <p className="md-rest">{parsed.rest}</p>}
  </div></FoundFiles.Provider>;
}

/** The most distinct references asked about per text; the desktop answers no more at a time. */
const MAX_ASKED = 64;
/** Asks the desktop which file-shaped references in `blocks` are files of the item's project; until it answers, none are. */
function useFoundFiles(blocks: readonly Block[]): { readonly projectId: string; readonly found: ReadonlySet<string> } | null {
  const files = useContext(FileRefs), projectId = useContext(FileRefProject);
  const asked = useMemo(() => files && projectId ? fileReferences(blocks).slice(0, MAX_ASKED) : [], [files, projectId, blocks]);
  const key = asked.join('\n');
  const [answer, setAnswer] = useState<{ readonly projectId: string; readonly key: string; readonly found: ReadonlySet<string> } | null>(null);
  useEffect(() => {
    if (!files || !projectId || asked.length === 0) return;
    let live = true;
    files.resolve(projectId, asked).then(flags => {
      if (live) setAnswer({ projectId, key, found: new Set(asked.filter((_text, at) => flags[at] === true)) });
    }, () => {});
    return () => { live = false; };
  }, [files, projectId, key]); // `asked` is `key` split, so the key stands for it
  // An answer for other text or another project is stale until the new one arrives.
  return projectId && answer && answer.projectId === projectId && answer.key === key && answer.found.size > 0 ? answer : null;
}
