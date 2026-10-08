// Tokens and Paperwhite base styles (.btn, .input) first, so component CSS
// imported through App wins ties without qualifying its selectors.
import './style.css';
import { createRoot } from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import App from './App';
import { RootBoundary } from './RootBoundary';
import { watchFullscreen } from './ui/shell/fullscreen';

async function start() {
  if (import.meta.env.VITE_ARIADNE_E2E === '1') {
    const { init } = await import('@wdio/tauri-plugin');
    await init();
  }
  // Outside the native window (tests, a browser) the probe rejects and the layout stays windowed.
  watchFullscreen({ isFullscreen: async () => getCurrentWindow().isFullscreen() });
  createRoot(document.getElementById('root')!).render(<RootBoundary><App /></RootBoundary>);
}
void start();
