// C9: the Details column's width and fold, for the shell body (which lays the column out) and the column itself.
//
// - The width is the owner's choice, kept in ui.json as `detail_width` (core takes 320 to 2400). Below 320 the column
//   is still used, but 320 is what gets saved. No other field of ui.json is touched.
// - Fold is a view choice kept on this Mac only, in localStorage under `ariadne.details.folded.v1`.
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

/** What Details measures: 400 in the wide frame, 340 in the narrow one, and the rail it folds to. */
export const DETAILS_WIDE = 400, DETAILS_NARROW = 340, DETAILS_RAIL = 36;
/** A window narrower than this takes the narrow sizes. The board draws 1280 (wide) and 900 (narrow), so this sits between them. */
export const NARROW_BELOW = 1100;
/** The bounds core accepts for the saved `detail_width`. */
export const SAVED_MIN = 320, SAVED_MAX = 2400;
export const FOLDED_KEY = 'ariadne.details.folded.v1';

const NARROW_MIN = 280, WIDE_MARGIN = 480, NARROW_MARGIN = 380;
/** The width is written once the owner stops changing it for this long, so a drag is one write. */
const SAVE_AFTER_MS = 400;

const narrow = (viewport: number) => viewport < NARROW_BELOW;
/** The width Details opens at when the owner has not chosen one. */
export const defaultWidth = (viewport: number) => narrow(viewport) ? DETAILS_NARROW : DETAILS_WIDE;

/** What the owner can drag the width to: 320 to W - 480 wide, 280 to W - 380 narrow, never past what core would save. */
export function widthRange(viewport: number): { readonly min: number; readonly max: number } {
  const small = narrow(viewport), min = small ? NARROW_MIN : SAVED_MIN;
  return { min, max: Math.min(SAVED_MAX, Math.max(min, Math.floor(viewport - (small ? NARROW_MARGIN : WIDE_MARGIN)))) };
}

/** The width Details shows for a wish, inside the range for this window. */
export function fitWidth(width: number, viewport: number): number {
  const { min, max } = widthRange(viewport);
  return Math.min(max, Math.max(min, Math.round(width)));
}

/** The width written to ui.json: narrow widths below 320 are used as they are but saved as 320. */
export const savedWidth = (width: number) => Math.min(SAVED_MAX, Math.max(SAVED_MIN, Math.round(width)));

const usable = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** Whether the owner folded Details. Anything but a stored `true` reads as unfolded, and so does a storage that refuses. */
export function readFolded(): boolean {
  try { return localStorage.getItem(FOLDED_KEY) === 'true'; } catch { return false; }
}
function writeFolded(folded: boolean) {
  try { localStorage.setItem(FOLDED_KEY, String(folded)); } catch { /* The fold still holds for this run. */ }
}

export interface DetailsColumn {
  /** The width the open column shows at, in CSS pixels. */
  readonly width: number;
  readonly folded: boolean;
  /** Shows the width at once and saves it once the owner stops. Fitted to the window; saved as at least 320. */
  setWidth(px: number): void;
  fold(): void;
  unfold(): void;
}

/** What the resize edge may do in this window. */
export interface DetailsRange {
  readonly min: number;
  readonly max: number;
  /** The width a double-click goes back to. */
  readonly standard: number;
}

interface ColumnContext { readonly column: DetailsColumn; readonly range: DetailsRange }

const nothing = () => {};
/** Outside a provider (previews): the wide default, unfolded, and nothing to change. */
const loose: ColumnContext = {
  column: { width: DETAILS_WIDE, folded: false, setWidth: nothing, fold: nothing, unfold: nothing },
  range: { ...widthRange(1280), standard: DETAILS_WIDE },
};
const Context = createContext<ColumnContext>(loose);

function watchWindow(listener: () => void) {
  window.addEventListener('resize', listener);
  return () => window.removeEventListener('resize', listener);
}
const windowWidth = () => window.innerWidth;
const unmeasured = () => 1280;

/**
 * Holds the Details column's width and fold above the shell, so the shell body can lay the column out and the column
 * can resize and fold it. `saved` is `detail_width` from ui.json (null for none); `onSave` writes the owner's width back.
 */
export function DetailsColumnProvider({ saved = null, onSave, unfoldWhen, onFolded, children }: {
  readonly saved?: number | null;
  readonly onSave?: (width: number) => void;
  /** Unfolds a folded column each time this changes (not on the first render): the owner chose an item to look at. */
  readonly unfoldWhen?: number;
  /** Told the fold whenever it changes, and once on mount: what the column shows is only seen while it is unfolded. */
  readonly onFolded?: (folded: boolean) => void;
  readonly children?: ReactNode;
}) {
  const viewport = useSyncExternalStore(watchWindow, windowWidth, unmeasured);
  const [live, setLive] = useState<number | null>(null);
  const [folded, setFolded] = useState(readFolded);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waiting = useRef<number | null>(null);
  const latest = useRef({ saved, onSave, onFolded });
  useEffect(() => { latest.current = { saved, onSave, onFolded }; });
  useEffect(() => { latest.current.onFolded?.(folded); }, [folded]);
  // A width waiting for its pause is written when Details goes away, so closing it never loses the choice.
  const flush = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const value = waiting.current;
    waiting.current = null;
    if (value !== null && value !== latest.current.saved) latest.current.onSave?.(value);
  }, []);
  useEffect(() => flush, [flush]);
  const setWidth = useCallback((px: number) => {
    const next = fitWidth(px, viewport);
    setLive(next);
    waiting.current = savedWidth(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_AFTER_MS);
  }, [viewport, flush]);
  const fold = useCallback(() => { setFolded(true); writeFolded(true); }, []);
  const unfold = useCallback(() => { setFolded(false); writeFolded(false); }, []);
  const asked = useRef(unfoldWhen);
  useEffect(() => {
    if (asked.current === unfoldWhen) return;
    asked.current = unfoldWhen;
    unfold();
  }, [unfoldWhen, unfold]);
  const width = fitWidth(live ?? (usable(saved) ? saved : defaultWidth(viewport)), viewport);
  const value = useMemo<ColumnContext>(() => ({
    column: { width, folded, setWidth, fold, unfold },
    range: { ...widthRange(viewport), standard: defaultWidth(viewport) },
  }), [width, folded, setWidth, fold, unfold, viewport]);
  return createElement(Context.Provider, { value }, children);
}

/** C9: the Details column's width and fold. */
export function useDetailsColumn(): DetailsColumn {
  return useContext(Context).column;
}

/** The widths the resize edge may reach in this window, and the one a double-click returns to. */
export function useDetailsRange(): DetailsRange {
  return useContext(Context).range;
}
