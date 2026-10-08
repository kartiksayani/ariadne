// Agent-written text rendered from Markdown (ui/shared/markdown.ts) as React
// elements: no HTML strings, nothing injected. Links open in the system
// browser through LinkOpener; a click never navigates the app's window.
import { createContext, Fragment, useContext, useMemo, type MouseEvent, type ReactNode } from 'react';
import { parseMarkdown, safeHref, type Block, type Inline } from './markdown';
import './markdown.css';

/** Opens a checked external URL; the composition supplies the desktop's opener. */
export const LinkOpener = createContext<(url: string) => void>(() => {});

function Spans({ nodes }: { readonly nodes: readonly Inline[] }) {
  const open = useContext(LinkOpener);
  return <>{nodes.map((node, index) => {
    if (typeof node === 'string') return <Fragment key={index}>{node}</Fragment>;
    switch (node.t) {
      // The newline after <br> renders as nothing but keeps the text's lines in copied and read text.
      case 'br': return <Fragment key={index}><br />{'\n'}</Fragment>;
      case 'code': return <code key={index} className="md-code">{node.text}</code>;
      case 'ref': return <code key={index} className="md-code md-ref">{node.text}</code>;
      case 'strong': return <strong key={index}><Spans nodes={node.children} /></strong>;
      case 'em': return <em key={index}><Spans nodes={node.children} /></em>;
      case 'del': return <del key={index}><Spans nodes={node.children} /></del>;
      case 'link': {
        const click = (event: MouseEvent<HTMLAnchorElement>) => {
          event.preventDefault(); event.stopPropagation();
          const href = safeHref(node.href);
          if (href) open(href);
        };
        return <a key={index} className="md-link" href={node.href} title={node.href} rel="noreferrer noopener" onClick={click}><Spans nodes={node.children} /></a>;
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
  const name = className ? `md ${className}` : 'md', only = parsed.blocks[0];
  if (inline && !parsed.rest && parsed.blocks.length === 1 && only.t === 'p') return <span className={name}><Spans nodes={only.children} /></span>;
  return <div className={name}>
    <Blocks blocks={parsed.blocks} />
    {parsed.rest && <p className="md-rest">{parsed.rest}</p>}
  </div>;
}
