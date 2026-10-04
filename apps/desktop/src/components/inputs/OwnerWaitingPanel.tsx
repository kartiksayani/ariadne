import { useEffect } from 'react';
import { WaitingPanel, type WaitingPanelProps } from '../waiting/WaitingPanel';
import { useWaiting } from '../../selectors/waiting/store';
import { blockedDraft, OwnerDraftStore, useOwnerDrafts } from '../../state/drafts/store';

export function OwnerWaitingPanel({ drafts, ...props }: Omit<WaitingPanelProps, 'answerControl'> & { drafts: OwnerDraftStore }) {
  const state = useOwnerDrafts(drafts), waiting = useWaiting(props.store);
  useEffect(() => { void drafts.load(); }, [drafts]);
  useEffect(() => {
    if (!state.ready) return;
    for (const row of waiting.waiting) {
      const session = props.store.sessionState(row.route)?.snapshot?.session;
      if (session) drafts.begin(session, row.item.id, 'answer');
    }
  }, [drafts, state.ready, waiting.waiting, props.store]);
  return <>
    {waiting.waiting.map(row => {
      const entry = drafts.find(row.route, row.item.id, 'answer'), session = props.store.sessionState(row.route)?.snapshot?.session;
      if (!entry || !session || entry.receipt) return null;
      if (entry.uncertain) return <div role="status" key={entry.draft.op_id}>Item {row.item.id} · {entry.rejected ? 'Rejected before save' : 'Save completion is unknown'}. The saved contents are retained.
        <p style={{ whiteSpace: 'pre-wrap' }}>{entry.draft.text}</p>
        {entry.draft.selected_option_id && <p>Saved choice: {entry.draft.selected_option_id}</p>}
        <button type="button" disabled={entry.saving || state.preferenceUncertain} onClick={() => { void drafts.submit(entry.draft.op_id).then(saved => { if (saved) void props.store.refresh(); }); }}>Retry saved input · {row.item.id}</button>
        {entry.rejected && <button type="button" disabled={entry.saving || state.preferenceUncertain} onClick={() => drafts.prepareRevised(entry.draft.op_id, session)}>Prepare revised input · {row.item.id}</button>}
      </div>;
      if (entry.draft.target_revision === row.item.revision && entry.draft.question_revision === row.item.question_revision && entry.draft.binding_id === session.active_binding_id) return null;
      return <div role="alert" key={entry.draft.op_id}>Item {row.item.id} changed. Review the current question and options before sending.
        <button type="button" disabled={entry.saving || state.preferenceUncertain} onClick={() => drafts.review(entry.draft.op_id, session)}>Review current target · {row.item.id}</button></div>;
    })}
    <WaitingPanel {...props} answerControl={row => {
      const entry = drafts.find(row.route, row.item.id, 'answer'), session = props.store.sessionState(row.route)?.snapshot?.session;
      const blocked = entry && session ? blockedDraft(entry.draft, session) : 'Loading saved drafts…';
      return { options: entry?.uncertain || entry?.receipt ? [] : row.item.options, selected: entry?.uncertain || entry?.receipt ? null : entry?.draft.selected_option_id ?? null, draft: entry?.draft.text ?? '',
        noText: entry?.uncertain || !!entry?.receipt,
        saving: entry?.saving || state.preferenceUncertain, blocked: entry?.uncertain ? 'Use explicit retry to reconcile the retained input.' : blocked ?? undefined,
        warning: entry?.uncertain ? 'Save completion is unknown. Retry this exact saved input to confirm it.' : undefined,
        error: entry?.error?.message ?? state.error?.message,
        stateLabel: entry?.receipt ? 'Saved' : undefined,
        onSelect: id => { if (entry) drafts.edit(entry.draft.op_id, { selected_option_id: id }); },
        onDraft: text => { if (entry) drafts.edit(entry.draft.op_id, { text }); },
        onSubmit: () => { if (entry) void drafts.submit(entry.draft.op_id).then(saved => { if (saved) void props.store.refresh(); }); } };
    }} />
    {state.preferenceUncertain && <button type="button" onClick={() => { void drafts.retryPreferences(); }}>Retry saving draft preferences</button>}
  </>;
}
