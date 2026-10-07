// View model for the message rail, from Ariadne.dc.html renderVals (2193-2205).
// The excerpt itself is ui/shared/excerpt.

export function followButton(following: boolean): { readonly text: string; readonly icon: string; readonly color: string } {
  return following
    ? { text: 'Following latest', icon: 'ph ph-arrow-line-down', color: 'var(--a-acc-text)' }
    : { text: 'Follow latest', icon: 'ph ph-arrow-down', color: 'color-mix(in srgb, var(--color-text) 66%, transparent)' };
}

export const jumpText = (count: number) => `${count} new message${count > 1 ? 's' : ''} · Jump to latest`;
