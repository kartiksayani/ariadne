// The words and marks of each connection state: the top bar's dot, the card on click and the line above the Map
// (SPEC 5.12, table of 9 states). One place, so the three never disagree.
import type { ConnectionCardActions, ConnectionKind, ConnectionView } from './model';

export interface ConnectionBadge {
  /** A 7px dot: filled with a colour, or a hollow ring. */
  readonly dot?: { readonly color?: string; readonly ring?: boolean };
  readonly icon?: { readonly name: string; readonly color: string; readonly spin?: boolean };
  readonly label: string;
  /** The word beside the mark; the narrow bar drops it for Live. */
  readonly showLabel: boolean;
  readonly title: string;
}

const text = (percent: number) => `color-mix(in srgb, var(--color-text) ${percent}%, transparent)`;
const agentOf = (view: ConnectionView) => view.agent ?? 'The agent';
const whereOf = (view: ConnectionView) => view.where ?? view.agent ?? 'the agent';

/** The top bar's dot and word. */
export function connectionBadge(view: ConnectionView, narrow: boolean): ConnectionBadge {
  switch (view.kind) {
    case 'live': return { dot: { color: 'var(--st-done)' }, label: 'Live', showLabel: !narrow, title: `Connected · ${whereOf(view)}` };
    case 'loading': return { icon: { name: 'ph ph-circle-notch', color: 'var(--st-progress)', spin: true }, label: 'Connecting…', showLabel: true, title: `Connecting to ${agentOf(view)}…` };
    case 'none': return { icon: { name: 'ph ph-plugs', color: 'var(--st-open)' }, label: 'Not connected', showLabel: true, title: 'No agent is connected to this session' };
    case 'off': return { dot: { ring: true }, label: narrow ? 'Not running' : `${agentOf(view)} not running`, showLabel: true, title: `${agentOf(view)} isn’t running for this session` };
    case 'closed': return { icon: { name: 'ph ph-lock-simple', color: text(62) }, label: 'Closed', showLabel: true, title: 'This session is closed and read-only' };
    case 'reconnect': return { icon: { name: 'ph ph-circle-notch', color: 'var(--a-warn)', spin: true }, label: 'Reconnecting…', showLabel: true, title: `Lost the connection to ${agentOf(view)}; trying again` };
    case 'unreadable': return { icon: { name: 'ph ph-warning-circle', color: 'var(--a-danger)' }, label: narrow ? 'Can’t read' : 'Can’t read the session', showLabel: true, title: 'Ariadne can’t read this session’s file' };
    case 'stale': return { icon: { name: 'ph ph-clock-counter-clockwise', color: 'var(--a-warn)' }, label: narrow || !view.lastGoodAt ? 'Last good copy' : `Last good copy, ${view.lastGoodAt}`, showLabel: true, title: `Showing the last copy Ariadne could read${view.lastGoodAt ? `, from ${view.lastGoodAt}` : ''}` };
    case 'unsaved': return { dot: { color: 'var(--st-done)' }, icon: { name: 'ph ph-warning', color: 'var(--a-warn)' }, label: narrow ? 'Not saving' : 'Live · not saving', showLabel: true, title: 'Connected, but your last change may not be saved' };
  }
}

export interface CardCopy { readonly title: string; readonly lines: readonly string[] }

/**
 * The words for a conversation whose Ariadne plugin is not the app's version. They live here, in the app, because the old plugin
 * that most needs them can't learn new words; they say what to do whichever side is older.
 */
const MISMATCH = { title: 'This Claude session’s Ariadne plugin doesn’t match the app.', text: 'Run /reload-plugins there, then /ariadne-connect.' } as const;
/** Only where the agent isn't live: a connected session has, by being connected, a plugin that matches. */
const mismatched = (view: ConnectionView) => !!view.pluginMismatch && (view.kind === 'off' || view.kind === 'reconnect');

/** The card that opens from the dot. */
export function connectionCopy(view: ConnectionView): CardCopy {
  const copy = cardCopy(view);
  return mismatched(view) ? { ...copy, lines: [`${MISMATCH.title} ${MISMATCH.text}`, ...copy.lines] } : copy;
}

