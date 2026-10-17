// Prop types of the redesign's pages, first-run view and dialogs (contract C8). Pure data in, callbacks out.
// `R` is the caller's own session route; the components only hand it back through callbacks.
import type { ReactNode } from 'react';
import type { RunState } from '../topbar/model';

export interface PageSession<R> {
  readonly route: R;
  /** The session's id, set on its name button as data-session-id: the stable handle tests and the e2e driver use. */
  readonly id?: string;
  readonly name: string;
  /** "Claude Code", "Codex" */
  readonly agent: string;
  readonly run: RunState;
  /** Questions waiting on me in it. */
  readonly waiting: number;
  readonly current?: boolean;
  /** "Live · iTerm window 1", "Not running · 1 queued", "Closed yesterday 18:05" */
  readonly status?: string;
}

export interface PageBack { readonly label: string; readonly onBack: () => void }

export interface ProjectCardData<R> {
  readonly id: string;
  readonly name: string;
  /** "~/code/notes-sdk" */
  readonly path: string;
  readonly current?: boolean;
  readonly waiting: number;
  readonly sessions: readonly PageSession<R>[];
  /** "3 sessions · 2 open · last activity 21:25"; for an empty project "Last activity 12 Sep". */
  readonly footer: string;
  /** Shown when the project has no sessions: "No sessions. Its last one, “landing copy”, is in Archive." */
  readonly emptyText?: string;
}

export interface ProjectsCardsProps<R> {
  /** Absent when there is no session to go back to. */
  readonly back?: PageBack;
  /** "4 projects · 5 questions waiting on you" */
  readonly sub: string;
  readonly projects: readonly ProjectCardData<R>[];
  /** The card, or its name. */
  readonly onOpenProject: (project: ProjectCardData<R>) => void;
  /** One of the card's session rows. */
  readonly onOpenSession: (project: ProjectCardData<R>, session: PageSession<R>) => void;
  readonly onRegister: () => void;
  readonly onDiscover: () => void;
  readonly onRemoveProject: (project: ProjectCardData<R>) => void;
}

export type SessionsTab = 'open' | 'closed' | 'all';

export interface SessionGroupData<R> {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly sessions: readonly PageSession<R>[];
  /** Shown instead of rows when the group has none. */
  readonly empty?: { readonly title: string; readonly text: string; readonly action?: { readonly label: string; readonly onClick: () => void } };
}

export interface SessionsListProps<R> {
  readonly narrow: boolean;
  /** Absent when there is no session to go back to. */
  readonly back?: PageBack;
  readonly title: string;
  /** "6 sessions in 3 projects" */
  readonly sub: string;
  /** Omit on a single project's page: no tabs. */
  readonly tabs?: { readonly value: SessionsTab; readonly counts: Readonly<Record<SessionsTab, number>>; readonly onChange: (tab: SessionsTab) => void };
  readonly groups: readonly SessionGroupData<R>[];
  /** Under the page head, above the groups: the card of a session that just connected. */
  readonly notes?: ReactNode;
  /** After the groups, inside the page column: page notes and links. */
  readonly children?: ReactNode;
  readonly onOpen: (session: PageSession<R>) => void;
  readonly onRename: (session: PageSession<R>) => void;
  /** Greyed ("Already closed") on a closed row: Reopen is on the opened session's connection card. */
  readonly onClose: (session: PageSession<R>) => void;
  readonly onArchive: (session: PageSession<R>) => void;
}

export interface ArchiveRowData {
  readonly id: string;
  readonly kind: 'session' | 'topic';
  readonly name: string;
  /** "notes-api · Claude Code · 4 topics · 31 items" */
  readonly sub: string;
  /** "Archived 3 Oct" */
  readonly when: string;
  /** Restored in this visit: the row reads "Restored, closed" (session) or "Back in the Map" (topic). */
  readonly restored?: boolean;
}

export interface ArchiveListProps {
  /** Absent when there is no session to go back to. */
  readonly back?: PageBack;
  /** "3 sessions · 1 topic" */
  readonly sub: string;
  readonly sessions: readonly ArchiveRowData[];
  readonly topics: readonly ArchiveRowData[];
  readonly onRestore: (row: ArchiveRowData) => void;
  /** The row's name: open it to read, as it is (a topic opens the session it came from). Restore stays its own button. Omit and the name is plain text. */
  readonly onOpen?: (row: ArchiveRowData) => void;
  /** The row's "…" menu: remove it from Ariadne. Omit and the "…" is not drawn. */
  readonly onRemove?: (row: ArchiveRowData) => void;
}

export interface FirstRunProps {
  /** The command to run in the Claude Code conversation. */
  readonly command: string;
  readonly onCopyCommand: () => void;
  readonly onCopyInstruction: () => void;
}

export interface WaitingHereChipProps {
  readonly count: number;
  readonly narrow: boolean;
  readonly onGo: () => void;
}

export interface NameSessionDialogProps {
  /** What the session shows as until named, e.g. "the Claude Code session from today 14:02". */
  readonly unnamedAs: string;
  readonly initialName?: string;
  readonly initialDescription?: string;
  readonly nameMax?: number;
  readonly descriptionMax?: number;
  /** Set while the save is in flight, or the reason it failed. */
  readonly busy?: boolean;
  readonly error?: string;
  readonly onSave: (value: { readonly name: string; readonly description: string }) => void;
  readonly onCancel: () => void;
}

export interface RegisterProjectDialogProps {
  readonly initialPath?: string;
  readonly busy?: boolean;
  readonly error?: string;
  readonly onRegister: (path: string) => void;
  readonly onCancel: () => void;
}

export interface RemoveProjectDialogProps {
  readonly name: string;
  readonly path: string;
  readonly sessionCount: number;
  /** Questions waiting on me in it; they go too, unanswered. */
  readonly waitingCount: number;
  readonly busy?: boolean;
  readonly error?: string;
  readonly onRemove: () => void;
  readonly onCancel: () => void;
}
