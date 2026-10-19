// Requests the Map carries out for a dialog mounted elsewhere: "Archive instead" in the Remove-topic dialog asks the
// session's lifecycle (mounted with the Map) to open its Archive dialog for that topic.
import type { SessionRef } from '../../generated/core';
import type { RemoveTarget } from '../dialogs/remove';

export interface ArchiveRequest { readonly route: SessionRef; readonly topicId: string }
type Listener = (request: ArchiveRequest) => void;

class ArchiveRequests {
  private readonly listeners = new Set<Listener>();
  /** Returns whether a mounted Map took it. */
  request(value: ArchiveRequest): boolean {
    this.listeners.forEach(listener => listener(value));
    return this.listeners.size > 0;
  }
  subscribe(listener: Listener): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}
export const archiveRequests = new ArchiveRequests();

/** "Remove again" on a removal that found new words at commit: the app asks again with a fresh review. */
export const againRequests = new Set<(target: Extract<RemoveTarget, { kind: 'item' | 'topic' }>) => void>();
