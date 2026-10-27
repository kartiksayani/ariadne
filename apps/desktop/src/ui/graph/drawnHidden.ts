// The hidden items the Graph actually draws (dimmed, on the route to the selected or revealed item). The Graph reports them from its own
// model, after its optimistic edits, to the TreeView hosting it, so the filter strip's note counts what the Graph really shows.
import { createContext, useContext, useLayoutEffect } from 'react';

export type ReportDrawnHidden = (ids: readonly string[] | null) => void;

export const DrawnHiddenContext = createContext<ReportDrawnHidden | null>(null);

/** Reports `ids` (null while the Graph has no layout) to the host; reports null again when the Graph goes away. */
export function useReportDrawnHidden(ids: readonly string[] | null): void {
  const report = useContext(DrawnHiddenContext);
  const key = ids ? ids.join('\n') : null;
  useLayoutEffect(() => {
    report?.(key === null ? null : key === '' ? [] : key.split('\n'));
    return () => report?.(null);
  }, [report, key]);
}