function cardCopy(view: ConnectionView): CardCopy {
  const where = whereOf(view), agent = agentOf(view);
  switch (view.kind) {
    case 'live': {
      const sending = view.sending, parts: string[] = [];
      if (view.lastMessageAt) parts.push(`Last message at ${view.lastMessageAt}.`);
      if (sending) {
        const on = sending.onItsWay, queued = sending.queued;
        const way = `${on} ${on === 1 ? 'answer is' : 'answers are'} on its way`, behind = `${queued} ${queued === 1 ? 'reply is' : 'replies are'} queued`;
        if (on && queued) parts.push(`Sending is on; ${way} and ${behind} behind it.`);
        else if (on) parts.push(`Sending is on; ${way}.`);
        else if (queued) parts.push(`Sending is on; ${behind}.`);
        else parts.push('Sending is on; nothing is waiting to go out.');
      } else parts.push('Sending is on.');
      return { title: 'Live', lines: [`Connected to ${where}.`, parts.join(' ')] };
    }
    case 'none': return { title: 'Not connected', lines: ['No agent is connected to this session. Answers you write wait here until one connects.'] };
    case 'off': return { title: `${agent} not running`, lines: [`${view.lastSeenAt ? `Last seen at ${view.lastSeenAt} in ${where}. ` : ''}What you send waits and goes out once when it runs again.`] };
    case 'closed': return { title: 'Closed', lines: [`${view.closedAt ? `You closed this session today at ${view.closedAt}. ` : ''}It’s read-only.`] };
    case 'loading': return { title: 'Connecting…', lines: [`Looking for ${where}.`] };
    case 'reconnect': return { title: 'Reconnecting…', lines: [`The connection to ${where} ${view.droppedAt ? `dropped at ${view.droppedAt}` : 'dropped'}. Ariadne tries again every few seconds.`, 'What you send waits here and goes out once, when it’s back.'] };
    case 'unreadable': return { title: 'Can’t read this session', lines: [view.corrupt
      ? 'The session file ends partway through a line, so Ariadne can’t build the Map. Nothing in the file was changed.'
      : 'Ariadne can’t read this session right now, so it can’t build the Map. Nothing in the file was changed.'] };
    case 'stale': return { title: 'Showing the last good copy', lines: [`${view.lastGoodAt ? `Ariadne last read this session at ${view.lastGoodAt}. ` : ''}Newer changes couldn’t be read; it keeps trying.`] };
    case 'unsaved': return { title: 'Your last change may not be saved', lines: [`Connected to ${where}.`, `Ariadne isn’t sure your last change was saved${view.unsavedAt ? ` (noticed at ${view.unsavedAt})` : ''}. It checks again when you press Try again.`] };
  }
}

export interface LineCopy { readonly icon: string; readonly color: string; readonly title: string; readonly text: string }

/** The line above the Map for a state that changes what I can do; Live and Loading draw none. */
export function connectionLine(view: ConnectionView): LineCopy | null {
  if (mismatched(view)) return { icon: 'ph ph-plugs', color: 'var(--a-warn)', ...MISMATCH };
  const agent = agentOf(view);
  switch (view.kind) {
    case 'none': return { icon: 'ph ph-plugs', color: 'var(--st-open)', title: 'No agent is connected to this session.', text: 'You can read the Map and write answers; they wait here until one connects.' };
    case 'off': return { icon: 'ph ph-pause-circle', color: 'var(--st-open)', title: `${agent} isn’t running for this session.`, text: 'What you send is queued and goes out once, when it runs again.' };
    case 'closed': if (view.archived) return { icon: 'ph ph-lock-simple', color: text(62), title: 'This session is archived.',
      text: 'It’s read-only. Restore it, then reopen it to answer; the questions that were waiting are still here.' };
      return { icon: 'ph ph-lock-simple', color: text(62), title: 'This session is closed.', text: 'It’s read-only. Reopen it to answer; the questions that were waiting are still here.' };
    case 'reconnect': return { icon: 'ph ph-circle-notch', color: 'var(--a-warn)', title: `Reconnecting to ${agent}…`, text: `${view.droppedAt ? `The connection dropped at ${view.droppedAt}.` : 'The connection dropped.'} What you send waits here and goes out once, when it’s back.` };
    case 'unreadable': {
      const kept = 'Nothing in the file was changed, and Ariadne tries again when it changes.';
      return { icon: 'ph ph-warning-circle', color: 'var(--a-danger)', ...view.corrupt
        ? { title: 'This session can’t be read.', text: `Its file ends partway through ${view.unreadableLine ? `line ${view.unreadableLine.toLocaleString('en-US')}` : 'a line'}, so there’s no Map to show. ${kept}` }
        : { title: 'This session can’t be read right now.', text: kept } };
    }
    case 'stale': return { icon: 'ph ph-clock-counter-clockwise', color: 'var(--a-warn)', title: `Showing the last good copy${view.lastGoodAt ? `, from ${view.lastGoodAt}` : ''}.`, text: 'Newer changes in the session couldn’t be read. You can read the Map; answers wait until it can be read again.' };
    case 'unsaved': return { icon: 'ph ph-warning', color: 'var(--a-warn)', title: 'Ariadne isn’t sure your last change was saved.', text: 'It checks again when you press Try again.' };
    case 'live': case 'loading': return null;
  }
}

