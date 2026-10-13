/** Owner-approved M1 navigation chrome, applied to the original handoff data. */
export function gettingAroundChrome(source: string): string {
  return source
    // Text size adds one 32px control and the header's existing 14px gap.
    .replace('    <button class="btn btn-secondary btn-icon" onClick="{{ toggleTheme }}"',
      '    <button class="btn btn-secondary btn-icon" aria-label="Text size" title="Text size (⌘− smaller, ⌘+ or ⌘= larger, ⌘0 default)" style="width:32px; height:32px; flex:none;">Aa</button>\n    <button class="btn btn-secondary btn-icon" onClick="{{ toggleTheme }}"')
    .replace('<div style="align-items:center; flex-wrap:wrap; gap:6px; padding:10px 16px 8px; display:{{ filterDisplay }};">',
      `<sc-if value="{{ showGettingAround }}"><div data-map-recent style="display:flex; flex:none; align-items:center; min-width:0; gap:8px; padding:4px 16px 0;">
        <nav aria-label="Your recent trail" style="display:flex; flex:1; align-items:center; gap:12px; box-sizing:border-box; height:28px; min-width:0; padding:0 8px; overflow:hidden; font-size:12px;">
          <div style="display:flex; flex:1; flex-wrap:nowrap; gap:6px; min-width:0; overflow:hidden;"><sc-for list="{{ mapTrail }}" as="v"><span style="display:flex; align-items:center; min-width:0; max-width:24ch;"><sc-if value="{{ v.separator }}"><span aria-hidden="true" style="margin-right:6px; opacity:.5;">›</span></sc-if><button title="{{ v.question }}" style="min-width:0; padding:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; color:color-mix(in srgb, var(--color-text) 62%, transparent); background:transparent; border:0; cursor:pointer; font:inherit;">{{ v.name }} <small>· {{ v.action }}</small></button></span></sc-for></div>
          <sc-if value="{{ hasMapNext }}"><button title="{{ mapNextQuestion }}" style="flex:0 1 auto; max-width:28ch; min-width:0; padding:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; color:color-mix(in srgb, var(--color-text) 62%, transparent); background:transparent; border:0; cursor:pointer; font:inherit;">Next: {{ mapNextName }} <span aria-hidden="true">→</span></button></sc-if>
        </nav><button class="btn btn-ghost" title="Recent (⌘E)" style="flex:none; font-size:12px;">Recent</button>
      </div></sc-if>
      <div style="align-items:center; flex-wrap:wrap; gap:6px; padding:10px 16px 8px; display:{{ filterDisplay }};">`)
    .replace('<div ref="{{ scrollRef }}" style="flex:1; min-height:0; overflow:auto; position:relative; padding-bottom:40px;">',
      `<sc-if value="{{ showMapAncestors }}"><nav aria-label="Map ancestors" style="display:flex; flex:none; align-items:center; gap:4px; height:28px; min-width:0; padding:0 16px; overflow:hidden; white-space:nowrap; font-size:12px;"><sc-for list="{{ mapAncestors }}" as="a"><span style="display:inline-flex; align-items:center; min-width:0; gap:4px;"><sc-if value="{{ a.separator }}"><span aria-hidden="true"> › </span></sc-if><button title="{{ a.question }}" style="min-width:0; padding:0; border:0; border-radius:4px; font:inherit; font-size:12px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; cursor:pointer; color:var(--a-acc-text); background:transparent;">{{ a.name }}</button></span></sc-for></nav></sc-if>
      <div ref="{{ scrollRef }}" onScroll="{{ rememberMapAncestors }}" style="flex:1; min-height:0; overflow:auto; position:relative; padding-bottom:40px;">`)
    .replace('const counts = [];', `const counts = [];
        const ackCount = t.archived || this.isReadOnly(all[0] || { topic: t.id }) ? 0 : all.filter(it =>
          ['finding', 'explanation'].includes(it.type) && ['open', 'progress'].includes(it.status)
          && (it.ack_to || it.ackTo) && (!(it.ask || '').trim() || s.subs[it.id] && s.subs[it.id].stage !== 'failed')).length;`)
    .replace('isTopic: true, isItem: false, name: t.name, counts,', 'isTopic: true, isItem: false, name: t.name, counts, ackCount, hasAckAll: ackCount > 0,')
    .replace(/(<sc-for list="\{\{ r.counts \}\}"[^\n]+?<\/sc-for>)/,
      '$1<sc-if value="{{ r.hasAckAll }}"><button title="Ack read-only findings and explanations in this topic" style="flex:none; padding:2px 6px; border:1px solid var(--color-divider); border-radius:4px; background:transparent; color:var(--a-acc-text); font:inherit; font-size:11.5px; cursor:pointer;">Ack all ({{ r.ackCount }})</button></sc-if>')
    .replace('isTopic: false, isItem: true, item: it,', 'isTopic: false, isItem: true, item: it, canFocus: !it.parent,')
    // Opening a restored selection is not a visit. Only deliberate navigation
    // records one, matching the gallery's initially empty recent_items preference.
    .replace('return { sel: id, exp, detail:', `return { sel: id, exp,
        mapRecent: it ? [{ id, action: 'viewed' }, ...(s.mapRecent || []).filter(entry => entry.id !== id)].slice(0, 15) : s.mapRecent,
        detail:`)
    .replace('  renderVals() {', `  mapLabel(it) {
    if (it.short && it.short.trim()) return it.short.trim();
    const text = it.q.trim(); if (text.length <= 24) return text;
    const cut = text.slice(0, 25), space = cut.lastIndexOf(' ');
    return (space > 8 ? cut.slice(0, space) : cut.slice(0, 24)).replace(/[\\s,.;:·–—-]+$/, '') + '…';
  }
  rememberMapAncestors = () => {
    const box = this.scrollRef.current; if (!box || this.state.view !== 'tree') return;
    const top = box.getBoundingClientRect().top;
    const first = [...box.querySelectorAll('[data-item-id]')].find(el => el.getBoundingClientRect().bottom > top);
    const ids = first ? this.ancestorsOf(this.state.items, first.dataset.itemId).slice(-3)
      .filter(it => { const el = box.querySelector('[data-item-id="' + it.id + '"]'); return !el || el.getBoundingClientRect().top < top; }).map(it => it.id) : [];
    const before = this.state.mapAncestorIds || [];
    if (ids.length !== before.length || ids.some((id, index) => id !== before[index])) this.setState({ mapAncestorIds: ids });
  };
  renderVals() {`)
    .replace('      statusChips,', `      showGettingAround: !loading && !tabAll && s.view === 'tree',
      showMapAncestors: !tabAll && s.view === 'tree',
      mapTrail: (s.mapRecent || []).filter(entry => m[entry.id] && this.topics.some(t => t.id === m[entry.id].topic && this.inTab(t)))
        .slice(0, 3).map((entry, index) => ({ name: this.mapLabel(m[entry.id]), question: m[entry.id].q, action: entry.action, separator: index > 0 })),
      hasMapNext: !!mapNext, mapNextName: mapNext ? this.mapLabel(mapNext) : '', mapNextQuestion: mapNext ? mapNext.q : '',
      mapAncestors: (s.mapAncestorIds || []).filter(id => m[id]).map((id, index) => ({ name: this.mapLabel(m[id]), question: m[id].q, separator: index > 0 })),
      rememberMapAncestors: this.rememberMapAncestors,
      statusChips,`)
    .replace('const actionableItems = ordered.filter(i => this.isActionable(i));', `const actionableItems = ordered.filter(i => this.isActionable(i));
    const mapNext = actionableItems.find(it => this.topics.some(t => t.id === it.topic && this.inTab(t)));`);
}

export function gettingAroundItemChrome(source: string): string {
  return source
    .replace('    <sc-if value="{{ showCollapsed }}">', `    <sc-if value="{{ showRootFocus }}"><button aria-label="Focus" style="align-self:flex-start; box-sizing:border-box; height:24px; min-width:0; padding:2px 5px; border:0; border-radius:4px; font:inherit; font-size:12px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; cursor:pointer; color:var(--a-acc-text); background:transparent; box-shadow:inset 0 0 0 1px var(--color-divider);">Focus</button></sc-if>
    <sc-if value="{{ showCollapsed }}">`)
    .replace('      r, it,', '      r, it, showRootFocus: !!r.canFocus && !it.parent,');
}
