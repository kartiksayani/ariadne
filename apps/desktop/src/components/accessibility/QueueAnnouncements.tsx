import { useEffect, useRef, useState } from 'react';
import type { InputState } from '../../generated/domain/models';
import type { WaitingState } from '../../selectors/waiting/store';
import './accessibility.css';

const unresolved = new Set<InputState>(['queued', 'in_flight', 'needs_attention']);
const resolved = new Set<InputState>(['handled', 'cancelled', 'skipped']);
// Observe committed queue facts, not message deltas or disappearing Sent cards.
// Keep episode/input identities for this application lifetime across refreshes.
export function QueueAnnouncements({ state }: { state: WaitingState }) {
  const history = useRef({ seeded: false, episodes: new Set<string>(), inputs: new Map<string, InputState>(), announced: new Set<string>() });
  const [announcement, setAnnouncement] = useState({ sequence: 0, text: '' });
  useEffect(() => {
    if (state.status !== 'ready' || state.error) return;
    const previous = history.current;
    let waiting = 0, completed = 0;
    for (const row of state.waiting) {
      const key = JSON.stringify([row.route.project_id, row.route.session_id, row.item.id, row.item.question_revision]);
      if (previous.seeded && !previous.episodes.has(key)) waiting++;
      previous.episodes.add(key);
    }
    for (const captured of state.sessions) for (const input of Object.values(captured.session.inputs)) {
      if (!input) continue;
      const key = JSON.stringify([captured.session.project_id, captured.session.id, input.id]);
      if (previous.seeded && unresolved.has(previous.inputs.get(key)!) && resolved.has(input.state) && !previous.announced.has(key)) {
        completed++; previous.announced.add(key);
      }
      previous.inputs.set(key, input.state);
    }
    previous.seeded = true;
    if (waiting || completed) setAnnouncement(value => ({ sequence: value.sequence + 1, text: [
      waiting ? `${waiting} new waiting ${waiting === 1 ? 'question' : 'questions'}.` : '',
      completed ? `${completed} owner ${completed === 1 ? 'input resolved' : 'inputs resolved'}.` : '',
    ].filter(Boolean).join(' ') }));
  }, [state]);
  return <div className="accessibility-announcement" role="status" aria-live="polite" aria-atomic="true" aria-label="Queue updates">
    <span key={announcement.sequence}>{announcement.text}</span>
  </div>;
}
