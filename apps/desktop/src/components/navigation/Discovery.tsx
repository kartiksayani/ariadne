import { useEffect, useState } from 'react';
import type { DesktopDiscoveryCandidate } from '../../generated/core';
import { candidateIdentity, useDiscovery, type DiscoveryController } from '../../data/discovery';

function untestedNotice(candidate: DesktopDiscoveryCandidate) {
  const product = candidate.adapter_id === 'codex' ? 'Codex' : 'Claude Code';
  return `${product} ${candidate.host_version} is newer than the tested version; it should work, but has not been verified.`;
}

export function CandidateList({ controller, root, select, selected }: { controller: DiscoveryController; root?: string;
  select: (candidate: DesktopDiscoveryCandidate) => void; selected?: string | null }) {
  const state = useDiscovery(controller);
  const candidates = state.snapshot?.candidates.filter(candidate => !root || candidate.cwd === root) ?? [];
  return <div className="nav-discovery">
    <p>Host facts are advisory. Loaded means daemon membership; freshness does not prove execution readiness.</p>
    {state.error && <p role="alert">{state.error}</p>}
    <button type="button" className="ref-button ref-secondary" disabled={state.reading} onClick={() => { void controller.refresh(); }}>Refresh host sessions</button>
    {!state.snapshot && <p role="status">{state.reading ? 'Reading host sessions…' : 'Waiting for host discovery…'}</p>}
    {state.snapshot && candidates.length === 0 && <p>No discovered host sessions{root ? ' for this project' : ''}. Manual entry remains available.</p>}
    {Array.from(new Set(candidates.map(candidate => candidate.cwd))).map(cwd => <section key={cwd} aria-label={`Discovered project ${cwd}`}>
    {!root && <h3>{cwd}</h3>}
    {candidates.filter(candidate => candidate.cwd === cwd).map(candidate => <article key={candidateIdentity(candidate)} className="nav-discovery-candidate" data-discovery-id={candidate.external_session_id}>
      <strong>{candidate.title ?? candidate.external_session_id}</strong>
      <p>{candidate.cwd}</p><p>{candidate.adapter_id} · {candidate.host_version} · {candidate.freshness} · {candidate.compatibility} · {candidate.availability} · {candidate.loaded ? 'daemon loaded' : 'daemon not loaded'} · observed {candidate.observed_at}</p>
      {candidate.compatibility === 'untested' && <p role="note">{untestedNotice(candidate)}</p>}
      <button type="button" className="ref-button ref-secondary" disabled={candidate.freshness !== 'fresh' || state.error !== null} aria-pressed={selected === candidateIdentity(candidate)} onClick={() => select(candidate)}>{root ? 'Use host session' : 'Register this project'}</button>
    </article>)}</section>)}
  </div>;
}
export function DiscoverProjects({ controller, visible, register }: { controller: DiscoveryController; visible: boolean; register: (root: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => expanded && visible ? controller.acquire() : undefined, [controller, expanded, visible]);
  return <section className="nav-banner" aria-label="Discover host sessions" hidden={!visible}>
    <button type="button" className="ref-button ref-secondary" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>Discover host sessions</button>
    {expanded && visible && <CandidateList controller={controller} select={candidate => register(candidate.cwd)} />}
  </section>;
}
