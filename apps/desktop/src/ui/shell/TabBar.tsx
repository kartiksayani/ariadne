import type { TabModel } from './model';

export interface TabBarProps {
  readonly tabs: readonly TabModel[];
  readonly disabled?: boolean;
  readonly onSelect: (id: string) => void;
  readonly onClose: (id: string) => void;
}

export function TabBar({ tabs, disabled, onSelect, onClose }: TabBarProps) {
  return <nav className="shell-tabs" aria-label="Projects and sessions">
    {tabs.map(tab => <div key={tab.id} className={tab.on ? 'shell-tab shell-tab-on' : 'shell-tab'}>
      <button type="button" className="shell-tab-open" title={tab.title} disabled={disabled} aria-current={tab.on ? 'page' : undefined}
        aria-label={[tab.project && `${tab.project} /`, tab.label, tab.sub].filter(Boolean).join(' ')}
        data-shell-tab={tab.closable ? undefined : tab.id} data-session-tab={tab.closable ? tab.id : undefined} style={{ paddingRight: tab.closable ? 6 : 12 }} onClick={() => onSelect(tab.id)}>
        <i className={tab.icon} aria-hidden="true" style={{ fontSize: tab.iconSize, color: tab.iconColor }} />
        {tab.project && <><span className="shell-tab-project">{tab.project}</span><span className="shell-tab-separator">/</span></>}
        <span className="shell-tab-label">{tab.label}</span><span className="shell-tab-sub">{tab.sub}</span>
      </button>
      {tab.closable && <button type="button" className="shell-tab-close" disabled={disabled} onClick={() => onClose(tab.id)}
        title="Close tab (the session stays as it is)" aria-label={`Close ${tab.label} ${tab.sub} tab`.replace(/\s+/g, ' ')}><i className="ph ph-x" aria-hidden="true" /></button>}
      <span className="shell-tab-bar" aria-hidden="true" />
    </div>)}
  </nav>;
}
