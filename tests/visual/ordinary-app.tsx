import { createRoot } from 'react-dom/client';
import { DesktopApp } from '../../apps/desktop/src/App';
import { createDesktopService } from '../../apps/desktop/src/data/service';
import { createOrdinaryCapture } from './fixture';
import '../../apps/desktop/src/style.css';

const capture = createOrdinaryCapture(new URLSearchParams(window.location.search));
window.__ordinaryCapture = capture;
createRoot(document.getElementById('root')!).render(<DesktopApp service={createDesktopService(capture.transport)} />);
declare global { interface Window { __ordinaryCapture: ReturnType<typeof createOrdinaryCapture> } }
