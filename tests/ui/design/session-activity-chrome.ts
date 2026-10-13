/** Alpha.15 keeps messages without an item in a collapsed disclosure above the Map. */
export function sessionActivityChrome(source: string): string {
  const disclosure = `<details class="session-activity" style="padding:8px 12px; font-size:13px;">
    <summary style="cursor:pointer;">Session activity · {{ sessionActivityCount }}</summary>
    <ol aria-label="Session activity" style="margin:8px 0 0; padding-left:20px;">
      <sc-for list="{{ sessionActivity }}" as="message"><li style="padding:8px 0;">
        <p style="margin:4px 0; white-space:pre-wrap; overflow-wrap:anywhere;">{{ message.excerpt }}</p>
      </li></sc-for>
    </ol>
  </details>`;
  return source
    .replace('<sc-if value="{{ showMapAncestors }}">', `<sc-if value="{{ showTreeActivity }}"><div style="display:flex; flex:none; flex-direction:column; gap:8px; max-height:30%; margin:0 16px 8px; overflow:auto;">${disclosure}</div></sc-if>
      <sc-if value="{{ showArchiveActivity }}">${disclosure}</sc-if>
      <sc-if value="{{ showMapAncestors }}">`)
    .replace("const curMsgs = msgsV.filter(x => (x.session || 's2') === s.tab);", `const curMsgs = msgsV.filter(x => (x.session || 's2') === s.tab);
    const sessionActivity = curMsgs.filter(message => !items.some(item => item.created === message.number
      || item.updated.includes(message.number) || (item.rounds || []).some(round => (round.msgs || []).includes(message.number))));`)
    .replace('const inViewerTab = !tabAll;', `const inViewerTab = !tabAll;
    const hasSessionActivity = inViewerTab && !loading && !first && sessionActivity.length > 0;`)
    .replace('rootRef: this.rootRef, searchRef: this.searchRef, scrollRef: this.scrollRef,', `showTreeActivity: hasSessionActivity && s.view !== 'archive',
      showArchiveActivity: hasSessionActivity && s.view === 'archive',
      sessionActivityCount: sessionActivity.length, sessionActivity,
      rootRef: this.rootRef, searchRef: this.searchRef, scrollRef: this.scrollRef,`);
}
