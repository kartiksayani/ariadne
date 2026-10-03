// Exact crops name their exclusions; whole source/app images are retained and
// are never described as whole-frame parity. No masks or relaxed tolerance.
export const assembledRegions = {
  brand: { source: 'header > div:first-child', app: '.ref-brand', excludes: 'Release footer shortcuts, discovery/binding text, and body scroll behavior.' },
  waitingHeading: { source: 'aside[aria-label="Waiting on me"] > div:first-child', app: '.ref-waiting-heading', excludes: 'Prototype default answer choice; gallery recommendations are unselected.' },
  waitingQuestion: { source: 'aside[aria-label="Waiting on me"] div[style*="font-size: 14.5px;"][style*="line-height: 21px;"]', app: '.ref-waiting-question', excludes: 'Prototype default answer choice and Enter hint; corrected controls are tested independently.' },
  sent: { source: 'aside[aria-label="Waiting on me"] div[style*="padding: 10px 12px;"]', app: '.ref-sent-card', excludes: 'Source uses one submission per item; release supports one row per input, including older inputs and new asks.' },
  round: { source: 'aside[aria-label="Item detail"] div[style*="padding: 10px 12px;"][style*="flex-direction: column;"]', app: '.ref-round-card', excludes: 'Detail composition and prototype selected recommendation.' },
  graph: { source: 'main div[style*="position: relative;"]:has(> svg)', app: '.ref-graph', excludes: 'Source coordinates are supplied fixture inputs; production 94px/254px layout and pan/zoom are P5.1. Waiting remains pinned in the release shell.' },
  project: { source: 'main div[style*="padding: 16px;"][style*="cursor: pointer;"]', app: '.ref-project-card', excludes: 'Read-only candidate registration and binding controls are release-specific states.' },
  session: { source: 'main div[style*="padding: 12px 14px;"][style*="box-shadow:"]', app: '.ref-session-card', excludes: 'Actual close/dispatch workflow is later product acceptance; controlled guard fixtures use the release contract.' },
  archive: { source: 'main div[style*="padding: 14px 16px;"]', app: '.ref-archive-card', excludes: 'Source allows archiving nonterminal items; release guard fixtures disallow it.' },
  continueSummary: { source: '.dialog > div[style*="max-height: 360px;"]', app: '.ref-continue-summary', excludes: 'Source lead: Ariadne sends claude-code this summary so it can pick up where codex left off. Item references stay the same, and new items join this topic. Release lead: Copy this snapshot from codex · yesterday into claude-code · today. The target receives new local IDs with immutable source references for topics, items, messages, rounds and answers. The source stays unchanged. Source send: Send to claude-code. Release send: Send to claude-code · today.' },
} as const;
export type AssembledRegion = keyof typeof assembledRegions;
export const frameRegions: Record<string, readonly AssembledRegion[]> = {
  '1a': ['brand', 'waitingHeading'], '1b': ['brand'], '1c': ['waitingQuestion'],
  '1d': ['graph'], '1e': ['waitingQuestion'], '1f': ['graph'],
  '1g': ['waitingHeading'], '1h': ['waitingHeading'], '1i': ['waitingHeading'],
  '1l': ['sent'], '1m': ['waitingQuestion'], '1n': ['brand'], '1o': ['waitingQuestion'],
  '1p': ['brand'], '1q': ['brand'], '1r': ['brand'], '1t': ['waitingQuestion'],
  '1u': ['round'], '1v': ['brand'], '1w': ['waitingQuestion'], '1x': ['archive'],
  '1y': ['continueSummary'], '1z': ['session'], '1aa': ['graph'],
  '1ab': ['project'], '1ac': ['session'], '1ad': [],
};
