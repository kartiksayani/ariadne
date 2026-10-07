// Mounts the real DesktopApp for one handoff frame: gallery.html?frame=1b.
// design.spec.mts serves the unzipped handoff at /source/.
import { createRoot } from 'react-dom/client';
import { DesktopApp } from '../../../apps/desktop/src/App';
import { createDesktopService } from '../../../apps/desktop/src/data/service';
import { designFixture, prototypeData, type DesignFixture } from './fixtures';
import '../../../apps/desktop/src/style.css';

declare global { interface Window { __designFixture?: DesignFixture; __designError?: string } }

async function mount() {
  const frame = new URLSearchParams(window.location.search).get('frame') ?? '';
  const source = await fetch('/source/Ariadne.dc.html');
  if (!source.ok) throw new Error(`Ariadne.dc.html is not served (${source.status})`);
  const fixture = designFixture(frame, prototypeData(await source.text()));
  window.__designFixture = fixture;
  createRoot(document.getElementById('root')!).render(<DesktopApp service={createDesktopService(fixture.transport)} />);
}
mount().catch((error: unknown) => { window.__designError = error instanceof Error ? error.message : String(error); });
