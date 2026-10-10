/** The graph's compact legend and card headings in the handoff runtime. */
export function graphChrome(source: string): string {
  return source
    // The runtime wraps the name in an inline span. Blockify that wrapper so its
    // fractional line height matches the app's direct text, without an extra strut.
    .replace('<span style="font-size:14.5px; font-weight:500; letter-spacing:-0.01em;">{{ gg.name }}</span>',
      '<span style="display:flex; font-size:14.5px; font-weight:500; letter-spacing:-0.01em;">{{ gg.name }}</span>')
    .replace('flex-wrap:wrap; gap:6px 18px; padding:6px 16px 8px 20px;', 'flex-wrap:nowrap; gap:6px 18px; padding:6px 16px 8px 20px;')
    .replace(/<span style="display:inline-flex; align-items:center; gap:7px;">(<span style="width:18px; height:2px;[^\n]+?<\/span>)Thread to the selected item<\/span>/,
      '<span aria-label="Thread to the selected item" title="Thread to the selected item" style="display:inline-flex; min-width:0; align-items:center; gap:7px;">$1<span style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">Thread</span></span>\n            <span aria-label="Related to the selected item" title="Related to the selected item" style="display:inline-flex; min-width:0; align-items:center; gap:7px;"><svg style="flex:none; width:22px; height:6px; overflow:visible;"><path d="M0 3 H22" style="fill:none; stroke:color-mix(in srgb, var(--color-text) 36%, transparent); stroke-width:1.25; stroke-dasharray:6 5;"></path></svg><span style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">Related</span></span>')
    .replace(/<span style="display:inline-flex; align-items:center; gap:7px;">(<span style="(?:width:18px; height:0;|width:12px; height:12px;)[^"\n]+"><\/span>)(Replaced by|Waiting on me|Closed)<\/span>/g,
      '<span style="display:inline-flex; min-width:0; align-items:center; gap:7px;">$1<span style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">$2</span></span>')
    .replace(/(style="display:inline-flex; min-width:0; align-items:center; gap:7px;"><span style=")/g, '$1flex:none; ')
    .replace('<span>One graph per topic</span>', '<span style="flex-shrink:3; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">One graph per topic</span>')
    .replace('onClick="{{ revealSelected }}" disabled="{{ noSel }}" style="margin-left:auto;',
      'onClick="{{ revealSelected }}" disabled="{{ noSel }}" style="flex-shrink:0; white-space:nowrap; margin-left:auto;');
}
