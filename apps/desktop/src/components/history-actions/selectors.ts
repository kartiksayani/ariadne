import type { CoreError, ContinuePreview, ItemRoute, SessionRef } from '../../generated/core';
import type { Binding, Session } from '../../generated/domain/models';
import type { Immutable } from '../../data';

const terminal = new Set(['decided', 'done', 'dropped', 'replaced']);
const pending = new Set(['queued', 'in_flight', 'needs_attention']);
/** Mirrors `Binding::dispatch_quiesced` in crates/ariadne-domain/src/models/delivery.rs. */
export function dispatchQuiesced(binding: Immutable<Binding> | null | undefined): boolean {
  return !binding || binding.dispatch_state === 'paused' || binding.dispatch_state === 'disconnected'
    || binding.connection_state !== 'connected';
}
export interface Blocker { key: string; label: string; item: ItemRoute | null }
export function lifecycleBlockers(session: Immutable<Session>, topicId: string | null, error?: CoreError): Blocker[] {
  const route = { project_id: session.project_id, session_id: session.id };
  const items = new Set(Object.values(session.items).filter(item => item && (!topicId || item.topic_id === topicId)
    && !terminal.has(item.status)).map(item => item!.id));
  const inputs = new Set(Object.values(session.inputs).filter(input => input && (!topicId || input.target.topic_id === topicId)
    && pending.has(input.state)).map(input => input!.id));
  error?.details?.blocking_item_ids.forEach(id => items.add(id));
  error?.details?.blocking_input_ids.forEach(id => inputs.add(id));
  return [...[...items].map(id => ({ key: `item:${id}`, label: `Item ${id} · ${session.items[id]?.question ?? 'Active item'}`,
    item: { ...route, item_id: id } })), ...[...inputs].map(id => {
    const input = session.inputs[id];
    return { key: `input:${id}`, label: `Input ${id} · ${input?.state.replace(/_/g, ' ') ?? 'Unresolved input'}`,
      item: input?.target.item_id ? { ...route, item_id: input.target.item_id } : null };
  })];
}
export function sameRoute(left: Immutable<SessionRef>, right: Immutable<SessionRef>): boolean {
  return left.project_id === right.project_id && left.session_id === right.session_id;
}
export function continueGroups(source: Immutable<Session>, preview: Immutable<ContinuePreview>) {
  return ['Waiting', 'Open', 'Terminal'].map(title => ({ title, items: preview.mapping.flatMap(mapping => {
    const item = source.items[mapping.source_item_id];
    if (!item || item.topic_id !== preview.source_topic_id) return [];
    const group = item.status === 'waiting_on_me' ? 'Waiting' : terminal.has(item.status) ? 'Terminal' : 'Open';
    return group === title ? [{ item, action: mapping.action }] : [];
  }) }));
}
