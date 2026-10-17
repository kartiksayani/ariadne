import type { ReactNode } from 'react';
import type { PageBack } from './page-types';
import './page-parts.css';

/** The head every page shares: a back button naming where it goes, the title, a quiet sub line, and room for controls on the right. */
export function PageHead({ back, title, sub, children }: { readonly back?: PageBack; readonly title: string; readonly sub?: string; readonly children?: ReactNode }) {
  return <div className="pp-head">
    {back && <button type="button" className="pp-back" title="Back ( esc )" onClick={back.onBack}><i className="ph ph-arrow-left" aria-hidden="true" /><span className="pp-back-label">{back.label}</span></button>}
    <h1 className="pp-title">{title}</h1>
    {sub && <span className="pp-sub">{sub}</span>}
    <span className="pp-spacer" />
    {children}
  </div>;
}

/** The scrolling column of a page: at most 1060px wide, centred. */
export function PageColumn({ children, label }: { readonly children: ReactNode; readonly label: string }) {
  return <div className="pp-scroll" role="region" aria-label={label}><div className="pp-col">{children}</div></div>;
}
