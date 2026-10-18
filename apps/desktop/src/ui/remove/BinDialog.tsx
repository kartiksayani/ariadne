// The bin (10.11) and Empty the bin (10.1), E30 and E31. The bin holds only what the agent removed: one dialog, two
// openers. The band's "…" opens "The bin for “T”" (that topic's removed items); a removed-topic strip or notice opens
// "The bin for this session" (its removed topics). The owner's words in it are quoted with Copy; Restore keeps the
// held-message confirmation; Empty quotes every word it deletes, then deletes at once. A topic continued in another
// session stays in the bin (E34).
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Immutable } from '../../data/session-store';
import type { SessionRef } from '../../generated/core';
import type { Session } from '../../generated/domain/models';
import type { SessionActions } from '../../components/bindings/actions';
import type { OwnerDraftStore } from '../../state/drafts/store';
import { removedRoots, removedSubtree } from '../../selectors/removed';
import { DialogActions, DialogButton, DialogError, DialogFrame, DialogList, DialogListRow, DialogQuote, DialogText, DialogTitle } from '../dialogs/DialogFrame';
import { notices } from '../pages/notices';
import { OutlineButton } from '../parts/parts';
import { agentName, clock } from '../shell/model';
import { toasts } from '../shell/toast';
import { shortLabel } from '../shared/short';
import { binView, useRestoreConfirmation } from './AgentBin';
import type { RemovalQueue } from './queue';
import { topicScope, itemScope, wordsInScope, wordsLabel, type FamilyCheck, type WordsEntry } from './words';
import '../dialogs/remove-dialog.css';

type Placed = { readonly kind: 'item'; readonly item: { readonly project_id: string; readonly session_id: string; readonly item_id: string } }
  | { readonly kind: 'topic'; readonly session: SessionRef; readonly topic_id: string };
interface BinEntry {
  readonly key: string;
  readonly topicId: string;
  readonly itemId: string | null;
  readonly name: string;
  /** The item and what's below it, or the topic's items. */
  readonly count: number;
  readonly removedAt: number | null;
  readonly cancelled: number;
  readonly words: readonly WordsEntry[];
  readonly target: Placed;
}
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** The bin's entries: a topic's removed items, or the session's removed topics. */
export function binEntries(session: Immutable<Session>, topicId: string | null, drafts: Parameters<typeof wordsInScope>[1]): readonly BinEntry[] {
  const route = { project_id: session.project_id, session_id: session.id };
  const cancelledIn = (words: readonly WordsEntry[]) => words.filter(entry => entry.kind === 'input' && entry.state === 'cancelled').length;
  if (topicId) return removedRoots(session, topicId).map(item => {
    const words = wordsInScope(session, drafts, itemScope(session, item.id));
    return { key: item.id, topicId, itemId: item.id, name: shortLabel(item), count: removedSubtree(session, item.id).length,
      removedAt: item.removed_at ? Date.parse(item.removed_at) : null, cancelled: cancelledIn(words), words,
      target: { kind: 'item', item: { ...route, item_id: item.id } } };
  });
  return Object.values(session.topics).flatMap(topic => {
    if (!topic?.removed_at) return [];
    const words = wordsInScope(session, drafts, topicScope(topic.id));
    return [{ key: topic.id, topicId: topic.id, itemId: null, name: topic.short?.trim() || topic.name,
      count: Object.values(session.items).filter(item => item?.topic_id === topic.id).length, removedAt: Date.parse(topic.removed_at), cancelled: cancelledIn(words), words,
      target: { kind: 'topic', session: route, topic_id: topic.id } }];
  });
}

/** "3 items in all · removed by Claude Code at 21:19 · 1 message of yours was cancelled". */
export function binSub(entry: Pick<BinEntry, 'count' | 'removedAt' | 'cancelled'>, agent: string): string {
  return [entry.count > 1 ? `${entry.count} items in all` : null, `removed by ${agent}${entry.removedAt !== null ? ` at ${clock(entry.removedAt)}` : ''}`,
    entry.cancelled ? `${plural(entry.cancelled, 'message')} of yours ${entry.cancelled === 1 ? 'was' : 'were'} cancelled` : null].filter(Boolean).join(' · ');
}

