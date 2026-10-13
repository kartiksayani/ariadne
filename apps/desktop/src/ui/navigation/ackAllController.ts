import type { Immutable } from '../../data/session-store';
import { CoreFailure, ServiceFailure } from '../../data';
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
interface PendingAck { readonly id: string; readonly proposal: string }
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
    this.queue = reviewed.map(item => ({ id: item.id, proposal: proposal(item) }));
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
  async retry(): Promise<void> {
    if (this.flight || !this.queue.length || !['holding', 'failed'].includes(this.state.phase)) return;
    clearTimeout(this.timer); this.timer = undefined; this.flight = true;
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
          const current = session && ackAllItems(session, this.state.topicId!).find(item => item.id === next.id);
          if (!current || proposal(current) !== next.proposal) throw new Error('A result changed. Read the current result, then cancel the remaining batch and confirm it again.');
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
    } finally { this.flight = false; }
  }
}
const controllers = new WeakMap<SessionActions, AckAllController>();
export function ackAllFor(actions: SessionActions): AckAllController {
  let controller = controllers.get(actions);
  if (!controller) { controller = new AckAllController(actions); controllers.set(actions, controller); }
  return controller;
}
