interface Line { top: number; bottom: number }

/** Measure text lines, rather than counting Markdown margins and code padding as text. */
export function measurePreviewLines(excerpt: HTMLElement, visibleLines: number): { lines: number; height: number } {
  const rectangles: Line[] = [];
  const walker = document.createTreeWalker(excerpt, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    const parent = node.parentElement;
    if (!parent) continue;
    const style = getComputedStyle(parent);
    const fontSize = parseFloat(style.fontSize) || 14;
    const lineHeight = style.lineHeight.endsWith('px') ? parseFloat(style.lineHeight)
      : (parseFloat(style.lineHeight) || 1.5) * fontSize;
    range.selectNodeContents(node);
    // Layout-less hosts have no text rectangles; they cannot establish a clamp.
    if (typeof range.getClientRects !== 'function') continue;
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      const leading = Math.max(0, lineHeight - rect.height) / 2;
      rectangles.push({ top: rect.top - leading, bottom: rect.bottom + leading });
    }
  }
  rectangles.sort((a, b) => a.top - b.top);
  const lines: Line[] = [];
  for (const rect of rectangles) {
    const line = lines.at(-1);
    // Emphasis, links and inline code yield separate rectangles on the same line.
    if (line && Math.min(line.bottom, rect.bottom) - Math.max(line.top, rect.top) > 1) {
      line.top = Math.min(line.top, rect.top);
      line.bottom = Math.max(line.bottom, rect.bottom);
    } else lines.push({ ...rect });
  }
  const boundary = lines[visibleLines - 1]?.bottom ?? 0;
  return { lines: lines.length, height: Math.max(0, boundary - excerpt.getBoundingClientRect().top) };
}
