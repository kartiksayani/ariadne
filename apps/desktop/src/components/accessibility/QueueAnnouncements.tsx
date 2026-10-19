import { useEffect, useRef, useState } from 'react';
import type { InputState } from '../../generated/domain/models';
import type { WaitingState } from '../../selectors/waiting/store';
import './accessibility.css';

const unresolved = new Set<InputState>(['queued', 'in_flight', 'needs_attention']);
const resolved = new Set<InputState>(['handled', 'cancelled', 'skipped']);
// Observe committed queue facts, not message deltas or disappearing Sent cards.
// Keep episode/input identities for this application lifetime across refreshes.
export function QueueAnnouncements({ state }: { state: WaitingState }) {
  const history = useRef({ mountedAt: Date.now(), published: false, seeded: new Set<string>(), episodes: new Set<string>(), inputs: new Map<string, InputState>(), announced: new Set<string>() });
  const [announcement, setAnnouncement] = useState({ sequence: 0, text: '' });
  useEffect(() => {
    // Seeding is per session. A session is announced from only once a read has listed it (a stale reader still lists the sessions
    // it last read), so one unreadable session never silences the others, and a session that was unreadable and then reads is
    // seeded silently from that first read. A session first listed after the first publish and created after this view mounted is
    // new, so its questions are announced. Nothing loaded yet (loading, or unavailable with no data) is skipped.
    const noData = (state.status === 'loading' || state.status === 'unavailable') && !state.counts && !state.waiting.length && !state.sessions.length;
    if (noData) return;
    const previous = history.current;
    const created = new Map<string, number>();
    for (const captured of state.sessions) created.set(JSON.stringify([captured.session.project_id, captured.session.id]), Number(captured.summary.created_at));
    const announces = (sessionKey: string) => previous.seeded.has(sessionKey)
      || (previous.published && (created.get(sessionKey) ?? -Infinity) > previous.mountedAt);
    let waiting = 0, completed = 0;
    for (const row of state.waiting) {
      const key = JSON.stringify([row.route.project_id, row.route.session_id, row.item.id, row.item.question_revision]);
      if (announces(JSON.stringify([row.route.project_id, row.route.session_id])) && !previous.episodes.has(key)) waiting++;
      previous.episodes.add(key);
    }
    for (const captured of state.sessions) for (const input of Object.values(captured.session.inputs)) {
      if (!input) continue;
      const key = JSON.stringify([captured.session.project_id, captured.session.id, input.id]);
      if (announces(JSON.stringify([captured.session.project_id, captured.session.id])) && unresolved.has(previous.inputs.get(key)!) && resolved.has(input.state) && !previous.announced.has(key)) {
        completed++; previous.announced.add(key);
      }
      previous.inputs.set(key, input.state);
    }
    for (const captured of state.sessions) previous.seeded.add(JSON.stringify([captured.session.project_id, captured.session.id]));
    previous.published = true;
    if (waiting || completed) setAnnouncement(value => ({ sequence: value.sequence + 1, text: [
      waiting ? `${waiting} new waiting ${waiting === 1 ? 'question' : 'questions'}.` : '',
      completed ? `${completed} owner ${completed === 1 ? 'reply resolved' : 'replies resolved'}.` : '',
    ].filter(Boolean).join(' ') }));
  }, [state]);
  return <div className="accessibility-announcement" role="status" aria-live="polite" aria-atomic="true" aria-label="Queue updates">
    <span key={announcement.sequence}>{announcement.text}</span>
  </div>;
}
