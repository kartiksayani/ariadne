// The "Continued from codex · yesterday" chip of a topic continued from another
// session (handoff README §4 topic row, §7 graph card; Ariadne.dc.html:1837).
import type { Immutable } from '../../data/session-store';
import type { SessionSummary, TopicOrigin } from '../../generated/domain/models';
import { agentName, dayWord, ownerName } from '../shell/model';

/** Names the origin session by the owner's name, else its agent, and day; "an earlier session" when the catalogue does not know it. */
export function continuedLabel(origin: Immutable<TopicOrigin>, summaries: readonly Immutable<SessionSummary>[], now: number): string {
  const source = summaries.find(value => value.project_id === origin.project_id && value.session_id === origin.session_id);
  const day = source ? dayWord(Date.parse(source.created_at), now).toLowerCase() : '';
  const name = ownerName(source) ?? (source?.active_binding ? agentName(source.active_binding.adapter_id) : 'an earlier session');
  return `Continued from ${name}${day ? ` · ${day}` : ''}`;
}
