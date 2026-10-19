// The actions row in the body of Details (SPEC 5.3 item 5): one primary button, then the hover bar's six icon slots minus the one
// promoted. "✓ Ack" (filled) for a finding to ack, "↺ Acked · Undo" right after, or "Bring it up" (filled) for an Open or Later item.
import { ItemActionIcon, type ItemActionId, type ItemActionView } from './itemActions';

export interface AckControl {
  /** What the button says to a screen reader, e.g. "Ack → Done". */
  readonly title: string;
  /** The Ack is in its 6 s hold: the button reads "Acked · Undo". */
  readonly held: boolean;
  readonly disabled: boolean;
  readonly onAck: () => void;
  readonly onUndo: () => void;
}

/** A greyed Ack says why, in place of "Ack → Done": the item is being written to or a message for it is on its way. */
const ACK_WAITS = 'A change is being saved';

/** What the slots say when the item's status has no use for them, and while they wait. */
const TITLE: Readonly<Partial<Record<ItemActionId, string>>> = {
  bring: 'Ask the agent to raise this as a question for you',
  reopen: 'Ask the agent to reopen it',
  later: 'Park it, still open',
  drop: 'Tell the agent to drop it',
};

export interface ActionsRowProps {
  readonly actions: readonly ItemActionView[];
  /** Set for a finding or explanation that can be acked: Ack is the primary button. */
  readonly ack: AckControl | null;
  /** The item's status in words ("Decided", "Later"), for "Drop: not for Decided items". */
  readonly statusLabel: string;
  /** The item is decided, done, dropped or replaced: slot 2 is Back to Open (greyed on a replaced item), not Bring it up. */
  readonly closed?: boolean;
  /** The row's tooltip: what the item's actions mean right now (the model's hint). */
  readonly hint?: string;
  /** The action whose box is open: its button reads as pressed. */
  readonly pressed?: ItemActionId | null;
}

export function ActionsRow({ actions, ack, statusLabel, closed = false, hint, pressed = null }: ActionsRowProps) {
  const byId = (id: ItemActionId) => actions.find(action => action.id === id);
  const reopen = byId('reopen'), bring = byId('bring');
  // The hover bar's slot 2 is Back to Open on a closed item and Bring it up otherwise.
  const second = closed ? reopen : bring;
  const promoted = !ack && bring?.applies && second === bring ? bring : null;
  const slots = [byId('followUp'), promoted ? null : second, byId('later'), byId('drop'), byId('unhide') ?? byId('hide'), byId('remove')]
    // Hide, Unhide, Remove and the reply slot are left out when the host or the status gives them no use; the other slots grey out and say why.
    .filter((action): action is ItemActionView => !!action && (!['hide', 'unhide', 'remove', 'followUp'].includes(action.id) || action.applies));
  const why = (action: ItemActionView) => action.applies ? action.disabledReason ?? '' : `${action.label}: not for ${statusLabel} items`;
  return <div className="detail-actions-row" role="group" aria-label="Item actions" title={hint}>
    {ack && (ack.held
      ? <button type="button" className="btn btn-secondary detail-primary detail-acked" title="Undo Ack" aria-label="Undo Ack" onClick={ack.onUndo}>
        <i className="ph ph-arrow-counter-clockwise" aria-hidden="true" />Acked · Undo</button>
      : <button type="button" className="btn btn-primary detail-primary" title={ack.disabled ? ACK_WAITS : ack.title} aria-label={ack.title} disabled={ack.disabled} onClick={ack.onAck}>
        <i className="ph ph-check" aria-hidden="true" />Ack</button>)}
    {promoted && <button type="button" className="btn btn-primary detail-primary" title={promoted.disabledReason ?? TITLE.bring} disabled={!!promoted.disabledReason} onClick={promoted.run}>
      <i className={promoted.icon} aria-hidden="true" />{promoted.label}</button>}
    {slots.map(action => {
      const off = !action.applies || !!action.disabledReason;
      return <button key={action.id} type="button" className="detail-icon-action" aria-label={action.label} title={off ? why(action) : TITLE[action.id] ?? action.label}
        aria-pressed={action.id === 'followUp' || action.id === 'drop' ? pressed === action.id : undefined} disabled={off} onClick={action.run}>
        <ItemActionIcon action={action} />
      </button>;
    })}
  </div>;
}
