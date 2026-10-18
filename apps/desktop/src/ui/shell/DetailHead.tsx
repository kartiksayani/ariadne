import { useContext, useSyncExternalStore, type ReactNode } from 'react';
import { ActionMenu } from '../shared/ActionMenu';
import { NARROW_BELOW } from '../../state/details/column';
import { ItemActionIcon, type ItemActionView } from '../detail/itemActions';
import { ItemHistoryContext } from './itemHistory';

/** What the head offers beyond the path. Topic mode passes no `read`, no `focus` and no actions. */
export interface DetailHeadControls {
  /** The Read toggle: opens the bigger view, or (open) goes back to the Map. */
  readonly read?: { readonly open: boolean; readonly toggle: () => void };
  /** Focus on the item's branch, or Unfocus. */
  readonly focus?: { readonly on: boolean; readonly toggle: () => void };
  /** The action list Details emits (`onActions`): the same list the actions row uses. */
  readonly actions?: readonly ItemActionView[] | null;
  /** "Close Details ( esc )". */
  readonly close?: () => void;
}

/** The menu's rows, in the order the plan fixes: Copy reference, Follow up, Back to Open, Drop, Hide or Unhide, Remove. */
export const MENU_ORDER = ['copyRef', 'followUp', 'reopen', 'drop', 'hide', 'unhide', 'remove'] as const satisfies readonly ItemActionView['id'][];

export function menuActions(actions: readonly ItemActionView[] | null | undefined): readonly ItemActionView[] {
  return MENU_ORDER.flatMap(id => (actions ?? []).filter(action => action.id === id && action.applies));
}

const watchWindow = (listener: () => void) => { window.addEventListener('resize', listener); return () => window.removeEventListener('resize', listener); };
const windowWidth = () => window.innerWidth;
const unmeasured = () => 1280;

export interface DetailHeadProps extends DetailHeadControls {
  readonly path: ReactNode;
  /** The bigger view: "← Map" comes first. */
  readonly bigger?: boolean;
  readonly onBackToMap?: () => void;
  /** The » Fold button, from the column. */
  readonly fold?: ReactNode;
  /** Where the path hides while the item is hidden. */
  readonly hidden?: boolean;
}

/**
 * The Details head (SPEC 5.3), in the column and in the bigger view: "← Map" (bigger view only), the path, Back and Forward
 * (wide windows only), the Read toggle, Focus, "…" and Fold. There is no Close ×: Esc and "Close Details" in "…" close it.
 */
export function DetailHead({ path, bigger = false, onBackToMap, fold, hidden = false, read, focus, actions, close }: DetailHeadProps) {
  const history = useContext(ItemHistoryContext);
  const wide = useSyncExternalStore(watchWindow, windowWidth, unmeasured) >= NARROW_BELOW;
  const rows = menuActions(actions);
  return <div className={`shell-detail-head${bigger ? ' conversation-header' : ''}`} data-view={bigger ? 'bigger' : 'column'}>
    {bigger && <button type="button" className="btn btn-secondary shell-detail-map" aria-label="Back to Map" title="Back to the Map" onClick={onBackToMap}>
      <i className="ph ph-arrow-left" aria-hidden="true" />Map</button>}
    <div className="shell-detail-path">
      <div className="shell-detail-path-content" data-hidden={hidden || undefined}>{path}</div>
    </div>
    {history && wide && <div className="shell-detail-history" role="group" aria-label="Item navigation">
      <button type="button" className="btn btn-ghost btn-icon shell-detail-action" title="Back (⌘[)" aria-label="Back"
        disabled={!history.canBack} onClick={history.back}><i className="ph ph-arrow-left" aria-hidden="true" /></button>
      <button type="button" className="btn btn-ghost btn-icon shell-detail-action" title="Forward (⌘])" aria-label="Forward"
        disabled={!history.canForward} onClick={history.forward}><i className="ph ph-arrow-right" aria-hidden="true" /></button>
    </div>}
    {read && <button type="button" className="btn btn-ghost btn-icon shell-detail-action"
      aria-label={read.open ? 'Back to the Map' : 'Read in a bigger view'} title={read.open ? 'Back to the Map' : 'Read in a bigger view'}
      onClick={read.toggle}><i className="ph ph-file-text" aria-hidden="true" /></button>}
    {focus && <button type="button" className="btn btn-ghost btn-icon shell-detail-action" aria-pressed={focus.on} data-testid="details-focus"
      aria-label={focus.on ? 'Unfocus' : 'Focus'} title={focus.on ? 'Unfocus ( ⇧F )' : 'Show only this item and what’s under it ( ⇧F )'}
      onClick={focus.toggle}><i className="ph ph-crosshair-simple" aria-hidden="true" /></button>}
    <ActionMenu label="More actions" title="Copy reference, follow up, reopen, drop, hide, remove" align="end" gap={6} panelClassName="tree-menu-panel"
      buttonClassName="btn btn-ghost btn-icon shell-detail-action" icon={<i className="ph ph-dots-three" aria-hidden="true" />}>
      {closeMenu => <>
        {rows.map(action => <button key={action.id} type="button" role="menuitem" className="tree-menu-row" disabled={!!action.disabledReason}
          title={action.disabledReason} data-danger={action.id === 'remove' || undefined} onClick={() => { closeMenu(); action.run(); }}>
          <span className="tree-menu-icon"><ItemActionIcon action={action} /></span><span className="tree-menu-label">{action.label}</span></button>)}
        {rows.length > 0 && <div className="tree-menu-divider" role="separator" />}
        <button type="button" role="menuitem" className="tree-menu-row" title="Close Details ( esc )" disabled={!close}
          onClick={() => { closeMenu(); close?.(); }}>
          <i className="ph ph-x tree-menu-icon" aria-hidden="true" /><span className="tree-menu-label">Close Details <span className="detail-head-key">( esc )</span></span></button>
      </>}
    </ActionMenu>
    {fold}
  </div>;
}
