// One owner submission for one item and intent: answer, reply, note, followup,
// drop, bring or reopen. The durable draft store keeps the draft and the exact
// operation; this hook adds the guards and wording the controls show.
import { useEffect } from 'react';
import type { ItemRoute } from '../../generated/core';
import type { ConnectionState, Session } from '../../generated/domain/models';
import type { Immutable } from '../../data/session-store';
import { blockedDraft, emptyDraft, ownerActions, useOwnerDrafts, type DraftEntry, type OwnerDraftStore, type OwnerIntent } from '../../state/drafts/store';
import { agentName } from '../shell/model';

/** A keyboard request to open the input for an intent, optionally choosing option `optionIndex`. */
export interface OwnerFocusRequest { intent: OwnerIntent; token: number; optionIndex?: number }

/** A send held because the session's agent is not running (handoff 1ad). */
export interface PendingSubmission {
  readonly route: ItemRoute;
  readonly intent: OwnerIntent;
  /** The chosen option's label or the message text. */
  readonly label: string;
  /** The agent that is not running, e.g. "codex". */
  readonly agent: string;
  /** Queues the saved draft for that agent; resolves true once the input is saved. */
  readonly queue: () => Promise<boolean>;
}

export interface SubmitOptions {
  readonly drafts: OwnerDraftStore;
  readonly session: Immutable<Session> | null | undefined;
  /** False while the session read is stale or failed: sending is blocked. */
  readonly current: boolean;
  readonly itemId: string;
  readonly intent: OwnerIntent;
  /** Called instead of sending when the agent is not running; without it the send queues. */
  readonly onAgentNotRunning?: (submission: PendingSubmission) => void;
  /** Called after a validated input receipt. */
  readonly onSaved?: () => void;
}

export interface Submit {
  readonly entry: DraftEntry | undefined;
  /** The item changed since the draft was written; it must be reviewed first. */
  readonly changed: boolean;
  /** Why the draft cannot be sent now, in the handoff's words where it has them. */
  readonly blocked: string | null;
  /** A send or a save is in flight or must be reconciled first. */
  readonly locked: boolean;
  readonly connection: ConnectionState | null;
  readonly agent: string;
  readonly preferenceUncertain: boolean;
  readonly error: string | null;
  select: (optionId: string | null) => void;
  write: (text: string) => void;
  /** Sends the option only. */
  sendOption: (optionId: string) => void;
  /** Sends the text only, never with an option. */
  sendText: (text: string) => void;
  /** Sends the draft as written (non-answer intents). */
  send: () => void;
  /** Replays the exact attempted operation, or resends after a definite failure. */
  retry: () => Promise<boolean>;
  review: () => void;
  prepareRevised: () => void;
  another: () => void;
  retryPreferences: () => void;
}

const stale = 'The session is unavailable or stale. Refresh before sending.';

export function useSubmit({ drafts, session, current, itemId, intent, onAgentNotRunning, onSaved }: SubmitOptions): Submit {
  const state = useOwnerDrafts(drafts);
  const route = session ? { project_id: session.project_id, session_id: session.id } : null;
  const entry = route ? drafts.find(route, itemId, intent) : undefined;
  const item = session?.items[itemId];
  const eligible = !!item && ownerActions(item).includes(intent);
  useEffect(() => { if (!drafts.getSnapshot().ready) void drafts.load(); }, [drafts]);
  useEffect(() => {
    if (session && eligible && state.ready && !entry) drafts.begin(session, itemId, intent);
  }, [drafts, session, eligible, itemId, intent, state.ready, entry]);
  const binding = session?.active_binding_id ? session.bindings[session.active_binding_id] ?? null : null;
  const connection = binding?.connection_state ?? null, agent = binding ? agentName(binding.adapter_id) : 'the agent';
  const draft = entry?.draft;
  const changed = !!draft && !!item && !!session && (item.revision !== draft.target_revision || item.question_revision !== draft.question_revision
    || session.active_binding_id !== draft.binding_id);
  // An untouched draft follows a revised question; only owner content needs a deliberate review.
  const pristine = changed && !!entry && !entry.saving && !entry.uncertain && !entry.receipt && !draft!.text && draft!.selected_option_id === null;
  useEffect(() => { if (pristine && session && entry) drafts.review(entry.draft.op_id, session); }, [pristine, session, entry, drafts]);
  const guard = draft && session ? blockedDraft(draft, session) : null;
  const blocked = !session || !draft ? null : !current ? stale
    : session.state !== 'active' && intent === 'answer' ? 'This session is closed. Reopen it to answer.'
      : connection === 'reconnecting' ? `Reconnecting to ${agent}. Your choice is kept; sending resumes when the connection is back.`
        : guard === emptyDraft ? null : guard;
  const locked = !entry || entry.saving || entry.uncertain || state.preferenceUncertain;
  const submit = () => entry ? drafts.submit(entry.draft.op_id).then(saved => { if (saved) onSaved?.(); return saved; }) : Promise.resolve(false);
  const dispatch = (label: string) => {
    if (!route) return;
    if (connection !== 'connected' && onAgentNotRunning) onAgentNotRunning({ route: { ...route, item_id: itemId }, intent, label, agent, queue: submit });
    else void submit();
  };
  const ready = () => !!entry && !locked && !changed && !blocked;
  return {
    entry, changed, blocked, locked, connection, agent, preferenceUncertain: state.preferenceUncertain,
    error: entry?.error?.message ?? state.error?.message ?? null,
    select: optionId => { if (entry && !locked) drafts.edit(entry.draft.op_id, { selected_option_id: optionId }); },
    write: text => { if (entry && !locked) drafts.edit(entry.draft.op_id, { text }); },
    sendOption: optionId => {
      const option = item?.options.find(value => value.id === optionId);
      if (!entry || !option || !ready()) return;
      drafts.edit(entry.draft.op_id, { selected_option_id: option.id, text: '' }); dispatch(option.label);
    },
    sendText: text => {
      if (!entry || !text.trim() || !ready()) return;
      drafts.edit(entry.draft.op_id, { selected_option_id: null, text }); dispatch(text);
    },
    send: () => { if (entry && ready() && guard !== emptyDraft) dispatch(entry.draft.text); },
    retry: () => entry && !entry.saving && !state.preferenceUncertain && (entry.uncertain || entry.error) ? submit() : Promise.resolve(false),
    review: () => { if (entry && session) drafts.review(entry.draft.op_id, session); },
    prepareRevised: () => { if (entry && session) drafts.prepareRevised(entry.draft.op_id, session); },
    another: () => { if (entry && session) drafts.another(entry.draft.op_id, session); },
    retryPreferences: () => { void drafts.retryPreferences(); },
  };
}
