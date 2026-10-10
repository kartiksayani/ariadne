/** Owner-approved alpha.13 changes to the handoff's session bar and filters. */
export function sessionChrome(source: string): string {
  return source
    .replace('align-items:center; flex-wrap:wrap; gap:6px 12px; margin:10px 16px 0;', 'align-items:center; flex-wrap:nowrap; gap:6px 12px; margin:10px 16px 0;')
    .replace('<span style="font-weight:500;">{{ sb.title }}</span>', '<span title="{{ sb.title }}" style="flex:1; min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-weight:500;">{{ sb.title }}</span>')
    .replace('meta: `${curS.range} · ${curTopics', 'meta: `${curTopics')
    .replace('<i class="ph ph-x-circle" style="font-size:13px;"></i>Close session</button>', '<i class="ph ph-dots-three" style="font-size:13px;"></i></button>')
    .replace('onClick="{{ closeThisSession }}" title="Mark this session Closed in Ariadne. The agent process isn’t touched."', 'aria-label="Session actions" title="Session actions"')
    .replace(/<sc-for list="\{\{ statusChips \}\}"[^\n]+\n[^\n]+All topics[^\n]+/, `<button aria-label="Filter" title="Filter" style="position:relative; display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; padding:0; border:0; border-radius:7px; font-size:14px; color:{{ filterColor }}; background:{{ filterBackground }}; box-shadow:{{ filterRing }};"><i class="ph ph-funnel"></i><span style="position:absolute; top:3px; right:3px; width:5px; height:5px; border-radius:50%; background:currentColor; display:{{ filterDot }};"></span></button>`)
    .replace("filterDisplay: s.view === 'archive' || tabAll ? 'none' : 'flex',", `filterDisplay: s.view === 'archive' || tabAll ? 'none' : 'flex',
      filterColor: s.fStatus === 'all' ? 'color-mix(in srgb, var(--color-text) 74%, transparent)' : 'var(--color-accent)',
      filterBackground: s.fStatus === 'all' ? 'transparent' : 'color-mix(in srgb, var(--color-accent) 14%, transparent)',
      filterRing: s.fStatus === 'all' ? '0 0 0 1px var(--color-divider)' : '0 0 0 1px color-mix(in srgb, var(--color-accent) 55%, transparent)',
      filterDot: s.fStatus === 'all' ? 'none' : 'block',`);
}
