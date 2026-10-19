// Prop types of the redesign's top bar and its popovers (contract C8). Pure data: the components keep no store.
// `R` is the caller's own session route; the components only hand it back through callbacks.
import type { ReactNode } from 'react';
import type { ShellTheme } from '../shell/model';
import type { TextSize } from '../shell/textScale';

/** Windows narrower than this use the narrow bar (icon-only controls, a "…" menu). The board draws 1280 and 900. */
export const NARROW_BELOW = 1100;

/** Where the agent stands for a session; the dot by the session name says it (SPEC 5.12). */
export type ConnectionKind = 'live' | 'loading' | 'none' | 'off' | 'closed' | 'reconnect' | 'unreadable' | 'stale' | 'unsaved';

export type RunState = 'live' | 'off' | 'closed';

export interface SwitcherQuestion { readonly itemId: string; readonly title: string; /** "12 min" */ readonly since?: string }

export interface SwitcherSession<R> {
  readonly route: R;
  readonly name: string;
  /** "Claude Code", "Codex" */
  readonly agent?: string;
  readonly running: boolean;
  readonly closed?: boolean;
  /** "yesterday", shown as "closed yesterday" */
  readonly closedWhen?: string;
  readonly current?: boolean;
  /** Questions waiting on me in this session; listed under the row for sessions other than the current one. */
  readonly waiting: readonly SwitcherQuestion[];
}

export interface SwitcherProject<R> {
  readonly id: string;
  readonly name: string;
  /** The project of the session on screen: listed first, labelled "this project". */
  readonly current?: boolean;
  readonly sessions: readonly SwitcherSession<R>[];
}

export type PageName = 'projects' | 'sessions' | 'archive';

export interface SwitcherMenuProps<R> {
  readonly projects: readonly SwitcherProject<R>[];
  /** What is typed when it opens (tests and the gallery); empty otherwise. */
  readonly initialQuery?: string;
  /** A session row, or one of its waiting questions (`itemId`). */
  readonly onOpenSession: (session: SwitcherSession<R>, projectId: string, itemId?: string) => void;
  readonly onOpenPage: (page: PageName) => void;
  /** Esc, a press outside, or after a choice. */
  readonly onClose: () => void;
}

export interface ConnectionView {
  readonly kind: ConnectionKind;
  /** "Claude Code in iTerm window 1" */
  readonly where?: string;
  /** "21:25" */
  readonly lastMessageAt?: string;
  /** "20:58" */
  readonly lastSeenAt?: string;
  /** "21:24", the copy shown while the session can't be read */
  readonly lastGoodAt?: string;
  /** "21:30" */
  readonly droppedAt?: string;
  /** "21:33", when the owner closed the session */
  readonly closedAt?: string;
  /** Closed because it is archived: its button restores it ("Restore session") instead of reopening it. */
  readonly archived?: boolean;
  /** "21:31", when Ariadne first noticed it wasn't sure the last change was saved */
  readonly unsavedAt?: string;
  /** Set when the last change may not be saved while another state is on show (the top bar's dot says only one thing): the line adds the report under that state's line. */
  readonly unsavedToo?: boolean;
  /** Set when the file is cut off (core's `corrupt_session`): only then do the words say it ends partway through a line. */
  readonly corrupt?: boolean;
  /** The line the session file ends partway through. */
  readonly unreadableLine?: number;
  /** "Claude Code" */
  readonly agent?: string;
  /** Answers on their way and replies queued behind them (Live card). */
  readonly sending?: { readonly onItsWay: number; readonly queued: number };
}

export interface ConnectionCardActions {
  /** Opens the dispatch dialog (Live, Not running). */
  readonly onSending?: () => void;
  readonly onHowToConnect?: () => void;
  /** Try again / Try now: checks the pending save, re-reads the session, or reconnects, whichever the state is about. */
  readonly onTryAgain?: () => void;
  /** The same for the unsaved-change report when it sits under another state's line (`unsavedToo`). */
  readonly onTryAgainUnsaved?: () => void;
  readonly onShowFile?: () => void;
  readonly onShowFolder?: () => void;
  /** Close the session (read-only until reopened). */
  readonly onClose?: () => void;
  readonly onReopen?: () => void;
  /** Copies the session reference; resolves to whether the write landed. The button says "Copied" only when it did. */
  readonly onCopyId?: () => Promise<boolean>;
  /** The "How to connect" steps of the line above the Map: copy `/ariadne-connect`, or the Codex setup instruction. Each resolves to whether the write landed. */
  readonly onCopyCommand?: () => Promise<boolean>;
  readonly onCopyInstruction?: () => Promise<boolean>;
}

export interface ConnectionCardProps {
  readonly view: ConnectionView;
  readonly actions: ConnectionCardActions;
  /** Esc or a press outside. */
  readonly onDismiss: () => void;
}

export interface ConnectionLineProps {
  readonly view: ConnectionView;
  readonly actions: ConnectionCardActions;
  /** The command to run in the agent's conversation; the line shows it in its steps. */
  readonly command?: string;
  /** "How to connect" / "Hide steps" (Not connected). Leave it out and the line keeps its own state; pass it so the card's "How to connect" can open the same steps. */
  readonly steps?: { readonly open: boolean; readonly onToggle: () => void };
}

export interface SearchView {
  readonly active: boolean;
  readonly query: string;
  /** "2 of 4" or "No matches" */
  readonly count?: string;
  readonly onOpen: () => void;
  readonly onQuery: (query: string) => void;
  /** Match stepping; absent when the search only filters (no arrows are drawn). */
  readonly onNext?: () => void;
  readonly onPrev?: () => void;
  readonly onClear: () => void;
  /** A line under the box: "Also matching: 1 in a hidden item." with an action. */
  readonly note?: { readonly text: string; readonly action: string; readonly onAction: () => void };
}

export interface TopBarProps {
  readonly narrow: boolean;
  /** 'first-run' draws only the mark, "No projects yet", and Aa / theme / ?. 'page' marks Archive active via `archive.active` and shows the waiting chip. */
  readonly variant?: 'session' | 'page' | 'first-run';
  /** "notes-sdk"; shown wide only. */
  readonly project?: string;
  readonly sessionName: string;
  /** Questions waiting on me in other sessions: the chip in the switcher button. */
  readonly otherWaiting: number;
  readonly switcherOpen: boolean;
  readonly onSwitcherToggle: () => void;
  readonly connection?: ConnectionView;
  readonly connectionOpen?: boolean;
  readonly onConnectionToggle?: () => void;
  /** The ConnectionCard, drawn under the connection button when it is open. */
  readonly connectionCard?: ReactNode;
  /** Pages only: unsent waiting questions in this session. */
  readonly waitingHere?: number;
  readonly onWaitingHere?: () => void;
  readonly search: SearchView;
  readonly view: 'tree' | 'graph';
  readonly onView: (view: 'tree' | 'graph') => void;
  /** Statuses picked in the filter; the badge shows the number, `active` tints the button. */
  readonly filter: { readonly active: boolean; readonly count: number; readonly onToggle: () => void };
  readonly recent: { readonly active: boolean; readonly onToggle: () => void };
  readonly archive: { readonly active: boolean; readonly onOpen: () => void };
  readonly textSize: TextSize;
  readonly onTextSizeChange: (size: TextSize) => void;
  readonly theme: ShellTheme;
  readonly onToggleTheme: () => void;
  readonly help: { readonly open: boolean; readonly onToggle: () => void };
  readonly disabled?: boolean;
  /** The switcher alone; defaults to `disabled`. It stays usable during a write: a choice queues as the newest navigation. */
  readonly switcherDisabled?: boolean;
}
