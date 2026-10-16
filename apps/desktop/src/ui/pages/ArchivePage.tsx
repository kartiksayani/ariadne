// The Archive page (SPEC 5.14): archived sessions and topics of every project, each with Restore and a "…" to remove
// it from Ariadne. A row restored in this visit stays and reads "Restored, closed" or "Back in the Map".
import { useState } from 'react';
import type { Immutable } from '../../data/session-store';
import { plainFailure } from '../../data/plain';
import type { ProjectSummary, Session, SessionSummary } from '../../generated/domain/models';
import type { NavigationStore } from '../../state/navigation/store';
import type { SessionActionControllers } from '../../components/bindings/actions';
import { RemoveDialog } from '../dialogs/RemoveDialog';
import type { RemoveHandler, RemoveSubject, RemoveTarget } from '../dialogs/remove';
import { agentOf, archivedTopics, continuationLinks, routeOf, sessionKey, sessionRemoval, type ArchivedTopic } from './model';
import { notices } from './notices';
import { useHidden } from '../remove/queue';
import { removeSubject } from '../remove/model';
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
  readonly back?: PageBack;
  readonly onRemove: RemoveHandler;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

export function ArchivePage({ navigation, actions, projects, sessions, snapshots, now, disabled, back, onRemove }: ArchivePageProps) {
  const [removing, setRemoving] = useState<{ subject: RemoveSubject; target: RemoveTarget } | null>(null);
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
  const remove = (row: ArchiveRowData) => {
    if (row.kind === 'topic') {
      const topic = topics.find(value => `${sessionKey(value.source)}:${value.topic.id}` === row.id);
      if (!topic) return;
      const target = { kind: 'topic', session: topic.source, topic_id: topic.topic.id } as const;
      const session = snapshots.get(sessionKey(topic.source)), subject = session && removeSubject(session, target);
      if (subject) setRemoving({ target, subject });
      return;
    }
    const summary = summaryOf(row.id);
    if (!summary) return;
    const counts = sessionRemoval(snapshots.get(row.id) ?? null, continuationLinks([...snapshots.values()]).shared);
    setRemoving({ target: { kind: 'session', session: routeOf(summary) },
      subject: { kind: 'session', agent: agentOf(summary), when: sessionWhen(Date.parse(summary.created_at), now), name: ownerName(summary), ...counts } });
  };
  const shownSessions = withRestored(sessionRows, 'session'), shownTopics = withRestored(topicRows, 'topic');
  return <>
    <ArchiveList back={back} sub={`${plural(shownSessions.length, 'session')} · ${plural(shownTopics.length, 'topic')}`}
      sessions={shownSessions} topics={shownTopics} onRestore={restore} onRemove={remove} />
    {archive.dialogs}
    {removing && <RemoveDialog subject={removing.subject} onCancel={() => setRemoving(null)} onConfirm={() => onRemove(removing.target, removing.subject)} />}
  </>;
}
