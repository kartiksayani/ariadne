// macOS full screen: hovering the top edge slides the system menu bar down over
// the window. <html data-fullscreen> reserves an empty strip above the app bar
// (shell.css) so the menu bar covers that strip instead of the app bar's controls.

export interface FullscreenProbe {
  /** Whether the native window is in full screen now. */
  isFullscreen(): Promise<boolean>;
}

/** The macOS full-screen transition animates; re-check once it has settled. */
export const SETTLE_MS = 800;

/** Keeps `root.dataset.fullscreen` in step with the native window. Returns a stop function. */
export function watchFullscreen(probe: FullscreenProbe, root: HTMLElement = document.documentElement, view: Window = window): () => void {
  let stopped = false, sequence = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    const current = ++sequence;
    probe.isFullscreen().then(on => {
      if (stopped || current !== sequence) return;
      if (on) root.dataset.fullscreen = ''; else delete root.dataset.fullscreen;
    }, () => { /* No native window (tests, browser preview): keep the windowed layout. */ });
  };
  const resized = () => {
    check();
    clearTimeout(timer);
    timer = setTimeout(check, SETTLE_MS);
  };
  view.addEventListener('resize', resized);
  check();
  return () => {
    stopped = true;
    clearTimeout(timer);
    view.removeEventListener('resize', resized);
    delete root.dataset.fullscreen;
  };
}
