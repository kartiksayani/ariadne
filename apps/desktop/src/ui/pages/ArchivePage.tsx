// The Archive page (SPEC 5.14): archived sessions and topics of every project, each with Restore and a "…" to remove
// it from Ariadne. A row restored in this visit stays and reads "Restored, closed" or "Back in the Map".
import { useState } from 'react';
import type { Immutable } from '../../data/session-store';
import { plainFailure } from '../../data/plain';
import type { SessionRef } from '../../generated/core';
import type { ProjectSummary, Session, SessionSummary } from '../../generated/domain/models';
import type { NavigationStore } from '../../state/navigation/store';
import type { SessionActionControllers } from '../../components/bindings/actions';
import { RemoveSessionDialog } from '../dialogs/RemoveDialog';
import type { RemoveHandler, RemoveSubject, RemoveTarget } from '../dialogs/remove';
import type { WholeTarget, WordsRead } from '../remove/words';
import { agentOf, archivedTopics, continuationLinks, routeOf, sessionKey, sessionRemoval, type ArchivedTopic } from './model';
import { notices } from './notices';
import { useHidden } from '../remove/queue';
import { isViewConflict } from '../shared/conflictNotice';
import { ownerName, sessionPhrase, sessionWhen } from '../shell/model';
import { ArchiveList } from './ArchiveList';
import { useSessionArchive } from './SessionLists';
import type { ArchiveRowData, PageBack } from './page-types';
import { archivedSessionRow, archivedTopicRow } from '../../components/navigation/pageData';
import './pages.css';