/** `copy` is set on a copy button: it resolves to whether the write landed, and the button says so. */
export interface ConnAction { readonly key: string; readonly icon: string; readonly label: string; readonly run: () => void; readonly copy?: () => Promise<boolean> }

const make = (key: string, icon: string, label: string, run: (() => void) | undefined): ConnAction[] => run ? [{ key, icon, label, run }] : [];
/** A closed session is reopened; an archived one (also closed) is restored, which is what its button does. */
const comeBack = (view: ConnectionView, run: (() => void) | undefined) => view.archived
  ? make('restore', 'ph ph-arrow-u-up-left', 'Restore session', run) : make('reopen', 'ph ph-arrow-u-up-left', 'Reopen session', run);

/** The buttons of the card: what fits the state first, then Close or Reopen, then Copy session ID. Only what the caller can do is drawn. */
export function cardActions(view: ConnectionView, a: ConnectionCardActions): ConnAction[] {
  const sending = make('sending', 'ph ph-paper-plane-tilt', 'Sending…', a.onSending);
  const again = make('again', 'ph ph-arrows-clockwise', 'Try again', a.onTryAgain);
  const own: ConnAction[] = ({
    live: sending,
    none: make('connect', 'ph ph-info', 'How to connect', a.onHowToConnect),
    off: sending,
    closed: comeBack(view, a.onReopen),
    loading: [],
    reconnect: make('again', 'ph ph-arrows-clockwise', 'Try now', a.onTryAgain),
    unreadable: [...again, ...make('file', 'ph ph-folder-simple', 'Show the file', a.onShowFile)],
    stale: again,
    // The Sending dialog stays one press away: Pause and Resume wait, but the owner may still read how sending stands.
    unsaved: [...again, ...sending],
  } satisfies Record<ConnectionKind, ConnAction[]>)[view.kind];
  const close = view.kind === 'closed' || view.kind === 'loading' ? [] : make('close', 'ph ph-x-circle', 'Close session', a.onClose);
  const copyId: ConnAction[] = a.onCopyId ? [{ key: 'copy-id', icon: 'ph ph-copy', label: 'Copy session ID', run: () => { void a.onCopyId?.(); }, copy: a.onCopyId }] : [];
  return [...own, ...close, ...copyId];
}

/** The buttons of the line above the Map. */
export function lineActions(view: ConnectionView, a: ConnectionCardActions): ConnAction[] {
  switch (view.kind) {
    case 'off': return make('sending', 'ph ph-paper-plane-tilt', 'Sending…', a.onSending);
    case 'closed': return comeBack(view, a.onReopen);
    case 'reconnect': return make('again', 'ph ph-arrows-clockwise', 'Try now', a.onTryAgain);
    case 'unreadable': return [...make('again', 'ph ph-arrows-clockwise', 'Try again', a.onTryAgain), ...make('file', 'ph ph-folder-simple', 'Show the file', a.onShowFile)];
    case 'stale': return make('again', 'ph ph-arrows-clockwise', 'Try again', a.onTryAgain);
    case 'unsaved': return [...make('again', 'ph ph-arrows-clockwise', 'Try again', a.onTryAgain), ...make('folder', 'ph ph-folder-simple', 'Show folder', a.onShowFolder)];
    default: return [];
  }
}
