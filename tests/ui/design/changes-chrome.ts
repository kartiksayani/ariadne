/** Alpha.14.4's intentional Map additions, rendered from the handoff's own facts.
 * The archive has no change ledger; existing records start caught up. App-only M2
 * frames exercise New/changed markers, comparison cards, attribution and Undo.
 */
export function changesChrome(source: string): string {
  // Gallery captures use text_scale: 100; 12px / the card's 0.8 base is 15px.
  const surface = 'padding:10px 12px; border:1px solid var(--a-guide); border-radius:var(--radius-md); background:var(--a-card); font-size:15px; line-height:1.6; overflow-wrap:anywhere;';
  const link = 'border:0; background:transparent; padding:3px 0; color:var(--a-acc-text); text-align:left; font:inherit; cursor:pointer; overflow-wrap:anywhere;';
  const topic = `<sc-if value="{{ r.showBrief }}"><div data-m2-topic="{{ r.key }}" style="margin:8px 16px 12px 32px;">
    <section aria-label="Topic brief" style="${surface}">
      <button type="button" aria-expanded="true" style="${link} display:inline-block; margin-right:6px;">Topic brief <i class="ph ph-caret-down" aria-hidden="true"></i></button>
      <sc-for list="{{ r.briefLists }}" as="group"><div style="display:flex; gap:10px; margin-top:6px;">
        <strong style="flex:0 0 70px; font-weight:500;">{{ group.label }}</strong>
        <ul style="flex:1; min-width:0; padding:0; margin:0; list-style:none;">
          <sc-if value="{{ group.empty }}"><li style="color:var(--a-label);">{{ group.emptyText }}</li></sc-if>
          <sc-for list="{{ group.names }}" as="name"><li>
            <sc-if value="{{ name.replaced }}"><del><button style="${link}">{{ name.label }}</button></del><span style="color:var(--a-label);"> replaced by </span><button style="${link}">{{ name.replacement }}</button></sc-if>
            <sc-if value="{{ name.ordinary }}"><button style="${link}">{{ name.label }}</button></sc-if>
          </li></sc-for>
        </ul>
      </div></sc-for>
    </section>
    <section aria-label="Since you were here" style="${surface} margin-top:8px;"><span style="color:var(--a-label);">All caught up</span></section>
  </div></sc-if>`;
  return source
    .replace('                <sc-if value="{{ r.isItem }}">', `                ${topic}\n                <sc-if value="{{ r.isItem }}">`)
    .replace('isTopic: true, isItem: false, name: t.name, counts,', `isTopic: true, isItem: false, name: t.name, counts,
          showBrief: r.expanded,
          briefLists: ['Decided', 'Your turn', 'Replaced'].map(label => {
            const status = { Decided: 'decided', 'Your turn': 'waiting', Replaced: 'replaced' }[label];
            const names = all.filter(it => it.status === status && (label !== 'Your turn' || this.sessById(s.tab)?.status !== 'closed')).map(it => ({
              label: it.short || it.q, replaced: label === 'Replaced', ordinary: label !== 'Replaced',
              replacement: m[it.replacedBy] ? m[it.replacedBy].short || m[it.replacedBy].q : 'an unavailable item'
            }));
            return { label, names, empty: !names.length, emptyText: label === 'Your turn' ? 'No questions waiting on you' : 'None yet' };
          }),`);
}
