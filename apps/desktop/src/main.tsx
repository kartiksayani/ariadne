// Tokens and Paperwhite base styles (.btn, .input) first, so component CSS
// imported through App wins ties without qualifying its selectors.
import './style.css';
import { createRoot } from 'react-dom/client';
import App from './App';

async function start() {
  if (import.meta.env.VITE_ARIADNE_E2E === '1') {
    const { init } = await import('@wdio/tauri-plugin');
    await init();
  }
  createRoot(document.getElementById('root')!).render(<App />);
}
void start();
