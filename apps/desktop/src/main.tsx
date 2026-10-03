import { createRoot } from 'react-dom/client';
import App from './App';
import './style.css';

async function start() {
  if (import.meta.env.VITE_ARIADNE_E2E === '1') {
    const { init } = await import('@wdio/tauri-plugin');
    await init();
  }
  createRoot(document.getElementById('root')!).render(<App />);
}
void start();