export interface ArchivePageProps {
  readonly navigation: NavigationStore;
  readonly actions: SessionActionControllers;
  readonly projects: readonly Immutable<ProjectSummary>[];
  /** Sessions from every catalogue project, including archived sessions. */
  readonly sessions: readonly Immutable<SessionSummary>[];
  readonly snapshots: ReadonlyMap<string, Immutable<Session>>;
  readonly now: number;
  readonly disabled: boolean;
  /** Opening a session waits only for a Refresh or the first load, not for an owner write; it queues behind the write. */
  readonly navigationDisabled?: boolean;
  readonly back?: PageBack;
  /** A row's name: open that session (archived, to read). */
  readonly onOpenSession: (route: SessionRef) => void;
  readonly onRemove: RemoveHandler;
  /** An archived topic's Remove: the app's own flow (E34), which quotes its words and checks its continuation family. */
  readonly onAskRemove: (target: Extract<RemoveTarget, { kind: 'topic' }>) => void;
  /** The words a session removal deletes, read fresh (E27). */
  readonly onReadWords: (target: WholeTarget) => Promise<WordsRead>;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

export function ArchivePage({ navigation, actions, projects, sessions, snapshots, now, disabled, navigationDisabled = disabled, back, onOpenSession, onRemove, onAskRemove, onReadWords }: ArchivePageProps) {
  const [removing, setRemoving] = useState<{ subject: Extract<RemoveSubject, { kind: 'session' }>; target: Extract<RemoveTarget, { kind: 'session' }>; words: WordsRead | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** Rows restored in this visit, as they were, so they stay in place with their new words. */
  const [restored, setRestored] = useState<ReadonlyMap<string, ArchiveRowData>>(new Map());
  const archive = useSessionArchive({ navigation, actions, now, disabled });
  const hidden = useHidden();
  const topics = archivedTopics(sessions, snapshots, '', now).filter(topic => !hidden.topic(topic.source, topic.topic.id));
  const summaryOf = (key: string) => sessions.find(summary => sessionKey(summary) === key);
  const project = (summary: Immutable<SessionSummary>) => projects.find(value => value.project_id === summary.project_id);
  const sessionRows = sessions.filter(summary => summary.archived_at != null && !hidden.session(routeOf(summary)))
    .sort((a, b) => Date.parse(b.archived_at!) - Date.parse(a.archived_at!)).map(summary => archivedSessionRow(summary, project(summary), now));
  const topicRows = topics.map(topic => archivedTopicRow(topic, summaryOf(sessionKey(topic.source)), now));
  const withRestored = (rows: readonly ArchiveRowData[], kind: ArchiveRowData['kind']) => [...rows.filter(row => !restored.has(row.id)),
    ...[...restored.values()].filter(row => row.kind === kind)];
  const markRestored = (row: ArchiveRowData) => setRestored(current => new Map(current).set(row.id, { ...row, restored: true }));
  const restoreTopic = async (topic: ArchivedTopic, row: ArchiveRowData) => {
    if (busy) return;
    setBusy(row.id);
    try {
      const store = navigation.opened.open(topic.source);
      await store.refresh();
      const session = store.getSnapshot().snapshot?.session, current = session?.topics[topic.topic.id];
      if (!session || !current) throw new Error('The topic could not be read.');
      const controller = actions.forSession(store);
      if (!await controller.execute({ command: 'topic_restore', api_version: 1, op_id: '', params: { topic_id: current.id, expected_revision: current.revision } }, session.revision)) {
        throw controller.getSnapshot().error ?? new Error('The topic could not be restored.');
      }
      notices.dismiss(`topic-restore-failed:${sessionKey(topic.source)}:${topic.topic.id}`);
      markRestored(row);
      await navigation.refresh();
    } catch (error: unknown) {
      const summary = summaryOf(sessionKey(topic.source));
      const subject = sessionPhrase(summary, topic.sourceAgent, summary ? sessionWhen(Date.parse(summary.created_at), now) : 'earlier');
      if (!isViewConflict(error)) notices.push({ id: `topic-restore-failed:${sessionKey(topic.source)}:${topic.topic.id}`, icon: 'ph ph-warning-circle', iconColor: 'var(--a-warn)', dismissible: true,
        text: `For “${topic.name}” in ${subject}: ${plainFailure(error, 'The topic could not be restored. Try again.')}` });
    } finally { setBusy(null); }
  };
  const restore = (row: ArchiveRowData) => {
    if (row.kind === 'topic') {
      const topic = topics.find(value => `${sessionKey(value.source)}:${value.topic.id}` === row.id);
      if (topic) void restoreTopic(topic, row);
      return;
    }
    const summary = summaryOf(row.id);
    if (summary && !busy) void archive.restore(summary).then(saved => { if (saved) markRestored(row); });
  };
  /** Opens the session to read; it stays archived. Restore is its own button. */
  const open = (row: ArchiveRowData) => {
    if (navigationDisabled) return;
    if (row.kind === 'topic') {
      const topic = topics.find(value => `${sessionKey(value.source)}:${value.topic.id}` === row.id);
      if (topic) onOpenSession(topic.source);
      return;
    }
    const summary = summaryOf(row.id);
    if (summary) onOpenSession(routeOf(summary));
  };
  const remove = (row: ArchiveRowData) => {
    if (row.kind === 'topic') {
      const topic = topics.find(value => `${sessionKey(value.source)}:${value.topic.id}` === row.id);
      if (!topic) return;
      onAskRemove({ kind: 'topic', session: topic.source, topic_id: topic.topic.id });
      return;
    }
    const summary = summaryOf(row.id);
    if (!summary) return;
    const counts = sessionRemoval(snapshots.get(row.id) ?? null, continuationLinks([...snapshots.values()]).shared);
    const target = { kind: 'session', session: routeOf(summary) } as const;
    setRemoving({ target, words: null,
      subject: { kind: 'session', agent: agentOf(summary), when: sessionWhen(Date.parse(summary.created_at), now), name: ownerName(summary), ...counts } });
    // Core deletes every input of the session: its words are read fresh and quoted before Remove can run (E27).
    void onReadWords(target).then(words => { setRemoving(current => current?.target === target ? { ...current, words } : current); });
  };
  const shownSessions = withRestored(sessionRows, 'session'), shownTopics = withRestored(topicRows, 'topic');
  return <>
    <ArchiveList back={back} sub={`${plural(shownSessions.length, 'session')} · ${plural(shownTopics.length, 'topic')}`}
      sessions={shownSessions} topics={shownTopics} onRestore={restore} onOpen={open} onRemove={remove} />
    {archive.dialogs}
    {removing && <RemoveSessionDialog subject={removing.subject} words={removing.words} onCancel={() => setRemoving(null)} onConfirm={() => onRemove(removing.target, removing.subject)} />}
  </>;
}
