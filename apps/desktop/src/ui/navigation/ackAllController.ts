import type { Immutable } from '../../data/session-store';
import { CoreFailure, ServiceFailure, type RendererService } from '../../data';
import type { Item, Session } from '../../generated/domain/models';
import type { SessionActions } from '../../components/bindings/actions';
import { ackTarget } from '../../selectors/ack';
import { activeItems } from '../../selectors/removed';
import { acknowledge, ackFailure } from '../shared/ack';
import { notices } from '../pages/notices';
import { navigationVisits } from './visits';

export const ACK_ALL_HOLD_MS = 5000;
export function ackAllItems(session: Immutable<Session>, topicId: string): readonly Immutable<Item>[] {
  if (!session.topics[topicId] || session.topics[topicId].archived_at != null) return [];
  return activeItems(session).filter(item => item.topic_id === topicId
    && (item.type === 'finding' || item.type === 'explanation') && !!ackTarget(session, item))
    .sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id));
}
const proposal = (item: Immutable<Item>) => JSON.stringify([item.revision, item.type, item.topic_id,
  item.question, item.ask, item.ack_to, item.outcome, item.why]);
interface PendingAck { readonly id: string; readonly reviewed: Immutable<Item> }
/** A manual Ack changes only the reviewed result's acknowledgement state. */
function alreadyAcknowledged(item: Immutable<Item>, reviewed: Immutable<Item>): boolean {
  const terminal = ['decided', 'done', 'dropped'].includes(reviewed.ack_to!);
  return item.revision === reviewed.revision + 1 && item.ack_to == null && item.status === reviewed.ack_to
    && item.type === reviewed.type && item.topic_id === reviewed.topic_id
    && item.question === reviewed.question && item.ask === reviewed.ask
    && item.outcome === (terminal ? reviewed.outcome ?? 'Acknowledged by the owner.' : reviewed.outcome)
    && item.why === (terminal ? reviewed.why ?? 'The owner read this item.' : reviewed.why);
}
export interface AckAllState {
  readonly phase: 'idle' | 'holding' | 'saving' | 'failed' | 'done' | 'cancelled';
  readonly topicId: string | null;
  readonly topicName: string;
  readonly total: number;
  readonly completed: number;
  readonly remaining: number;
  readonly error: string | null;
}
/** Session-owned work survives component unmounts. Uncertain commands retry their exact op_id. */
export class AckAllController {
  private state: AckAllState = Object.freeze({ phase: 'idle', topicId: null, topicName: '', total: 0, completed: 0, remaining: 0, error: null });
  private queue: PendingAck[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flight = false;
  private running: Promise<void> | null = null;
  private operationId: string | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly noticeId: string;
  constructor(private readonly actions: SessionActions) {
    const route = actions.session.getSnapshot().route;
    this.noticeId = JSON.stringify(['ack-all', route.project_id, route.session_id]);
  }
  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<AckAllState>) {
    this.state = Object.freeze({ ...this.state, ...update, remaining: this.queue.length });
    this.listeners.forEach(listener => listener());
    const { phase, topicName, completed, total, remaining, error } = this.state;
    if (phase === 'holding') notices.push({ id: this.noticeId, icon: 'ph ph-check', dismissible: false,
      text: `Ack ${total} results in “${topicName}” in 5 seconds.`, actions: [{ label: 'Undo', run: () => { this.undo(); } }] });
    else if (phase === 'saving') notices.push({ id: this.noticeId, icon: 'ph ph-check', dismissible: false,
      text: `Acknowledging results in “${topicName}”: ${completed} of ${total} saved.` });
    else if (phase === 'failed') notices.push({ id: this.noticeId, icon: 'ph ph-warning', tone: 'problem', dismissible: false,
      text: `${completed} of ${total} results saved in “${topicName}”; ${remaining} remain. ${error}`,
      actions: [{ label: 'Retry', run: () => { void this.retry(); } },
        { label: 'Cancel remaining', disabled: !!this.actions.getSnapshot().pending, run: () => { this.cancelRemaining(); } }] });
    else if (phase === 'done' || phase === 'cancelled') notices.push({ id: this.noticeId, icon: 'ph ph-check',
      text: phase === 'done' ? `Acknowledged ${completed} results in “${topicName}”.`
        : `Cancelled Ack all in “${topicName}”. ${completed ? `${completed} results were already saved.` : 'No acknowledgements were saved.'}` });
  }
  /** The exact displayed list is reviewed at confirmation, never expanded later. */
  confirm(topicId: string, topicName: string, reviewed: readonly Immutable<Item>[]): boolean {
    if (this.flight || ['holding', 'saving', 'failed'].includes(this.state.phase) || !reviewed.length
        || new Set(reviewed.map(item => item.id)).size !== reviewed.length) return false;
    const session = this.actions.session.getSnapshot().snapshot?.session;
    if (!session || this.actions.getSnapshot().writing || this.actions.getSnapshot().pending) return false;
    const eligible = new Map(ackAllItems(session, topicId).map(item => [item.id, item]));
    if (reviewed.some(item => !eligible.has(item.id) || proposal(eligible.get(item.id)!) !== proposal(item))) return false;
    this.queue = reviewed.map(item => ({ id: item.id, reviewed: item }));
    this.publish({ phase: 'holding', topicId, topicName, total: reviewed.length, completed: 0, error: null });
    this.timer = setTimeout(() => { this.timer = undefined; void this.retry(); }, ACK_ALL_HOLD_MS);
    return true;
  }
  undo(): boolean {
    if (this.state.phase !== 'holding') return false;
    clearTimeout(this.timer); this.timer = undefined; this.queue = [];
    this.publish({ phase: 'cancelled', error: null }); return true;
  }
  cancelRemaining(): boolean {
    if (this.flight || this.state.phase !== 'failed' || this.actions.getSnapshot().pending) return false;
    this.queue = []; this.publish({ phase: 'cancelled', error: null }); return true;
  }
  /** Closing the application commits confirmed work still in its Undo window. */
  flush(): Promise<void> {
    return this.state.phase === 'holding' ? this.retry() : this.running ?? Promise.resolve();
  }
  retry(): Promise<void> {
    if (this.flight) return this.running ?? Promise.resolve();
    if (!this.queue.length || !['holding', 'failed'].includes(this.state.phase)) return Promise.resolve();
    clearTimeout(this.timer); this.timer = undefined; this.flight = true;
    this.running = this.save();
    return this.running;
  }
  private async save(): Promise<void> {
    this.publish({ phase: 'saving', error: null });
    try {
      while (this.queue.length) {
        const next = this.queue[0], pending = this.actions.getSnapshot().pending;
        let saved: boolean;
        if (pending) {
          if (!this.operationId || pending.command.op_id !== this.operationId || pending.command.command !== 'ack' || pending.command.params.item_id !== next.id) {
            throw new Error('Another change needs to finish before Ack all can continue.');
          }
          saved = await this.actions.retry();
        } else {
          const sessionState = this.actions.session.getSnapshot();
          if (sessionState.status !== 'ready' || sessionState.error) throw new Error('The latest results are still loading. Try again when this session is ready.');
          const session = sessionState.snapshot?.session;
          const item = session && activeItems(session).find(item => item.id === next.id);
          if (item && session?.archived_at == null && session.topics[this.state.topicId!]?.archived_at == null
              && alreadyAcknowledged(item, next.reviewed)) {
            this.queue.shift();
            this.publish({ completed: this.state.completed + 1 });
            continue;
          }
          const current = session && ackAllItems(session, this.state.topicId!).find(item => item.id === next.id);
          if (!current || proposal(current) !== proposal(next.reviewed)) throw new Error('A result changed. Read the current result, then cancel the remaining batch and confirm it again.');
          // execute publishes its immutable pending operation synchronously before transport.
          // Observe only operations admitted by this dispatch, never an earlier same-item Ack.
          let unsubscribe = () => {};
          unsubscribe = this.actions.subscribe(() => {
            const admitted = this.actions.getSnapshot().pending;
            if (admitted?.command.command === 'ack' && admitted.command.params.item_id === next.id) {
              this.operationId = admitted.command.op_id; unsubscribe();
            }
          });
          try { saved = await acknowledge(this.actions, next.id); } finally { unsubscribe(); }
        }
        if (!saved) throw this.actions.getSnapshot().error ?? new Error('Ack could not be saved. Try again.');
        this.queue.shift();
        this.operationId = null;
        navigationVisits.record(this.actions.session.getSnapshot().route, next.id, 'acked');
        this.publish({ completed: this.state.completed + 1 });
      }
      this.publish({ phase: 'done', error: null });
    } catch (error) {
      this.publish({ phase: 'failed', error: error instanceof CoreFailure || error instanceof ServiceFailure
        ? ackFailure(error) : error instanceof Error ? error.message : ackFailure(error) });
    } finally { this.flight = false; this.running = null; }
  }
}
const controllers = new WeakMap<SessionActions, AckAllController>();
const lifetimes = new WeakMap<RendererService, Set<AckAllController>>();
export function ackAllFor(actions: SessionActions): AckAllController {
  let controller = controllers.get(actions);
  if (!controller) {
    controller = new AckAllController(actions); controllers.set(actions, controller);
    let lifetime = lifetimes.get(actions.service);
    if (!lifetime) { lifetime = new Set(); lifetimes.set(actions.service, lifetime); }
    lifetime.add(controller);
  }
  return controller;
}
/** Application-owned teardown waits for confirmed batches before closing their readers. */
export function stopAckAll(service: RendererService): Promise<void> {
  const lifetime = lifetimes.get(service);
  if (!lifetime) return Promise.resolve();
  const stopping = [...lifetime];
  return Promise.all(stopping.map(controller => controller.flush())).then(() => {
    stopping.forEach(controller => lifetime.delete(controller));
  });
}
/** Shares the removal queue's close/hide behavior, independent of mounted topic rows. */
export function attachAckAll(service: RendererService, target: Window = window): () => void {
  const flush = () => { lifetimes.get(service)?.forEach(controller => { void controller.flush(); }); };
  const hidden = () => { if (target.document.visibilityState === 'hidden') flush(); };
  target.addEventListener('pagehide', flush);
  target.addEventListener('beforeunload', flush);
  target.document.addEventListener('visibilitychange', hidden);
  return () => {
    target.removeEventListener('pagehide', flush);
    target.removeEventListener('beforeunload', flush);
    target.document.removeEventListener('visibilitychange', hidden);
  };
}
