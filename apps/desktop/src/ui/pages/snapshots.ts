// Session snapshots behind the session cards and the project-wide archive.
// SessionSummary carries neither a message count nor topics, so each listed
// session is read once per revision with `session_get`.
import { useEffect, useMemo, useState } from 'react';
import type { RendererService } from '../../data/service';
import { plainFailure } from '../../data/plain';
import { immutable, type Immutable } from '../../data/session-store';
import type { Session, SessionSummary } from '../../generated/domain/models';
import { sessionKey } from './model';
import { notices } from './notices';

type Entry = { readonly revision: number; readonly session: Immutable<Session> };

export function useSessionSnapshots(service: RendererService | null, summaries: readonly Immutable<SessionSummary>[]): ReadonlyMap<string, Immutable<Session>> {
  const [entries, setEntries] = useState<ReadonlyMap<string, Entry>>(new Map());
  const wanted = summaries.map(summary => `${sessionKey(summary)}@${summary.revision}`).join('|');
  useEffect(() => {
    if (!service) return undefined;
    let current = true;
    const stale = summaries.filter(summary => entries.get(sessionKey(summary))?.revision !== summary.revision);
    for (const summary of stale) {
      void service.query({ session: { project_id: summary.project_id, session_id: summary.session_id }, request: { command: 'session_get', params: {} } })
        .then(result => {
          if (!current || result.session.id !== summary.session_id) return;
          setEntries(previous => new Map(previous).set(sessionKey(summary), { revision: result.session.revision, session: immutable(result.session) }));
        }, (error: unknown) => {
          if (!current) return;
          // One note per session; a later successful read does not clear it, the owner dismisses it.
          notices.push({ id: `session-read-failed:${sessionKey(summary)}`, icon: 'ph ph-warning-circle', iconColor: 'var(--a-danger)', dismissible: true,
            text: `A session could not be read, so its card is incomplete. ${plainFailure(error)}` });
        });
    }
    return () => { current = false; };
  // `wanted` names every listed session at its revision; `entries` changes only from these reads.
  }, [service, wanted]);
  return useMemo(() => new Map([...entries].map(([key, entry]) => [key, entry.session])), [entries]);
}
