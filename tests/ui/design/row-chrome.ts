/** The owner's compact action columns, keeping the original handoff's content. */
export function itemRowChrome(source: string): string {
  return source
    .replace('<div role="treeitem"', '<div role="treeitem" data-item-id="{{ it.id }}"')
    .replace('flex:none; display:flex; align-items:center; gap:8px; height:22px;', 'flex:none; display:flex; flex-direction:column; align-items:flex-end; gap:4px;')
    .replace('<span style="display:flex; align-items:center; gap:1px;">', '<span style="display:grid; grid-template-rows:repeat(2, auto); grid-auto-flow:column; grid-auto-columns:max-content; gap:1px; visibility:{{ actionVisibility }}; opacity:{{ actionOpacity }};">')
    .replace(/ {4}<span style="font-family:ui-monospace[^\n]+\n/, '')
    .replace(/ {4}<dc-import name="Status Badge" status="\{\{ it.status \}\}" label="\{\{ badgeLabel \}\}"[^\n]+\n/, '')
    .replace(/( {4}<div style="font-size:15px;[^\n]+<\/div>)/,
      '<div style="display:flex; align-items:flex-start; flex-wrap:wrap; gap:4px 8px; min-width:0;">$1<span style="display:inline-flex; align-items:center; padding-top:2px;"><dc-import name="Status Badge" status="{{ it.status }}" label="{{ badgeLabel }}" variant="text" hint-size="80px,22px"></dc-import></span></div>')
    .replace('style="font-size:15px; line-height:22px;', 'style="flex:1 1 12ch; min-width:0; font-size:15px; line-height:22px;')
    .replace('showActions: (sel || hov) && !!(r.actions && r.actions.length),', `showActions: !!(r.actions && r.actions.length),
      actionVisibility: sel || hov ? 'visible' : 'hidden',
      actionOpacity: sel || hov ? 1 : 0,`);
}

export function topicRowChrome(source: string): string {
  return source
    // The app restores a selected row with detail open, then Escape/a opens its inline
    // answer without scrolling. Replay that opening here rather than centering the final editor.
    .replace('sel, detail: detail && !!sel, reveal,', 'sel, detail: !!props.answering || detail && !!sel, reveal,')
    .replace('answering: props.answering || null,', 'answering: null,')
    .replace('[400, 1200, 2500].forEach(t => setTimeout(() => this.scrollToSel(true), t));', `if (this.props.answering) {
      document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!this.rootRef.current) return;
        this.scrollToSel(true);
        this.setState({ detail: false, answering: this.props.answering }, () => {
          requestAnimationFrame(() => requestAnimationFrame(() => {
            if (this.rootRef.current) this.rootRef.current.dataset.inlineAnswerReady = 'true';
          }));
        });
      })));
    } else {
      [400, 1200, 2500].forEach(t => setTimeout(() => this.scrollToSel(true), t));
    }`)
    .replace("nameColor: earlier ? neutral(82) : 'var(--color-text)',", "nameColor: earlier ? 'color-mix(in srgb, var(--a-acc-text) 82%, transparent)' : 'var(--a-acc-text)',")
    .replace('<div style="display:flex; align-items:center; gap:6px; min-width:0;">', '<div style="display:flex; flex-wrap:wrap; align-items:center; gap:6px; min-width:0;">')
    .replace('<span style="min-width:0; padding-left:4px; font-size:15.5px;', '<span style="flex:1 1 12em; min-width:0; padding-left:4px; font-size:15.5px;')
    .replace('<span style="display:flex; gap:2px;"><sc-for list="{{ r.actions }}"', '<span style="display:grid; grid-template-rows:repeat(2, auto); grid-auto-flow:column; grid-auto-columns:max-content; gap:2px; visibility:{{ r.actionVisibility }}; opacity:{{ r.actionOpacity }};"><sc-for list="{{ r.actions }}"')
    .replace('title="{{ a.title }}" style="display:inline-flex; align-items:center; gap:5px; height:24px; padding:0 7px;', 'title="{{ a.title }}" aria-label="{{ a.label }}" style="display:grid; place-items:center; width:26px; height:22px; padding:0;')
    .replace('</i>{{ a.label }}</button>', '</i></button>')
    .replace('list="{{ r.counts }}" as="c"><span style="display:inline-flex; align-items:center; gap:4px;"', 'list="{{ r.counts }}" as="c"><span style="display:inline-flex; align-items:center; gap:4px; white-space:nowrap;"')
    .replace(/(<sc-for list="\{\{ r.counts \}\}"[^\n]+)(\s*<\/span>\s*<\/div>)/,
      '$2\n                    <div style="display:flex; flex-wrap:wrap; align-items:center; gap:4px 12px; padding-left:26px; font-size:12px; color:color-mix(in srgb, var(--color-text) 62%, transparent);">$1</div>')
    .replace('showActions: (selT || s.hoverItem === t.id) && !tsub, actions: acts,', `showActions: !tsub && acts.length > 0, actions: acts,
          actionVisibility: selT || s.hoverItem === t.id ? 'visible' : 'hidden',
          actionOpacity: selT || s.hoverItem === t.id ? 1 : 0,`);
}
