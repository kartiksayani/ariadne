// How links and file references in agent text reach the desktop, and what the owner is told when one does not open.
import type { RendererService, Unsubscribe } from '../../data/service';
import { notices, type NoticeStore } from '../pages/notices';
import type { FileOpener } from './MarkdownText';

export const LINK_NOT_OPENED = 'That link didn’t open.';
export const FILE_NOT_OPENED = 'That file didn’t open.';
/** How long the note stays when the owner does not dismiss it. */
const NOTICE_MS = 6000;

const failed = (store: NoticeStore, id: string, text: string) =>
  store.push({ id, icon: 'ph ph-warning', iconColor: 'var(--a-warn)', text, dismissible: true }, NOTICE_MS);

type Opening = Pick<RendererService, 'openLink' | 'resolveFileReferences' | 'openFileReference'>;

/** Native WebView navigation failures use the same note as links opened from agent text. */
export function listenForLinkFailures(service: Pick<RendererService, 'subscribe'>, store: NoticeStore = notices): Unsubscribe {
  let stopped = false, unsubscribe: Unsubscribe | undefined;
  void service.subscribe('ariadne://open_link_failed', () => {
    if (!stopped) failed(store, 'open-link-failed', LINK_NOT_OPENED);
  }).then(detach => {
    if (stopped) detach(); else unsubscribe = detach;
  }).catch(() => {});
  return () => { stopped = true; unsubscribe?.(); unsubscribe = undefined; };
}

/** Opens an external link in the system browser; a failure shows a short note and leaves the app where it is. */
export const linkOpener = (service: Opening, store: NoticeStore = notices) => (url: string): void => {
  const opening = service.openLink?.(url);
  if (opening) void opening.catch(() => { failed(store, 'open-link-failed', LINK_NOT_OPENED); });
};

/** Resolves and opens files named in agent text; null when the desktop cannot. A failed open shows a short note. */
export const fileOpener = (service: Opening, store: NoticeStore = notices): FileOpener | null =>
  service.resolveFileReferences && service.openFileReference ? {
    resolve: (projectId, references) => service.resolveFileReferences!(projectId, references),
    open: (projectId, reference) => { void service.openFileReference!(projectId, reference).catch(() => { failed(store, 'open-file-failed', FILE_NOT_OPENED); }); },
  } : null;
