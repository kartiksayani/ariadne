// Archived topics (frame 1x), ported from Ariadne.dc.html:265-283. The archive
// is kept per project: it lists the archived topics of every session in it.
import { useState } from 'react';
import type { Immutable } from '../../data/session-store';
import type { SessionRef } from '../../generated/core';
import type { Session, SessionSummary } from '../../generated/domain/models';
import type { NavigationStore } from '../../state/navigation/store';
import type { SessionActionControllers } from '../../components/bindings/actions';
import { openContinueTopic } from '../dialogs/ContinueTopicDialog';
import { RemoveDialog } from '../dialogs/RemoveDialog';
import type { RemoveHandler, RemoveSubject, RemoveTarget } from '../dialogs/remove';
import { archivedTopics, ICON, STATUS_LABEL, type ArchivedTopic } from './model';
import { notices } from './notices';
import './pages.css';

export interface ArchivePageProps {
  readonly navigation: NavigationStore;
  readonly actions: SessionActionControllers;
  readonly projectName: string;
  /** Every session of the project. */
  readonly sessions: readonly Immutable<SessionSummary>[];
  readonly snapshots: ReadonlyMap<string, Immutable<Session>>;
  /** The session tab the archive is shown in: Continue brings a topic here. */
  readonly target: SessionRef;
  readonly query: string;
  readonly now: number;
  readonly onRemove: RemoveHandler;
}

export function ArchivePage({ navigation, actions, projectName, sessions, snapshots, target, query, now, onRemove }: ArchivePageProps) {
  const [removing, setRemoving] = useState<{ subject: RemoveSubject; target: RemoveTarget } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const all = archivedTopics(sessions, snapshots, '', now), shown = query.trim() ? archivedTopics(sessions, snapshots, query, now) : all;
  const restore = async (topic: ArchivedTopic) => {
    if (busy) return;
    setBusy(topic.topic.id);
    try {
      const store = navigation.opened.open(topic.source);
      await store.refresh();
      const session = store.getSnapshot().snapshot?.session, current = session?.topics[topic.topic.id];
      if (!session || !current) throw new Error('The topic could not be read.');
      const controller = actions.forSession(store);
      if (!await controller.execute({ command: 'topic_restore', api_version: 1, op_id: '', params: { topic_id: current.id, expected_revision: current.revision } }, session.revision)) {
        throw controller.getSnapshot().error ?? new Error('The topic could not be restored.');
      }
      await navigation.refresh();
    } catch (error: unknown) {
      notices.push({ icon: 'ph ph-warning-circle', iconColor: 'var(--a-danger)', dismissible: true, text: error instanceof Error ? error.message : 'The topic could not be restored.' });
    } finally { setBusy(null); }
  };
  const remove = (topic: ArchivedTopic) => setRemoving({ target: { kind: 'topic', session: topic.source, topic_id: topic.topic.id },
    subject: { kind: 'topic', name: topic.name, items: topic.items, waiting: topic.waiting,
      tell: { agent: topic.sourceAgent, mode: topic.sourceClosed ? 'closed' : topic.sourceRunning ? 'tell' : 'queued' } } });
  const needle = query.trim();
  return <div className="pw-archive">
    <div className="pw-page-title"><h1 className="pw-archive-name">Archived topics</h1>
      <span className="pw-page-sub">{`${all.length} topic${all.length === 1 ? '' : 's'} · kept for every session in ${projectName}`}</span></div>
    {shown.length === 0 && <div className="pw-archive-empty">{needle ? `No archived topic matches “${needle}”.`
      : 'Nothing archived yet. Archive a topic from its header when you’re done with it; it stays here for every session.'}</div>}
    {shown.map(topic => <div key={`${topic.source.session_id}:${topic.topic.id}`} className="pw-archive-card" data-topic-id={topic.topic.id}>
      <div className="pw-archive-head">
        <i className="ph ph-archive pw-archive-icon" aria-hidden="true" />
        <div className="pw-archive-text"><span className="pw-archive-title">{topic.name}</span><span className="pw-archive-meta">{topic.meta}</span></div>
        <div className="pw-archive-actions">
          <button type="button" className="btn btn-secondary pw-card-button" disabled={busy !== null} onClick={() => { void restore(topic); }}>
            <i className="ph ph-arrow-u-up-left" aria-hidden="true" />Restore</button>
          <button type="button" className="btn btn-primary pw-card-button" onClick={() => openContinueTopic({ source: topic.source, topicId: topic.topic.id, target })}>
            <i className="ph ph-arrow-bend-down-right" aria-hidden="true" />Continue in this session</button>
          <button type="button" className="btn btn-ghost pw-card-button" title="Remove topic" onClick={() => remove(topic)}>
            <i className="ph ph-trash" aria-hidden="true" />Remove</button>
        </div>
      </div>
      <div className="pw-archive-lines">
        {topic.lines.map(line => <div key={line.id} className="pw-archive-line">
          <span className="pw-archive-status"><i className={ICON[line.status]} role="img" title={STATUS_LABEL[line.status]} aria-label={STATUS_LABEL[line.status]}
            style={{ color: `var(--st-${line.status})` }} /></span><span>{line.text}</span></div>)}
        {topic.more && <div className="pw-archive-more">{topic.more}</div>}
      </div>
    </div>)}
    {removing && <RemoveDialog subject={removing.subject} onCancel={() => setRemoving(null)} onConfirm={() => onRemove(removing.target)} />}
  </div>;
}
