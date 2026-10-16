import type { ReactNode } from 'react';
import { Body, type LegacyBody } from './Body';
import './shell.css';

export interface ShellProps {
  /** The bar across the top. Until the new top bar lands it holds the old 48px header and 38px tab bar. */
  readonly topBar: ReactNode;
  /** The Map (Tree or Graph) or a page. */
  readonly main: ReactNode;
  /** The Details column (`DetailsColumn`); absent, the Map takes the full width. */
  readonly side?: ReactNode;
  /** Floats over the main and side areas, anchored to the bottom of the body. */
  readonly dock?: ReactNode;
  /** Dialogs and popovers. */
  readonly overlay?: ReactNode;
  /** The old 30px footer row under the body, until the new top bar replaces it. */
  readonly footer?: ReactNode;
  /** Body state the dock and the Details column replace: Waiting, the conversation view and the saved layout. */
  readonly legacy?: LegacyBody;
}

/** The Paperwhite chrome: the top bar, then the body (main, side and the floating dock). */
export function Shell({ topBar, main, side, dock, overlay, footer, legacy }: ShellProps) {
  return <div className="shell">
    <div className="shell-top">{topBar}</div>
    <Body {...legacy} main={main} side={side} dock={dock} />
    {footer}
    {overlay}
  </div>;
}
