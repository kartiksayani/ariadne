// The Help panel over its real styles, in the window's overlay layer (it floats under the top bar's right edge). Base styles first, as in main.tsx.
import '../../../apps/desktop/src/style.css';
import { createRoot } from 'react-dom/client';
import { HelpPanel } from '../../../apps/desktop/src/ui/help/HelpPanel';
import { KEY_GROUPS } from '../../../apps/desktop/src/ui/help/content';
import { NARROW_BELOW } from '../../../apps/desktop/src/ui/topbar/model';

(window as unknown as { helpKeyGroups: typeof KEY_GROUPS }).helpKeyGroups = KEY_GROUPS;
createRoot(document.getElementById('root')!).render(
  <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>
    <HelpPanel narrow={window.innerWidth < NARROW_BELOW} onClose={() => undefined} />
  </div>,
);
