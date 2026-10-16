// C6: the answer dock's API. The dock's view state lives here, above the dock, so remounting the dock (a session
// load, a page and back) keeps the current question and whether it is open. Callers never reach the DockStore itself.
import { createContext, createElement, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { SessionRef } from '../../generated/core';
import { DockStore, dockSessionKey } from '../../state/dock/store';
import { DockInsetProvider } from '../shell/dockInset';

/** A session route; the dock answers questions of the current session only. */
export type SessionRoute = SessionRef;

export interface DockApi {
  /** The dock shows a question (not the 40px line). */
  readonly isOpen: boolean;
  /** The dock's rendered height in px: 40 for the line, the open height, or 0 when no dock is shown (pages). */
  readonly height: number;
  /** Opens the dock at the item's question. For another session, call after navigating there; it opens once that session loads. */
  openAt(target: { readonly route: SessionRoute; readonly itemId: string }): void;
  /** `[`: folded, open at the current question; open, the previous question. */
  openPrev(): void;
  /** `]`: folded, open at the current question; open, the next question. */
  openNext(): void;
  fold(): void;
}

interface DockContextValue {
  readonly store: DockStore;
  readonly height: number;
  readonly setHeight: (height: number) => void;
}

const DockContext = createContext<DockContextValue | null>(null);

/**
 * Sits under the App, above every view that shows the dock or calls `useDock`. The dock's rendered height goes to the
 * shell's `DockInsetProvider` (C2), so the Map and Details keep that much room at their bottom.
 */
export function DockProvider({ children }: { readonly children?: ReactNode }) {
  const [store] = useState(() => new DockStore());
  const [height, setHeight] = useState(0);
  const value = useMemo(() => ({ store, height, setHeight }), [store, height]);
  return createElement(DockContext.Provider, { value }, createElement(DockInsetProvider, { height }, children));
}

const noop = () => {};
const folded = () => false;

/** The dock's internals: its store and the height report, or null without a provider. For `AnswerDock` only. */
export function useDockModel(): DockContextValue | null {
  return useContext(DockContext);
}

export function useDock(): DockApi {
  const context = useContext(DockContext);
  const store = context?.store;
  const isOpen = useSyncExternalStore(store?.subscribe ?? (() => noop), store ? () => store.getSnapshot().open : folded, store ? () => store.getSnapshot().open : folded);
  return useMemo(() => ({
    isOpen,
    height: context?.height ?? 0,
    openAt: target => store?.openAt(dockSessionKey(target.route), target.itemId),
    openPrev: () => store?.step(-1),
    openNext: () => store?.step(1),
    fold: () => store?.fold(),
  }), [isOpen, context?.height, store]);
}
