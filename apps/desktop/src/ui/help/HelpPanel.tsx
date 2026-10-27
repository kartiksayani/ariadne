// Help behind "?" (SPEC 5.16): two tabs. Keys lists the approved key map in four groups; Markers and statuses explains the
// New / Changed markers, the 11 statuses and the branch tints. Pure props in, callbacks out (contract C8). Mount it in the
// window's overlay layer: it floats under the top bar's right edge (top 44, right 8).
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Keycap, usePopover, useRestoreFocus } from '../parts/parts';
import { BRANCH_HUES, KEY_GROUPS, STATUS_HELP } from './content';
import { ChangeMarker } from '../changes/ChangeMarker';
import './help.css';

export type HelpTab = 'keys' | 'markers';

export interface HelpPanelProps {
  readonly narrow: boolean;
  /** The tab it opens on. */
  readonly initialTab?: HelpTab;
  readonly onTabChange?: (tab: HelpTab) => void;
  /** Esc, a press outside, or the × button. */
  readonly onClose: () => void;
}

const TABS: ReadonlyArray<{ id: HelpTab; label: string }> = [{ id: 'keys', label: 'Keys' }, { id: 'markers', label: 'Markers and statuses' }];

function Info({ children }: { readonly children: string }) {
  return <div className="hlp-info"><i className="ph ph-info" aria-hidden="true" /><span>{children}</span></div>;
}

function KeysTab() {
  return <>
    <div className="hlp-keys">
      {KEY_GROUPS.map(group => <section className="hlp-group" key={group.label} aria-label={group.label}>
        <h3 className="p-label hlp-h">{group.label}</h3>
        {group.keys.map(([keys, text]) => <div className="hlp-key" data-testid="help-key" key={keys.join('+') + text}>
          <span className="hlp-caps">{keys.map(key => <Keycap size="md" key={key}>{key}</Keycap>)}</span>
          <span className="hlp-text">{text}</span>
        </div>)}
      </section>)}
    </div>
    <Info>Single-letter keys work when no text box has focus. In a text box, ⌘↵ sends and esc leaves it with your words kept. Details folds and unfolds with its » button or its rail, with no key; drag its left edge to change its width. Drag the dock’s top edge to change its height.</Info>
  </>;
}

function MarkersTab() {
  return <>
    <section className="hlp-sec" aria-label="Markers">
      <h3 className="p-label hlp-h">Markers</h3>
      <div className="hlp-markers">
        <ChangeMarker kind="new" />
        <span className="hlp-text">You haven’t seen it yet: a new question, task or finding.</span>
        <ChangeMarker kind="changed" />
        <span className="hlp-text">You’ve seen it, and since then its status, outcome, options or conversation changed. A rewording alone doesn’t count.</span>
        <span className="hlp-diamonds" aria-hidden="true"><ChangeMarker kind="new" form="diamond" /><ChangeMarker kind="changed" form="diamond" /></span>
        <span className="hlp-text">On Graph cards and in tight spots the diamond stands alone: solid for New, outlined for Changed.</span>
      </div>
      <Info>Both clear after about a second in Details or in the open answer dock. Peeking and scrolling past leave them, and so does n, which only outlines the next one.</Info>
    </section>
    <section className="hlp-sec" aria-label="Statuses">
      <h3 className="p-label hlp-h">Statuses</h3>
      <div className="hlp-statuses">
        {STATUS_HELP.map(status => <span className="hlp-status" key={status.label}>
          <i className={status.icon} style={{ color: status.color }} aria-hidden="true" />
          <span><span className="hlp-status-name">{status.label}</span> <span className="hlp-status-text">{status.text}</span></span>
        </span>)}
      </div>
    </section>
    <section className="hlp-sec" aria-label="Branches">
      <h3 className="p-label hlp-h">Branches</h3>
      <div className="hlp-branches">
        <span className="hlp-swatches" aria-hidden="true">{BRANCH_HUES.map(branch => <span key={branch.name} className="hlp-sw" style={{ '--h': branch.hue, '--m': branch.chroma } as CSSProperties} />)}</span>
        <span className="hlp-branch-text">Each top item’s branch gets its own tint. Markers never use them.</span>
      </div>
    </section>
  </>;
}

export function HelpPanel({ narrow, initialTab = 'keys', onTabChange, onClose }: HelpPanelProps) {
  const [tab, setTab] = useState<HelpTab>(initialTab);
  const panel = useRef<HTMLDivElement>(null), id = useId();
  usePopover(true, () => onClose(), panel, '[data-popover-trigger="help"]');
  useRestoreFocus(panel);
  useEffect(() => { panel.current?.focus(); }, []);
  const pick = (next: HelpTab) => { setTab(next); onTabChange?.(next); };
  const tabKeys = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const at = TABS.findIndex(entry => entry.id === tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : (at + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    pick(TABS[next]!.id);
    requestAnimationFrame(() => document.getElementById(`${id}-${TABS[next]!.id}`)?.focus());
  };
  return <div ref={panel} className={narrow ? 'hlp hlp-narrow' : 'hlp'} role="dialog" aria-label="Help: keys and markers" tabIndex={-1}>
    <div className="hlp-head">
      <div className="hlp-tabs" role="tablist" aria-label="Help" onKeyDown={tabKeys}>
        {TABS.map(entry => <button type="button" role="tab" id={`${id}-${entry.id}`} key={entry.id} aria-selected={tab === entry.id} aria-controls={`${id}-panel`}
          tabIndex={tab === entry.id ? 0 : -1} className="hlp-tab" onClick={() => pick(entry.id)}>{entry.label}</button>)}
      </div>
      <button type="button" className="hlp-close" title="Close ( esc )" aria-label="Close help" onClick={onClose}><i className="ph ph-x" aria-hidden="true" /></button>
    </div>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`} className="hlp-body">
      {tab === 'keys' ? <KeysTab /> : <MarkersTab />}
    </div>
  </div>;
}
