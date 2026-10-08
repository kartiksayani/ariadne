import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { RailExcerpt } from '../../../src/ui/shared/MessageExcerpt';
import { Markdown } from '../../../src/ui/shared/MarkdownText';

// The agent's line breaks reach the screen: stored text is kept as written, Markdown turns bullets into
// lists. Tree excerpts compact those blocks until expanded; message rail previews retain their breaks.
afterEach(cleanup);
const css = (path: string) => readFileSync(resolve(__dirname, '../../../src', path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const declarations = (file: string, selector: string) => [...css(file).matchAll(/([^{}]+)\{([^}]*)\}/g)]
  .filter(([, rule]) => rule!.split(',').some(part => part.trim() === selector)).map(([, , body]) => body!).join(';');

describe('line breaks in agent text', () => {
  const bullets = 'Done:\n- one\n- two\n- three';

  it('are kept in the text of a message preview and laid out as written', () => {
    const { container } = render(<RailExcerpt id="m1" view={{ number: '#1', author: 'agent', who: 'Agent', icon: 'ph ph-robot', when: '15:04', body: bullets }}
      active={false} highlight={false} onHover={() => {}} onPin={() => {}} />);
    expect(container.querySelector('.pw-excerpt-text')?.textContent).toBe(bullets);
    expect(declarations('ui/shared/shared.css', '.pw-excerpt-text')).toMatch(/white-space:\s*pre-line/);
  });

  it('compact excerpt blocks until expanded while titles keep their authored breaks', () => {
    expect(declarations('ui/tree/tree.css', '.tree-question')).toMatch(/white-space:\s*pre-line/);
    const { container, rerender } = render(<Markdown text={bullets} compact className="tree-clamp" />);
    expect(container.textContent).toBe('Done: · one · two · three');
    expect(container.querySelector('br,li')).toBeNull();
    rerender(<Markdown text={bullets} className="tree-clamp" />);
    expect([...container.querySelectorAll('li')].map(li => li.textContent)).toEqual(['one', 'two', 'three']);
  });

  it('become a list in the detail panel and the waiting cards, in a one-paragraph slot too', () => {
    const { container } = render(<Markdown text={bullets} />);
    expect([...container.querySelectorAll('li')].map(li => li.textContent)).toEqual(['one', 'two', 'three']);
    cleanup();
    const slot = render(<Markdown text={'First line\nsecond line'} inline />);
    expect(slot.container.querySelectorAll('br')).toHaveLength(1);
    expect(slot.container.textContent).toBe('First line\nsecond line');
  });
});
