// The words the stuck and recovered notices share (alpha.21 E17, E18): what an owner message is called, and the agent's name.
import type { Immutable } from '../../data';
import type { Input } from '../../generated/domain/models';
import { inputAbout, quoted } from '../../selectors/waiting/stuck';

/** "Claude Code" for the binding's adapter id; other adapters read as their id with spaces ("codex" becomes "Codex"). */
export function agentLabel(adapterId: string): string {
  const id = adapterId.toLowerCase().replace(/[_-]+/g, ' ').trim();
  if (id === 'claude code' || id === 'claude code mod') return 'Claude Code';
  return id.replace(/^./u, letter => letter.toUpperCase());
}

/** What the owner sent, as a noun phrase that ends before the name: "reply about", "answer on". */
export function sentNoun(kind: Input['kind'] | string): string {
  switch (kind) {
    case 'answer': return 'answer on';
    case 'note': return 'note about';
    case 'followup': return 'follow-up about';
    case 'reply': case 'topic_reply': return 'reply about';
    default: return 'request about';
  }
}

/** "reply about “x”" for an owner input: its question, else its topic's name. */
export const sentPhrase = (input: Immutable<Input>): string => `${sentNoun(input.kind)} ${quoted(inputAbout(input))}`;
/** "Your reply about “x”". */
export const yourSent = (input: Immutable<Input>): string => `Your ${sentPhrase(input)}`;
