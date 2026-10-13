import { useState } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ItemRow, type ItemRowProps } from '../../../src/ui/tree/ItemRow';
import type { ItemRow as Row } from '../../../src/ui/tree/model';
import { ItemRefs, LinkOpener } from '../../../src/ui/shared/MarkdownText';
import { AppTransport, route } from '../app/transport';
import { shortLabel } from '../../../src/ui/shared/short';
import { TreeFonts, useTreeFonts } from '../../../src/ui/tree/fonts';

const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts);
  else Reflect.deleteProperty(document, 'fonts');
});

const text = (lines: number, separator = '\n') => Array.from({ length: lines }, (_, index) => `Line ${index + 1}`).join(separator);
const rectangle = (top: number, height = 21) => new DOMRect(0, top + 3, 120, height - 6);

/** Supply the text-node rectangles a native Range reports, independently of container height. */
function geometry(rects: (node: Node) => DOMRect[], lineHeight = () => 21) {
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    const range = new Range();
    let node: Node;
    range.selectNodeContents = target => { node = target; };
    range.getClientRects = () => Object.assign(rects(node), { item: (index: number) => rects(node)[index] ?? null });
    return range;
  });
  const computed = window.getComputedStyle;
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = document.createElement('span').style;
    style.cssText = computed(element, pseudo).cssText;
    if (element.closest('.tree-clamp')) { style.setProperty('line-height', `${lineHeight()}px`); style.setProperty('font-size', '14px'); }
    return style;
  });
  const bounds = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('tree-clamp') ? new DOMRect(0, 100, 400, 84) : bounds.call(this);
  });
  // A tall container is never itself evidence that seven text lines exist.
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(500);
}

function mount(body: string, extra: Partial<ItemRowProps> = {}) {
  const item = { ...new AppTransport().sessions.get(route.session_id)!.items['1']!, status: 'open' as const, outcome: body };
  const row: Row = { kind: 'item', key: 'item:1', item, status: 'open', ack: null, depth: 1, hasKids: false, expanded: false,
    context: false, guides: [], later: false, hidden: false, segments: [{ text: 'Complete question', hit: false }],
    replacedBy: null, rounds: 1, relatedCount: 0, collapsed: null, delivery: null, badge: 'Open' };
  const onSelect = vi.fn(), openItem = vi.fn(), openLink = vi.fn();
  function Harness() {
    const [unfolded, setUnfolded] = useState(false);
    const epoch = useTreeFonts();
    return <ItemRefs.Provider value={{ lookup: id => { const value = extra.row?.replacedBy; return value?.id === id ? { label: value.question, name: shortLabel(value), status: value.status } : null; }, onOpenItem: openItem }}><TreeFonts.Provider value={epoch}><LinkOpener.Provider value={openLink}><ItemRow row={row} selected={false} focused={true} note={null}
      actions={[]} answer={null} unfolded={unfolded} onUnfold={() => setUnfolded(value => !value)} remember={() => {}}
      onFocus={() => {}} onKeyDown={() => {}} onSelect={onSelect} onToggle={() => {}} {...extra} /></LinkOpener.Provider></TreeFonts.Provider></ItemRefs.Provider>;
  }
  const view = render(<Harness />);
  return { ...view, row, onSelect, openItem, openLink, preview: () => document.querySelector<HTMLElement>('.tree-preview')! };
}

