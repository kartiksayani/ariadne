import type { ReactNode } from 'react';
import { bodyColumns } from './model';

export interface BodyProps {
  readonly waiting: ReactNode;
  readonly center: ReactNode;
  readonly detail?: ReactNode;
  /** The detail header's breadcrumb. */
  readonly detailPath?: ReactNode;
  readonly rail?: ReactNode;
  readonly onCloseDetail?: () => void;
  readonly onRemove?: () => void;
}

export function Body({ waiting, center, detail, detailPath, rail, onCloseDetail, onRemove }: BodyProps) {
  return <div className="shell-body" style={{ gridTemplateColumns: bodyColumns(!!detail, !!rail) }}>
    <div className="shell-waiting">{waiting}</div>
    <main className="shell-center">{center}</main>
    {detail && <aside className="shell-detail" aria-label="Item detail">
      <div className="shell-detail-head">
        <div className="shell-detail-path">{detailPath}</div>
        <button type="button" className="btn btn-ghost btn-icon shell-detail-action" title="Remove (⌫)" aria-label="Remove item" onClick={onRemove}>
          <i className="ph ph-trash" aria-hidden="true" /></button>
        <button type="button" className="btn btn-ghost btn-icon shell-detail-action" title="Close (Esc)" aria-label="Close detail" onClick={onCloseDetail}>
          <i className="ph ph-x" aria-hidden="true" /></button>
      </div>
      <div className="shell-detail-scroll">{detail}</div>
    </aside>}
    {rail}
  </div>;
}
