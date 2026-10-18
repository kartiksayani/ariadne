import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useSessionActions, type SessionActions } from '../../components/bindings/actions';
import type { Immutable } from '../../data/session-store';
import type { Item } from '../../generated/domain/models';
import { useAckHeld } from '../shared/ack';
import { shortLabel } from '../shared/short';
import { StatusBadge } from '../shared/StatusBadge';
import { ackAllFor } from './ackAllController';
import './navigation.css';

const WIDTH = 340, EDGE = 8, RIGHT_INSET = 10, GAP = 4;

/** The review popover under the band (SPEC 4.3). It leaves the Map's flow, closes on scroll and never covers the band. */
function AckAllReview({ anchor, label, topicName, items, error, onConfirm, onCancel }: {
  readonly anchor: HTMLElement | null;
  readonly label: string;
  readonly topicName: string;
  readonly items: readonly Immutable<Item>[];
  readonly error: string | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null), confirm = useRef<HTMLButtonElement>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useLayoutEffect(() => {
    const place = () => {
      const element = panel.current;
      if (!element || !anchor) return;
      const band = anchor.closest('.tree-topic')?.getBoundingClientRect() ?? anchor.getBoundingClientRect();
      const viewport = document.documentElement.clientWidth || window.innerWidth;
      const width = Math.min(WIDTH, viewport - EDGE * 2);
      const right = Math.min(band.right - RIGHT_INSET, viewport - EDGE);
      element.style.width = `${width}px`;
      element.style.left = `${Math.max(EDGE, right - width)}px`;
      element.style.top = `${band.bottom + GAP}px`;
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor]);
  useEffect(() => {
    confirm.current?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || panel.current?.contains(event.target) || anchor?.contains(event.target)) return;
      cancel.current();
    };
    // A Map scroll moves what the popover was reviewing, so it closes (D18). Scrolling its own list does not.
    const scrolled = (event: Event) => { if (!(event.target instanceof Node && panel.current?.contains(event.target))) cancel.current(); };
    window.addEventListener('pointerdown', outside);
    window.addEventListener('scroll', scrolled, true);
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('scroll', scrolled, true); anchor?.focus({ preventScroll: true }); };
  }, [anchor]);
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    // The popover owns its keys: none reaches the Map's one-letter shortcuts underneath.
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); cancel.current(); }
  };
  const host = anchor?.closest('.product-app') ?? document.body;
  return createPortal(<div ref={panel} className="ack-all-review" role="dialog" aria-label={label} onKeyDown={keys}>
    <h2 className="ack-all-title">Ack {items.length} results in “{topicName}”?</h2>
    <p className="ack-all-text">They stay in the Map, marked as read. Questions and open items aren’t touched.</p>
    <ul className="ack-all-list">{items.map(item => <li key={item.id}>
      <StatusBadge status="done" variant="icon" size={12.5} /><span className="ack-all-name">{shortLabel(item)}</span></li>)}</ul>
    {error && <p className="ack-all-error" role="alert">{error}</p>}
    <div className="ack-all-actions">
      <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      <button ref={confirm} type="button" className="btn btn-primary" onClick={onConfirm}><i className="ph ph-check" aria-hidden="true" />Ack all</button>
    </div>
  </div>, host);
}

export function AckAll({ actions, topicId, topicName, items, disabled = false }: {
  readonly actions: SessionActions;
  readonly topicId: string;
  readonly topicName: string;
  readonly items: readonly Immutable<Item>[];
  readonly disabled?: boolean;
}) {
  const sessionState = useSyncExternalStore(actions.session.subscribe, actions.session.getSnapshot, actions.session.getSnapshot);
  const actionState = useSessionActions(actions);
  const controller = ackAllFor(actions), state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  // Items a single Ack holds are that Ack's: they are not offered here, so nothing is acknowledged twice.
  const held = useAckHeld(sessionState.route.session_id);
  const eligible = useMemo(() => items.filter(item => !held.has(item.id)), [items, held]);
  const [reviewed, setReviewed] = useState<readonly Immutable<Item>[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const mine = state.topicId === topicId;
  const busy = ['holding', 'saving', 'failed'].includes(state.phase);
  // If this band goes away while its batch is held (the Graph shows no band), the Undo moves to a notice.
  useEffect(() => {
    if (controller.getSnapshot().topicId === topicId) controller.withdraw();
    return () => { if (controller.getSnapshot().topicId === topicId) controller.announce(); };
  }, [controller, topicId]);
  const confirm = () => {
    if (!reviewed) return;
    if (controller.confirm(topicId, topicName, reviewed)) { setReviewed(null); setError(null); }
    else setError('These results changed or another save is pending. Cancel and review the current results before trying again.');
  };
  const close = () => { setReviewed(null); setError(null); };
  return <>
    {mine && state.phase === 'holding'
      ? <span className="ack-all-held" role="status"><i className="ph ph-check" aria-hidden="true" />
        <span>Acked {state.total}<span className="tree-wide-only"> results</span></span>
        <button type="button" className="ack-all-undo" aria-label="Undo Ack all" onClick={() => controller.undo()}>Undo</button></span>
      : !!eligible.length && <button ref={opener} type="button" className="tree-topic-ack-all" title="Ack read-only findings and explanations in this topic"
        aria-haspopup="dialog" aria-expanded={!!reviewed}
        disabled={disabled || busy || actionState.writing || !!actionState.pending || sessionState.status !== 'ready' || !!sessionState.error}
        onClick={() => { if (reviewed) close(); else { setReviewed(eligible); setError(null); } }}><i className="ph ph-check" aria-hidden="true" />Ack all ({eligible.length})</button>}
    {mine && state.phase === 'failed' && <span className="ack-all-progress" role="status">{state.completed} saved · {state.remaining} to finish</span>}
    {reviewed && !(mine && state.phase === 'holding') && <AckAllReview anchor={opener.current} label={`Acknowledge results in ${topicName}`} topicName={topicName}
      items={reviewed} error={error} onConfirm={confirm} onCancel={close} />}
  </>;
}
