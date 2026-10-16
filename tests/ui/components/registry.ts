// What the component gallery draws and what each frame is checked against. Plain data: the screenshot spec reads it
// in Node; frames.tsx holds the render function of each id (browser side).
export interface Zone {
  readonly selector: string;
  /** The element sits at this x in the design, in window pixels, when the app places it differently (an anchored popover). */
  readonly designX?: number;
  readonly designXNarrow?: number;
  /** The most pixels the zone may have with no match within one pixel in the design, as a ratio; the frame's limit by default. */
  readonly limit?: number;
}

export interface FrameMeta {
  readonly id: string;
  /** Board shot name without the -light / -dark / -light-900 suffix. */
  readonly shot: string;
  /** Elements compared with the same rectangle of the shot, by zone name. */
  readonly zones: Readonly<Record<string, string | Zone>>;
  /** The 900-wide frame has no counterpart for this frame. */
  readonly wideOnly?: boolean;
  /** The most pixels a zone may have with no match within one pixel in the design, as a ratio; the spec's default is 0.03. */
  readonly limit?: number;
}

export const sizeOf = (narrow: boolean) => narrow ? { width: 900, height: 650 } : { width: 1280, height: 800 };

const connection = (id: string, shot: string, line = true): FrameMeta => ({ id: `connection-${id}`, shot: `12-connection-${shot}`, zones: line ? { bar: '.tb', line: '.cl' } : { bar: '.tb' } });

export const registry: readonly FrameMeta[] = [
  { id: 'topbar', shot: '01-the-window-and-the-map-01-question-waiting', zones: { bar: '.tb' } },
  { id: 'topbar-search', shot: '08-finding-things-01-search-questions-and-outcomes', zones: { bar: '.tb', note: '.tb-search-note' } },
  { id: 'switcher', shot: '13-session-and-project-switcher-01-open', zones: { bar: '.tb', menu: '.swm' } },
  { id: 'switcher-typing', shot: '13-session-and-project-switcher-02-typing-finds-sessions-and-projects-by-na', zones: { bar: '.tb', menu: '.swm' } },
  // The card is anchored to its button, so it sits left of where the board draws it; it has Close session and Copy session ID
  // where the board has Disconnect, hence the wider limit.
  { id: 'connection-live', shot: '12-connection-01-live', zones: { bar: '.tb', card: { selector: '.cc', designX: 318, designXNarrow: 214, limit: 0.25 } } },
  { id: 'help-keys', shot: '16-help-behind-01-keys-grouped-by-what-im-doing', zones: { bar: '.tb', panel: '.hlp' } },
  { id: 'help-markers', shot: '16-help-behind-02-markers-and-statuses', zones: { bar: '.tb', panel: '.hlp' } },
  connection('none', '02-not-connected'),
  connection('off', '03-agent-not-running'),
  connection('closed', '04-session-closed'),
  connection('loading', '05-loading', false),
  connection('reconnect', '06-reconnecting'),
  connection('unreadable', '07-this-session-cant-be-read'),
  connection('stale', '08-showing-the-last-good-copy'),
  connection('unsaved', '09-your-last-change-may-not-be-saved'),
];
