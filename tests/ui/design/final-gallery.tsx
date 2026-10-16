// Mounts the real DesktopApp for one final-board state: final-gallery.html?state=2.1&variant=light.
// final.spec.mts drives it; the state's data comes from final-frames.ts through final-fixtures.ts.
// Base styles first, as in main.tsx: component CSS follows through the App import.
import '../../../apps/desktop/src/style.css';
import { createRoot } from 'react-dom/client';
import { DesktopApp } from '../../../apps/desktop/src/App';
import { createDesktopService } from '../../../apps/desktop/src/data/service';
import { notices } from '../../../apps/desktop/src/ui/pages/notices';
import { finalState, variantNames, type Variant } from './final-frames';
import { finalFixture } from './final-fixtures';
import type { DesignFixture } from './fixtures';

declare global { interface Window { __designFixture?: DesignFixture; __designError?: string; __designNotices?: typeof notices } }

function mount() {
  const params = new URLSearchParams(window.location.search), variant = params.get('variant') as Variant;
  if (!variantNames.includes(variant)) throw new Error(`unknown variant ${variant}`);
  const fixture = finalFixture(finalState(params.get('state') ?? ''), variant);
  window.__designFixture = fixture;
  window.__designNotices = notices;
  createRoot(document.getElementById('root')!).render(<DesktopApp service={createDesktopService(fixture.transport)} />);
}
try { mount(); } catch (error) { window.__designError = error instanceof Error ? error.message : String(error); }