describe('rendered preview lines', () => {
  it.each(['paragraphs', 'list', 'code'] as const)('never folds six real %s lines, despite gaps and padding', kind => {
    const body = kind === 'paragraphs' ? text(6, '\n\n') : kind === 'list' ? text(6).split('\n').map(line => `- ${line}`).join('\n') : `\`\`\`\n${text(6)}\n\`\`\``;
    geometry(node => {
      if (node.parentElement?.closest('pre')) return Array.from({ length: 6 }, (_, index) => rectangle(120 + index * 21));
      const index = Number(node.textContent?.match(/Line (\d+)/)?.[1]) - 1;
      return Number.isFinite(index) ? [rectangle(100 + index * 35)] : [];
    });
    const view = mount(body);
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    expect(view.preview().hasAttribute('data-clamped')).toBe(false);
    expect(document.querySelectorAll(kind === 'code' ? 'pre' : kind === 'list' ? 'li' : 'p')).toHaveLength(kind === 'code' ? 1 : 6);
  });

  it.each(['paragraphs', 'list', 'code'] as const)('folds seven %s lines at the complete fourth line boundary', kind => {
    const gap = kind === 'code' ? 18 : 29, inset = kind === 'code' ? 8 : 0;
    const body = kind === 'paragraphs' ? text(7, '\n\n') : kind === 'list' ? text(7).split('\n').map(line => `- ${line}`).join('\n') : `\`\`\`\n${text(7)}\n\`\`\``;
    geometry(node => {
      if (node.parentElement?.closest('pre')) return Array.from({ length: 7 }, (_, index) => rectangle(100 + inset + index * gap, gap));
      const index = Number(node.textContent?.match(/Line (\d+)/)?.[1]) - 1;
      return Number.isFinite(index) ? [rectangle(100 + index * gap)] : [];
    }, () => kind === 'code' ? 18 : 21);
    const view = mount(body), height = inset + 3 * gap + (kind === 'code' ? 18 : 21);
    expect(view.preview().hasAttribute('data-clamped')).toBe(true);
    expect(view.preview().style.getPropertyValue('--tree-clamp-height')).toBe(`${height}px`);
    expect(height).toBeLessThanOrEqual(inset + 4 * gap);
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(view.preview().hasAttribute('data-clamped')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(view.preview().hasAttribute('data-clamped')).toBe(true);
    expect(view.onSelect).not.toHaveBeenCalled();
  });

  it('counts emphasis, inline code and links sharing a line only once', () => {
    geometry(node => node.textContent?.trim() ? [rectangle(100)] : []);
    mount('**Bold** and `code` with [evidence](https://example.com).');
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('remeasures width and completed fonts while clipped, including a later font load', async () => {
    let count = 7, line = 21;
    const observers: { run: () => void; targets: Set<Element> }[] = [];
    vi.stubGlobal('ResizeObserver', class {
      targets = new Set<Element>();
      constructor(run: () => void) { observers.push({ run, targets: this.targets }); }
      observe(element: Element) { this.targets.add(element); }
      disconnect() { this.targets.clear(); }
    });
    const fonts = new EventTarget();
    let ready!: () => void;
    Object.defineProperty(fonts, 'ready', { value: new Promise<void>(resolveReady => { ready = resolveReady; }) });
    Object.defineProperty(document, 'fonts', { configurable: true, get: () => fonts });
    geometry(() => Array.from({ length: count }, (_, index) => rectangle(100 + index * line, line)), () => line);
    const view = mount('Body that wraps as the available width and fonts change.');
    expect(view.preview().style.getPropertyValue('--tree-clamp-height')).toBe('84px');
    count = 8; line = 25;
    act(() => observers.find(observer => observer.targets.has(document.querySelector('.tree-clamp')!))!.run());
    expect(view.preview().hasAttribute('data-clamped')).toBe(true);
    expect(view.preview().style.getPropertyValue('--tree-clamp-height')).toBe('100px');
    count = 6;
    await act(async () => { ready(); await Promise.resolve(); });
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    count = 7; line = 23;
    act(() => fonts.dispatchEvent(new Event('loadingdone')));
    expect(view.preview().hasAttribute('data-clamped')).toBe(true);
    expect(view.preview().style.getPropertyValue('--tree-clamp-height')).toBe('92px');
    view.unmount();
    expect(observers.every(observer => observer.targets.size === 0)).toBe(true);
  });

  it('keeps answer options and their complete text outside the folded body', () => {
    geometry(() => Array.from({ length: 7 }, (_, index) => rectangle(100 + index * 21)));
    const option = text(12);
    const view = mount(text(7), { answer: <div className="answer-full"><button className="answer-option">{option}</button></div> });
    expect(view.preview().hasAttribute('data-clamped')).toBe(true);
    const answer = screen.getByRole('button', { name: /Line 12/ });
    expect(answer.closest('.tree-preview')).toBeNull();
    expect(answer.textContent).toBe(option);
  });

  it('observes natural content height when direct text scaling leaves the clipped box size unchanged', () => {
    let line = 21;
    const observers: { run: () => void; targets: Set<Element> }[] = [];
    vi.stubGlobal('ResizeObserver', class {
      targets = new Set<Element>();
      constructor(run: () => void) { observers.push({ run, targets: this.targets }); }
      observe(element: Element) { this.targets.add(element); }
      disconnect() { this.targets.clear(); }
    });
    geometry(() => Array.from({ length: 7 }, (_, index) => rectangle(100 + index * line, line)), () => line);
    const view = mount(text(7));
    const excerpt = document.querySelector('.tree-clamp')!, content = document.querySelector('.tree-clamp-content')!;
    const observer = observers.find(observer => observer.targets.has(content))!;
    expect(observer).toBeDefined();
    expect(observer.targets.has(excerpt)).toBe(true);
    expect(view.preview().style.getPropertyValue('--tree-clamp-height')).toBe('84px');
    // The clip's mock bounds remain 84px; only its natural child's observer fires.
    line = 31.5;
    act(() => observer.run());
    expect(view.preview().hasAttribute('data-clamped')).toBe(true);
    expect(view.preview().style.getPropertyValue('--tree-clamp-height')).toBe('126px');
    expect(document.querySelectorAll('.tree-clamp-content.tree-clamp')).toHaveLength(0);
  });

  it.each([false, true])('unfolds focused links only when focus-visible is %s', keyboard => {
    geometry(() => Array.from({ length: 7 }, (_, index) => rectangle(100 + index * 21)));
    const view = mount('[Read the evidence](https://example.com)');
    const link = screen.getByRole('link', { name: 'Read the evidence' });
    const matches = link.matches.bind(link);
    vi.spyOn(link, 'matches').mockImplementation(selector => selector === ':focus-visible' ? keyboard : matches(selector));
    if (!keyboard) fireEvent.mouseDown(link);
    act(() => link.focus());
    expect(document.activeElement).toBe(link);
    expect(view.preview().hasAttribute('data-clamped')).toBe(!keyboard);
    fireEvent.click(link);
    expect(view.openLink).toHaveBeenCalledWith('https://example.com');
    expect(view.onSelect).not.toHaveBeenCalled();
    expect(view.preview().hasAttribute('data-clamped')).toBe(!keyboard);
  });

  it('uses the measured line boundary and preserves scaled preview typography', () => {
    const css = readFileSync(resolve(__dirname, '../../../src/ui/tree/tree.css'), 'utf8');
    expect(css).toContain('--tree-preview-line: calc(21px * var(--text-scale))');
    expect(css).toMatch(/\.tree-preview\[data-clamped\] \.tree-clamp\s*\{\s*max-height: var\(--tree-clamp-height\);\s*overflow: hidden;/);
    expect(css).toMatch(/\.tree-preview \.md-pre\s*\{\s*max-height: none;\s*overflow: visible;/);
  });

  it('displays the replacement as a short name reference with the complete question in its title', () => {
    const replacement = { ...new AppTransport().sessions.get(route.session_id)!.items['4']!, question: 'A complete replacement question that is much longer than the old short label'.repeat(3) };
    const base = mount(''); base.unmount();
    const row = { ...base.row, item: { ...base.row.item, status: 'replaced' as const }, replacedBy: replacement };
    const view = mount('', { row });
    const link = screen.getByRole('link', { name: shortLabel(replacement) });
    expect(link.textContent).toBe(shortLabel(replacement));
    expect(link.getAttribute('title')).toContain(replacement.question);
    fireEvent.click(link);
    expect(view.openItem).toHaveBeenCalledWith(replacement.id);
    expect(view.onSelect).not.toHaveBeenCalled();
  });
});