/** 10.1's lead: what is deleted for good, and the owner's words with it. */
export function emptyText(count: number, words: readonly WordsEntry[]): string {
  const items = `The ${count === 1 ? 'removed item' : `${count} removed items`} in it ${count === 1 ? 'is' : 'are'} deleted for good`;
  if (!words.length) return `${items}. This can’t be undone.`;
  const cancelled = words.every(entry => entry.kind === 'input' && entry.state === 'cancelled');
  const what = words.length === 1 ? 'one message of yours' : `${words.length} messages of yours`;
  return `${items}, along with ${what}${cancelled ? ` that ${words.length === 1 ? 'was' : 'were'} cancelled when they were removed` : ', quoted below'}. This can’t be undone.`;
}

type Open = { readonly topicId: string | null; readonly step: 'bin' | 'empty' };

export function BinDialog({ session, route, actions, queue, drafts }: {
  readonly session: Immutable<Session>; readonly route: SessionRef; readonly actions: SessionActions;
  readonly queue: RemovalQueue | null; readonly drafts: OwnerDraftStore;
}) {
  const request = useSyncExternalStore(binView.subscribe, binView.getSnapshot);
  const draftState = useSyncExternalStore(drafts.subscribe, drafts.getSnapshot);
  const [open, setOpen] = useState<Open | null>(null);
  const [restored, setRestored] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [families, setFamilies] = useState<ReadonlyMap<string, FamilyCheck> | 'checking' | null>(null);
  const confirmation = useRestoreConfirmation(actions);
  // Asked for by the owner (the band's "…" menu, a strip, a notice's "Open the bin"): open once.
  useEffect(() => {
    const wanted = binView.take(route);
    if (!wanted) return;
    setOpen({ topicId: wanted.topicId, step: 'bin' }); setRestored(new Set()); setError(null); setFamilies(null);
  }, [request, route]);
  const topicId = open?.topicId ?? null;
  const entries = useMemo(() => open ? binEntries(session, topicId, draftState) : [], [open, session, topicId, draftState]);
  const entryKeys = entries.map(entry => entry.key).join('|');
  // E34: a removed topic continued in another session stays in the bin; the check runs when the session's bin opens.
  useEffect(() => {
    if (!open || topicId !== null || !queue) return undefined;
    let current = true;
    const topics = entries.flatMap(entry => { const topic = session.topics[entry.topicId]; return topic ? [topic] : []; });
    if (!topics.length) { setFamilies(new Map()); return undefined; }
    setFamilies('checking');
    void Promise.all(topics.map(async topic => [topic.id, await queue.family(topic, session)] as const)).then(checked => { if (current) setFamilies(new Map(checked)); });
    return () => { current = false; };
  // The check is for the topics in the bin when it opens or they change, not for every session revision.
  }, [open !== null, topicId, entryKeys, queue]);
  if (!open) return null;
  const binding = session.active_binding_id ? session.bindings[session.active_binding_id] : null;
  const agent = binding ? agentName(binding.adapter_id) : 'the agent';
  const topicName = topicId ? session.topics[topicId]?.name ?? 'this topic' : null;
  const familyOf = (entry: BinEntry) => entry.itemId === null && families !== null && families !== 'checking' && families.get(entry.topicId)?.family;
  const eligible = entries.filter(entry => !restored.has(entry.key) && (entry.itemId !== null || families !== null && families !== 'checking' && !familyOf(entry)));
  const close = () => { if (!busy) { setOpen(null); confirmation.confirmation?.resolve(false); } };

  if (confirmation.confirmation) {
    const count = confirmation.confirmation.count;
    return <DialogFrame label="Restore work" onCancel={() => confirmation.confirmation?.resolve(false)}>
      <DialogTitle>Restore work</DialogTitle>
      <DialogText>Restoring this work makes {plural(count, 'held message')} visible again. {count === 1 ? 'It will' : 'They will'} send when sending can resume.</DialogText>
      {/* Each step's buttons mount afresh, so its autoFocus button takes focus. */}
      <DialogActions key="restore">
        <DialogButton kind="ghost" kbd="esc" onClick={() => confirmation.confirmation?.resolve(false)}>Cancel</DialogButton>
        <DialogButton kind="primary" autoFocus onClick={() => confirmation.confirmation?.resolve(true)}>Restore</DialogButton>
      </DialogActions>
    </DialogFrame>;
  }

  if (open.step === 'empty') {
    const words = eligible.flatMap(entry => entry.words);
    const back = () => { if (!busy) setOpen({ ...open, step: 'bin' }); };
    const deleteForGood = async () => {
      if (!queue || busy || !eligible.length) return;
      setBusy(true);
      try {
        const result = await queue.deleteNow(eligible.map(entry => entry.target));
        if (result.deleted.length) toasts.show({ text: `Deleted the ${result.deleted.length === 1 ? 'removed item' : `${result.deleted.length} removed items`} for good.` });
        for (const failure of result.failed) {
          const entry = eligible.find(value => value.target === failure.target);
          notices.push({ id: `bin-empty:${entry?.key ?? Math.random()}`, icon: 'ph ph-warning-circle', tone: 'problem',
            text: `Couldn’t delete “${entry?.name ?? 'an item'}” for good. ${failure.error} It’s still in the bin.` });
        }
      } finally { setBusy(false); setOpen(value => value && { ...value, step: 'bin' }); }
    };
    const title = topicName ? `Empty the bin for “${topicName}”?` : 'Empty the bin for this session?';
    const kept = entries.filter(entry => !restored.has(entry.key) && familyOf(entry)).length;
    return <DialogFrame label={title} onCancel={back}>
      <DialogTitle>{title}</DialogTitle>
      <DialogText>{emptyText(eligible.length, words)}</DialogText>
      {kept > 0 && <DialogText>{kept === 1 ? 'One topic continues' : `${kept} topics continue`} in another session and {kept === 1 ? 'stays' : 'stay'} in the bin.</DialogText>}
      {words.map(entry => <DialogQuote key={entry.key} label={wordsLabel(entry)} text={entry.text} />)}
      <DialogActions key="empty">
        <DialogButton kind="focus" kbd="esc" autoFocus disabled={busy} onClick={back}>Keep them</DialogButton>
        <DialogButton kind="danger" icon="ph ph-trash" disabled={busy || !eligible.length} onClick={() => { void deleteForGood(); }}>Delete for good</DialogButton>
      </DialogActions>
    </DialogFrame>;
  }

  const title = topicName ? `The bin for “${topicName}”` : 'The bin for this session';
  const restore = async (entry: BinEntry) => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const result = await confirmation.restore(actions, entry.topicId, entry.itemId);
      if (result.error) setError(result.error);
      else if (result.restored) setRestored(previous => new Set(previous).add(entry.key));
    } finally { setBusy(false); }
  };
  const shown = [...entries, ...[...restored].filter(key => !entries.some(entry => entry.key === key)).map(key => ({ key, restoredOnly: true as const }))];
  const empty = entries.every(entry => restored.has(entry.key));
  return <DialogFrame label={title} width={560} onCancel={close}>
    <DialogTitle>{title}</DialogTitle>
    <DialogText>Removed items wait here until you empty the bin. Restore puts one back where it was, and {agent} is told once.</DialogText>
    {error && <DialogError>{error}</DialogError>}
    {empty && !restored.size ? <DialogText>✓ The bin is empty.</DialogText>
      : <DialogList label="Removed items">{shown.map(value => {
        if ('restoredOnly' in value) return <DialogListRow key={value.key} name={restoredName(session, value.key)} dim action={<span className="bin-back">✓ Back in the Map</span>} />;
        const entry = value, back = restored.has(entry.key), family = familyOf(entry);
        return <DialogListRow key={entry.key} name={entry.name} dim={back}
          sub={family ? `${binSub(entry, agent)} · Continues in another session` : binSub(entry, agent)}
          action={back ? <span className="bin-back">✓ Back in the Map</span>
            : <OutlineButton icon="ph ph-arrow-counter-clockwise" title="Put it back where it was" disabled={busy} onClick={() => { void restore(entry); }}>Restore</OutlineButton>}>
          {!back && entry.words.map(words => <DialogQuote key={words.key} inList text={words.text} />)}
        </DialogListRow>;
      })}</DialogList>}
    <DialogActions key="bin">
      <DialogButton kind="secondary" left icon="ph ph-trash" disabled={busy || !eligible.length} onClick={() => setOpen({ ...open, step: 'empty' })}>Empty the bin…</DialogButton>
      <DialogButton kind="primary" kbd="esc" onClick={close}>Done</DialogButton>
    </DialogActions>
  </DialogFrame>;
}

const restoredName = (session: Immutable<Session>, key: string) => {
  const item = session.items[key];
  if (item) return shortLabel(item);
  const topic = session.topics[key];
  return topic ? topic.short?.trim() || topic.name : 'Restored';
};
