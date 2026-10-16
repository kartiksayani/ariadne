import type { ReactNode } from 'react';
export function Banner({ icon, children, actions, alert = false }: { icon: string; children: ReactNode; actions?: ReactNode; alert?: boolean }) {
  return <div className="tree-banner" role={alert ? 'alert' : 'status'}>
    <i className={icon} />
    <span className="tree-banner-text">{children}</span>
    {actions}
  </div>;
}
