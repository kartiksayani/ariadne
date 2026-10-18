// The words the stuck and recovered notices share (alpha.21 E17, E18): what an owner message is called. The agent's name is `agentName` in ../shell/model.
import type { Immutable } from '../../data';
import type { Input } from '../../generated/domain/models';
import { inputAbout, quoted } from '../../selectors/waiting/stuck';

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
